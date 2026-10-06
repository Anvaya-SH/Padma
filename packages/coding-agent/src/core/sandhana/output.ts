import { createHash } from "node:crypto";
import { types } from "node:util";
import type { AgentToolResult } from "@anvaya.sh/padma-agent-core";
import { redact } from "./code.ts";

const MAX_DEPTH = 64;
const MAX_NODES = 100000;
const STRING_CHUNK = 4096;

export interface SerializedOutput {
	bytes: Buffer | null;
	measured_bytes: number | null;
	observed_bytes: number;
	digest: string | null;
	limitation: string | null;
}

/** Serialize data without invoking getters, proxies or custom toJSON methods. */
export function serializeOutput(value: unknown, maxBytes: number, timeoutMs = 30000): SerializedOutput {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid output capture bound");
	const hash = createHash("sha256");
	const ancestors = new Set<object>();
	let chunks: Buffer[] = [];
	let count = 0;
	let nodes = 0;
	const started = performance.now();
	const check = () => {
		if (performance.now() - started >= timeoutMs) throw new Error("Output serialization time limit reached");
	};
	const emit = (text: string) => {
		check();
		const bytes = Buffer.from(text);
		count += bytes.length;
		if (!Number.isSafeInteger(count)) throw new Error("Output byte count exceeds safe measurement range");
		hash.update(bytes);
		if (count <= maxBytes) chunks.push(bytes);
		else chunks = [];
	};
	const string = (text: string) => {
		emit('"');
		for (let start = 0; start < text.length; ) {
			let end = Math.min(start + STRING_CHUNK, text.length);
			const last = text.charCodeAt(end - 1);
			const next = text.charCodeAt(end);
			if (end < text.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
			emit(JSON.stringify(text.slice(start, end)).slice(1, -1));
			start = end;
		}
		emit('"');
	};
	const encode = (item: unknown, depth: number): void => {
		check();
		if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error("Output exceeds bounded JSON traversal");
		if (typeof item === "string") {
			string(item);
			return;
		}
		if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) {
			emit(JSON.stringify(item));
			return;
		}
		if (typeof item !== "object" || item === null) throw new Error("Output contains non-JSON data");
		if (types.isProxy(item)) throw new Error("Output contains a runtime proxy");
		if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
			throw new Error("Output contains a runtime object");
		if (ancestors.has(item)) throw new Error("Output contains a cycle");
		ancestors.add(item);
		try {
			if (Array.isArray(item)) {
				emit("[");
				for (let index = 0; index < item.length; index++) {
					if (index) emit(",");
					const property = Object.getOwnPropertyDescriptor(item, String(index));
					if (property && !("value" in property)) throw new Error("Output contains an accessor");
					encode(property?.value === undefined ? null : property.value, depth + 1);
				}
				emit("]");
			} else {
				emit("{");
				let first = true;
				for (const key in item) {
					check();
					const property = Object.getOwnPropertyDescriptor(item, key);
					if (!property?.enumerable) continue;
					if (!("value" in property)) throw new Error("Output contains an accessor");
					// Optional native tool fields are absent in JSON, rather than serialized as undefined.
					if (property.value === undefined) continue;
					if (!first) emit(",");
					first = false;
					string(key);
					emit(":");
					encode(property.value, depth + 1);
				}
				emit("}");
			}
		} finally {
			ancestors.delete(item);
		}
	};
	try {
		encode(value, 0);
		return {
			bytes: count <= maxBytes ? Buffer.concat(chunks, count) : null,
			measured_bytes: count,
			observed_bytes: count,
			digest: hash.digest("hex"),
			limitation: count > maxBytes ? "Serialized output exceeds bounded artifact storage" : null,
		};
	} catch (error) {
		return {
			bytes: null,
			measured_bytes: null,
			observed_bytes: count,
			digest: null,
			limitation: error instanceof Error ? error.message : "Output serialization failed",
		};
	}
}

function dataProperty(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object" || types.isProxy(value)) return undefined;
	if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
	const property = Object.getOwnPropertyDescriptor(value, key);
	return property && "value" in property ? property.value : undefined;
}

export function isToolOutput(value: unknown): value is AgentToolResult<unknown> {
	const content = dataProperty(value, "content");
	if (!Array.isArray(content) || types.isProxy(content) || content.length > MAX_NODES) return false;
	for (const key of ["isError", "terminate"]) {
		const flag = dataProperty(value, key);
		if (flag !== undefined && typeof flag !== "boolean") return false;
	}
	for (let index = 0; index < content.length; index++) {
		const part = dataProperty(content, String(index));
		const type = dataProperty(part, "type");
		if (type === "text" && typeof dataProperty(part, "text") === "string") continue;
		if (
			type === "image" &&
			typeof dataProperty(part, "data") === "string" &&
			typeof dataProperty(part, "mimeType") === "string"
		)
			continue;
		return false;
	}
	return true;
}

/** A shared payload allowance, with bounded structure and explicit omissions. */
export function toolOutputView(value: unknown, maxChars: number, retained = false): AgentToolResult<unknown> {
	let remaining = maxChars;
	let nodes = 0;
	let omitted = false;
	const viewNodes = Math.min(1024, Math.max(maxChars, 32));
	const ancestors = new Set<object>();
	const project = (item: unknown, depth: number): unknown => {
		if (++nodes > viewNodes || depth > MAX_DEPTH) {
			omitted = true;
			return undefined;
		}
		if (typeof item === "string") {
			const text = redact(item.slice(0, Math.min(item.length, remaining + 256))).slice(0, remaining);
			if (item.length > remaining) omitted = true;
			remaining -= text.length;
			return text;
		}
		if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)))
			return item;
		if (typeof item !== "object" || types.isProxy(item) || ancestors.has(item)) {
			if (item !== undefined) omitted = true;
			return undefined;
		}
		if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) {
			omitted = true;
			return undefined;
		}
		ancestors.add(item);
		try {
			if (Array.isArray(item)) {
				const array: unknown[] = [];
				for (let index = 0; index < item.length; index++) {
					if (nodes >= viewNodes) {
						omitted = true;
						break;
					}
					array.push(project(dataProperty(item, String(index)), depth + 1) ?? null);
				}
				return array;
			}
			const object: Record<string, unknown> = {};
			for (const key in item) {
				if (!Object.hasOwn(item, key)) continue;
				if (nodes >= viewNodes || key.length > remaining) {
					omitted = true;
					break;
				}
				remaining -= key.length;
				const projected = project(
					/^(?:password|api[_-]?key|authorization|access[_-]?token)$/i.test(key)
						? "[REDACTED]"
						: dataProperty(item, key),
					depth + 1,
				);
				if (projected !== undefined) Object.defineProperty(object, key, { value: projected, enumerable: true });
			}
			return object;
		} finally {
			ancestors.delete(item);
		}
	};
	const content: AgentToolResult<unknown>["content"] = [];
	const parts = dataProperty(value, "content");
	if (Array.isArray(parts) && !types.isProxy(parts)) {
		for (let index = 0; index < parts.length; index++) {
			if (content.length >= viewNodes) {
				omitted = true;
				break;
			}
			const part = dataProperty(parts, String(index));
			const text = dataProperty(part, "text");
			if (dataProperty(part, "type") === "text" && typeof text === "string") {
				const before = remaining;
				const projected = project(text, 0);
				content.push({
					type: "text",
					text:
						(typeof projected === "string" ? projected : "") +
						(text.length > before
							? retained
								? "\n[Model view truncated; complete bounded result retained in mission artifact]"
								: "\n[Model view truncated; final capture is not yet established]"
							: ""),
				});
			} else if (dataProperty(part, "type") === "image") {
				const data = dataProperty(part, "data");
				const mimeType = dataProperty(part, "mimeType");
				if (
					typeof data === "string" &&
					typeof mimeType === "string" &&
					data.length + mimeType.length <= remaining
				) {
					remaining -= data.length + mimeType.length;
					content.push({ type: "image", data, mimeType });
				} else omitted = true;
			} else omitted = true;
			if (remaining === 0 && index + 1 < parts.length) {
				omitted = true;
				break;
			}
		}
	} else omitted = true;
	const details = project(dataProperty(value, "details"), 0);
	const structuredContent = project(
		dataProperty(value, "structuredContent"),
		0,
	) as AgentToolResult<unknown>["structuredContent"];
	const usage = project(dataProperty(value, "usage"), 0) as AgentToolResult<unknown>["usage"];
	return {
		content: content.length
			? content
			: [{ type: "text", text: omitted ? "[Tool payload omitted from bounded model view]" : "" }],
		details: omitted
			? details !== null && typeof details === "object" && !Array.isArray(details)
				? { ...details, model_view_truncated: true }
				: { primitive_details: details ?? null, model_view_truncated: true }
			: details,
		...(structuredContent === undefined ? {} : { structuredContent }),
		...(usage === undefined ? {} : { usage }),
		...(dataProperty(value, "isError") === true ? { isError: true } : {}),
		...(dataProperty(value, "terminate") === true ? { terminate: true } : {}),
	};
}
