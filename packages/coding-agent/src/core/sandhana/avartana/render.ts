import { redact } from "../redaction.ts";
import { ContextError } from "./contracts.ts";

/** Sanitize string values before JSON encoding. Redacting an encoded JSON string can remove its closing quotes. */
export function modelSafe<T>(value: T, key = "", depth = 0): T {
	if (depth > 64) throw new ContextError("CAPACITY", "Model rendering exceeds bounded nesting");
	if (typeof value === "string")
		return (
			/^(?:password|secret|api[_-]?key|authorization|access[_-]?token)$/i.test(key) ? "[REDACTED]" : redact(value)
		) as T;
	if (Array.isArray(value)) return value.map((item) => modelSafe(item, "", depth + 1)) as T;
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([name, item]) => [name, modelSafe(item, name, depth + 1)]),
		) as T;
	return value;
}
