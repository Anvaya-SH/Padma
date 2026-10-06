export function redact(text: string): string {
	return text
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [REDACTED]")
		.replace(/\b(https?:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@")
		.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED credential]")
		.replace(
			/(["']?(?:password|passwd|secret|api[_-]?key|authorization|(?:access|refresh|id)[_-]?token|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*')/gi,
			(_match, prefix: string, value: string) => `${prefix}${value[0]}[REDACTED]${value[0]}`,
		)
		.replace(
			/((?:password|passwd|secret|api[_-]?key|authorization|(?:access|refresh|id)[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*)(?!["'])([^\s,;]+)/gi,
			"$1[REDACTED]",
		);
}
