import { readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@anvaya.sh/padma-ai";
import { afterEach, describe, expect, it } from "vitest";
import { observedProcessSources } from "../../src/core/sandhana/process-sources.ts";
import type { RecordOf } from "../../src/core/sandhana/records.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()!.cleanup();
});

describe("cognitive stagnation through the actual session controller", () => {
	it("revocation retires the attempted branch before another proposal reads its source", async () => {
		const h = await createHarness();
		harnesses.push(h);
		writeFileSync(join(h.tempDir, "parser.txt"), "before");
		const kernel = h.session.sandhana;
		const proposal = {
			target: "parser.txt",
			cause: "INPUT_FORMAT",
			mechanism: "VALIDATE",
			failure_signature: "unproven cause",
			expected_result: "unobserved prediction",
		};
		let original: RecordOf<"Hypothesis"> | undefined;
		let retrievalBeforeRevocation = 0;
		h.setResponses([
			fauxAssistantMessage(
				[
					{ type: "text", text: `<yukti>${JSON.stringify(proposal)}</yukti>` },
					fauxToolCall("read", { path: "parser.txt" }),
				],
				{ stopReason: "toolUse" },
			),
			() => {
				const state = kernel.state!;
				original = kernel.store.get(state.mission_id, state.hypotheses[0], "Hypothesis");
				retrievalBeforeRevocation = state.used.retrieval_bytes;
				kernel.revoke();
				return fauxAssistantMessage(
					[
						{ type: "text", text: `<yukti>${JSON.stringify(proposal)}</yukti>` },
						fauxToolCall("read", { path: "parser.txt" }),
					],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("This response must remain unused after revocation"),
		]);
		await h.session.prompt(
			`padma: ${JSON.stringify({
				objective: "inspect parser behavior",
				requirements: [{ text: "behavior", rule: "SEMANTIC", target: "parser.txt" }],
			})}`,
		);
		const state = kernel.state!;
		expect(kernel.terminal!.status).toBe("BLOCKED");
		expect(state.used.execution).toBe(1);
		expect(state.used.ticks).toBe(2);
		expect(state.used.retrieval_bytes).toBe(retrievalBeforeRevocation);
		expect(state.stagnation).toBe(2);
		expect(state.leading_hypothesis).toBeNull();
		expect(kernel.store.get(state.mission_id, state.hypotheses[0], "Hypothesis")).toMatchObject({
			hypothesis_id: original!.hypothesis_id,
			premise_binding_ref: original!.premise_binding_ref,
			attempts: 1,
			status: "REJECTED",
			supporting: [],
			contradicting: [],
		});
		expect(kernel.store.get(state.mission_id, original!.record_id, "Hypothesis")).toEqual(original);
		expect(h.getPendingResponseCount()).toBe(1);
	});
	it.each(["CONTENT_CHANGE", "DEPENDENCY_REMOVED"] as const)(
		"a repaired previously passing process check resets progress after %s on the actual resumed controller",
		async (change) => {
			const h = await createHarness();
			harnesses.push(h);
			const command = "node check.cjs";
			const good = "module.exports = 'good';";
			writeFileSync(join(h.tempDir, "parser.cjs"), good);
			writeFileSync(join(h.tempDir, "check.cjs"), "if (require('./parser.cjs') !== 'good') process.exit(1);");
			h.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: "parser.cjs" }), fauxToolCall("bash", { command })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("The required check passed; behavior coverage remains unknown"),
			]);
			await h.session.prompt(
				`padma: ${JSON.stringify({
					objective: "repair parser behavior",
					allow_edits: true,
					shell_commands: [command],
					requirements: [
						{ text: "behavior", rule: "SEMANTIC", target: "parser.cjs" },
						{
							text: "required check",
							rule: "PROCESS",
							target: ".",
							expected: command,
							dependencies: ["parser.cjs"],
						},
					],
				})}`,
			);
			const kernel = h.session.sandhana;
			const mission = kernel.state!.mission_id;
			expect(kernel.terminal!.status).toBe("PARTIALLY_COMPLETE");
			h.setResponses([
				() => {
					if (change === "DEPENDENCY_REMOVED") unlinkSync(join(h.tempDir, "parser.cjs"));
					return fauxAssistantMessage(
						[
							...(change === "CONTENT_CHANGE"
								? [fauxToolCall("write", { path: "parser.cjs", content: "module.exports = 'bad';" })]
								: []),
							fauxToolCall("bash", { command }),
						],
						{ stopReason: "toolUse" },
					);
				},
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture provider stopped before repair" }),
			]);
			await h.session.prompt(`resume ${mission}`);
			expect(kernel.terminal!.status).toBe("EXECUTION_FAILED");
			const before = kernel.state!.used;
			h.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("write", { path: "parser.cjs", content: good }), fauxToolCall("bash", { command })],
					{ stopReason: "toolUse" },
				),
				() => {
					expect(kernel.state!.stagnation).toBe(0);
					const tick = kernel.store
						.records(mission)
						.findLast((record) => record.record_type === "CognitiveTick" && record.status === "SETTLED");
					if (tick?.record_type !== "CognitiveTick") throw new Error("Missing settled repair decision");
					expect(tick.progress).toHaveLength(1);
					expect(
						tick.progress[0].evidence.map((ref) => kernel.store.get(mission, ref, "EvidenceRecord").payload),
					).toEqual([
						expect.objectContaining({ result: "FAILED" }),
						expect.objectContaining({ result: "PASSED" }),
					]);
					return fauxAssistantMessage("The repaired check passed; semantic coverage is still unverified");
				},
				fauxAssistantMessage("This extra critic must remain unused"),
			]);
			await h.session.prompt(`resume ${mission}`);
			expect(kernel.state!.mission_id).toBe(mission);
			expect(kernel.terminal!.status).toBe("PARTIALLY_COMPLETE");
			expect(kernel.state!.used.execution).toBe(before.execution + 2);
			expect(kernel.state!.used.ticks).toBe(before.ticks + 2);
			expect(h.getPendingResponseCount()).toBe(1);
			expect(readFileSync(join(h.tempDir, "parser.cjs"), "utf8")).toBe(good);
		},
		120000,
	);
	it("a repaired declared quality check supplies new progress without another critic", async () => {
		const h = await createHarness();
		harnesses.push(h);
		writeFileSync(join(h.tempDir, "check.cjs"), "process.exit(1);");
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "required" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("write", { path: "check.cjs", content: "process.exit(0);" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("This speculative decision must remain unused"),
		]);
		await h.session.prompt(
			`padma: ${JSON.stringify({
				objective: "bytes with quality proof",
				allow_edits: true,
				quality_checks: ["node check.cjs"],
				requirements: [{ text: "bytes", rule: "CONTENT", target: "a.txt", expected: "required" }],
			})}`,
		);
		const kernel = h.session.sandhana;
		expect(kernel.terminal?.status).toBe("VERIFIED_COMPLETE");
		expect(kernel.state!.used.ticks).toBe(2);
		expect(kernel.state!.used.execution).toBe(4);
		expect(kernel.state!.stagnation).toBe(0);
		expect(h.getPendingResponseCount()).toBe(1);
		const tick = kernel.store.get(kernel.state!.mission_id, kernel.state!.cognitive_tick!, "CognitiveTick");
		expect(
			tick.progress.some((fact) =>
				fact.evidence.some((ref) => {
					const evidence = kernel.store.get(tick.mission_id, ref, "EvidenceRecord");
					return evidence.stage === "pariskara";
				}),
			),
		).toBe(true);
	});
	it("counts a tool batch once, rejects irrelevant diagnosis and stops after seven decisions", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const kernel = h.session.sandhana;
		h.setResponses([
			...Array.from({ length: 7 }, (_, index) => () => {
				if (index) expect(kernel.state!.stagnation).toBe(index);
				writeFileSync(join(h.tempDir, "a.txt"), `new unrelated output ${index}`);
				return fauxAssistantMessage(
					Array.from({ length: index === 0 ? 5 : 1 }, () => fauxToolCall("read", { path: "a.txt" })),
					{ stopReason: "toolUse" },
				);
			}),
			fauxAssistantMessage("This eighth decision must remain unused"),
		]);
		await h.session.prompt("Inspect the parser behavior");
		expect(kernel.terminal?.status).toBe("PARTIALLY_COMPLETE");
		expect(kernel.state!.stagnation).toBe(7);
		expect(kernel.state!.used.ticks).toBe(7);
		expect(kernel.state!.used.execution).toBe(8);
		expect(
			h.session.messages.filter(
				(message) => message.role === "toolResult" && getMessageText(message).includes("DIAGNOSIS_REQUIRED"),
			),
		).toHaveLength(3);
		expect(h.getPendingResponseCount()).toBe(1);
		const records = kernel.store.records(kernel.state!.mission_id);
		const settled = records.filter(
			(record): record is RecordOf<"CognitiveTick"> =>
				record.record_type === "CognitiveTick" && record.status === "SETTLED",
		);
		expect(settled.map((tick) => tick.stagnation_after)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect(settled.every((tick) => tick.progress.length === 0)).toBe(true);
		expect(
			records.some(
				(record) =>
					record.record_type === "EvidenceRecord" &&
					record.stage === "niyantr" &&
					record.payload &&
					typeof record.payload === "object" &&
					"decision" in record.payload &&
					record.payload.decision === "PIVOT",
			),
		).toBe(true);
	}, 30000);

	it("interrupts an attempted stagnant approach and admits a different mechanism without resetting its history", async () => {
		const h = await createHarness();
		harnesses.push(h);
		writeFileSync(join(h.tempDir, "parser.txt"), "before");
		const kernel = h.session.sandhana;
		const proposal = {
			target: "parser.txt",
			cause: "INPUT_FORMAT",
			mechanism: "VALIDATE",
			failure_signature: "unproven symptom",
			expected_result: "unobserved prediction",
		};
		h.setResponses([
			...Array.from({ length: 4 }, (_, index) =>
				fauxAssistantMessage(
					[
						{
							type: "text" as const,
							text: `<yukti>${JSON.stringify({ ...proposal, cause_detail: `same cause ${index}` })}</yukti>`,
						},
						fauxToolCall("read", { path: "parser.txt" }),
					],
					{ stopReason: "toolUse" },
				),
			),
			() => {
				const state = kernel.state!;
				const hypothesis = kernel.store.get(state.mission_id, state.hypotheses[0], "Hypothesis");
				expect(hypothesis).toMatchObject({ status: "REJECTED", attempts: 4, supporting: [], contradicting: [] });
				expect(hypothesis.rejection_ref).toBeDefined();
				expect(state.leading_hypothesis).toBeNull();
				return fauxAssistantMessage(
					[
						{
							type: "text",
							text: `<yukti>${JSON.stringify({ ...proposal, expected_result: "cosmetic optimism" })}</yukti>`,
						},
						fauxToolCall("read", { path: "parser.txt", offset: 1, limit: 1 }),
					],
					{ stopReason: "toolUse" },
				);
			},
			() => {
				expect(kernel.state!.stagnation).toBe(5);
				expect(kernel.state!.used.execution).toBe(4);
				return fauxAssistantMessage(
					[
						{ type: "text", text: `<yukti>${JSON.stringify({ ...proposal, mechanism: "NORMALIZE" })}</yukti>` },
						fauxToolCall("write", { path: "parser.txt", content: "required" }),
					],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("This decision must remain unused"),
		]);
		await h.session.prompt(
			`padma: ${JSON.stringify({
				objective: "required parser bytes",
				allow_edits: true,
				requirements: [{ text: "parser bytes", rule: "CONTENT", target: "parser.txt", expected: "required" }],
			})}`,
		);
		expect(kernel.terminal?.status).toBe("VERIFIED_COMPLETE");
		expect(readFileSync(join(h.tempDir, "parser.txt"), "utf8")).toBe("required");
		expect(kernel.state!.used.ticks).toBe(6);
		expect(kernel.state!.used.execution).toBe(5);
		expect(kernel.state!.stagnation).toBe(0);
		expect(h.getPendingResponseCount()).toBe(1);
		const state = kernel.state!;
		const history = kernel.store.records(state.mission_id);
		expect(
			history.filter(
				(record) => record.record_type === "EvidenceRecord" && record.source === "hypothesis-normalization/1",
			),
		).toHaveLength(3);
		const first = history.find((record) => record.record_type === "Hypothesis")!;
		if (first.record_type !== "Hypothesis") throw new Error("Missing original branch");
		expect(kernel.store.get(state.mission_id, state.hypotheses[0], "Hypothesis").premise_binding_ref).toBe(
			first.premise_binding_ref,
		);
		expect(state.hypotheses.map((ref) => kernel.store.get(state.mission_id, ref, "Hypothesis").attempts)).toEqual([
			4, 1,
		]);
		const ticks = kernel.store
			.records(state.mission_id)
			.filter(
				(record): record is RecordOf<"CognitiveTick"> =>
					record.record_type === "CognitiveTick" && record.status === "SETTLED",
			);
		expect(ticks.map((tick) => tick.stagnation_after)).toEqual([1, 2, 3, 4, 5, 0]);
	});

	it("admits one unseen targeted span after rejecting a repeated call in the same batch", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const path = join(h.tempDir, "parser.txt");
		writeFileSync(path, "first\nsecond\nthird");
		const proposal = {
			target: "parser.txt",
			cause: "INPUT_FORMAT",
			mechanism: "VALIDATE",
			failure_signature: "unproven symptom",
			expected_result: "unobserved prediction",
		};
		h.setResponses([
			...Array.from({ length: 4 }, (_, index) =>
				fauxAssistantMessage(
					[
						...(index === 0
							? [{ type: "text" as const, text: `<yukti>${JSON.stringify(proposal)}</yukti>` }]
							: []),
						fauxToolCall("read", { path: "parser.txt", limit: 1 }),
					],
					{ stopReason: "toolUse" },
				),
			),
			fauxAssistantMessage(
				[
					fauxToolCall("read", { path: "parser.txt", limit: 1 }),
					fauxToolCall("read", { path: "parser.txt", offset: 2, limit: 1 }),
					fauxToolCall("read", { path: "parser.txt", offset: 3, limit: 1 }),
				],
				{ stopReason: "toolUse" },
			),
			() => {
				utimesSync(path, new Date(Date.now() + 10000), new Date(Date.now() + 10000));
				return fauxAssistantMessage([fauxToolCall("read", { path, offset: 2, limit: 1 })], {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage([fauxToolCall("read", { path: "parser.txt", offset: 2, limit: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("This decision must remain unused"),
		]);
		await h.session.prompt(
			`padma: ${JSON.stringify({
				objective: "inspect parser behavior",
				requirements: [{ text: "behavior", rule: "SEMANTIC", target: "parser.txt" }],
			})}`,
		);
		const kernel = h.session.sandhana;
		expect(kernel.terminal?.status).toBe("PARTIALLY_COMPLETE");
		expect(kernel.state!.used.ticks).toBe(7);
		expect(kernel.state!.used.execution).toBe(5);
		expect(kernel.state!.stagnation).toBe(7);
		expect(h.getPendingResponseCount()).toBe(1);
		expect(
			h.session.messages.filter(
				(message) => message.role === "toolResult" && getMessageText(message).includes("DIAGNOSIS_REQUIRED"),
			),
		).toHaveLength(4);
		expect(
			h.session.messages.some((message) => message.role === "toolResult" && getMessageText(message) === "second"),
		).toBe(true);
		expect(
			h.session.messages.some(
				(message) =>
					message.role === "toolResult" &&
					getMessageText(message).includes("Only one optional targeted diagnosis"),
			),
		).toBe(true);
	});

	it("new requirement evidence finishes early within the same decision and deterministic checks", async () => {
		const h = await createHarness();
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "required" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("This speculative decision must remain unused"),
		]);
		await h.session.prompt(
			`padma: ${JSON.stringify({
				objective: "required bytes",
				allow_edits: true,
				requirements: [{ text: "bytes", rule: "CONTENT", target: "a.txt", expected: "required" }],
			})}`,
		);
		const kernel = h.session.sandhana;
		expect(kernel.terminal?.status).toBe("VERIFIED_COMPLETE");
		expect(kernel.state!.stagnation).toBe(0);
		expect(kernel.state!.used.ticks).toBe(1);
		expect(kernel.state!.used.execution).toBe(1);
		expect(h.getPendingResponseCount()).toBe(1);
		const tick = kernel.store.get(kernel.state!.mission_id, kernel.state!.cognitive_tick!, "CognitiveTick");
		expect(tick.status).toBe("SETTLED");
		expect(tick.progress.length).toBeGreaterThan(0);
	});
	it("a real source change admits the same scoped diagnostic command without claiming semantic completion", async () => {
		const h = await createHarness();
		harnesses.push(h);
		writeFileSync(join(h.tempDir, "parser.cjs"), "module.exports = () => 'DIAGNOSTIC_BEFORE';");
		writeFileSync(join(h.tempDir, "other.txt"), "unrelated bytes");
		writeFileSync(
			join(h.tempDir, "parser.test.cjs"),
			`const { test } = require('node:test');
const assert = require('node:assert/strict');
const parse = require('./parser.cjs');
test('narrow diagnostic', () => { assert.equal(typeof parse, 'function'); console.log(parse()); });`,
		);
		const kernel = h.session.sandhana;
		const proposal = {
			target: "parser.cjs",
			cause: "INPUT_FORMAT",
			mechanism: "VALIDATE",
			failure_signature: "unproven cause",
			expected_result: "unobserved prediction",
		};
		const command = "node --test parser.test.cjs";
		h.setResponses([
			fauxAssistantMessage(
				[
					{ type: "text", text: `<yukti>${JSON.stringify(proposal)}</yukti>` },
					fauxToolCall("read", { path: "parser.cjs" }),
					fauxToolCall("read", { path: "other.txt" }),
					fauxToolCall("bash", { command }),
				],
				{ stopReason: "toolUse" },
			),
			...Array.from({ length: 3 }, () =>
				fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
			),
			fauxAssistantMessage(
				[
					{ type: "text", text: `<yukti>${JSON.stringify({ ...proposal, mechanism: "NORMALIZE" })}</yukti>` },
					fauxToolCall("write", { path: "parser.cjs", content: "module.exports = () => 'DIAGNOSTIC_AFTER';" }),
				],
				{ stopReason: "toolUse" },
			),
			() => {
				expect(kernel.state!.stagnation).toBe(5);
				return fauxAssistantMessage(
					[
						{
							type: "text",
							text: `<yukti>${JSON.stringify({ ...proposal, cause: "STATE", mechanism: "TRACE", expected_result: "DIAGNOSTIC_AFTER" })}</yukti>`,
						},
						fauxToolCall("bash", { command: "node --test ./parser.test.cjs" }),
					],
					{ stopReason: "toolUse" },
				);
			},
			() => {
				expect(kernel.state!.stagnation).toBe(0);
				return fauxAssistantMessage("The diagnostic changed; behavior coverage remains unverified");
			},
			fauxAssistantMessage("This decision must remain unused"),
		]);
		await h.session.prompt(
			`padma: ${JSON.stringify({
				objective: "repair parser behavior",
				allow_edits: true,
				requirements: [{ text: "behavior", rule: "SEMANTIC", target: "parser.cjs" }],
			})}`,
		);
		expect(kernel.terminal?.status).toBe("PARTIALLY_COMPLETE");
		expect(kernel.state!.used.ticks).toBe(7);
		expect(kernel.state!.used.execution).toBe(8);
		expect(h.getPendingResponseCount()).toBe(1);
		const state = kernel.state!;
		const observations = kernel.store
			.records(state.mission_id)
			.filter(
				(record): record is RecordOf<"EvidenceRecord"> =>
					record.record_type === "EvidenceRecord" &&
					record.stage === "phala" &&
					observedProcessSources(kernel.store, record) !== null,
			);
		expect(observations).toHaveLength(5);
		const first = observedProcessSources(kernel.store, observations[0])!;
		const last = observedProcessSources(kernel.store, observations.at(-1)!)!;
		const path =
			process.platform === "win32" ? join(h.tempDir, "parser.cjs").toLowerCase() : join(h.tempDir, "parser.cjs");
		expect(first[path]).toBeDefined();
		expect(last[path]).not.toBe(first[path]);
		expect(state.hypotheses.map((ref) => kernel.store.get(state.mission_id, ref, "Hypothesis").status)).toEqual([
			"REJECTED",
			"REJECTED",
			"SUPPORTED",
		]);
	}, 60000);

	it("settles failed provider decisions and leaves exact commands without a cognitive tick", async () => {
		const h = await createHarness();
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture provider failure" })]);
		await h.session.prompt("Inspect the parser behavior");
		const kernel = h.session.sandhana;
		expect(kernel.terminal?.status).toBe("EXECUTION_FAILED");
		expect(kernel.state!.stagnation).toBe(1);
		expect(kernel.store.get(kernel.state!.mission_id, kernel.state!.cognitive_tick!, "CognitiveTick").status).toBe(
			"SETTLED",
		);
		writeFileSync(join(h.tempDir, "a.txt"), "actual bytes");
		await h.session.prompt("read a.txt");
		expect(kernel.terminal?.status).toBe("VERIFIED_COMPLETE");
		expect(kernel.state!.used.ticks).toBe(0);
		expect(kernel.state!.cognitive_tick).toBeUndefined();
		expect(kernel.state!.stagnation).toBe(0);
	});
	it("external premise changes cannot resolve an old branch or reset the decision counter", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const path = join(h.tempDir, "parser.txt");
		writeFileSync(path, "before");
		const proposal = {
			target: "parser.txt",
			cause: "INPUT_FORMAT",
			mechanism: "VALIDATE",
			failure_signature: "unproven cause",
			expected_result: "EXPERIMENT_SUPPORTED",
		};
		const kernel = h.session.sandhana;
		h.setResponses([
			fauxAssistantMessage(
				[
					{ type: "text", text: `<yukti>${JSON.stringify(proposal)}</yukti>` },
					fauxToolCall("read", { path: "parser.txt" }),
				],
				{ stopReason: "toolUse" },
			),
			() => {
				expect(kernel.state!.stagnation).toBe(1);
				writeFileSync(path, "EXPERIMENT_SUPPORTED");
				return fauxAssistantMessage([fauxToolCall("read", { path: "parser.txt" })], { stopReason: "toolUse" });
			},
			() => {
				expect(kernel.state!.stagnation).toBe(2);
				return fauxAssistantMessage("The externally replaced source does not establish the proposed cause");
			},
		]);
		await h.session.prompt(
			`padma: ${JSON.stringify({
				objective: "inspect parser behavior",
				requirements: [{ text: "behavior", rule: "SEMANTIC", target: "parser.txt" }],
			})}`,
		);
		const state = kernel.state!;
		expect(kernel.terminal?.status).toBe("PARTIALLY_COMPLETE");
		expect(state.used.execution).toBe(2);
		expect(state.used.ticks).toBe(3);
		expect(state.stagnation).toBe(3);
		expect(kernel.store.get(state.mission_id, state.hypotheses[0], "Hypothesis")).toMatchObject({
			attempts: 1,
			status: "REJECTED",
			supporting: [],
			contradicting: [],
		});
		expect(
			kernel.store
				.records(state.mission_id)
				.filter((record) => record.record_type === "CandidateAction")
				.map((record) => record.hypothesis_ref),
		).toEqual([expect.any(String), null]);
	});
	it("a guarded correction chain retains its branch through the actual foreground test", async () => {
		const h = await createHarness();
		harnesses.push(h);
		writeFileSync(join(h.tempDir, "parser.cjs"), "module.exports = () => 'before';");
		writeFileSync(
			join(h.tempDir, "parser.test.cjs"),
			`const { test } = require('node:test');
const assert = require('node:assert/strict');
const parse = require('./parser.cjs');
test('narrow experiment', () => { assert.equal(parse(), 'after'); console.log('EXPERIMENT_SUPPORTED'); });`,
		);
		const proposal = {
			target: "parser.cjs",
			cause: "INPUT_FORMAT",
			mechanism: "NORMALIZE",
			failure_signature: "unproven cause",
			expected_result: "EXPERIMENT_SUPPORTED",
		};
		const kernel = h.session.sandhana;
		let original: RecordOf<"Hypothesis"> | undefined;
		h.setResponses([
			fauxAssistantMessage(
				[
					{ type: "text", text: `<yukti>${JSON.stringify(proposal)}</yukti>` },
					fauxToolCall("write", { path: "parser.cjs", content: "module.exports = () => 'intermediate';" }),
				],
				{ stopReason: "toolUse" },
			),
			() => {
				const state = kernel.state!;
				original = kernel.store.get(state.mission_id, state.hypotheses[0], "Hypothesis");
				expect(original).toMatchObject({ attempts: 1, status: "ACTIVE" });
				return fauxAssistantMessage(
					[
						{
							type: "text",
							text: `<yukti>${JSON.stringify({ ...proposal, mechanism_detail: "retain the guarded correction" })}</yukti>`,
						},
						fauxToolCall("write", {
							path: "parser.cjs",
							content: "module.exports = () => 'after';",
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage(
				[
					{ type: "text", text: `<yukti>${JSON.stringify(proposal)}</yukti>` },
					fauxToolCall("bash", { command: "node --test parser.test.cjs" }),
				],
				{ stopReason: "toolUse" },
			),
			() => {
				const state = kernel.state!;
				expect(state.stagnation).toBe(0);
				expect(kernel.store.get(state.mission_id, state.hypotheses[0], "Hypothesis")).toMatchObject({
					hypothesis_id: original!.hypothesis_id,
					fingerprint: original!.fingerprint,
					premise_binding_ref: original!.premise_binding_ref,
					attempts: 3,
					status: "SUPPORTED",
				});
				return fauxAssistantMessage(
					"The experiment supports this branch; requested behavior coverage remains unverified",
				);
			},
		]);
		await h.session.prompt(
			`padma: ${JSON.stringify({
				objective: "repair parser behavior",
				allow_edits: true,
				requirements: [{ text: "behavior", rule: "SEMANTIC", target: "parser.cjs" }],
			})}`,
		);
		expect(kernel.terminal?.status).toBe("PARTIALLY_COMPLETE");
		expect(kernel.state!.used.execution).toBe(3);
		expect(kernel.state!.used.ticks).toBe(4);
		expect(kernel.state!.hypotheses).toHaveLength(1);
		expect(
			kernel.store
				.records(kernel.state!.mission_id)
				.filter(
					(record) => record.record_type === "EvidenceRecord" && record.source === "hypothesis-normalization/1",
				),
		).toHaveLength(2);
		expect(
			h.session.messages.some(
				(message) => message.role === "toolResult" && getMessageText(message).includes("EXPERIMENT_SUPPORTED"),
			),
		).toBe(true);
	});
	it("a native process that changes the premise retains its output without branch progress", async () => {
		const h = await createHarness();
		harnesses.push(h);
		writeFileSync(join(h.tempDir, "parser.cjs"), "module.exports = () => 'before';");
		writeFileSync(
			join(h.tempDir, "parser.test.cjs"),
			`const { test } = require('node:test');
const fs = require('node:fs');
test('changing source', () => {
  fs.writeFileSync('parser.cjs', "module.exports = () => 'external postimage';");
  console.log('EXPERIMENT_SUPPORTED');
});`,
		);
		const kernel = h.session.sandhana;
		h.setResponses([
			fauxAssistantMessage(
				[
					{
						type: "text",
						text: `<yukti>${JSON.stringify({
							target: "parser.cjs",
							cause: "INPUT_FORMAT",
							mechanism: "VALIDATE",
							failure_signature: "unproven cause",
							expected_result: "EXPERIMENT_SUPPORTED",
						})}</yukti>`,
					},
					fauxToolCall("bash", { command: "node --test parser.test.cjs" }),
				],
				{ stopReason: "toolUse" },
			),
			() => {
				expect(kernel.state!.stagnation).toBe(1);
				return fauxAssistantMessage("The source changed during the experiment");
			},
		]);
		await h.session.prompt(
			`padma: ${JSON.stringify({
				objective: "repair parser behavior",
				allow_edits: true,
				requirements: [{ text: "behavior", rule: "SEMANTIC", target: "parser.cjs" }],
			})}`,
		);
		const state = kernel.state!;
		expect(kernel.terminal?.status).toBe("PARTIALLY_COMPLETE");
		expect(state.used.execution).toBe(1);
		expect(state.stagnation).toBe(2);
		expect(kernel.store.get(state.mission_id, state.hypotheses[0], "Hypothesis")).toMatchObject({
			attempts: 1,
			status: "ACTIVE",
			supporting: [],
			contradicting: [],
		});
		const operation = kernel.store.get(state.mission_id, state.operations[0], "OperationRecord");
		const observation = kernel.store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
		expect(operation.status).toBe("CONFIRMED_COMPLETE");
		expect(observation.payload).toMatchObject({ dependencies_unchanged: false });
		expect(kernel.store.artifact(state.mission_id, observation.artifact_ref!).toString()).toContain(
			"EXPERIMENT_SUPPORTED",
		);
	});
	it("a stale unattempted branch yields its slot to a new mechanism without decision progress", async () => {
		const h = await createHarness();
		harnesses.push(h);
		writeFileSync(join(h.tempDir, "parser.txt"), "before");
		writeFileSync(join(h.tempDir, "unrelated.txt"), "unrelated");
		const kernel = h.session.sandhana;
		const proposal = {
			target: "parser.txt",
			cause: "INPUT_FORMAT",
			mechanism: "VALIDATE",
			failure_signature: "unproven cause",
			expected_result: "unobserved prediction",
		};
		h.setResponses([
			fauxAssistantMessage(
				[
					{ type: "text", text: `<yukti>${JSON.stringify(proposal)}</yukti>` },
					fauxToolCall("read", { path: "unrelated.txt" }),
				],
				{ stopReason: "toolUse" },
			),
			() => {
				expect(kernel.state!.stagnation).toBe(1);
				writeFileSync(join(h.tempDir, "parser.txt"), "changed premise");
				return fauxAssistantMessage(
					[
						{ type: "text", text: `<yukti>${JSON.stringify({ ...proposal, mechanism: "NORMALIZE" })}</yukti>` },
						fauxToolCall("read", { path: "parser.txt" }),
					],
					{ stopReason: "toolUse" },
				);
			},
			() => {
				const state = kernel.state!;
				expect(state.stagnation).toBe(2);
				expect(state.hypotheses.map((ref) => kernel.store.get(state.mission_id, ref, "Hypothesis"))).toMatchObject([
					{ status: "REJECTED", attempts: 0, supporting: [], contradicting: [] },
					{ status: "ACTIVE", attempts: 1 },
				]);
				return fauxAssistantMessage(
					"The changed premise permits another mechanism; requested behavior is still unverified",
				);
			},
		]);
		await h.session.prompt(
			`padma: ${JSON.stringify({
				objective: "inspect parser behavior",
				requirements: [{ text: "behavior", rule: "SEMANTIC", target: "parser.txt" }],
			})}`,
		);
		expect(kernel.terminal?.status).toBe("PARTIALLY_COMPLETE");
		expect(kernel.state!.used.execution).toBe(2);
		expect(kernel.state!.used.ticks).toBe(3);
		expect(kernel.state!.stagnation).toBe(3);
	});
});
