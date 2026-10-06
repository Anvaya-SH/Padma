import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()!.cleanup();
});

describe("ordinary manual shell truth", () => {
	it("retains a typed budget rejection before any native invocation", async () => {
		const h = await createHarness({ sandhanaConfiguration: { version: "sandhana/1", artifact: { max_bytes: 0 } } });
		harnesses.push(h);
		const result = await h.session.executeBash("printf unused");
		expect(result.output).toContain("Artifact retention is disabled");
		expect(h.session.sandhana.terminal?.status).toBe("BUDGET_EXHAUSTED");
		expect(h.session.sandhana.state!.used.execution).toBe(0);
		expect(h.faux.state.callCount).toBe(0);
	});
	it("reports that a bounded display omits actually retained native output", async () => {
		const h = await createHarness({ sandhanaConfiguration: { version: "sandhana/1", view: { tool_chars: 500 } } });
		harnesses.push(h);
		writeFileSync(join(h.tempDir, "output.cjs"), "console.log('ACTUAL_OUTPUT'.repeat(100));");
		const result = await h.session.executeBash("node output.cjs");
		expect(result.truncated).toBe(true);
		expect(result.output).toContain("Model view truncated");
		const kernel = h.session.sandhana;
		const state = kernel.state!;
		expect(state.used.execution).toBe(1);
		const operation = kernel.store.get(state.mission_id, state.operations[0], "OperationRecord");
		expect(operation.status).toBe("CONFIRMED_COMPLETE");
		const output = kernel.store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
		expect(kernel.store.artifact(state.mission_id, output.artifact_ref!).toString()).toContain(
			"ACTUAL_OUTPUT".repeat(100),
		);
		expect(h.faux.state.callCount).toBe(0);
	});
});
