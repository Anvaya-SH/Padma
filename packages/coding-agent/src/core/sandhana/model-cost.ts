import type { Model } from "@anvaya.sh/padma-ai";
import { SandhanaError } from "./errors.ts";

/** Bound all input/cache mixtures and pricing tiers reachable within the reserved input allowance. */
export function estimateModelCost(model: Pick<Model<string>, "api" | "cost">, input: number, output: number): number {
	let inputRate = 0;
	let outputRate = 0;
	for (const rates of [model.cost, ...(model.cost.tiers ?? []).filter((tier) => input > tier.inputTokensAbove)]) {
		if (
			[rates.input, rates.output, rates.cacheRead, rates.cacheWrite].some(
				(rate) => !Number.isFinite(rate) || rate < 0,
			)
		)
			throw new SandhanaError(
				"BUDGET_REJECTED",
				"Model pricing requires finite nonnegative rates; no provider call admitted",
			);
		// The SDK measures Anthropic's one-hour cache writes at twice the applicable input rate.
		inputRate = Math.max(
			inputRate,
			rates.input,
			rates.cacheRead,
			rates.cacheWrite,
			model.api === "anthropic-messages" ? rates.input * 2 : 0,
		);
		outputRate = Math.max(outputRate, rates.output);
	}
	return (input * inputRate + output * outputRate) / 1000000;
}
