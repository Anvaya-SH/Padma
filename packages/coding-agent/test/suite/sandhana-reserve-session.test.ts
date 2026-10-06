import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@anvaya.sh/padma-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { CoverageProposal } from "../../src/core/sandhana/acceptance.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()!.cleanup();
});

describe("protected verification capacity through the actual session controller", () => {
	it.each(["valid", "fabricated", "stale", "unrelated command"] as const)(
		"plans the first behavioral check from current sources at the reserve boundary: %s",
		async (scenario) => {
			const h = await createHarness({
				sandhanaConfiguration: {
					version: "sandhana/1",
					routes: { MADHYAMA: { execution: 9, ticks: 12, verification_reserve: 6 } },
				},
			});
			harnesses.push(h);
			const fixed = "module.exports = (value) => { if (value === '') throw new Error('empty'); return value; };";
			const cases = [
				"test('rejects empty', () => assert.throws(() => parse(''), /empty/));",
				"test('preserves valid', () => assert.equal(parse('valid'), 'valid'));",
				"test('preserves whitespace', () => assert.equal(parse(' valid '), ' valid '));",
			];
			const names = ["rejects empty", "preserves valid", "preserves whitespace"];
			const command = "node --test parser.test.cjs";
			writeFileSync(join(h.tempDir, "parser.cjs"), "module.exports = (value) => value;");
			writeFileSync(
				join(h.tempDir, "parser.test.cjs"),
				`const test = require('node:test'); const assert = require('node:assert/strict'); const parse = require('./parser.cjs');\n${cases.join("\n")}`,
			);
			const proposals = (): CoverageProposal[] => {
				const kernel = h.session.sandhana;
				const state = kernel.state!;
				const observations = new Map(
					state.operations.map((ref) => {
						const operation = kernel.store.get(state.mission_id, ref, "OperationRecord");
						const action = kernel.store.get(state.mission_id, operation.prepared_ref, "PreparedAction");
						return [(action.arguments as { path?: string }).path, operation.result_refs[0]];
					}),
				);
				return state.requirements.map((ref, index) => ({
					requirement_id: kernel.store.get(state.mission_id, ref, "Requirement").requirement_id,
					command: scenario === "unrelated command" ? "node unrelated.cjs" : command,
					case_names: [names[index]],
					applicability: "SUPPORTED",
					explanation:
						"The named assertion invokes the changed parser and checks this original behavioral obligation.",
					citations: [
						{
							observation_id: observations.get("parser.cjs")!,
							role: "IMPLEMENTATION",
							quote: scenario === "fabricated" ? "module.exports = () => 'fabricated source';" : fixed,
						},
						{
							observation_id: observations.get("parser.test.cjs")!,
							role: "TEST_ASSERTION",
							case_name: names[index],
							quote: cases[index],
						},
					],
				}));
			};
			h.setResponses([
				fauxAssistantMessage(
					[
						{
							type: "text",
							text: `<yukti>${JSON.stringify({ target: "parser.cjs", cause: "INPUT_FORMAT", mechanism: "VALIDATE", failure_signature: "empty input is accepted", expected_result: fixed })}</yukti>`,
						},
						fauxToolCall("read", { path: "parser.test.cjs" }),
						fauxToolCall("write", { path: "parser.cjs", content: fixed }),
						fauxToolCall("read", { path: "parser.cjs" }),
					],
					{ stopReason: "toolUse" },
				),
				(context) => {
					expect(getCurrentTools(context.messages)).toEqual([]);
					expect(h.session.sandhana.state!.used.execution).toBe(3);
					expect(h.session.sandhana.state!.hypotheses).toHaveLength(1);
					expect(
						h.session.sandhana.store
							.records(h.session.sandhana.state!.mission_id)
							.find((record) => record.record_type === "Hypothesis"),
					).toMatchObject({ status: "ACTIVE", cause: "INPUT_FORMAT", mechanism: "VALIDATE" });
					expect(
						h.session.sandhana.state!.requirements.every(
							(ref) =>
								h.session.sandhana.store.get(h.session.sandhana.state!.mission_id, ref, "Requirement")
									.status === "UNMET",
						),
					).toBe(true);
					if (scenario === "stale")
						writeFileSync(join(h.tempDir, "parser.cjs"), "module.exports = () => 'human edit';");
					return fauxAssistantMessage(`<pramana_plan>${JSON.stringify({ results: proposals() })}</pramana_plan>`);
				},
				(context) => {
					expect(getCurrentTools(context.messages)).toEqual([]);
					expect(h.session.sandhana.state!.used.execution).toBe(4);
					return fauxAssistantMessage(`<pramana>${JSON.stringify({ results: proposals() })}</pramana>`);
				},
				fauxAssistantMessage("must remain unused"),
			]);
			await h.session.prompt(
				"Fix the parser accepting an invalid empty value; preserve valid existing values; preserve whitespace around valid values",
			);
			const kernel = h.session.sandhana;
			expect(kernel.state!.route).toBe("MADHYAMA");
			expect(kernel.state!.requirements).toHaveLength(3);
			expect(kernel.terminal!.verified).toHaveLength(scenario === "valid" ? 3 : 0);
			expect(kernel.terminal!.status, JSON.stringify(kernel.terminal)).toBe(
				scenario === "valid" ? "VERIFIED_COMPLETE" : "PARTIALLY_COMPLETE",
			);
			expect(kernel.state!.used.execution).toBe(scenario === "valid" ? 4 : 3);
			expect(kernel.state!.used.ticks).toBe(scenario === "valid" ? 3 : 2);
			expect(h.getPendingResponseCount()).toBe(scenario === "valid" ? 1 : 2);
			const checks = kernel
				.state!.operations.map((ref) => kernel.store.get(kernel.state!.mission_id, ref, "OperationRecord"))
				.filter(
					(operation) =>
						kernel.store.get(kernel.state!.mission_id, operation.prepared_ref, "PreparedAction")
							.operation_class === `SHELL:${command}`,
				);
			expect(checks).toHaveLength(scenario === "valid" ? 1 : 0);
			if (scenario === "valid")
				expect(
					kernel
						.state!.reservations.map((ref) =>
							kernel.store.get(kernel.state!.mission_id, ref, "BudgetReservation"),
						)
						.find((reservation) => reservation.owner_operation_id === checks[0].operation_id),
				).toMatchObject({ protected_for_verification: true, actual: { execution: 1 } });
		},
	);
	it.each(["complete", "missing case", "fabricated quote", "extra tool", "repair"] as const)(
		"assesses retained behavioral tests without more tools at the reserve boundary: %s",
		async (assessment) => {
			const h = await createHarness({
				sandhanaConfiguration: {
					version: "sandhana/1",
					routes: { MADHYAMA: { execution: 10, ticks: 12, verification_reserve: 6 } },
				},
			});
			harnesses.push(h);
			const fixed = "module.exports = (value) => { if (value === '') throw new Error('empty'); return value; };";
			let implementation =
				assessment === "repair" ? fixed.replace("return value;", "return value.toUpperCase();") : fixed;
			const emptyCase = "test('rejects empty', () => assert.throws(() => parse(''), /empty/));";
			const validCase = "test('preserves valid', () => assert.equal(parse('valid'), 'valid'));";
			const command = "node --test parser.test.cjs";
			writeFileSync(join(h.tempDir, "parser.cjs"), "module.exports = (value) => value;");
			writeFileSync(
				join(h.tempDir, "parser.test.cjs"),
				`const test = require('node:test'); const assert = require('node:assert/strict'); const parse = require('./parser.cjs');\n${emptyCase}${assessment === "missing case" ? "" : `\n${validCase}`}`,
			);
			const coverage: FauxResponseFactory = (context) => {
				if (h.session.sandhana.state!.used.execution === 4) expect(getCurrentTools(context.messages)).toEqual([]);
				else expect(getCurrentTools(context.messages).map((tool) => tool.name)).toContain("write");
				if (assessment === "extra tool")
					return fauxAssistantMessage([fauxToolCall("read", { path: "parser.cjs" })], {
						stopReason: "toolUse",
					});
				const kernel = h.session.sandhana;
				const state = kernel.state!;
				const reads = state.operations
					.map((ref) => kernel.store.get(state.mission_id, ref, "OperationRecord"))
					.filter(
						(op) =>
							kernel.store.get(state.mission_id, op.prepared_ref, "PreparedAction").operation_class === "READ",
					);
				const proposals: CoverageProposal[] = state.requirements.map((ref, index) => ({
					requirement_id: kernel.store.get(state.mission_id, ref, "Requirement").requirement_id,
					command,
					case_names: [index === 0 ? "rejects empty" : "preserves valid"],
					applicability: "SUPPORTED",
					explanation:
						index === 0
							? "The assertion invokes the changed parser with empty input and checks rejection."
							: "The assertion invokes the same parser with valid input and checks the unchanged result.",
					citations: [
						{
							observation_id: reads.findLast(
								(op) =>
									(
										kernel.store.get(state.mission_id, op.prepared_ref, "PreparedAction").arguments as {
											path: string;
										}
									).path === "parser.cjs",
							)!.result_refs[0],
							role: "IMPLEMENTATION",
							quote:
								assessment === "fabricated quote"
									? "module.exports = () => 'invented implementation';"
									: implementation,
						},
						{
							observation_id: reads.find(
								(op) =>
									(
										kernel.store.get(state.mission_id, op.prepared_ref, "PreparedAction").arguments as {
											path: string;
										}
									).path === "parser.test.cjs",
							)!.result_refs[0],
							role: "TEST_ASSERTION",
							case_name: index === 0 ? "rejects empty" : "preserves valid",
							quote: index === 0 ? emptyCase : validCase,
						},
					],
				}));
				return fauxAssistantMessage(`<pramana>${JSON.stringify({ results: proposals })}</pramana>`);
			};
			h.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("read", { path: "parser.test.cjs" }),
						fauxToolCall("write", { path: "parser.cjs", content: implementation }),
						fauxToolCall("read", { path: "parser.cjs" }),
						fauxToolCall("bash", { command }),
					],
					{ stopReason: "toolUse" },
				),
				coverage,
				...(assessment === "repair"
					? [
							((context) => {
								expect(getCurrentTools(context.messages).map((tool) => tool.name)).toContain("write");
								implementation = fixed;
								return fauxAssistantMessage(
									[
										fauxToolCall("write", { path: "parser.cjs", content: fixed }),
										fauxToolCall("read", { path: "parser.cjs" }),
										fauxToolCall("bash", { command }),
									],
									{ stopReason: "toolUse" },
								);
							}) satisfies FauxResponseFactory,
							coverage,
						]
					: []),
				fauxAssistantMessage("This extra decision must remain unused"),
			]);
			await h.session.prompt("Fix the parser accepting an invalid empty value; preserve valid existing values");
			const kernel = h.session.sandhana;
			expect(kernel.terminal!.status, JSON.stringify(kernel.terminal)).toBe(
				assessment === "complete" || assessment === "repair" ? "VERIFIED_COMPLETE" : "PARTIALLY_COMPLETE",
			);
			expect(kernel.terminal!.verified).toHaveLength(
				assessment === "complete" || assessment === "repair" ? 2 : assessment === "missing case" ? 1 : 0,
			);
			expect(kernel.state!.used).toMatchObject({
				execution: assessment === "repair" ? 7 : 4,
				ticks: assessment === "repair" ? 4 : 2,
			});
			expect(kernel.state!.stagnation).toBe(["complete", "missing case", "repair"].includes(assessment) ? 0 : 2);
			expect(h.getPendingResponseCount()).toBe(1);
			expect(h.eventsOfType("tool_execution_end").filter((event) => !event.preparationFailure)).toHaveLength(
				assessment === "repair" ? 7 : 4,
			);
			if (assessment === "repair")
				expect(
					kernel
						.state!.reservations.map((ref) =>
							kernel.store.get(kernel.state!.mission_id, ref, "BudgetReservation"),
						)
						.filter((reservation) =>
							kernel.state!.operations.some(
								(ref) =>
									kernel.store.get(kernel.state!.mission_id, ref, "OperationRecord").operation_id ===
									reservation.owner_operation_id,
							),
						)
						.map((reservation) => reservation.protected_for_verification),
				).toEqual([false, false, false, false, true, true, true]);
			expect(
				kernel.store
					.records(kernel.state!.mission_id)
					.filter(
						(record) =>
							record.record_type === "EvidenceRecord" &&
							record.stage === "pramana" &&
							record.kind === "CONTROL" &&
							record.payload &&
							typeof record.payload === "object" &&
							"coverage_request_key" in record.payload,
					),
			).toHaveLength(1);
		},
	);
	it.each([
		{ reason: "initial verification reserve", optional: 0, execution: 6, ticks: 12, exitCode: 0 },
		{ reason: "exhausted optional invocations", optional: 1, execution: 7, ticks: 12, exitCode: 0 },
		{ reason: "exhausted model ticks", optional: 1, execution: 40, ticks: 1, exitCode: 0 },
		{ reason: "failed required check", optional: 1, execution: 7, ticks: 12, exitCode: 1 },
	])(
		"runs required checks at $reason before requesting another decision",
		async ({ optional, execution, ticks, exitCode }) => {
			const h = await createHarness({
				sandhanaConfiguration: {
					version: "sandhana/1",
					routes: { MADHYAMA: { execution, ticks, verification_reserve: 6 } },
				},
			});
			harnesses.push(h);
			writeFileSync(join(h.tempDir, "parser.cjs"), "module.exports = 'good';");
			writeFileSync(
				join(h.tempDir, "check.cjs"),
				`if (require('./parser.cjs') !== 'good') process.exit(1); process.exit(${exitCode});`,
			);
			writeFileSync(join(h.tempDir, "diagnosis.txt"), "unrelated observation");
			h.setResponses([
				...(optional
					? [fauxAssistantMessage([fauxToolCall("read", { path: "diagnosis.txt" })], { stopReason: "toolUse" })]
					: []),
				fauxAssistantMessage([fauxToolCall("read", { path: "diagnosis.txt" })], { stopReason: "toolUse" }),
			]);
			await h.session.prompt(
				`padma: ${JSON.stringify({
					objective: "inspect parser behavior with a required foreground check",
					shell_commands: ["node check.cjs"],
					requirements: [
						{ text: "behavior", rule: "SEMANTIC", target: "parser.cjs" },
						{
							text: "required check",
							rule: "PROCESS",
							target: ".",
							expected: "node check.cjs",
							dependencies: ["parser.cjs"],
						},
					],
				})}`,
			);
			const kernel = h.session.sandhana;
			const state = kernel.state!;
			expect(state.route).toBe("MADHYAMA");
			expect(kernel.terminal!.status).toBe(
				exitCode !== 0 ? "EXECUTION_FAILED" : optional === ticks ? "BUDGET_EXHAUSTED" : "PARTIALLY_COMPLETE",
			);
			if (optional === ticks)
				expect(
					kernel.terminal!.failure_refs!.map(
						(ref) => kernel.store.get(state.mission_id, ref, "EvidenceRecord").failure?.code,
					),
				).toContain("BUDGET_REJECTED");
			expect(state.used.execution).toBe(optional + 1);
			expect(state.used.ticks).toBe(optional);
			expect(state.stagnation).toBe(exitCode === 0 ? 0 : 1);
			expect(h.getPendingResponseCount()).toBe(1);
			expect(state.requirements.map((ref) => kernel.store.get(state.mission_id, ref, "Requirement"))).toMatchObject([
				{ rule: "SEMANTIC", status: "UNMET" },
				{ rule: "PROCESS", status: exitCode === 0 ? "VERIFIED" : "UNMET" },
			]);
			const operation = kernel.store.get(state.mission_id, state.operations.at(-1)!, "OperationRecord");
			const reservation = state.reservations
				.map((ref) => kernel.store.get(state.mission_id, ref, "BudgetReservation"))
				.find((record) => record.owner_operation_id === operation.operation_id);
			expect(operation.status).toBe(exitCode === 0 ? "CONFIRMED_COMPLETE" : "FAILED");
			expect(reservation).toMatchObject({
				protected_for_verification: true,
				state: "RECONCILED",
				actual: { execution: 1 },
			});
		},
	);
});
