import type { Api, Model } from "@anvaya.sh/padma-ai";
import { redact } from "../../core/sandhana/redaction.ts";

/** Model selection metadata is public; runtime credentials and arbitrary sampling payloads are private. */
export function publicModel<TApi extends Api>(model: Model<TApi>): Model<TApi> {
	let baseUrl = redact(model.baseUrl);
	try {
		const url = new URL(model.baseUrl);
		if (url.username) url.username = "REDACTED";
		if (url.password) url.password = "REDACTED";
		for (const key of url.searchParams.keys()) url.searchParams.set(key, "REDACTED");
		baseUrl = url.toString();
	} catch {
		/* Invalid runtime URLs remain redacted text, never authorization. */
	}
	return {
		id: redact(model.id),
		name: redact(model.name),
		api: model.api,
		provider: model.provider,
		baseUrl,
		input: [...model.input],
		cost: structuredClone(model.cost),
		reasoning: model.reasoning,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		...(model.type ? { type: model.type } : {}),
		...(model.inputLimits ? { inputLimits: structuredClone(model.inputLimits) } : {}),
		...(model.thinkingLevelMap ? { thinkingLevelMap: structuredClone(model.thinkingLevelMap) } : {}),
		...(model.promptCache ? { promptCache: structuredClone(model.promptCache) } : {}),
		...(model.compat ? { compat: structuredClone(model.compat) } : {}),
		...(model.headers
			? { headers: Object.fromEntries(Object.keys(model.headers).map((key) => [key, "[REDACTED]"])) }
			: {}),
		...(model.samplingParams
			? {
					samplingParams: Object.fromEntries(
						Object.entries(model.samplingParams).map(([key, value]) => [
							key,
							typeof value === "number" || typeof value === "boolean" || value === null ? value : "[PRIVATE]",
						]),
					),
				}
			: {}),
	};
}
