const PRIVATE_KEY =
	/^(?:password|passwd|secret|token|api[_-]?key|authorization|proxy[_-]?authorization|headers|cookie|set[_-]?cookie|(?:access|refresh|id)[_-]?token|client[_-]?secret|private[_-]?key)$/i;

/** Redact structured text before encoding so escaped source strings remain valid JSON. */
export function redact(text: string): string {
	if (!/^\s*[[{]/.test(text)) return redactText(text);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return redactText(text);
	}
	let changed = false;
	let nodes = 0;
	const project = (value: unknown, depth: number): unknown => {
		if (++nodes > 100000 || depth > 64) {
			changed = true;
			return "[Redacted view omitted: structure limit]";
		}
		if (typeof value === "string") {
			const result = redactText(value);
			if (result !== value) changed = true;
			return result;
		}
		if (Array.isArray(value)) return value.map((item: unknown) => project(item, depth + 1));
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(([key, item]) => {
					if (PRIVATE_KEY.test(key)) {
						if (item !== "[REDACTED]") changed = true;
						return [key, "[REDACTED]"];
					}
					return [key, project(item, depth + 1)];
				}),
			);
		return value;
	};
	const result = project(parsed, 0);
	return changed ? JSON.stringify(result) : text;
}

function redactText(text: string): string {
	return text
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [REDACTED]")
		.replace(/\b(https?:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@")
		.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED credential]")
		.replace(
			/(["']?(?:password|passwd|secret|token|api[_-]?key|(?:proxy[_-]?)?authorization|(?:set[_-]?)?cookie|(?:access|refresh|id)[_-]?token|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*')/gi,
			(_match, prefix: string, value: string) => `${prefix}${value[0]}[REDACTED]${value[0]}`,
		)
		.replace(
			/((?:password|passwd|secret|token|api[_-]?key|(?:proxy[_-]?)?authorization|(?:set[_-]?)?cookie|(?:access|refresh|id)[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*)(?!["']|\[REDACTED(?: credential)?\](?=$|[\s,;"'}\]]|\\[nrt"]))([^\s,;]+)/gi,
			"$1[REDACTED]",
		);
}
