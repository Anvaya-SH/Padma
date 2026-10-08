import { describe, expect, it } from "vitest";
import { makeRecord } from "../src/core/sandhana/records.ts";
import { renderTerminal, renderTerminalDetails } from "../src/core/sandhana/reporting.ts";

function uncertainReport() {
	return makeRecord("private-mission", 1, "TerminalReport", {
		status: "OUTCOME_UNKNOWN",
		verification_report_ref: "private-verification",
		artifacts: [],
		verified: [],
		remaining: ["private-requirement"],
		checks_run: [],
		checks_skipped: [],
		limitations: [
			"Operation a1cba27c-d364-4086-82d0-348fc4c66e63 on C:\\workspace may have taken effect; reconcile, never blindly retry",
		],
		unknown_operation: "a1cba27c-d364-4086-82d0-348fc4c66e63",
		next_action: "Inspect authoritative operation/target state; do not repeat the effect",
		evidence: [],
	});
}

describe("plain-language task delivery", () => {
	it.each([
		"VERIFIED_COMPLETE",
		"DELIVERED_UNVERIFIED",
		"PARTIALLY_COMPLETE",
		"BLOCKED",
		"BUDGET_EXHAUSTED",
		"EXECUTION_FAILED",
		"UNSAFE_OR_UNAUTHORIZED",
		"OUTCOME_UNKNOWN",
	] as const)("renders %s in plain language while preserving its diagnostic status", (status) => {
		const report = { ...uncertainReport(), status, next_action: null, limitations: [] };
		const text = renderTerminal(report, 1024).text;
		expect(text).not.toContain(status);
		expect(text).not.toContain(report.unknown_operation!);
		expect(text.length).toBeGreaterThan(0);
		expect(renderTerminalDetails(report, 4096).text).toContain(status);
	});
	it("explains uncertainty without exposing operation identities and retains the diagnostic report", () => {
		const report = uncertainReport();
		const text = renderTerminal(report, 512).text;
		expect(text).toContain("could not confirm");
		expect(text).toContain("Check the command's output and target state before running it again");
		expect(text).not.toContain("OUTCOME_UNKNOWN");
		expect(text).not.toContain(report.unknown_operation);
		expect(text).not.toContain("reconcile");
		const audit = renderTerminalDetails(report, 4096).text;
		expect(audit).toContain("OUTCOME_UNKNOWN");
		expect(audit).toContain(report.unknown_operation);
		expect(report.unknown_operation).toBe("a1cba27c-d364-4086-82d0-348fc4c66e63");
	});
	it("prioritizes uncertainty and recovery over an oversized presentation", () => {
		const report = { ...uncertainReport(), presentation: "é🙂".repeat(1000) };
		const view = renderTerminal(report, 256);
		expect(view.omitted).toBe(true);
		expect(view.text).toContain("could not confirm");
		expect(view.text).toContain("before running it again");
		expect(view.text).not.toContain("�");
		expect(Buffer.byteLength(view.text)).toBeLessThanOrEqual(256);
	});
	it("retains the coverage scope in diagnostics without appending engine boilerplate to the answer", () => {
		const limitation =
			"Behavioral coverage was assessed from cited source and executed named cases; broader behavior was not verified";
		const report = {
			...uncertainReport(),
			status: "VERIFIED_COMPLETE" as const,
			presentation: "Fixed addition. Four tests passed.",
			next_action: null,
			limitations: [limitation],
		};
		expect(renderTerminal(report, 2048).text).toBe("Fixed addition. Four tests passed.\nCompleted and verified.");
		expect(renderTerminalDetails(report, 4096).text).toContain(limitation);
	});
});
