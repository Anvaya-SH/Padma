import { types } from "node:util";
import type { AgentEvent } from "@anvaya.sh/padma-agent-core";
import { redact } from "./redaction.ts";

const PRIVATE_FIELD =
	/^(?:password|passwd|secret|api[_-]?key|authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|(?:access|refresh|id)[_-]?token|client[_-]?secret|private[_-]?key)$/i;

/** Public protocol values are copies. Accessors, runtime objects and private credential fields never reach JSON. */
export function publicOutput(value: unknown, maxBytes = 8 * 1024 * 1024): unknown {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid public output bound");
	let remaining = maxBytes;
	let nodes = 0;
	const ancestors = new Set<object>();
	const project = (item: unknown, depth: number, headers = false): unknown => {
		if (++nodes > 100000 || depth > 64) return "[Public value omitted: structure limit]";
		if (typeof item === "string") {
			const size = Buffer.byteLength(item);
			if (size > remaining) return "[Public string omitted: byte limit]";
			remaining -= size;
			return redact(item);
		}
		if (item === null || typeof item === "boolean" || typeof item === "number") return item;
		if (typeof item !== "object") return undefined;
		if (
			types.isProxy(item) ||
			ancestors.has(item) ||
			(!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
		)
			return "[Private runtime value omitted]";
		ancestors.add(item);
		try {
			if (Array.isArray(item)) {
				const result: unknown[] = [];
				for (let index = 0; index < item.length && nodes < 100000; index++) {
					const field = Object.getOwnPropertyDescriptor(item, String(index));
					result.push(field && "value" in field ? (project(field.value, depth + 1, headers) ?? null) : null);
				}
				if (result.length !== item.length) result.push("[Public items omitted: structure limit]");
				return result;
			}
			const result: Record<string, unknown> = {};
			for (const key in item) {
				if (!Object.hasOwn(item, key)) continue;
				if (nodes >= 100000 || Buffer.byteLength(key) > remaining) {
					result.public_omission = "Structure limit reached";
					break;
				}
				remaining -= Buffer.byteLength(key);
				const field = Object.getOwnPropertyDescriptor(item, key);
				const projected =
					headers || PRIVATE_FIELD.test(key)
						? "[REDACTED]"
						: field && "value" in field
							? project(field.value, depth + 1, /^(?:headers|requestHeaders|responseHeaders)$/i.test(key))
							: "[Private accessor omitted]";
				if (projected !== undefined) Object.defineProperty(result, key, { value: projected, enumerable: true });
			}
			return result;
		} finally {
			ancestors.delete(item);
		}
	};
	return project(value, 0);
}

/** Credential fragments cannot be retracted after display. Publish complete blocks and the final message instead. */
export function publicAgentEvent(event: AgentEvent, maxBytes = 8 * 1024 * 1024): AgentEvent | null {
	if (
		event.type === "message_update" &&
		["text_delta", "thinking_delta", "toolcall_delta"].includes(event.assistantMessageEvent.type)
	)
		return null;
	return publicOutput(event, maxBytes) as AgentEvent;
}
