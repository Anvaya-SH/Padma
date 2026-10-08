import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@anvaya.sh/padma-ai";
import type { FauxResponseStep } from "@anvaya.sh/padma-ai/compat";
import { afterEach, expect, test, vi } from "vitest";
import type { CoverageProposal } from "../../src/core/sandhana/acceptance.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

test("the provider receives a harness guide matching every current tool declaration", async () => {
	const harness = await createHarness();
	harnesses.push(harness);
	harness.setResponses([
		(context) => {
			const prompt = getCurrentSystemPrompt(context.messages);
			expect(prompt).toContain("<padma_harness>");
			for (const tool of getCurrentTools(context.messages)) expect(prompt).toContain(`- ${tool.name}:`);
			expect(prompt).toContain("ordinary foreground commands");
			expect(prompt).toContain("Do not repeat an action whose effect is uncertain");
			expect(prompt).toContain("User-facing answers");
			expect(prompt).toContain("omit offset and limit");
			return fauxAssistantMessage("I can inspect and change files using the declared tools.");
		},
	]);
	await harness.session.prompt("What can you do in this workspace?");
	expect(harness.faux.state.callCount).toBe(1);
});

test("a read-only question keeps its answer after successful reads without claiming artifact completion", async () => {
	const harness = await createHarness();
	harnesses.push(harness);
	writeFileSync(join(harness.tempDir, "input.txt"), "alpha=2 beta=3");
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Alpha plus beta is 5."),
	]);
	await harness.session.prompt("Read input.txt and calculate alpha plus beta. Explain the result in one sentence.");
	expect(harness.session.getLastAssistantText()).toBe("Alpha plus beta is 5.");
	expect(harness.session.sandhana.terminal?.status).toBe("PARTIALLY_COMPLETE");
	expect(harness.session.sandhana.state?.used.execution).toBe(1);
});

test("the next native decision receives the actual reason a verification proposal was rejected", async () => {
	const harness = await createHarness();
	harnesses.push(harness);
	writeFileSync(join(harness.tempDir, "input.txt"), "alpha=2 beta=3");
	harness.setResponses([
		fauxAssistantMessage(
			[
				{ type: "text", text: '<pramana_plan>{"results":[]}</pramana_plan>' },
				fauxToolCall("read", { path: "input.txt" }),
			],
			{ stopReason: "toolUse" },
		),
		(context) => {
			const position = JSON.parse(harness.session.sandhana.position()) as { verification_feedback: unknown[] };
			expect(position.verification_feedback).toEqual([
				{ rejected_check_plan: true, reason: "Invalid bounded check plan" },
			]);
			expect(getCurrentSystemPrompt(context.messages)).toContain("Invalid bounded check plan");
			return fauxAssistantMessage("Alpha plus beta is 5.");
		},
	]);
	await harness.session.prompt("Read input.txt and calculate alpha plus beta. Explain the result in one sentence.");
	expect(harness.session.getLastAssistantText()).toBe("Alpha plus beta is 5.");
	expect(harness.session.sandhana.state?.used.execution).toBe(1);
});

test("compaction retains the guide and keeps excluded tools out of the callable inventory", async () => {
	const harness = await createHarness({
		initialActiveToolNames: ["read"],
		models: [{ id: "bounded-context", contextWindow: 128000 }],
		sandhanaConfiguration: { version: "sandhana/1", avartana: { compaction_threshold: 0.5 } },
		extensionFactories: [
			(padma) => {
				padma.on("before_agent_start", () => ({ systemPrompt: "Project reference guidance. ".repeat(1500) }));
			},
		],
	});
	harnesses.push(harness);
	const compact = vi.spyOn(harness.session.sandhana, "compactContext");
	writeFileSync(join(harness.tempDir, "input.txt"), "retained input");
	harness.setResponses([
		(context) => {
			const prompt = getCurrentSystemPrompt(context.messages);
			expect(prompt).toContain("<padma_harness>");
			expect(prompt).toContain("- read:");
			expect(prompt).not.toContain("- write:");
			return fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), { stopReason: "toolUse" });
		},
		(context) => {
			const prompt = getCurrentSystemPrompt(context.messages);
			expect(prompt).toContain("<padma_harness>");
			expect(prompt).not.toContain("- write:");
			return fauxAssistantMessage("The file contains retained input.");
		},
	]);
	await harness.session.prompt("What does input.txt contain?");
	expect(harness.session.getLastAssistantText()).toBe("The file contains retained input.");
	expect(harness.faux.state.callCount).toBe(2);
	expect(compact).toHaveBeenCalled();
});

test("an explicitly requested repair check executes after diagnosis without a model-authored check plan", async () => {
	const harness = await createHarness({
		sandhanaConfiguration: { version: "sandhana/1", stagnation: { diagnose: 3, stop: 8 } },
	});
	harnesses.push(harness);
	const before = "module.exports = (left, right) => left - right;";
	const after = before.replace("left - right", "left + right");
	writeFileSync(join(harness.tempDir, "sum.cjs"), before);
	writeFileSync(
		join(harness.tempDir, "sum.test.cjs"),
		"const test = require('node:test'); const assert = require('node:assert/strict'); const sum = require('./sum.cjs'); test('adds numbers', () => assert.equal(sum(2, 3), 5));",
	);
	harness.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("read", { path: "sum.cjs" }), fauxToolCall("read", { path: "sum.test.cjs" })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(fauxToolCall("edit", { path: "sum.cjs", edits: [{ oldText: before, newText: after }] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage(fauxToolCall("read", { path: "sum.cjs" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("avartana_context_status", {}), { stopReason: "toolUse" }),
		() => {
			expect(harness.session.sandhana.state!.stagnation).toBeGreaterThanOrEqual(3);
			return fauxAssistantMessage(fauxToolCall("bash", { command: "node --test sum.test.cjs" }), {
				stopReason: "toolUse",
			});
		},
		fauxAssistantMessage("The named addition test passed."),
		(context) => {
			expect(getCurrentTools(context.messages)).toHaveLength(0);
			return fauxAssistantMessage("The check passed, but its behavioral coverage has not been established.");
		},
	]);
	await harness.session.prompt(
		"Fix sum.cjs to add numbers, then run node --test sum.test.cjs. Report the actual result.",
	);
	const result = getToolResult(harness, "bash");
	expect(result.isError).not.toBe(true);
	expect(result.content).toEqual(
		expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("# pass 1") })]),
	);
	expect(harness.eventsOfType("tool_execution_start").filter((event) => event.toolName === "bash")).toHaveLength(1);
	expect(harness.session.sandhana.terminal?.status).not.toBe("VERIFIED_COMPLETE");
});

test.each([
	{ needsPlan: false, submittedEarly: false },
	{ needsPlan: true, submittedEarly: false },
	{ needsPlan: false, submittedEarly: true },
])(
	"a current check receives bounded assessment (needs plan: $needsPlan, submitted early: $submittedEarly)",
	async ({ needsPlan, submittedEarly }) => {
		const harness = await createHarness({
			sandhanaConfiguration: {
				version: "sandhana/1",
				stagnation: submittedEarly ? { diagnose: 30, stop: 40 } : { diagnose: 3, stop: 4 },
			},
		});
		harnesses.push(harness);
		const before =
			"module.exports = (left, right) => { if (typeof left !== 'number' || typeof right !== 'number') throw new TypeError('numbers required'); return left - right; };";
		const after = before.replace("left - right", "left + right");
		const additionCase = "test('adds numbers', () => assert.equal(sum(2, 3), 5));";
		const rejectionCase = "test('rejects non-numbers', () => assert.throws(() => sum('2', 3), TypeError));";
		writeFileSync(join(harness.tempDir, "sum.cjs"), before);
		writeFileSync(
			join(harness.tempDir, "sum.test.cjs"),
			`const test = require('node:test'); const assert = require('node:assert/strict'); const sum = require('./sum.cjs');\n${additionCase}\n${rejectionCase}`,
		);
		const command = "node --test sum.test.cjs";
		const answer =
			"Fixed sum.cjs to add numbers and preserve TypeError. Ran node --test sum.test.cjs: 2 passed, 0 failed.";
		const coverage = (): CoverageProposal[] => {
			const data = JSON.parse(harness.session.sandhana.position()) as {
				remaining: { id: string }[];
				evidence_index: { id: string; operation_class: string; target: string }[];
			};
			const implementation = data.evidence_index.findLast(
				(entry) => entry.operation_class === "READ" && entry.target === join(harness.tempDir, "sum.cjs"),
			)!;
			const tests = data.evidence_index.findLast(
				(entry) => entry.operation_class === "READ" && entry.target === join(harness.tempDir, "sum.test.cjs"),
			)!;
			return data.remaining.map((requirement, index) => ({
				requirement_id: requirement.id,
				command,
				case_names: [index === 0 ? "adds numbers" : "rejects non-numbers"],
				applicability: "SUPPORTED",
				explanation:
					index === 0
						? "The actual passing assertion exercises addition through the directly imported changed implementation."
						: "The actual passing assertion preserves TypeError for a non-number through the directly imported implementation.",
				citations: [
					{ observation_id: implementation.id, role: "IMPLEMENTATION", quote: after },
					{
						observation_id: tests.id,
						role: "TEST_ASSERTION",
						case_name: index === 0 ? "adds numbers" : "rejects non-numbers",
						quote: index === 0 ? additionCase : rejectionCase,
					},
				],
			}));
		};
		const planningStep: FauxResponseStep = (context) => {
			expect(getCurrentTools(context.messages)).toHaveLength(0);
			expect(getCurrentSystemPrompt(context.messages)).toContain("coverage_inputs");
			expect(getCurrentSystemPrompt(context.messages)).toContain("rejects non-numbers");
			return fauxAssistantMessage(`<pramana_plan>${JSON.stringify({ results: coverage() })}</pramana_plan>`);
		};
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("read", { path: "sum.cjs", offset: null, limit: null }),
					fauxToolCall("read", { path: "sum.test.cjs", offset: null, limit: null }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("edit", { path: "sum.cjs", edits: [{ oldText: before, newText: after }] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("read", { path: "sum.cjs", offset: null, limit: null }), {
				stopReason: "toolUse",
			}),
			...(submittedEarly
				? [
						() => {
							expect(harness.session.sandhana.verificationDue()).toBe(false);
							return fauxAssistantMessage("");
						},
					]
				: needsPlan
					? [
							fauxAssistantMessage(fauxToolCall("avartana_context_status", {}), { stopReason: "toolUse" }),
							planningStep,
						]
					: [
							() =>
								fauxAssistantMessage(
									[
										{
											type: "text",
											text: `<pramana_plan>${JSON.stringify({ results: coverage() })}</pramana_plan>`,
										},
										fauxToolCall("bash", { command }),
									],
									{ stopReason: "toolUse" },
								),
						]),
			(context) => {
				expect(getCurrentTools(context.messages)).toHaveLength(0);
				const prior = structuredClone(harness.session.sandhana.state!);
				const position = JSON.parse(harness.session.sandhana.position()) as {
					validated_check_plans: CoverageProposal[];
					coverage_inputs: { inputs: { operation_class: string; text: string }[]; omitted: string[] };
				};
				expect(harness.session.sandhana.state!.revision).toBe(prior.revision);
				expect(harness.session.sandhana.state!.used).toEqual(prior.used);
				expect(position.validated_check_plans).toHaveLength(submittedEarly ? 0 : 2);
				if (!submittedEarly)
					expect(position.validated_check_plans.map((plan) => plan.citations)).toEqual(
						coverage()
							.map((plan) => plan.citations)
							.toReversed(),
					);
				expect(getCurrentSystemPrompt(context.messages)).toContain("validated_check_plans");
				expect(position.coverage_inputs.omitted).toEqual([]);
				expect(
					position.coverage_inputs.inputs.find(
						(input) => input.operation_class === "READ" && input.text.includes("adds numbers"),
					)?.text,
				).toContain(rejectionCase);
				expect(
					position.coverage_inputs.inputs.find((input) => input.operation_class.startsWith("SHELL:"))?.text,
				).toContain("# pass 2");
				return fauxAssistantMessage(`<pramana>${JSON.stringify({ results: coverage() })}</pramana>\n${answer}`);
			},
		]);
		await harness.session.prompt(
			`Fix sum.cjs to add instead of subtract; preserve rejection of non-number inputs${submittedEarly ? ", then run node --test sum.test.cjs." : ""}`,
		);
		const kernel = harness.session.sandhana;
		expect(kernel.terminal?.status, JSON.stringify(kernel.terminal)).toBe("VERIFIED_COMPLETE");
		expect(kernel.terminal?.verified).toHaveLength(2);
		expect(kernel.state!.used.execution).toBe(5);
		expect(kernel.state!.used.ticks).toBe(needsPlan ? 6 : 5);
		expect(harness.faux.state.callCount).toBe(needsPlan ? 6 : 5);
		expect(harness.eventsOfType("tool_execution_start").filter((event) => event.toolName === "bash")).toHaveLength(1);
		expect(kernel.terminal?.presentation).toBe(answer);
		expect(harness.session.getLastAssistantText()).toBe(`${answer}\nCompleted and verified.`);
		expect(
			JSON.stringify(harness.eventsOfType("message_end").filter((event) => event.message.role === "assistant")),
		).not.toContain("<pramana>");
		expect(harness.getPendingResponseCount()).toBe(0);
	},
);
