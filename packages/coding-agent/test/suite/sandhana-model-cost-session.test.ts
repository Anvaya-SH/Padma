import { calculateCost, fauxAssistantMessage, type ModelCost, type Usage } from "@anvaya.sh/padma-ai";
import { afterEach, describe, expect, it } from "vitest";
import { estimateModelCost } from "../../src/core/sandhana/model-cost.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()!.cleanup();
});

describe("model pricing admission through the actual session", () => {
	it.each([50, 100, 200])(
		"covers native measured input/cache usage across reachable pricing tiers within %i tokens",
		async (inputBound) => {
			const h = await createHarness();
			harnesses.push(h);
			const cost: ModelCost = {
				input: 1,
				output: 2,
				cacheRead: 0.1,
				cacheWrite: 1.25,
				tiers: [
					{ inputTokensAbove: 50, input: 3, output: 4, cacheRead: 0.2, cacheWrite: 3.75 },
					{ inputTokensAbove: 150, input: 0.5, output: 0.25, cacheRead: 0.01, cacheWrite: 0.6 },
				],
			};
			const model = { ...h.getModel(), api: "anthropic-messages" as const, cost };
			const estimate = estimateModelCost(model, inputBound, 80);
			for (const input of [0, 50, 51, 150, 151, inputBound].filter((value) => value <= inputBound)) {
				for (const dimension of ["input", "cacheRead", "cacheWrite", "cacheWrite1h"] as const) {
					const usage: Usage = { ...fauxAssistantMessage("").usage, output: 60, totalTokens: input + 60 };
					usage[dimension] = input;
					if (dimension === "cacheWrite1h") usage.cacheWrite = input;
					expect(estimate).toBeGreaterThanOrEqual(calculateCost(model, usage).total);
				}
			}
			const unreachable = {
				...model,
				cost: {
					...cost,
					tiers: [
						{
							inputTokensAbove: inputBound,
							input: 1000000,
							output: 1000000,
							cacheRead: 1000000,
							cacheWrite: 1000000,
						},
					],
				},
			};
			expect(estimateModelCost(unreachable, inputBound, 80)).toBeLessThan(0.001);
		},
	);
	it("rejects invalid model pricing with a budget failure before consuming a provider response", async () => {
		const h = await createHarness({
			models: [{ id: "invalid-price-fixture", cost: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("This provider response must remain unused")]);
		await h.session.prompt("Inspect the parser behavior");
		expect(h.session.sandhana.terminal?.status, h.session.getLastAssistantText()).toBe("BUDGET_EXHAUSTED");
		expect(h.session.sandhana.state!.used.ticks).toBe(0);
		expect(h.getPendingResponseCount()).toBe(1);
	});
	it.each(["cacheRead", "cacheWrite"] as const)(
		"reserves the declared %s rate before consuming a provider response",
		async (dimension) => {
			const h = await createHarness({
				sandhanaConfiguration: { version: "sandhana/1", resources: { cost: 1 } },
				models: [
					{
						id: "expensive-cache-fixture",
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, [dimension]: 1000000 },
					},
				],
			});
			harnesses.push(h);
			h.setResponses([fauxAssistantMessage("This provider response must remain unused")]);
			await h.session.prompt("Inspect the parser behavior");
			const kernel = h.session.sandhana;
			const state = kernel.state!;
			expect(kernel.terminal?.status, h.session.getLastAssistantText()).toBe("BUDGET_EXHAUSTED");
			expect(state.used).toMatchObject({ ticks: 0, execution: 0, input_tokens: 0, output_tokens: 0, cost: 0 });
			expect(
				state.reservations
					.map((ref) => kernel.store.get(state.mission_id, ref, "BudgetReservation"))
					.some((record) => record.owner_operation_id.startsWith("model:")),
			).toBe(false);
			expect(
				kernel.terminal!.failure_refs!.map(
					(ref) => kernel.store.get(state.mission_id, ref, "EvidenceRecord").failure?.code,
				),
			).toContain("BUDGET_REJECTED");
			expect(h.getPendingResponseCount()).toBe(1);
			expect(h.eventsOfType("tool_execution_end")).toHaveLength(0);
		},
	);
});
