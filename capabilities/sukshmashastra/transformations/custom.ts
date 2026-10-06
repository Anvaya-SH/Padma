// Custom codemods run in the existing QuickJS/WASM worker with no injected tools.
// They can produce candidate text, never access Node, filesystem or process authority.

import { CodemodeSandbox } from "@anvaya.sh/padma-codemode";
import { checkSyntax } from "../engine/syntax-validator.ts";
import type { ByteRangeEdit } from "../model/diff.ts";
import { SukshmashastraError } from "../model/reason-codes.ts";

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_SCRIPT_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 30000;
const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;

export interface CustomCodemodResult {
	readonly newContent: string;
	readonly edits: ByteRangeEdit[];
}

/** Only JSON input/output crosses the tool-free worker; host constructors are never injected. */
export async function runCustomCodemod(
	source: string,
	codemodScript: string,
	timeoutMs = 5000,
	fileName = "source.ts",
): Promise<CustomCodemodResult> {
	if (
		typeof source !== "string" ||
		typeof codemodScript !== "string" ||
		typeof fileName !== "string" ||
		Buffer.byteLength(source) > MAX_SOURCE_BYTES ||
		Buffer.byteLength(codemodScript) > MAX_SCRIPT_BYTES ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs <= 0 ||
		timeoutMs > MAX_TIMEOUT_MS
	) {
		throw new SukshmashastraError("SCOPE_DENIED", "Custom codemod input or execution bound is invalid");
	}
	const initialCheck = checkSyntax(source, fileName);
	if (!initialCheck.valid) {
		throw new SukshmashastraError(
			"REJECTED_SYNTAX_ERROR",
			`Initial source contains syntax errors: ${initialCheck.diagnostics.map((d) => d.message).join(", ")}`,
		);
	}

	const sandbox = new CodemodeSandbox({
		tools: [],
		globals: [],
		timeoutMs,
		memoryLimitBytes: MEMORY_LIMIT_BYTES,
	});
	let newContent: string;
	try {
		const outcome = await sandbox.execute(
			`let source = load("source");
			let result = source;
			(function(code) { "use strict";\n${codemodScript}\n})(source);
			if (typeof result !== "string") throw new TypeError("Codemod result must be a string");
			return result;`,
			{ store: { source } },
		);
		if (!outcome.ok) throw new Error(`Custom codemod execution failed: ${outcome.error.message}`);
		if (typeof outcome.value !== "string" || Buffer.byteLength(outcome.value) > MAX_SOURCE_BYTES) {
			throw new SukshmashastraError("SCOPE_DENIED", "Custom codemod result exceeds the bounded text contract");
		}
		newContent = outcome.value;
	} finally {
		await sandbox.close();
	}

	const postCheck = checkSyntax(newContent, fileName);
	if (!postCheck.valid) {
		throw new SukshmashastraError(
			"REJECTED_SYNTAX_ERROR",
			`Custom codemod introduced syntax errors: ${postCheck.diagnostics.map((d) => d.message).join(", ")}`,
		);
	}
	return {
		newContent,
		edits: [{ start: 0, end: source.length, newText: newContent, description: "Tool-free QuickJS codemod" }],
	};
}
