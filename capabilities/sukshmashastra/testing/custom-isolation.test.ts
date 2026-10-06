import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildAndValidatePlan } from "../pipeline/plan-builder.ts";
import { InMemoryArtifactStore } from "../ports/artifact-store.ts";
import { runCustomCodemod } from "../transformations/custom.ts";

const source = "const x = 1;\n";

describe("custom codemod capability isolation", () => {
	it("does not expose the host process through injected constructors", async () => {
		for (const script of [
			"result = Object.constructor('return process')().platform;",
			"result = console.log.constructor('return process')().platform;",
		]) {
			await assert.rejects(async () => runCustomCodemod(source, script));
		}
	});

	it("preserves ordinary transformations and provides only guest JavaScript globals", async () => {
		const result = await runCustomCodemod(
			source,
			`
			if (typeof process !== 'undefined' || typeof require !== 'undefined' || typeof fetch !== 'undefined') throw new Error('Host capability exposed');
			if (ALL_TOOLS.length !== 0) throw new Error('Tools exposed');
			result = code.replace('1', String(Math.max(2, 1)));
		`,
		);
		assert.equal(result.newContent, "const x = 2;\n");
	});

	it("does not execute a host filesystem effect during preparation", async () => {
		const root = mkdtempSync(join(tmpdir(), "padma-custom-isolation-"));
		const sentinel = join(root, "sentinel.txt");
		writeFileSync(sentinel, "original");
		try {
			const script = `Object.constructor('return process')().getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'changed');`;
			await assert.rejects(() => runCustomCodemod(source, script));
			assert.equal(readFileSync(sentinel, "utf8"), "original");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects non-text results without invoking their coercion methods on the host", async () => {
		await assert.rejects(() => runCustomCodemod(source, "result = { toString() { while (true) {} } };"));
		const next = await runCustomCodemod(source, "result = code.replace('1', '3');");
		assert.equal(next.newContent, "const x = 3;\n");
	});

	it("terminates a spinning worker and permits the next independent transformation", async () => {
		await assert.rejects(() => runCustomCodemod(source, "while (true) {}", 500), /timed out/);
		const next = await runCustomCodemod(source, "result = code.replace('1', '4');");
		assert.equal(next.newContent, "const x = 4;\n");
	});

	it("rejects invalid execution bounds and oversized data before producing candidate text", async () => {
		for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 30001]) {
			await assert.rejects(() => runCustomCodemod(source, "result = code;", timeout), /bound/);
		}
		await assert.rejects(() => runCustomCodemod("x".repeat(1024 * 1024 + 1), "result = code;"), /bound/);
		await assert.rejects(() => runCustomCodemod(source, " ".repeat(64 * 1024 + 1)), /bound/);
		await assert.rejects(() => runCustomCodemod(source, "result = ' '.repeat(1024 * 1024 + 1);"), /bound/);
	});

	it("awaits custom plan preparation and scans generated text before publishing artifacts", async () => {
		const store = new InMemoryArtifactStore();
		const binding = { canonical_path: "/fixture", repository_identity: "custom-isolation" };
		const input = {
			repoBinding: binding,
			activeBinding: binding,
			baseCommit: "fixture",
			activeBaseCommit: "fixture",
			workspaceGeneration: "1",
			activeWorkspaceGeneration: "1",
			intent: "Update a constant",
			anchors: [],
			files: new Map([["a.ts", source]]),
			artifactStore: store,
		};
		const transformation = {
			transformation_id: "custom",
			kind: "custom" as const,
			target_file: "a.ts",
			replacement_text: "result = code.replace('1', '2');",
			affected_nodes: [],
			deliberately_unchanged_nodes: [],
		};
		const plan = await buildAndValidatePlan({ ...input, transformations: [transformation] });
		assert.equal(plan.status, "VALIDATED");
		assert.match((await store.get(plan.expected_diff_ref.digest))!, /const x = 2/);
		await assert.rejects(
			() =>
				buildAndValidatePlan({
					...input,
					transformations: [
						{
							...transformation,
							replacement_text: `result = "const token = '" + "gh" + "p_" + "a".repeat(36) + "';";`,
						},
					],
				}),
			/SECRET_IN_REPLACEMENT/,
		);
	});
});
