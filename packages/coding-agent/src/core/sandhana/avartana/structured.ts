import { digest } from "../records.ts";
import type { Citation, Snippet } from "./contracts.ts";

/** Bounded lexical validation before JSON.parse. Duplicate policy: reject within each object, not across siblings. */
function parse(text: string): unknown {
	if (Buffer.byteLength(text) > 256 * 1024) throw new Error("Parser byte ceiling");
	const stack: (Set<string> | null)[] = [];
	let tokens = 0;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (character === '"') {
			const start = index;
			index++;
			while (index < text.length) {
				if (text[index] === "\\") index += 2;
				else if (text[index] === '"') break;
				else index++;
			}
			let next = index + 1;
			while (/\s/.test(text[next] ?? "") && next < text.length) next++;
			const object = stack.at(-1);
			if (text[next] === ":" && object) {
				const key = JSON.parse(text.slice(start, index + 1)) as string;
				if (object.has(key)) throw new Error("Duplicate object key");
				object.add(key);
			}
		} else if (character === "{" || character === "[") {
			stack.push(character === "{" ? new Set<string>() : null);
			if (stack.length > 32) throw new Error("Parser nesting ceiling");
		} else if (character === "}" || character === "]") stack.pop();
		if (++tokens > 64000) throw new Error("Parser work ceiling");
	}
	return JSON.parse(text);
}
export interface StructuredProjection {
	parser: "BOUNDED_JSON_OR_JSONL/1";
	records: { value: unknown; citation: Citation }[];
	rejected: { citation: Citation; reason: string }[];
	complete: boolean;
	support: "DETERMINISTIC_DERIVATION";
}
export function extractStructured(inputs: Snippet[], key: string): StructuredProjection {
	const records: StructuredProjection["records"] = [];
	const rejected: StructuredProjection["rejected"] = [];
	for (const input of inputs) {
		if (input.citation.lossy || input.truncated || input.redacted) {
			rejected.push({ citation: input.citation, reason: "Transformed or partial JSON view" });
			continue;
		}
		let segments = [{ text: input.text, offset: 0 }];
		try {
			parse(input.text);
		} catch {
			let offset = 0;
			segments = input.text
				.split("\n")
				.map((text) => {
					const result = { text, offset };
					offset += Buffer.byteLength(text) + 1;
					return result;
				})
				.filter((item) => item.text.trim());
		}
		if (segments.length > 2048) {
			rejected.push({ citation: input.citation, reason: "Record ceiling" });
			continue;
		}
		for (const segment of segments) {
			const begin = input.citation.rawRange.begin + segment.offset;
			const end = begin + Buffer.byteLength(segment.text);
			const citation: Citation = {
				...input.citation,
				range: { kind: "bytes_half_open", begin, end },
				rawRange: { kind: "bytes_half_open", begin, end },
				excerptDigest: digest(Buffer.from(segment.text)),
			};
			try {
				const value = parse(segment.text);
				if (key && value && typeof value === "object" && Object.hasOwn(value, key))
					records.push({ value: (value as Record<string, unknown>)[key], citation });
				else if (!key) records.push({ value, citation });
				else throw new Error("Missing key is unknown, not zero");
			} catch (error) {
				rejected.push({ citation, reason: error instanceof Error ? error.message : "Malformed JSON record" });
			}
		}
	}
	return {
		parser: "BOUNDED_JSON_OR_JSONL/1",
		records,
		rejected,
		complete: !rejected.length,
		support: "DETERMINISTIC_DERIVATION",
	};
}
