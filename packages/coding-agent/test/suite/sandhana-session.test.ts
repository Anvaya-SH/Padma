import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@anvaya.sh/padma-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoverageProposal } from "../../src/core/sandhana/acceptance.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	while (harnesses.length) harnesses.pop()!.cleanup();
});
async function fixture() {
	const harness = await createHarness();
	harnesses.push(harness);
	return harness;
}
describe("real Pi session seam mounted on Sandhana", () => {
	it("ordinary resume inspects a lost replacement and runs its real mandatory check without another provider decision", async () => {
		const h = await fixture();
		writeFileSync(join(h.tempDir, "a.txt"), "old");
		writeFileSync(
			join(h.tempDir, "check.cjs"),
			"require('node:assert/strict').equal(require('node:fs').readFileSync('a.txt','utf8'), 'new');",
		);
		const kernel = h.session.sandhana;
		const commit = kernel.store.commit.bind(kernel.store);
		let lost = false;
		const fault = vi.spyOn(kernel.store, "commit").mockImplementation((expected, state, records, artifacts) => {
			if (
				!lost &&
				records.some(
					(record) =>
						record.record_type === "BudgetReservation" &&
						record.state === "RESERVED" &&
						record.amounts.retrieval_bytes > 0,
				) &&
				readFileSync(join(h.tempDir, "a.txt"), "utf8") === "new"
			) {
				lost = true;
				throw new Error("Lost post-replacement observation");
			}
			return commit(expected, state, records, artifacts);
		});
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "new" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("This decision must remain unused"),
		]);
		await h.session.prompt(
			`padma: ${JSON.stringify({
				objective: "repair bytes with current regression proof",
				allow_edits: true,
				shell_commands: ["node check.cjs"],
				quality_checks: ["node check.cjs"],
				requirements: [
					{ text: "bytes", rule: "CONTENT", target: "a.txt", expected: "new" },
					{ text: "mandatory regression", rule: "PROCESS", target: ".", expected: "node check.cjs" },
				],
			})}`,
		);
		fault.mockRestore();
		const old = kernel.terminal!;
		expect(old.status).toBe("OUTCOME_UNKNOWN");
		expect(lost).toBe(true);
		await h.session.prompt(`resume ${old.mission_id}`);
		expect(kernel.terminal?.status).toBe("VERIFIED_COMPLETE");
		expect(kernel.state!.mission_id).toBe(old.mission_id);
		expect(kernel.state!.used.execution).toBe(3);
		expect(kernel.state!.used.ticks).toBe(1);
		expect(h.getPendingResponseCount()).toBe(1);
		expect(h.eventsOfType("tool_execution_end")).toHaveLength(3);
		expect(
			h.session.messages.filter((message) => message.role === "toolResult").map((message) => message.toolName),
		).toEqual(["write", "read", "bash"]);
		expect(kernel.store.get(old.mission_id, old.record_id, "TerminalReport")).toEqual(old);
		expect(kernel.store.list(h.sessionManager.getSessionId())).toHaveLength(1);
		expect(readFileSync(join(h.tempDir, "a.txt"), "utf8")).toBe("new");
	});
	it("current user steering records a budget event without adding an obligation or granting edits", async () => {
		const h = await fixture();
		writeFileSync(join(h.tempDir, "a.txt"), "actual data");
		h.setResponses([
			async () => {
				await h.session.prompt('budget: {"version":1,"ceilings":{"execution":50}}', { streamingBehavior: "steer" });
				return fauxAssistantMessage([fauxToolCall("read", { path: "a.txt" })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("Submit current evidence"),
		]);
		await h.session.prompt("Inspect the parser behavior");
		const kernel = h.session.sandhana;
		expect(kernel.terminal?.status).toBe("PARTIALLY_COMPLETE");
		expect(kernel.state!.requirements).toHaveLength(1);
		expect(kernel.state!.ceilings.execution).toBe(50);
		expect(kernel.state!.used.execution).toBe(1);
		expect(kernel.state!.used.ticks).toBe(2);
		expect(
			kernel.store.records(kernel.state!.mission_id).filter((record) => record.record_type === "BudgetChange"),
		).toHaveLength(1);
		expect(
			kernel.state!.authorizations.flatMap(
				(ref) => kernel.store.get(kernel.state!.mission_id, ref, "Authorization").classes,
			),
		).not.toContain("EDIT");
		expect(h.getPendingResponseCount()).toBe(0);
	});
	it("trusted session configuration bounds the real provider request without granting edit authority", async () => {
		const h = await createHarness({
			sandhanaConfiguration: { version: "sandhana/1", model: { response_tokens: 17 } },
		});
		harnesses.push(h);
		h.setResponses([
			(_context, options) => {
				expect(options?.maxTokens).toBe(17);
				return fauxAssistantMessage("No sufficient evidence yet");
			},
		]);
		await h.session.prompt("Inspect the parser behavior");
		const kernel = h.session.sandhana;
		expect(kernel.terminal?.status).toBe("PARTIALLY_COMPLETE");
		expect(kernel.state!.used.ticks).toBe(1);
		expect(kernel.configuration.model.response_tokens).toBe(17);
		expect(
			kernel.state!.authorizations.flatMap(
				(ref) => kernel.store.get(kernel.state!.mission_id, ref, "Authorization").classes,
			),
		).not.toContain("EDIT");
		expect(h.getPendingResponseCount()).toBe(0);
	});
	it("zero model allowance stops before inference while exact commands still work", async () => {
		const h = await createHarness({
			sandhanaConfiguration: { version: "sandhana/1", model: { response_tokens: 0 } },
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("This response must remain unused")]);
		await h.session.prompt("Inspect the parser behavior");
		expect(h.session.sandhana.terminal?.status).toBe("BUDGET_EXHAUSTED");
		expect(h.session.sandhana.state!.used.ticks).toBe(0);
		expect(h.getPendingResponseCount()).toBe(1);
		writeFileSync(join(h.tempDir, "a.txt"), "actual bytes");
		await h.session.prompt("read a.txt");
		expect(h.session.sandhana.terminal?.status).toBe("VERIFIED_COMPLETE");
		expect(h.getPendingResponseCount()).toBe(1);
	});
	it("zero output capacity persists a budget stop through the ordinary session without inference or tool dispatch", async () => {
		const h = await createHarness({
			sandhanaConfiguration: { version: "sandhana/1", resources: { output_bytes: 0 } },
		});
		harnesses.push(h);
		writeFileSync(join(h.tempDir, "a.txt"), "actual bytes");
		h.setResponses([fauxAssistantMessage("This response must remain unused")]);
		await h.session.prompt("read a.txt");
		const kernel = h.session.sandhana;
		const report = kernel.terminal!;
		expect(report).toMatchObject({ status: "BUDGET_EXHAUSTED", output_limit_bytes: 0, output_omitted: true });
		expect(kernel.state!.used.output_bytes).toBe(0);
		expect(kernel.state!.used.execution).toBe(0);
		expect(kernel.state!.used.ticks).toBe(0);
		expect(h.getPendingResponseCount()).toBe(1);
		expect(kernel.state!.operations).toEqual([]);
		expect(h.eventsOfType("tool_execution_end")).toMatchObject([
			{ toolName: "read", isError: true, result: { details: { sandhana_stop: "BUDGET_EXHAUSTED" } } },
		]);
		expect(h.eventsOfType("agent_end")).toHaveLength(1);
		expect(h.session.getLastAssistantText()).toBeUndefined();
		expect(h.session.messages.findLast((message) => message.role === "assistant")).toMatchObject({ content: [] });
		expect(kernel.store.get(report.mission_id, report.record_id, "TerminalReport")).toEqual(report);
	});
	it("resume budget input reaches the same mission through the ordinary prompt API", async () => {
		const h = await createHarness({
			sandhanaConfiguration: { version: "sandhana/1", routes: { SAKSHAT: { execution: 1 } } },
		});
		harnesses.push(h);
		await h.session.prompt("read missing.txt");
		const kernel = h.session.sandhana;
		const old = kernel.terminal!;
		writeFileSync(join(h.tempDir, "missing.txt"), "now available");
		await h.session.prompt(`resume ${old.mission_id} budget: {"version":1,"ceilings":{"execution":2}}`);
		expect(kernel.terminal?.status).toBe("VERIFIED_COMPLETE");
		expect(kernel.state!.used.execution).toBe(2);
		expect(kernel.state!.ceilings.execution).toBe(2);
		expect(kernel.store.get(old.mission_id, old.record_id, "TerminalReport")).toEqual(old);
		expect(
			kernel.store.records(old.mission_id).filter((record) => record.record_type === "BudgetChange"),
		).toHaveLength(1);
		expect(kernel.store.list(h.sessionManager.getSessionId())).toHaveLength(1);
		expect(h.getPendingResponseCount()).toBe(0);
	});
	for (const preservation of [true, false])
		it(`natural parser repair retains both obligations when preservation coverage is ${preservation ? "present" : "missing"}`, async () => {
			const h = await fixture();
			const before = "module.exports = (value) => value;";
			const after = "module.exports = (value) => { if (value === '') throw new Error('empty'); return value; };";
			const emptyCase = "test('rejects empty', () => assert.throws(() => parse(''), /empty/));";
			const validCase = "test('preserves valid', () => assert.equal(parse('valid'), 'valid'));";
			writeFileSync(join(h.tempDir, "parser.cjs"), before);
			writeFileSync(
				join(h.tempDir, "parser.test.cjs"),
				`const test = require('node:test'); const assert = require('node:assert/strict'); const parse = require('./parser.cjs');\n${emptyCase}${preservation ? `\n${validCase}` : ""}`,
			);
			const command = "node --test parser.test.cjs";
			h.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("read", { path: "parser.cjs" }), fauxToolCall("read", { path: "parser.test.cjs" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
				fauxAssistantMessage(
					[fauxToolCall("edit", { path: "parser.cjs", edits: [{ oldText: before, newText: after }] })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([fauxToolCall("read", { path: "parser.cjs" }), fauxToolCall("bash", { command })], {
					stopReason: "toolUse",
				}),
				(context) => {
					const position = context.messages.findLast(
						(message) =>
							message.role === "system" &&
							typeof message.content === "string" &&
							message.content.startsWith('{"controller":"sandhana"'),
					);
					if (!position || typeof position.content !== "string") throw new Error("Missing native kernel position");
					const data = JSON.parse(position.content) as {
						remaining: { id: string }[];
						evidence_index: { id: string; operation_class: string; target: string }[];
					};
					const implementation = data.evidence_index.findLast(
						(entry) => entry.operation_class === "READ" && entry.target === join(h.tempDir, "parser.cjs"),
					)!;
					const tests = data.evidence_index.findLast(
						(entry) => entry.operation_class === "READ" && entry.target === join(h.tempDir, "parser.test.cjs"),
					)!;
					const proposals: CoverageProposal[] = data.remaining.map((requirement, index) => ({
						requirement_id: requirement.id,
						command,
						case_names: [index === 0 ? "rejects empty" : "preserves valid"],
						applicability: "SUPPORTED",
						explanation:
							index === 0
								? "The named assertion calls the changed parser with empty input and verifies rejection."
								: "The preservation assertion calls the current parser with a valid value and checks that it is returned unchanged.",
						citations: [
							{ observation_id: implementation.id, role: "IMPLEMENTATION", quote: after },
							{
								observation_id: tests.id,
								role: "TEST_ASSERTION",
								case_name: index === 0 ? "rejects empty" : "preserves valid",
								quote: index === 0 ? emptyCase : validCase,
							},
						],
					}));
					return fauxAssistantMessage(`<pramana>${JSON.stringify({ results: proposals })}</pramana>`);
				},
			]);
			await h.session.prompt("Fix the parser accepting an invalid empty value; preserve valid existing values");
			const kernel = h.session.sandhana;
			expect(kernel.terminal?.status).toBe(preservation ? "VERIFIED_COMPLETE" : "PARTIALLY_COMPLETE");
			expect(kernel.terminal?.verified).toHaveLength(preservation ? 2 : 1);
			expect(kernel.state!.requirements).toHaveLength(2);
			expect(kernel.state!.used.execution).toBe(6);
			expect(kernel.state!.used.ticks).toBe(5);
			expect(h.getPendingResponseCount()).toBe(0);
			expect(h.eventsOfType("tool_execution_end")).toHaveLength(6);
			expect(kernel.store.list(h.sessionManager.getSessionId())).toHaveLength(1);
		});
	it("exact read enters via existing prompt API and persists one backend terminal without provider calls", async () => {
		const h = await fixture();
		writeFileSync(join(h.tempDir, "a.txt"), "hello\n");
		await h.session.prompt("read a.txt");
		expect(h.session.sandhana.terminal?.status).toBe("VERIFIED_COMPLETE");
		expect(h.getPendingResponseCount()).toBe(0);
		expect(h.session.sandhana.state!.used.ticks).toBe(0);
		expect(h.eventsOfType("tool_execution_end")).toHaveLength(1);
		expect(h.eventsOfType("agent_end")).toHaveLength(1);
		expect(
			h.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "toolResult"),
		).toHaveLength(1);
		expect(h.session.getLastAssistantText()).toContain("VERIFIED_COMPLETE");
		expect(h.session.getLastAssistantText()).toContain("hello\n");
	});
	it("an explicit client resume keeps the mission ledger and old report through the ordinary prompt API", async () => {
		const h = await fixture();
		await h.session.prompt("read missing.txt");
		const kernel = h.session.sandhana;
		const old = kernel.terminal!;
		expect(old.status).toBe("EXECUTION_FAILED");
		writeFileSync(join(h.tempDir, "missing.txt"), "now available");
		await h.session.prompt(`resume ${old.mission_id}`);
		expect(kernel.terminal?.status).toBe("VERIFIED_COMPLETE");
		expect(kernel.state!.mission_id).toBe(old.mission_id);
		expect(kernel.state!.used.execution).toBe(2);
		expect(kernel.state!.used.ticks).toBe(0);
		expect(kernel.store.get(old.mission_id, old.record_id, "TerminalReport")).toEqual(old);
		expect(kernel.store.list(h.sessionManager.getSessionId())).toHaveLength(1);
		expect(h.eventsOfType("tool_execution_end")).toHaveLength(2);
		await h.session.prompt("resume does-not-exist");
		expect(h.session.getLastAssistantText()).toContain("BLOCKED");
		expect(h.session.getLastAssistantText()).not.toContain("VERIFIED_COMPLETE");
		expect(kernel.state!.used.execution).toBe(2);
	});
	it("native provider tool selection and streaming drive a guarded edit and targeted real test", async () => {
		const h = await fixture();
		writeFileSync(join(h.tempDir, "a.txt"), "old");
		writeFileSync(
			join(h.tempDir, "check.cjs"),
			"const assert = require('node:assert/strict'); const fs = require('node:fs'); assert.equal(fs.readFileSync('a.txt', 'utf8'), 'new'); console.log('targeted check passed');",
		);
		const command = "node check.cjs";
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "a.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("edit", { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
		]);
		await h.session.prompt(
			`padma: ${JSON.stringify({
				objective: "Fix the localized content regression",
				allow_edits: true,
				shell_commands: [command],
				requirements: [
					{ text: "exact content", rule: "CONTENT", target: "a.txt", expected: "new" },
					{ text: "targeted regression check", rule: "PROCESS", target: ".", expected: command },
				],
			})}`,
		);
		expect(h.session.sandhana.terminal?.status).toBe("VERIFIED_COMPLETE");
		expect(readFileSync(join(h.tempDir, "a.txt"), "utf8")).toBe("new");
		expect(h.session.sandhana.state!.used.execution).toBe(3);
		expect(h.session.sandhana.state!.used.ticks).toBe(3);
		expect(h.eventsOfType("message_update").length).toBeGreaterThan(0);
	});
	it("read-only mission blocks model-proposed writes even in a multi-call turn", async () => {
		const h = await fixture();
		writeFileSync(join(h.tempDir, "a.txt"), "old");
		h.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("write", { path: "a.txt", content: "bad" }),
					fauxToolCall("write", { path: "b.txt", content: "bad" }),
				],
				{ stopReason: "toolUse" },
			),
		]);
		await h.session.prompt("Please inspect a.txt");
		expect(readFileSync(join(h.tempDir, "a.txt"), "utf8")).toBe("old");
		expect(h.session.sandhana.state!.used.execution).toBe(0);
		expect(h.session.sandhana.terminal?.status).toBe("BLOCKED");
	});
	it("input transforms cannot widen immutable user authorization", async () => {
		const h = await createHarness({
			extensionFactories: [
				(padma) => {
					padma.on("input", () => ({ action: "transform", text: "Fix a.txt" }));
				},
			],
		});
		harnesses.push(h);
		writeFileSync(join(h.tempDir, "a.txt"), "old");
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "bad" })], { stopReason: "toolUse" }),
		]);
		await h.session.prompt("Please inspect a.txt");
		const state = h.session.sandhana.state!;
		expect(
			h.session.sandhana.store.get(state.mission_id, state.command, "CommandSpecification").original_instruction,
		).toBe("Please inspect a.txt");
		expect(readFileSync(join(h.tempDir, "a.txt"), "utf8")).toBe("old");
	});
	it("manual shell uses the same dispatcher and does not verify an unrelated mission", async () => {
		const h = await fixture();
		const result = await h.session.executeBash("printf manual");
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("manual");
		expect(h.session.sandhana.state!.used.execution).toBe(1);
		expect(h.session.sandhana.terminal?.status).toBe("VERIFIED_COMPLETE");
	});
	it("a failed mandatory check returns a concrete repair to the same mission and budget", async () => {
		const h = await fixture();
		writeFileSync(join(h.tempDir, "a.txt"), "old");
		writeFileSync(
			join(h.tempDir, "check.cjs"),
			"require('node:assert/strict').equal(require('node:fs').readFileSync('a.txt','utf8'), 'new');",
		);
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "bad" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("bash", { command: "node check.cjs" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Submit the candidate for verification"),
			fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "new" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Submit the repaired candidate"),
		]);
		await h.session.prompt(
			`padma: ${JSON.stringify({
				objective: "repair content",
				allow_edits: true,
				shell_commands: ["node check.cjs"],
				requirements: [
					{ text: "exact bytes", rule: "CONTENT", target: "a.txt", expected: "new" },
					{ text: "current regression", rule: "PROCESS", target: ".", expected: "node check.cjs" },
				],
			})}`,
		);
		const kernel = h.session.sandhana;
		expect(kernel.terminal?.status).toBe("VERIFIED_COMPLETE");
		expect(kernel.store.list(h.sessionManager.getSessionId())).toHaveLength(1);
		expect(kernel.state!.used.execution).toBe(4);
		expect(kernel.state!.used.ticks).toBe(5);
		expect(h.eventsOfType("tool_execution_end")).toHaveLength(4);
		expect(h.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(4);
		expect(
			kernel.store
				.records(kernel.state!.mission_id)
				.some(
					(record) =>
						record.record_type === "EvidenceRecord" &&
						record.stage === "yukti" &&
						record.payload !== null &&
						typeof record.payload === "object" &&
						"preserve_best" in record.payload &&
						record.payload.preserve_best === true,
				),
		).toBe(true);
	});
	it("quality failure refines under the original ledger and rechecks the affected source", async () => {
		const h = await fixture();
		writeFileSync(join(h.tempDir, "flag.txt"), "bad");
		writeFileSync(
			join(h.tempDir, "quality.cjs"),
			"require('node:assert/strict').equal(require('node:fs').readFileSync('flag.txt','utf8'), 'good');",
		);
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "new" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("write", { path: "flag.txt", content: "good" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Submit the refined candidate"),
		]);
		await h.session.prompt(
			`padma: ${JSON.stringify({
				objective: "content with applicable quality",
				allow_edits: true,
				quality_checks: ["node quality.cjs"],
				requirements: [
					{ text: "exact bytes", rule: "CONTENT", target: "a.txt", expected: "new", dependencies: ["flag.txt"] },
				],
			})}`,
		);
		const kernel = h.session.sandhana;
		expect(kernel.terminal?.status).toBe("VERIFIED_COMPLETE");
		expect(kernel.state!.used.execution).toBe(5);
		expect(kernel.state!.used.refinement).toBe(1);
		expect(h.eventsOfType("tool_execution_end")).toHaveLength(5);
		expect(h.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(5);
		const reports = kernel.store
			.records(kernel.state!.mission_id)
			.filter((record) => record.record_type === "VerificationReport");
		expect(reports.map((report) => [report.completion_status, report.quality])).toEqual([
			["PASSED", "FAILED"],
			["PASSED", "PASSED"],
			["PASSED", "PASSED"],
		]);
	});
});
