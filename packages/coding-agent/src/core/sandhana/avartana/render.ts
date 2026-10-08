import { redact } from "../redaction.ts";
import { ContextError } from "./contracts.ts";

/** Sanitize string values before JSON encoding. Redacting an encoded JSON string can remove its closing quotes. */
export function modelSafe<T>(value: T, key = "", depth = 0): T {
	if (depth > 64) throw new ContextError("CAPACITY", "Model rendering exceeds bounded nesting");
	if (
		/^(?:password|passwd|secret|token|api[_-]?key|authorization|proxy[_-]?authorization|headers|cookie|set[_-]?cookie|(?:access|refresh|id)[_-]?token|client[_-]?secret|private[_-]?key)$/i.test(
			key,
		)
	)
		return "[REDACTED]" as T;
	if (typeof value === "string") return redact(value) as T;
	if (Array.isArray(value)) return value.map((item) => modelSafe(item, "", depth + 1)) as T;
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([name, item]) => [name, modelSafe(item, name, depth + 1)]),
		) as T;
	return value;
}
