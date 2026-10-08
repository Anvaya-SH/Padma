import { redact } from "./code.ts";
import type { RecordOf, TerminalStatus } from "./records.ts";

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

const STATUS_TEXT: Record<TerminalStatus, string> = {
	VERIFIED_COMPLETE: "Completed and verified.",
	DELIVERED_UNVERIFIED: "Delivered; review is still required.",
	PARTIALLY_COMPLETE: "Some work remains unverified.",
	BLOCKED: "I need more information or permission to continue.",
	BUDGET_EXHAUSTED: "Stopped because the configured task limit was reached.",
	EXECUTION_FAILED: "The task could not be completed.",
	UNSAFE_OR_UNAUTHORIZED: "The requested action needs permission before it can run.",
	OUTCOME_UNKNOWN:
		"I could not confirm whether the command completed.\nCheck the command's output and target state before running it again.",
};

const OPERATION_STATUS_TEXT = new Map([
	["QUEUED", "Waiting to run."],
	["DISPATCHED", "Starting."],
	["RUNNING", "Running."],
	["COMPLETED", "Command completed."],
	["FAILED", "Command failed."],
	["CANCELLED", "Cancelled."],
	["CANCEL_REQUESTED", "Cancellation requested; completion is still being checked."],
	["UNCERTAIN", STATUS_TEXT.OUTCOME_UNKNOWN],
]);

export function userFacingOperationStatus(status: string): string | undefined {
	return OPERATION_STATUS_TEXT.get(status);
}

/** Controlled engine explanations; file and command output are never rewritten by this projection. */
export function userFacingReason(reason: string): string {
	if (
		reason ===
		"Behavioral coverage was assessed from cited source and executed named cases; broader behavior was not verified"
	)
		return "";
	return reason
		.replace(
			"Supply exact authorized action or current requirement-specific acceptance check",
			"Provide a specific command or a check for the remaining work.",
		)
		.replace(
			"Semantic or subjective acceptance requires explicit current proof/review; no success claim from prose",
			"The requested result still needs a relevant check or review.",
		)
		.replace("Cognitive tick settlement failed", "Saving task progress failed")
		.replace(
			"Configured stagnation limit reached: no evidence-backed new approach",
			"Recent steps did not resolve the remaining checks.",
		)
		.replace("Failure recording failed", "Saving error details failed")
		.replace(/\s*\[evidence [^\]\r\n]+\]/g, "")
		.replace(/\b(?:Operation|Unknown operation:) [0-9a-f-]{36}[^\r\n]*/gi, "")
		.trim();
}

export function userFacingStop(status: TerminalStatus, reason?: string): string {
	const detail = reason ? userFacingReason(reason) : "";
	return [STATUS_TEXT[status], detail].filter(Boolean).join("\n");
}

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
/** Detailed audit projection; ordinary delivery uses the separately admitted compact rendering. */
export function renderTerminalDetails(report: TerminalView, maxBytes: number): { text: string; omitted: boolean } {
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

/**
 * One ordinary delivery projection for admission, store validation, chat and replay.
 * Essential status/reconciliation text must fit before optional presentation.
 * Detailed verification stays accessible in the persisted report.
 */
export function renderTerminal(report: TerminalView, maxBytes: number): { text: string; omitted: boolean } {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid output byte allowance");
	const control: string[] = [STATUS_TEXT[report.status]];
	if (report.next_action && report.status !== "OUTCOME_UNKNOWN") control.push(userFacingReason(report.next_action));
	if (boundedText(control.join("\n"), maxBytes).omitted) return { text: "", omitted: true };
	const limitations: string[] = [];
	for (const limitation of report.limitations) {
		if (limitation && !limitation.includes("sandhana://") && !limitation.includes("[evidence ")) {
			const reason = userFacingReason(limitation);
			if (reason) limitations.push(reason);
		}
	}
	const presentation = report.presentation?.trim() ? [report.presentation] : [];
	// Redact before measuring, exactly like the persisted rendering.
	const full = [...presentation, ...control, ...limitations].join("\n");
	const marker = "[Output shortened; full details are saved in task history]";
	const rendered = boundedText(full, maxBytes);
	if (!rendered.omitted) return rendered;
	const prefixLimit = Math.max(0, maxBytes - Buffer.byteLength(marker) - 1);
	if (boundedText(control.join("\n"), prefixLimit).omitted) return { text: "", omitted: true };
	const prefix = boundedText([...control, ...limitations, ...presentation].join("\n"), prefixLimit);
	return { text: prefix.text ? `${prefix.text}\n${marker}` : "", omitted: true };
}

export function terminalText(report: RecordOf<"TerminalReport">): string {
	return renderTerminal(report, report.output_limit_bytes ?? Number.MAX_SAFE_INTEGER).text;
}

export function userTerminalText(report: RecordOf<"TerminalReport">): string {
	return terminalText(report);
}
