import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult } from "@anvaya.sh/padma-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@anvaya.sh/padma-ai";
import { afterEach, describe, expect, it } from "vitest";
import { MODEL_OVERRUN_SOURCE } from "../../src/core/sandhana/model-usage.ts";
import { makeRecord, resources } from "../../src/core/sandhana/records.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()!.cleanup();
});

describe("capture of already launched native results", () => {
	it("captures complete native logs and source generations after the running mission has a terminal report", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const kernel = h.session.sandhana;
		const output = "LATE_NATIVE_OUTPUT\n".repeat(8192);
		writeFileSync(join(h.tempDir, "late.cjs"), `process.stdout.write(${JSON.stringify(output)});`);
		let report: typeof kernel.terminal = null;
		h.session.subscribe((event) => {
			if (report || event.type !== "tool_execution_update" || event.toolName !== "bash") return;
			const partial: AgentToolResult<unknown> = event.partialResult;
			if (!partial.content.some((part) => part.type === "text" && part.text.includes("LATE_NATIVE_OUTPUT"))) return;
			report = kernel.finalize("OUTCOME_UNKNOWN", "The process was still running when the report was recorded");
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "node late.cjs" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("must remain unused"),
		]);
		await h.session.prompt(
			`padma: ${JSON.stringify({
				objective: "Inspect emitted behavior",
				shell_commands: ["node late.cjs"],
				requirements: [{ text: "Explain emitted behavior", rule: "SEMANTIC", target: "late.cjs" }],
			})}`,
		);
		expect(report).not.toBeNull();
		expect(kernel.terminal).toEqual(report);
		const state = kernel.state!;
		const operation = kernel.store.get(state.mission_id, state.operations[0], "OperationRecord");
		expect(operation.status).toBe("CONFIRMED_COMPLETE");
		const observation = kernel.store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
		expect(observation.payload).toMatchObject({
			capture_limitations: [],
			dependencies_unchanged: true,
			process_sources: { complete: true },
			native_output_bytes: Buffer.byteLength(output),
		});
		const payload = observation.payload as { full_output_ref: string };
		expect(kernel.store.artifact(state.mission_id, payload.full_output_ref).toString()).toBe(output);
		expect(state.used.execution).toBe(1);
		expect(state.used.retrieval_bytes).toBeGreaterThanOrEqual(Buffer.byteLength(output));
		expect(kernel.store.publicSnapshot(state.mission_id)).toMatchObject({
			terminal: { status: "OUTCOME_UNKNOWN" },
			current_operations: [{ status: "CONFIRMED_COMPLETE" }],
		});
		expect(h.faux.state.callCount).toBe(1);
		expect(h.getPendingResponseCount()).toBe(1);
	});
	it.each([2, 10001])(
		"retains complete native output and bound sources after a peer uses %s output tokens",
		async (tokens) => {
			const h = await createHarness({
				sandhanaConfiguration: {
					version: "sandhana/1",
					model: { response_tokens: 300 },
					resources: { output_tokens: 10000 },
				},
			});
			harnesses.push(h);
			const output = "ACTUAL_NATIVE_OUTPUT\n".repeat(8192);
			writeFileSync(join(h.tempDir, "emit.cjs"), `process.stdout.write(${JSON.stringify(output)});`);
			const command = "node emit.cjs";
			const kernel = h.session.sandhana;
			let failure: ReturnType<typeof kernel.reconcileModel> | undefined;
			let settled = false;
			h.session.subscribe((event) => {
				if (event.type !== "tool_execution_update" || event.toolName !== "bash" || settled) return;
				const partial: AgentToolResult<unknown> = event.partialResult;
				if (!partial.content.some((part) => part.type === "text" && part.text.includes("ACTUAL_NATIVE_OUTPUT")))
					return;
				const current = kernel.state!;
				if (
					!current.operations.some(
						(ref) => kernel.store.get(current.mission_id, ref, "OperationRecord").status === "IN_PROGRESS",
					)
				)
					return;
				settled = true;
				const reservation = kernel.reserveModel(10, 1, 0);
				failure = kernel.reconcileModel(
					reservation,
					{ input: 1, output: tokens, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					0,
				);
				const before = kernel.state!;
				const recordCount = kernel.store.records(before.mission_id).length;
				const capture = {
					owner_operation_id: `capture:${before.operations[0]}:forged`,
					capture_operation_ref: before.operations[0],
					amounts: { ...resources(), retrieval_bytes: 1 },
					protected_for_verification: false,
					state: "RESERVED" as const,
					actual: null,
				};
				for (const fields of [
					{ ...capture, capture_operation_ref: reservation },
					{ ...capture, amounts: { ...capture.amounts, execution: 1 } },
					{ ...capture, amounts: { ...capture.amounts, retrieval_bytes: before.ceilings.retrieval_bytes } },
				]) {
					const forged = makeRecord(before.mission_id, before.revision + 1, "BudgetReservation", fields);
					expect(() =>
						kernel.store.commit(
							before.revision,
							{
								...before,
								revision: before.revision + 1,
								reservations: [...before.reservations, forged.record_id],
							},
							[forged],
						),
					).toThrow();
					expect(kernel.state).toEqual(before);
					expect(kernel.store.records(before.mission_id)).toHaveLength(recordCount);
				}
				const forged = makeRecord(before.mission_id, before.revision + 1, "BudgetReservation", capture);
				expect(() =>
					kernel.store.commit(
						before.revision,
						{
							...before,
							revision: before.revision + 1,
							authorizations: [],
							reservations: [...before.reservations, forged.record_id],
						},
						[forged],
					),
				).toThrow();
				expect(kernel.state).toEqual(before);
			});
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }),
				fauxAssistantMessage("A further provider request must remain unused"),
			]);
			await h.session.prompt(
				`padma: ${JSON.stringify({
					objective: "Inspect the emitted behavior",
					shell_commands: [command],
					requirements: [{ text: "Explain the behavior", rule: "SEMANTIC", target: "emit.cjs" }],
				})}`,
			);
			expect(settled).toBe(true);
			expect(failure).toMatchObject({ failure: { code: "BUDGET_OVERRUN" } });
			const state = kernel.state!;
			expect(state.operations, h.session.getLastAssistantText()).toHaveLength(1);
			const operation = kernel.store.get(state.mission_id, state.operations[0], "OperationRecord");
			const observation = kernel.store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
			expect(operation.status).toBe("CONFIRMED_COMPLETE");
			expect(observation.payload).toMatchObject({
				capture_limitations: [],
				process_sources: { complete: true },
				native_output_bytes: Buffer.byteLength(output),
				dependencies_unchanged: true,
			});
			const payload = observation.payload as { full_output_ref: string | null };
			expect(payload.full_output_ref).not.toBeNull();
			expect(kernel.store.artifact(state.mission_id, payload.full_output_ref!).toString()).toBe(output);
			expect(state.used.retrieval_bytes).toBeGreaterThanOrEqual(Buffer.byteLength(output));
			expect(kernel.terminal?.status).toBe("BUDGET_EXHAUSTED");
			expect(h.faux.state.callCount).toBe(1);
			expect(h.getPendingResponseCount()).toBe(1);
			expect(state.used).toMatchObject({ execution: 1, ticks: 2 });
			expect(
				kernel.store
					.records(state.mission_id)
					.filter((record) => record.record_type === "EvidenceRecord" && record.source === MODEL_OVERRUN_SOURCE),
			).toHaveLength(1);
		},
	);
});
