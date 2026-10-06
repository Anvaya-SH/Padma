import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { makeRecord } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createReadTool, createWriteTool } from "../src/core/tools/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(rule: "CONTENT" | "SEMANTIC" = "CONTENT", incomplete = false) {
	const directory = mkdtempSync(join(tmpdir(), "padma-hypothesis-resolution-"));
	const cwd = join(directory, "workspace");
	mkdirSync(cwd);
	writeFileSync(join(cwd, "parser.txt"), "before");
	const store = new MissionStore(join(directory, "mission.sqlite"));
	const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "resolved-hypothesis", store });
	cleanups.push(() => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	});
	kernel.register(createReadTool(cwd), "read");
	kernel.register(createWriteTool(cwd), "write");
	kernel.captureInput(
		`padma: ${JSON.stringify({
			objective: "repair the parser",
			allow_edits: true,
			requirements: [
				{
					text: "requested parser result",
					rule,
					target: "parser.txt",
					...(rule === "CONTENT" ? { expected: "SUPPORTED_RESULT" } : {}),
				},
				...(incomplete
					? [{ text: "required second deliverable", rule: "CONTENT", target: "other.txt", expected: "missing" }]
					: []),
			],
		})}`,
		"USER",
	);
	kernel.begin("");
	expect(
		kernel.proposeHypothesis({
			target: "parser.txt",
			cause: "INPUT_FORMAT",
			mechanism: "VALIDATE",
			failure_signature: "FAILURE",
			expected_result: "SUPPORTED_RESULT",
		}),
	).toBe(true);
	return { cwd, store, kernel };
}

describe("verified hypothesis resolution", () => {
	it("closes a supported guarded correction with its current terminal proof and preserves attempts", async () => {
		const f = fixture();
		await f.kernel.execute("write", "correction", { path: "parser.txt", content: "SUPPORTED_RESULT" });
		await f.kernel.execute("read", "support", { path: "parser.txt" });
		const before = f.kernel.state!;
		const supported = f.store.get(before.mission_id, before.hypotheses[0], "Hypothesis");
		expect(supported).toMatchObject({ status: "SUPPORTED", attempts: 2 });
		const terminal = f.kernel.finalize();
		expect(terminal.status).toBe("VERIFIED_COMPLETE");
		const resolved = f.store.get(before.mission_id, f.kernel.state!.hypotheses[0], "Hypothesis");
		expect(resolved).toMatchObject({
			status: "RESOLVED",
			resolution_ref: terminal.record_id,
			attempts: 2,
			supporting: supported.supporting,
			contradicting: [],
		});
		expect(f.store.get(before.mission_id, supported.record_id, "Hypothesis")).toEqual(supported);
		expect(f.kernel.state!.used.execution).toBe(before.used.execution);
		expect(f.kernel.finalize()).toEqual(terminal);
	});
	it.each(["semantic", "incomplete", "stale"] as const)(
		"retains supported evidence without resolving an %s objective",
		async (variant) => {
			const f = fixture(variant === "semantic" ? "SEMANTIC" : "CONTENT", variant === "incomplete");
			await f.kernel.execute("write", "correction", { path: "parser.txt", content: "SUPPORTED_RESULT" });
			await f.kernel.execute("read", "support", { path: "parser.txt" });
			const before = f.kernel.state!;
			const supported = f.store.get(before.mission_id, before.hypotheses[0], "Hypothesis");
			expect(supported.status).toBe("SUPPORTED");
			if (variant === "stale") writeFileSync(join(f.cwd, "parser.txt"), "external user changes");
			expect(f.kernel.finalize().status).toBe("PARTIALLY_COMPLETE");
			expect(f.store.get(before.mission_id, f.kernel.state!.hypotheses[0], "Hypothesis")).toEqual(supported);
		},
	);
	it("rejects model resolution without a verified terminal transition", async () => {
		const f = fixture();
		await f.kernel.execute("write", "correction", { path: "parser.txt", content: "SUPPORTED_RESULT" });
		await f.kernel.execute("read", "support", { path: "parser.txt" });
		const state = f.kernel.state!;
		const history = f.store.records(state.mission_id);
		const supported = f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis");
		const forged = makeRecord(state.mission_id, state.revision + 1, "Hypothesis", {
			...supported,
			status: "RESOLVED",
			resolution_ref: state.last_event!,
		});
		expect(() =>
			f.store.commit(state.revision, { ...state, revision: state.revision + 1, hypotheses: [forged.record_id] }, [
				forged,
			]),
		).toThrow();
		expect(f.store.records(state.mission_id)).toEqual(history);
	});
});
