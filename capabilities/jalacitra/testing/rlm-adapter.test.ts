// RLM Source Adapter Unit Tests (Step 12, J5-RLM-001 through J5-RLM-004)

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAtlas } from "../api/atlas.ts";
import { JalacitraRlmSourceAdapter } from "../ports/rlm-source-adapter.ts";

test("J5-RLM-001: RLM adapter returns references and handles, never source prose", async () => {
	const fixtureDir = join(tmpdir(), `jalacitra-rlm-${Date.now()}`);
	mkdirSync(join(fixtureDir, "src"), { recursive: true });
	const dbPath = join(fixtureDir, "store.sqlite");

	const atlas = createAtlas({ dbPath, repoRoot: fixtureDir, repoIdentity: "repo:rlm" });

	try {
		writeFileSync(
			join(fixtureDir, "src", "service.ts"),
			`export function executeOrder(id: string) {\n  return id;\n}\n`,
		);

		atlas.ensureIndex();

		const adapter = new JalacitraRlmSourceAdapter(atlas);
		const answer = await adapter.retrieve({
			intent: "investigate_symbol",
			target: "executeOrder",
			repoRoot: fixtureDir,
			freshness_requirement: "current_generation",
		});

		assert.equal(answer.version, "RLM_GRAPH_ANSWER/1");
		assert.ok(answer.references.length >= 1);

		const ref = answer.references[0];
		assert.equal(ref.filePath, "src/service.ts");
		assert.ok(ref.range);
		assert.equal(ref.range?.startLine, 1);
		assert.equal(ref.provenance, "PARSED");
		assert.equal(ref.isInferred, false);
		assert.equal(ref.isAmbiguous, false);

		// Assert answer object does not contain full source code text
		const answerStr = JSON.stringify(answer);
		assert.equal(answerStr.includes("return id;"), false);
	} finally {
		atlas.close();
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test("J5-RLM-002 / J5-RLM-003: Freshness requirement mapping and compaction key", async () => {
	const fixtureDir = join(tmpdir(), `jalacitra-rlm-fresh-${Date.now()}`);
	mkdirSync(join(fixtureDir, "src"), { recursive: true });
	const dbPath = join(fixtureDir, "store.sqlite");

	const atlas = createAtlas({ dbPath, repoRoot: fixtureDir, repoIdentity: "repo:rlm-fresh" });

	try {
		writeFileSync(
			join(fixtureDir, "src", "calc.ts"),
			`export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
		);

		atlas.ensureIndex();

		const adapter = new JalacitraRlmSourceAdapter(atlas);

		// Request live freshness
		const answer = await adapter.retrieve({
			intent: "investigate_symbol",
			target: "add",
			repoRoot: fixtureDir,
			freshness_requirement: "live",
		});

		assert.equal(answer.references[0].freshness, "FRESH");
		assert.equal(answer.references[0].sourceGeneration, 1);

		// Verify compaction key for mission compaction (J5-RLM-004)
		assert.ok(answer.compaction_key);
		assert.equal(answer.compaction_key.snapshotId, answer.snapshotId);
		assert.equal(answer.compaction_key.generation, 1);
	} finally {
		atlas.close();
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});
