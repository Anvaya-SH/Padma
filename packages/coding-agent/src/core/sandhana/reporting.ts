import { redact } from "./code.ts";
import type { RecordOf } from "./records.ts";

/** Crop before redaction/allocation, then stop at a complete UTF-8 character. */
export function boundedText(text: string, maxBytes: number): { text: string; omitted: boolean } {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid output byte allowance");
	const prefix = text.slice(0, Math.min(text.length, maxBytes + 256));
	const bytes = Buffer.from(redact(prefix));
	let end = Math.min(bytes.length, maxBytes);
	while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
	return { text: bytes.toString("utf8", 0, end), omitted: prefix.length < text.length || end < bytes.length };
}

type TerminalView = Omit<RecordOf<"TerminalReport">, "record_id" | "record_type" | "revision" | "schema_version">;

/** Verification records remain private; show only the checked operation, target and verdict. */
function checkText(check: string): string {
	const text = check.replace(/\s*\[evidence [^\]\r\n]+\]$/, "");
	try {
		const value: unknown = JSON.parse(text);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			const fields = value as Record<string, unknown>;
			const label = typeof fields.exact_command === "string" ? fields.exact_command : fields.rule;
			const result = fields.result;
			if (typeof label === "string" && ["PASSED", "FAILED", "INCONCLUSIVE"].includes(String(result))) {
				return `${label}: ${result}${typeof fields.target === "string" ? ` (${fields.target})` : ""}`;
			}
		}
	} catch {
		// A human-readable skipped-check reason is already a useful explanation.
		if (!text.trimStart().startsWith("{")) return text;
	}
	return "Check details retained in the execution history";
}
export function renderTerminal(report: TerminalView, maxBytes: number): { text: string; omitted: boolean } {
	const marker = "[Report view truncated; inspect persisted report]";
	const render = (allowance: number): { text: string; omitted: boolean } => {
		const parts: string[] = [];
		let used = 0;
		let omitted = false;
		const append = (text: string) => {
			if (!text || omitted) return;
			const separator = parts.length ? 1 : 0;
			if (used + separator > allowance) {
				omitted = true;
				return;
			}
			const part = boundedText(text, allowance - used - separator);
			parts.push(part.text);
			used += separator + Buffer.byteLength(part.text);
			omitted = part.omitted;
		};
		append(report.status);
		if (report.unknown_operation) append(`Unknown operation: ${report.unknown_operation}`);
		if (report.next_action) append(report.next_action);
		// Suppress text if the allowance cannot carry the essential stop identity and recovery action.
		if (omitted) return { text: "", omitted: true };
		for (const limitation of report.limitations) {
			append(limitation);
			if (omitted) break;
		}
		append(`Verified: ${report.verified.length}; remaining: ${report.remaining.length}.`);
		if (report.artifacts.length) append(`Retained results: ${report.artifacts.length}.`);
		if (report.presentation !== undefined) {
			append("Result (sensitive fields redacted where required):");
			append(report.presentation);
		}
		append(report.checks_run.length ? "Checks actually run:" : "No requirement check established completion.");
		for (const check of report.checks_run) {
			if (omitted) break;
			append(checkText(check));
		}
		if (report.checks_skipped.length) append("Checks skipped/inconclusive:");
		for (const check of report.checks_skipped) {
			if (omitted) break;
			append(checkText(check));
		}
		return { text: parts.join("\n"), omitted };
	};
	const full = render(maxBytes);
	if (!full.omitted || !full.text) return full;
	const prefix = render(Math.max(0, maxBytes - Buffer.byteLength(marker) - 1));
	return { text: prefix.text ? `${prefix.text}\n${marker}` : "", omitted: true };
}

export function terminalText(report: RecordOf<"TerminalReport">): string {
	return renderTerminal(report, report.output_limit_bytes ?? Number.MAX_SAFE_INTEGER).text;
}

/**
 * Chat delivery projection: behavior or exact blocker first, then the terminal
 * status word. Ledger internals (verified/remaining counts, per-check detail,
 * artifact/evidence references) stay in the persisted report only; the chat
 * message must read as an outcome, not a database dump.
 * Respects the persisted output budget: when no bytes remain, returns "".
 */
export function userTerminalText(report: RecordOf<"TerminalReport">): string {
	const allowance = report.output_limit_bytes ?? Number.MAX_SAFE_INTEGER;
	if (!Number.isSafeInteger(allowance) || allowance <= 0) return "";
	const lines: string[] = [];
	if (report.presentation?.trim()) {
		lines.push(report.presentation.trim());
	}
	for (const limitation of report.limitations) {
		if (limitation && !limitation.includes("sandhana://") && !limitation.includes("[evidence ")) {
			lines.push(limitation);
		}
	}
	if (report.unknown_operation) {
		lines.push(`Unknown operation: ${report.unknown_operation}`);
	}
	if (report.next_action) lines.push(report.next_action);
	lines.push(report.status);
	// Redact before measuring, exactly like the persisted rendering.
	const full = lines.join("\n");
	const marker = "[Report view truncated; inspect persisted report]";
	const rendered = boundedText(full, allowance);
	if (!rendered.omitted) return rendered.text;
	const prefix = boundedText(full, Math.max(0, allowance - Buffer.byteLength(marker) - 1));
	return prefix.text ? `${prefix.text}\n${marker}` : "";
}
