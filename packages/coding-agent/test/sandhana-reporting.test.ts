import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { type Draft, makeRecord, resources } from "../src/core/sandhana/records.ts";
import { boundedText, renderTerminal, terminalText, userTerminalText } from "../src/core/sandhana/reporting.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createBashTool, createReadTool } from "../src/core/tools/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(outputBytes = 32 * 1024 * 1024, instruction = "read a.txt") {
	const cwd = mkdtempSync(join(tmpdir(), "padma-terminal-output-"));
	writeFileSync(join(cwd, "a.txt"), "complete read\n");
	const store = new MissionStore(":memory:");
	const kernel = new SandhanaKernel({
		cwd: () => cwd,
		session: () => "reporting",
		store,
		limits: { output_bytes: outputBytes },
	});
	kernel.register(createReadTool(cwd), "read");
	kernel.captureInput(instruction, "USER");
	kernel.begin("");
	cleanups.push(() => {
		store.close();
		rmSync(cwd, { recursive: true, force: true });
	});
	return { cwd, kernel, store };
}

describe("terminal output admission", () => {
	it("charges the persisted rendering exactly once without another invocation and replays the same bytes", async () => {
		const f = fixture();
		await f.kernel.execute("read", "read", { path: "a.txt" });
		const before = f.kernel.state!;
		const report = f.kernel.finalize();
		const text = terminalText(report);
		const after = f.kernel.state!;
		const usage = f.store.get(after.mission_id, report.output_reservation_ref!, "BudgetReservation");
		expect(report.status).toBe("VERIFIED_COMPLETE");
		expect(text).toContain("complete read\n");
		// The chat projection carries the outcome only; ledger detail stays persisted.
		const chat = userTerminalText(report);
		expect(chat).toContain("complete read\n");
		expect(chat).toContain("VERIFIED_COMPLETE");
		expect(chat).not.toContain("sandhana://");
		expect(chat).not.toContain("[evidence ");
		expect(chat).not.toContain('"dependencies":');
		expect(chat).not.toContain("Checks actually run:");
		expect(chat).not.toContain("Verified:");
		expect(text).not.toContain("sandhana://");
		expect(text).not.toContain("[evidence ");
		expect(text).not.toContain('"dependencies":');
		expect(usage).toMatchObject({
			state: "RECONCILED",
			protected_for_verification: true,
			owner_operation_id: `terminal:${after.contract}`,
			actual: { output_bytes: Buffer.byteLength(text), execution: 0 },
		});
		expect(after.used.output_bytes).toBe(before.used.output_bytes + Buffer.byteLength(text));
		expect(after.used.execution).toBe(before.used.execution);
		expect(f.kernel.finalize()).toEqual(report);
		expect(f.kernel.state).toEqual(after);
		expect(terminalText(f.store.get(after.mission_id, report.record_id, "TerminalReport"))).toBe(text);
	});
	it("stops an oversized final view within the remaining budget and preserves complete read bytes", async () => {
		const f = fixture();
		const content = `${"🙂é".repeat(2000)}\n`;
		writeFileSync(join(f.cwd, "a.txt"), content);
		await f.kernel.execute("read", "read", { path: "a.txt" });
		const before = f.kernel.state!.used.output_bytes;
		f.kernel.amend(`budget: ${JSON.stringify({ version: 1, ceilings: { output_bytes: before + 512 } })}`);
		const report = f.kernel.finalize();
		const text = terminalText(report);
		expect(report.status).toBe("BUDGET_EXHAUSTED");
		expect(report.output_omitted).toBe(true);
		expect(text).toContain("BUDGET_EXHAUSTED");
		expect(text).toContain("Report view truncated");
		expect(text).not.toContain("�");
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(512);
		expect(f.kernel.state!.used.output_bytes).toBe(before + Buffer.byteLength(text));
		expect(f.kernel.state!.used.output_bytes).toBeLessThanOrEqual(f.kernel.state!.ceilings.output_bytes);
		const proof = f.store.get(report.mission_id, report.verification_report_ref!, "VerificationReport");
		expect(proof.results[0].result).toBe("PASSED");
		expect(proof.presentation_omitted).toBe(true);
		expect(Buffer.byteLength(proof.presentation!)).toBeLessThanOrEqual(512);
		const result = JSON.parse(f.store.artifact(report.mission_id, report.artifacts[0]).toString()) as {
			content: { text: string }[];
		};
		expect(result.content[0].text).toBe(content);
	});
	it("records a zero-output stop without launching a tool or inventing an extra output pool", async () => {
		const f = fixture(0);
		await expect(f.kernel.execute("read", "no-capacity", { path: "a.txt" })).rejects.toThrow();
		const report = f.kernel.finalize("BUDGET_EXHAUSTED", "Output is disabled by the current user ceiling");
		expect(report.status).toBe("BUDGET_EXHAUSTED");
		expect(report.output_limit_bytes).toBe(0);
		expect(report.output_omitted).toBe(true);
		expect(terminalText(report)).toBe("");
		expect(f.kernel.state!.used.output_bytes).toBe(0);
		expect(f.kernel.state!.used.execution).toBe(0);
		expect(report.limitations.join("\n")).toContain("Output is disabled");
	});
	it("keeps an unknown effect and its no-repeat instruction ahead of optional output", async () => {
		const f = fixture(undefined, "run: node effect.cjs");
		f.kernel.register(
			{
				...createBashTool(f.cwd),
				execute: async () => {
					writeFileSync(join(f.cwd, "effect"), "happened");
					return {
						content: [{ type: "text", text: "unconfirmed process" }],
						details: {},
						structuredContent: { output_complete: false },
					};
				},
			},
			"bash",
		);
		await expect(f.kernel.execute("bash", "unknown", { command: "node effect.cjs" })).rejects.toThrow(
			"may have taken effect",
		);
		const used = f.kernel.state!.used.output_bytes;
		f.kernel.amend(`budget: ${JSON.stringify({ version: 1, ceilings: { output_bytes: used + 512 } })}`);
		const report = f.kernel.finalize();
		const text = terminalText(report);
		expect(report.status).toBe("OUTCOME_UNKNOWN");
		expect(text).toContain(`Unknown operation: ${report.unknown_operation}`);
		expect(text).toContain("do not repeat the effect");
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(512);
		expect(f.kernel.state!.used.execution).toBe(1);
		expect(readFileSync(join(f.cwd, "effect"), "utf8")).toBe("happened");
	});
	it.each(["charge", "owner", "allowance", "omitted success"])(
		"rejects a terminal transaction with forged %s",
		async (fault) => {
			const f = fixture();
			await f.kernel.execute("read", "read", { path: "a.txt" });
			if (fault === "omitted success")
				f.kernel.amend(
					`budget: ${JSON.stringify({ version: 1, ceilings: { output_bytes: f.kernel.state!.used.output_bytes + 512 } })}`,
				);
			const proof = f.kernel.assessCandidate();
			f.kernel.transition("FINALIZING", "pramana", { verification_report: proof.record_id });
			const before = f.kernel.state!;
			const available = before.ceilings.output_bytes - before.used.output_bytes;
			const fields: Draft<"TerminalReport"> = {
				status: "VERIFIED_COMPLETE",
				contract_ref: before.contract,
				verification_report_ref: proof.record_id,
				artifacts: proof.candidate_refs,
				verified: proof.results.map((result) => result.requirement_id),
				remaining: [],
				checks_run: [],
				checks_skipped: [],
				limitations: [],
				unknown_operation: null,
				next_action: null,
				evidence: [before.last_event!],
				presentation: fault === "omitted success" ? "x".repeat(2000) : "complete read\n",
				output_limit_bytes: available + (fault === "allowance" ? 1 : 0),
			};
			const view = renderTerminal({ ...fields, mission_id: before.mission_id }, fields.output_limit_bytes!);
			const amounts = { ...resources(), output_bytes: Buffer.byteLength(view.text) };
			const usage = makeRecord(before.mission_id, before.revision + 1, "BudgetReservation", {
				owner_operation_id: fault === "owner" ? "unrelated" : `terminal:${before.contract}`,
				amounts,
				actual: amounts,
				state: "RECONCILED",
				protected_for_verification: true,
			});
			const report = makeRecord(before.mission_id, before.revision + 1, "TerminalReport", {
				...fields,
				output_reservation_ref: usage.record_id,
				output_omitted: view.omitted,
			});
			expect(() =>
				f.store.commit(
					before.revision,
					{
						...before,
						revision: before.revision + 1,
						phase: report.status,
						terminal: report.record_id,
						reservations: [...before.reservations, usage.record_id],
						used: {
							...before.used,
							output_bytes: before.used.output_bytes + amounts.output_bytes + (fault === "charge" ? 1 : 0),
						},
					},
					[usage, report],
				),
			).toThrow(/Terminal output|terminal report/);
			expect(f.kernel.state).toEqual(before);
		},
	);
});

describe("bounded UTF-8 rendering", () => {
	it("shows check commands and redacts every delivered field without exposing proof records", () => {
		const report = makeRecord("projection-fixture", 1, "TerminalReport", {
			status: "BLOCKED",
			verification_report_ref: "private-report",
			artifacts: ["private-artifact"],
			verified: [],
			remaining: ["requirement"],
			checks_run: [
				'{"dependencies":{"private-source":"digest"},"exact_command":"npm run check","result":"PASSED","rule":"PROCESS","target":"workspace"} [evidence private-proof]',
			],
			checks_skipped: ["Regression check unavailable"],
			limitations: ["api_key=private-limitation"],
			presentation: "api_key=private-presentation",
			next_action: "api_key=private-action",
			unknown_operation: null,
			evidence: ["private-proof"],
			output_limit_bytes: 4096,
		});
		const text = userTerminalText(report);
		// Chat shows the redacted outcome; per-check audit detail stays persisted.
		expect(text).toContain("BLOCKED");
		expect(text).not.toContain("Checks actually run:");
		expect(text).not.toContain("Verified:");
		expect(terminalText(report)).toContain("npm run check: PASSED (workspace)");
		expect(terminalText(report)).toContain("Regression check unavailable");
		for (const secret of [
			"private-limitation",
			"private-presentation",
			"private-action",
			"private-source",
			"private-proof",
			"private-artifact",
			"private-report",
		])
			expect(text).not.toContain(secret);
		expect(text).not.toContain("sandhana://");
	});
	it("never splits a character and redacts before choosing the displayed prefix", () => {
		for (const limit of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 20, 100]) {
			const view = boundedText(`🙂é api_key=private-value ${"x".repeat(100000)}`, limit);
			expect(Buffer.byteLength(view.text)).toBeLessThanOrEqual(limit);
			expect(view.text).not.toContain("�");
			expect(view.text).not.toContain("private-value");
			expect(view.omitted).toBe(true);
		}
	});
});
