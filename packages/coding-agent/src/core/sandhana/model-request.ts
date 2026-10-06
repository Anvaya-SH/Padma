import { SandhanaError } from "./errors.ts";
import { serializeOutput } from "./output.ts";

const outputFields = new Set([
	"maxTokens",
	"max_tokens",
	"max_completion_tokens",
	"max_output_tokens",
	"maxOutputTokens",
	"max_new_tokens",
	"maxNewTokens",
	"num_predict",
	"thinking_token_budget",
	"thinking_budget",
	"thinking_budget_tokens",
	"budget_tokens",
]);

/** Sampling overrides are provider input, not permission to replace the admitted model or enlarge its work. */
export function validateModelSampling(parameters: Record<string, unknown> | undefined, outputLimit: number): void {
	if (!parameters) return;
	for (const [key, value] of Object.entries(parameters)) {
		if (["model", "messages", "input", "prompt", "tools", "system"].includes(key))
			throw new SandhanaError(
				"BUDGET_REJECTED",
				"Sampling parameters cannot replace admitted provider identity or input",
			);
		if (
			outputFields.has(key) &&
			(!Number.isSafeInteger(value) || typeof value !== "number" || value < 0 || value > outputLimit)
		)
			throw new SandhanaError("BUDGET_REJECTED", "Sampling output exceeds the admitted model allowance");
		if ((key === "n" || key === "best_of") && value !== 1)
			throw new SandhanaError(
				"BUDGET_REJECTED",
				"Multiple provider generations require a separately admitted request",
			);
	}
}

/** Copy the actual native payload before send; retained hook objects cannot mutate the admitted request later. */
export function boundedModelPayload(
	payload: unknown,
	inputLimit: number,
	outputLimit: number,
	native = false,
): unknown {
	const serialized = serializeOutput(payload, inputLimit);
	if (!serialized.bytes || serialized.limitation)
		throw new SandhanaError(
			"BUDGET_REJECTED",
			"Final provider payload exceeds admitted input or is not bounded JSON data",
		);
	const copied: unknown = JSON.parse(serialized.bytes.toString());
	const inspect = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const child of value) inspect(child);
			return;
		}
		const fields = value as Record<string, unknown>;
		for (const [key, child] of Object.entries(fields)) {
			if (outputFields.has(key)) {
				if (
					typeof child !== "number" ||
					!Number.isSafeInteger(child) ||
					child < 0 ||
					(!native && child > outputLimit)
				)
					throw new SandhanaError("BUDGET_REJECTED", "Final provider output exceeds the admitted model allowance");
				if (native) {
					// Anthropic's simple adapter adds thinking to an explicit answer cap. Keep its actual total within admission.
					const bound = key === "budget_tokens" ? Math.max(0, outputLimit - 1024) : outputLimit;
					if (key === "budget_tokens" && child > 0 && bound < 1024)
						throw new SandhanaError(
							"BUDGET_REJECTED",
							"Admitted output cannot fit the native thinking minimum and answer room",
						);
					fields[key] = Math.min(child, bound);
				}
			}
			if ((key === "n" || key === "best_of") && child !== 1)
				throw new SandhanaError("BUDGET_REJECTED", "Final provider payload requests unadmitted extra generations");
			// Request fields are checked without treating text or tool argument schemas as provider configuration.
			if (["generationConfig", "generation_config", "inferenceConfig", "inference_config", "thinking"].includes(key))
				inspect(child);
		}
	};
	inspect(copied);
	return copied;
}
