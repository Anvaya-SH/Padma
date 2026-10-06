import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KernelStop, SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { makeRecord, type RecordOf } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { TOOL_OVERRUN_SOURCE } from "../src/core/sandhana/tool-usage.ts";
import { createBashTool } from "../src/core/tools/index.ts";

const close: (() => void)[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dispose of close.splice(0).reverse()) dispose();
});

describe("atomic launched tool overrun evidence", () => {
	it.each(["output", "deadline"] as const)(
		"retains the actual %s mismatch once before stopping further admission",
		async (boundary) => {
			const cwd = mkdtempSync(join(tmpdir(), "padma-tool-overrun-"));
			const store = new MissionStore(":memory:");
			const kernel = new SandhanaKernel({
				cwd: () => cwd,
				session: () => "tool-overrun",
				store,
				configuration: { version: "sandhana/1", artifact: { max_bytes: 4096 } },
			});
			close.push(() => {
				store.close();
				rmSync(cwd, { recursive: true, force: true });
			});
			const now = Date.now();
			const clock = vi.spyOn(Date, "now").mockReturnValue(now);
			const execute = vi.fn(async () => {
				if (boundary === "deadline") clock.mockReturnValue(now + kernel.state!.ceilings.elapsed_ms + 1);
				return {
					content: [
						{
							type: "text" as const,
							text: boundary === "output" ? "actual output".repeat(10000) : "actual confirmed response",
						},
					],
					details: {},
					structuredContent: { exit_code: 0 },
				};
			});
			kernel.register({ ...createBashTool(cwd), execute }, "bash");
			kernel.captureInput("run: node check.cjs", "USER");
			kernel.begin("");
			let failure: unknown;
			try {
				await kernel.execute("bash", "one-launched-invocation", { command: "node check.cjs" });
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(KernelStop);
			expect(failure).toMatchObject({ failure: { code: "BUDGET_OVERRUN" }, status: "BUDGET_EXHAUSTED" });
			const state = kernel.state!;
			const operation = store.get(state.mission_id, state.operations[0], "OperationRecord");
			expect(operation.status).toBe("CONFIRMED_COMPLETE");
			expect(state.used.execution).toBe(1);
			expect(execute).toHaveBeenCalledTimes(1);
			const overruns = store
				.records(state.mission_id)
				.filter(
					(record): record is RecordOf<"EvidenceRecord"> =>
						record.record_type === "EvidenceRecord" && record.source === TOOL_OVERRUN_SOURCE,
				);
			expect(overruns).toHaveLength(1);
			expect(overruns[0]).toMatchObject({
				revision: operation.revision,
				operation_id: operation.operation_id,
				failure: { operation_id: operation.operation_id, code: "BUDGET_OVERRUN" },
				payload:
					boundary === "output"
						? { over_reservation: ["output_bytes"], over_ceiling: [] }
						: { over_reservation: [], over_ceiling: ["elapsed_ms"] },
			});
			if (!(failure instanceof KernelStop)) throw new Error("Missing typed failure");
			expect(kernel.recordFailure(failure)).toBe(overruns[0].record_id);
			expect(() => kernel.reserveModel(0, 0, 0)).toThrow();
			expect(kernel.state).toEqual(state);
			const forged = makeRecord(state.mission_id, state.revision + 1, "EvidenceRecord", {
				...overruns[0],
				event_id: "duplicate-overrun",
			});
			expect(() =>
				store.commit(state.revision, { ...state, revision: state.revision + 1, last_event: forged.record_id }, [
					forged,
				]),
			).toThrow();
			expect(kernel.state).toEqual(state);
			expect(execute).toHaveBeenCalledTimes(1);
		},
	);
});
