import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@anvaya.sh/padma-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextAnswer } from "../../src/core/sandhana/avartana/contracts.ts";
import { MODEL_OVERRUN_SOURCE } from "../../src/core/sandhana/model-usage.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()!.cleanup();
});

describe("model usage overruns through the actual session", () => {
	it.each([100, 1000])(
		"retains measured output and refuses its proposed write with a %s token ceiling",
		async (ceiling) => {
			const h = await createHarness({
				sandhanaConfiguration: {
					version: "sandhana/1",
					model: { response_tokens: 100 },
					resources: { output_tokens: ceiling },
				},
			});
			harnesses.push(h);
			writeFileSync(join(h.tempDir, "config.txt"), "mode: strict\n");
			h.setResponses([
				fauxAssistantMessage(
					[
						{ type: "text", text: "x".repeat(1000) },
						fauxToolCall("write", { path: "config.txt", content: "mode: permissive\n" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Further launch must remain unused"),
			]);
			await h.session.prompt("Update config.txt to use permissive mode");
			const kernel = h.session.sandhana;
			const state = kernel.state!;
			expect(kernel.terminal?.status, h.session.getLastAssistantText()).toBe("BUDGET_EXHAUSTED");
			expect(state.used).toMatchObject({ ticks: 1, execution: 0, cost: 0 });
			expect(state.used.output_tokens).toBeGreaterThan(100);
			expect(readFileSync(join(h.tempDir, "config.txt"), "utf8")).toBe("mode: strict\n");
			expect(h.eventsOfType("tool_execution_start")).toHaveLength(0);
			expect(h.faux.state.callCount).toBe(1);
			expect(h.getPendingResponseCount()).toBe(1);
			const events = kernel.store
				.records(state.mission_id)
				.filter((record) => record.record_type === "EvidenceRecord" && record.source === MODEL_OVERRUN_SOURCE);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				failure: { code: "BUDGET_OVERRUN", operation_id: null, target_binding_ref: null },
				payload: { over_reservation: ["output_tokens"], over_ceiling: ceiling === 100 ? ["output_tokens"] : [] },
			});
			const usage = state.reservations
				.map((ref) => kernel.store.get(state.mission_id, ref, "BudgetReservation"))
				.find((record) => record.owner_operation_id.startsWith("model:"))!;
			expect(usage).toMatchObject({
				state: "RECONCILED",
				revision: events[0].revision,
				actual: { output_tokens: state.used.output_tokens },
			});
			expect(kernel.terminal!.failure_refs).toContain(events[0].record_id);
			expect(h.eventsOfType("agent_end")).toHaveLength(1);
		},
	);
	it("keeps a leaf overrun charged and blocks the remaining write in the same native batch", async () => {
		const h = await createHarness({
			sandhanaConfiguration: {
				version: "sandhana/1",
				model: { response_tokens: 300 },
				resources: { output_tokens: 10000 },
			},
		});
		harnesses.push(h);
		writeFileSync(join(h.tempDir, "config.txt"), "mode: strict\n");
		const source = { family: "filesystem_text", locator: "config.txt" };
		h.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("avartana", {
						question: "Interpret the mode",
						sources: [source],
						limits: { contextTokens: 16000 },
						plan: {
							version: "AVARTANA_PLAN/1",
							nodes: [
								{ id: "read", op: "read_range", source, inputs: [] },
								{ id: "leaf", op: "analyse", inputs: ["read"], question: "Interpret the mode" },
								{ id: "return", op: "return", inputs: ["leaf"] },
							],
						},
					}),
					fauxToolCall("write", { path: "config.txt", content: "mode: permissive\n" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(JSON.stringify({ answer: "x".repeat(5000), citations: [0], limitations: [] })),
			fauxAssistantMessage("Further launch must remain unused"),
		]);
		await h.session.prompt("Inspect config.txt, then update it to permissive mode");
		const kernel = h.session.sandhana;
		const state = kernel.state!;
		expect(kernel.terminal?.status, h.session.getLastAssistantText()).toBe("BUDGET_EXHAUSTED");
		expect(readFileSync(join(h.tempDir, "config.txt"), "utf8")).toBe("mode: strict\n");
		expect(state.used).toMatchObject({ ticks: 2, execution: 1, cost: 0 });
		expect(state.used.output_tokens).toBeGreaterThan(300);
		expect(state.used.output_tokens).toBeLessThan(10000);
		expect(h.faux.state.callCount).toBe(2);
		expect(h.getPendingResponseCount()).toBe(1);
		const answer = JSON.parse(getMessageText(getToolResult(h, "avartana"))) as ContextAnswer;
		expect(answer.limitations).toContainEqual(expect.objectContaining({ code: "BUDGET" }));
		expect(answer.snippets.map((snippet) => snippet.text).join("\n")).toContain("mode: strict");
		expect(
			kernel.store
				.records(state.mission_id)
				.filter((record) => record.record_type === "EvidenceRecord" && record.source === "AVARTANA_DERIVATION/1"),
		).toHaveLength(0);
		expect(
			kernel.terminal!.failure_refs!.map(
				(ref) => kernel.store.get(state.mission_id, ref, "EvidenceRecord").failure?.code,
			),
		).toContain("BUDGET_OVERRUN");
	});
});
