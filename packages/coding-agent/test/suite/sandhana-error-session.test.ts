import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@anvaya.sh/padma-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isFailure } from "../../src/core/sandhana/errors.ts";
import { ProposalFailureSchema } from "../../src/core/sandhana/records.ts";
import { assertShellDispatchReady } from "../../src/core/tools/dispatch-guard.ts";
import { getShellEnv } from "../../src/utils/shell.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	while (harnesses.length) harnesses.pop()!.cleanup();
});

describe("failure reporting through the actual Sandhana session", () => {
	it.each(["cost", "input_tokens", "output_tokens"] as const)(
		"stops before another provider decision when pending model %s fills the mission account",
		async (dimension) => {
			const h = await createHarness({
				sandhanaConfiguration: { version: "sandhana/1", resources: { cost: 1, output_tokens: 4096 } },
				models: [{ id: "priced-fixture", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
			});
			harnesses.push(h);
			const kernel = h.session.sandhana;
			const reserve = kernel.reserveModel.bind(kernel);
			let held: string | undefined;
			vi.spyOn(kernel, "reserveModel").mockImplementation((input, output, cost) => {
				const inputCapacity = kernel.state!.ceilings.input_tokens;
				if (inputCapacity === null) throw new Error("Fixture requires known input capacity");
				held ??= reserve(
					dimension === "input_tokens" ? inputCapacity : 1,
					dimension === "output_tokens" ? 4096 : 1,
					dimension === "cost" ? 1 : 0,
				);
				return reserve(input, output, cost);
			});
			h.setResponses([fauxAssistantMessage("This provider response must remain unused")]);
			await h.session.prompt("Inspect the parser behavior");
			const state = kernel.state!;
			expect(kernel.terminal?.status, h.session.getLastAssistantText()).toBe("BUDGET_EXHAUSTED");
			expect(state.used).toMatchObject({ ticks: 1, execution: 0, input_tokens: 0, output_tokens: 0, cost: 0 });
			expect(kernel.store.get(state.mission_id, held!, "BudgetReservation").state).toBe("RESERVED");
			expect(
				kernel.terminal!.failure_refs!.map(
					(ref) => kernel.store.get(state.mission_id, ref, "EvidenceRecord").failure,
				),
			).toContainEqual(
				expect.objectContaining({
					code: "BUDGET_REJECTED",
					operation_id: null,
					target_binding_ref: null,
					retry: expect.objectContaining({ automatic: false }),
				}),
			);
			expect(h.getPendingResponseCount()).toBe(1);
			expect(h.eventsOfType("tool_execution_end")).toHaveLength(0);
			expect(h.eventsOfType("agent_end")).toHaveLength(1);
		},
	);
	it("executes exact user-approved bytes through the real session without another provider decision", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const path = join(h.tempDir, "a.txt");
		writeFileSync(path, "old");
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "a.txt", content: "new" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("This extra decision must remain unused"),
		]);
		await h.session.prompt(
			`padma: ${JSON.stringify({
				objective: "Deliver the requested bytes",
				requirements: [{ text: "Current bytes are new", rule: "CONTENT", target: "a.txt", expected: "new" }],
			})}`,
		);
		const kernel = h.session.sandhana;
		expect(kernel.terminal?.status, h.session.getLastAssistantText()).toBe("BLOCKED");
		const before = kernel.state!;
		const previousReport = kernel.terminal!;
		const view = kernel.store.publicAuthorization(before.mission_id);
		const request = view.request!;
		await h.session.prompt(
			`authorize: ${JSON.stringify({
				version: "SANDHANA_APPROVAL/1",
				mission_id: view.mission_id,
				revision: view.revision,
				decision_ref: request.decision_ref,
				prepared_ref: request.prepared_ref,
				action_digest: request.action_digest,
			})}`,
		);
		const state = kernel.state!;
		expect(kernel.terminal?.status, h.session.getLastAssistantText()).toBe("VERIFIED_COMPLETE");
		expect(readFileSync(path, "utf8")).toBe("new");
		expect(state.mission_id).toBe(before.mission_id);
		expect(state.started_at).toBe(before.started_at);
		expect(state.used.ticks).toBe(1);
		expect(state.used.execution).toBe(1);
		expect(state.used.input_tokens).toBe(before.used.input_tokens);
		expect(kernel.store.get(state.mission_id, previousReport.record_id, "TerminalReport")).toEqual(previousReport);
		expect(
			kernel.store.records(state.mission_id).filter((record) => record.record_type === "ActionApproval"),
		).toHaveLength(1);
		expect(h.eventsOfType("tool_execution_end").map((event) => event.toolName)).toEqual(["write", "write"]);
		const requirement = kernel.store.get(state.mission_id, state.requirements[0], "Requirement");
		expect(requirement.status).toBe("VERIFIED");
		expect(requirement.evidence.length).toBeGreaterThan(0);
		expect(kernel.terminal?.verified).toEqual([requirement.requirement_id]);
		expect(h.getPendingResponseCount()).toBe(1);
	});
	it("reports a denied provider edit with retained action identity and no recovery publication", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const path = join(h.tempDir, "a.txt");
		writeFileSync(path, "PRIVATE_PREIMAGE");
		h.setResponses([
			fauxAssistantMessage(
				fauxToolCall("write", { path: "a.txt", content: "PRIVATE_REPLACEMENT api_key=private-denied-edit" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("This decision must remain unused"),
		]);
		await h.session.prompt("Inspect a.txt and explain its current contents");
		const kernel = h.session.sandhana;
		const state = kernel.state!;
		expect(kernel.terminal?.status, h.session.getLastAssistantText()).toBe("BLOCKED");
		const request = kernel.store.publicAuthorization(state.mission_id).request!;
		expect(request).toMatchObject({ action: { tool_id: "write", kind: "EDIT" }, requires_repreparation: true });
		const failures = kernel.terminal!.failure_refs!.map(
			(ref) => kernel.store.get(state.mission_id, ref, "EvidenceRecord").failure,
		);
		expect(failures).toContainEqual(
			expect.objectContaining({
				code: "AUTHORIZATION_REQUIRED",
				operation_id: request.operation_id,
				target_binding_ref: request.target.binding_ref,
			}),
		);
		const result = h.eventsOfType("tool_execution_end")[0].result;
		expect(result.details).toMatchObject({
			sandhana_failure: {
				code: "AUTHORIZATION_REQUIRED",
				operation_id: request.operation_id,
				target_binding_ref: request.target.binding_ref,
			},
		});
		for (const secret of ["PRIVATE_PREIMAGE", "PRIVATE_REPLACEMENT", "private-denied-edit"]) {
			expect(h.session.getLastAssistantText()).not.toContain(secret);
			expect(JSON.stringify(result)).not.toContain(secret);
			expect(JSON.stringify(request)).not.toContain(secret);
		}
		expect(state.checkpoints).toEqual([]);
		expect(state.operations).toEqual([]);
		expect(kernel.store.records(state.mission_id).some((record) => record.record_type === "Artifact")).toBe(false);
		expect(state.used.execution).toBe(0);
		expect(state.used.artifact_bytes).toBe(0);
		expect(state.used.ticks).toBe(1);
		expect(readFileSync(path, "utf8")).toBe("PRIVATE_PREIMAGE");
		expect(h.getPendingResponseCount()).toBe(1);
	});
	it("returns typed undispatched correction to the provider and public events, then executes corrected arguments", async () => {
		const h = await createHarness();
		harnesses.push(h);
		writeFileSync(join(h.tempDir, "a.txt"), "old");
		let correctionRef: string | undefined;
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "a.txt", password: "fixture-sensitive-value" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				const message = context.messages.findLast((message) => message.role === "toolResult");
				expect(message?.role).toBe("toolResult");
				if (message?.role !== "toolResult") throw new Error("Missing correction feedback");
				const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
				const parsed: unknown = JSON.parse(text);
				expect(parsed).toMatchObject({
					failure: {
						code: "INVALID_ACTION_SCHEMA",
						operation_id: null,
						target_binding_ref: null,
						retry: { automatic: false },
					},
				});
				if (
					!parsed ||
					typeof parsed !== "object" ||
					!("failure_ref" in parsed) ||
					typeof parsed.failure_ref !== "string"
				)
					throw new Error("Missing failure reference");
				correctionRef = parsed.failure_ref;
				expect(text).not.toContain("fixture-sensitive-value");
				expect(readFileSync(join(h.tempDir, "a.txt"), "utf8")).toBe("old");
				expect(h.session.sandhana.state!.used.execution).toBe(0);
				return fauxAssistantMessage(fauxToolCall("write", { path: "a.txt", content: "new" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("This decision must remain unused"),
		]);
		await h.session.prompt(
			`padma: ${JSON.stringify({ objective: "replace exact bytes", allow_edits: true, requirements: [{ text: "new bytes", rule: "CONTENT", target: "a.txt", expected: "new" }] })}`,
		);
		const kernel = h.session.sandhana;
		const state = kernel.state!;
		expect(kernel.terminal?.status, h.session.getLastAssistantText()).toBe("VERIFIED_COMPLETE");
		expect(state.used.ticks).toBe(2);
		expect(state.used.execution).toBe(1);
		expect(state.used.input_tokens).toBeGreaterThan(0);
		expect(readFileSync(join(h.tempDir, "a.txt"), "utf8")).toBe("new");
		const failure = kernel.store.get(state.mission_id, correctionRef!, "EvidenceRecord");
		expect(isFailure(failure.failure)).toBe(true);
		expect(Value.Check(ProposalFailureSchema, failure.payload)).toBe(true);
		expect(failure.payload).toMatchObject({ count: 1 });
		const publicResult = h.eventsOfType("tool_execution_end")[0].result;
		expect(publicResult.details).toMatchObject({ failure_ref: correctionRef });
		expect(JSON.stringify(publicResult)).not.toContain("fixture-sensitive-value");
		const charges = state.reservations
			.map((ref) => kernel.store.get(state.mission_id, ref, "BudgetReservation"))
			.filter((charge) => charge.owner_operation_id === `proposal-feedback:${correctionRef}`);
		expect(charges).toHaveLength(1);
		expect(charges[0].actual).toMatchObject({
			execution: 0,
			ticks: 0,
			output_bytes: Buffer.byteLength(JSON.stringify(publicResult)),
		});
		expect(h.getPendingResponseCount()).toBe(1);
	});
	it("keeps the invalid-proposal bound across resume and fences a later write in the same batch", async () => {
		const h = await createHarness({
			sandhanaConfiguration: { version: "sandhana/1", stagnation: { diagnose: 1, stop: 3 } },
		});
		harnesses.push(h);
		writeFileSync(join(h.tempDir, "a.txt"), "old");
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("future_worker", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture stops before candidate acceptance" }),
		]);
		await h.session.prompt(
			`padma: ${JSON.stringify({ objective: "replace exact bytes", allow_edits: true, requirements: [{ text: "new bytes", rule: "CONTENT", target: "a.txt", expected: "new" }] })}`,
		);
		const kernel = h.session.sandhana;
		const previous = kernel.terminal!;
		expect(previous.status).toBe("EXECUTION_FAILED");
		const executionBeforeResume = kernel.state!.used.execution;
		expect(executionBeforeResume).toBe(0);
		expect(kernel.state!.used.ticks).toBe(2);
		h.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("write", { path: "a.txt" }, { id: "same-id" }),
					fauxToolCall("future_worker", {}, { id: "same-id" }),
					fauxToolCall("write", { path: "a.txt", content: "new" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("This decision must remain unused"),
		]);
		await h.session.prompt(`resume ${previous.mission_id}`);
		const state = kernel.state!;
		expect(kernel.terminal?.status, h.session.getLastAssistantText()).toBe("EXECUTION_FAILED");
		expect(readFileSync(join(h.tempDir, "a.txt"), "utf8")).toBe("old");
		expect(state.used.execution).toBe(executionBeforeResume);
		expect(state.used.ticks).toBe(3);
		const failures = kernel.store
			.records(state.mission_id)
			.filter((record) => record.record_type === "EvidenceRecord" && record.stage === "proposal-failure");
		expect(failures).toHaveLength(3);
		expect(
			failures.map((record) =>
				record.record_type === "EvidenceRecord" && Value.Check(ProposalFailureSchema, record.payload)
					? record.payload.count
					: null,
			),
		).toEqual([1, 2, 3]);
		expect(kernel.store.get(state.mission_id, previous.record_id, "TerminalReport")).toEqual(previous);
		for (const event of h.eventsOfType("tool_execution_end")) {
			const details: unknown = event.result.details;
			if (
				!details ||
				typeof details !== "object" ||
				!("failure_ref" in details) ||
				typeof details.failure_ref !== "string" ||
				!("sandhana_failure" in details) ||
				!isFailure(details.sandhana_failure)
			)
				continue;
			expect(kernel.store.get(state.mission_id, details.failure_ref, "EvidenceRecord").failure).toEqual(
				details.sandhana_failure,
			);
		}
		expect(h.getPendingResponseCount()).toBe(1);
	});
	it("retains rejection evidence and stops before dispatch when typed correction cannot fit the output view", async () => {
		const h = await createHarness({ sandhanaConfiguration: { version: "sandhana/1", view: { tool_chars: 32 } } });
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("future_worker", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("This decision must remain unused"),
		]);
		await h.session.prompt("Inspect the parser behavior");
		const kernel = h.session.sandhana;
		const state = kernel.state!;
		expect(kernel.terminal?.status, h.session.getLastAssistantText()).toBe("BUDGET_EXHAUSTED");
		expect(state.used.execution).toBe(0);
		expect(state.used.ticks).toBe(1);
		expect(
			kernel.terminal?.failure_refs?.map(
				(ref) => kernel.store.get(state.mission_id, ref, "EvidenceRecord").failure?.code,
			),
		).toContain("UNREGISTERED_OPERATION");
		expect(h.eventsOfType("tool_execution_end")).toHaveLength(0);
		expect(h.getPendingResponseCount()).toBe(1);
	});
	it("rejects a malformed new command without settling or finalizing the previous open decision", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const kernel = h.session.sandhana;
		kernel.captureInput("Inspect the parser behavior", "USER");
		kernel.begin("");
		const reservation = kernel.reserveModel(100, 100);
		kernel.beginCognitiveTick(reservation);
		const state = kernel.state!;
		const records = kernel.store.records(state.mission_id);
		h.setResponses([fauxAssistantMessage("This provider decision must remain unused")]);
		await h.session.prompt("padma: {");
		expect(kernel.state).toEqual(state);
		expect(kernel.store.records(state.mission_id)).toEqual(records);
		expect(kernel.terminal).toBeNull();
		expect(kernel.store.get(state.mission_id, state.cognitive_tick!, "CognitiveTick").status).toBe("OPEN");
		expect(h.session.getLastAssistantText()).toContain("The task could not be completed.");
		expect(h.getPendingResponseCount()).toBe(1);
		expect(h.eventsOfType("agent_end")).toHaveLength(1);
	});
	it("retains the provider failure and charged decision when cognitive tick settlement fails", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const store = h.session.sandhana.store;
		const commit = store.commit.bind(store);
		vi.spyOn(store, "commit").mockImplementation((expected, state, records, artifacts) => {
			if (records.some((record) => record.record_type === "CognitiveTick" && record.status === "SETTLED"))
				throw new Error("fixture tick persistence failure");
			return commit(expected, state, records, artifacts);
		});
		h.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "fixture provider failure: PREIMAGE_CONFLICT sk-fixtureCredential123456789",
			}),
			fauxAssistantMessage("This extra decision must remain unused"),
		]);
		await h.session.prompt("Inspect the parser behavior");
		const kernel = h.session.sandhana;
		const state = kernel.state!;
		expect(kernel.terminal?.status, h.session.getLastAssistantText()).toBe("EXECUTION_FAILED");
		expect(
			kernel.terminal?.failure_refs?.map((ref) => store.get(state.mission_id, ref, "EvidenceRecord").failure?.code),
		).toContain("PROVIDER_FAILURE");
		expect(h.session.getLastAssistantText()).toContain("fixture provider failure");
		expect(h.session.getLastAssistantText()).not.toContain("sk-fixtureCredential123456789");
		expect(h.session.getLastAssistantText()).toContain("fixture tick persistence failure");
		expect(store.get(state.mission_id, state.cognitive_tick!, "CognitiveTick").status).toBe("OPEN");
		expect(state.used.ticks).toBe(1);
		expect(state.used.execution).toBe(0);
		expect(state.operations).toEqual([]);
		expect(h.getPendingResponseCount()).toBe(1);
		expect(h.eventsOfType("agent_end")).toHaveLength(1);
		expect(store.get(state.mission_id, state.command, "CommandSpecification").original_instruction).toBe(
			"Inspect the parser behavior",
		);
	});
	it("keeps an actual uncertain effect and its reservation when tick settlement also fails", async () => {
		let calls = 0;
		let target = "";
		let environment: NodeJS.ProcessEnv = {};
		const tool = {
			name: "bash",
			label: "Lost fixture response",
			description: "Actual local fixture effect",
			parameters: Type.Object({ command: Type.String(), cwd: Type.String(), timeout: Type.Optional(Type.Number()) }),
			execute: async (_id: string, value: unknown) => {
				const args = value as { command: string; cwd: string };
				assertShellDispatchReady({ command: args.command, cwd: args.cwd, env: environment });
				calls++;
				writeFileSync(target, "actual effect");
				throw new Error("fixture response lost after effect");
			},
		};
		const h = await createHarness({ tools: [tool] });
		harnesses.push(h);
		h.session.sandhana.register(tool, "bash");
		environment = { ...getShellEnv() };
		for (const key of [
			"PADMA_SESSION_ID",
			"PADMA_SESSION_FILE",
			"PADMA_PROVIDER",
			"PADMA_MODEL",
			"PADMA_REASONING_LEVEL",
		])
			delete environment[key];
		environment.PADMA_SESSION_ID = h.session.sessionId;
		environment.PADMA_PROVIDER = h.getModel().provider;
		environment.PADMA_MODEL = h.getModel().id;
		environment.PADMA_REASONING_LEVEL = h.session.thinkingLevel;
		target = join(h.tempDir, "effect.txt");
		writeFileSync(join(h.tempDir, "check.cjs"), "// exact declared fixture command\n");
		const store = h.session.sandhana.store;
		const commit = store.commit.bind(store);
		vi.spyOn(store, "commit").mockImplementation((expected, state, records, artifacts) => {
			if (records.some((record) => record.record_type === "CognitiveTick" && record.status === "SETTLED")) {
				throw new Error("fixture tick persistence failure");
			}
			return commit(expected, state, records, artifacts);
		});
		h.setResponses([
			fauxAssistantMessage({
				type: "toolCall",
				id: "uncertain-effect",
				name: "bash",
				arguments: { command: "node check.cjs", cwd: h.tempDir },
			}),
			fauxAssistantMessage("This extra decision must remain unused"),
		]);
		await h.session.prompt("run: node check.cjs");
		const kernel = h.session.sandhana;
		const state = kernel.state!;
		expect(state.operations, h.session.getLastAssistantText()).toHaveLength(1);
		const operation = store.get(state.mission_id, state.operations[0], "OperationRecord");
		expect(kernel.terminal?.status).toBe("OUTCOME_UNKNOWN");
		expect(kernel.terminal?.unknown_operation).toBe(operation.operation_id);
		expect(store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord").failure).toMatchObject({
			code: "EFFECT_OUTCOME_UNKNOWN",
			operation_id: operation.operation_id,
			retry: { automatic: false },
		});
		expect(operation.status).toBe("OUTCOME_UNKNOWN");
		expect(operation.result_refs.length).toBeGreaterThan(0);
		expect(store.get(state.mission_id, operation.reservation_ref!, "BudgetReservation").state).toBe("RETAINED");
		expect(store.get(state.mission_id, state.cognitive_tick!, "CognitiveTick").status).toBe("OPEN");
		expect(state.used.execution).toBe(1);
		expect(state.used.ticks).toBe(1);
		expect(calls).toBe(1);
		expect(readFileSync(target, "utf8")).toBe("actual effect");
		expect(h.session.getLastAssistantText()).toContain("fixture tick persistence failure");
		expect(h.getPendingResponseCount()).toBe(1);
		expect(h.eventsOfType("agent_end")).toHaveLength(1);
	});
	it("resumes a stopped open decision before requesting the next provider response", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const kernel = h.session.sandhana;
		const store = kernel.store;
		const commit = store.commit.bind(store);
		const failure = vi.spyOn(store, "commit").mockImplementation((expected, state, records, artifacts) => {
			if (records.some((record) => record.record_type === "CognitiveTick" && record.status === "SETTLED"))
				throw new Error("fixture tick persistence failure");
			return commit(expected, state, records, artifacts);
		});
		const failed = fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture provider failure" });
		failed.usage = { ...failed.usage, input: 1, totalTokens: 1 };
		h.setResponses([failed]);
		await h.session.prompt("Inspect the parser behavior");
		const stopped = kernel.state!;
		const report = kernel.terminal!;
		expect(store.get(stopped.mission_id, stopped.cognitive_tick!, "CognitiveTick").status).toBe("OPEN");
		failure.mockRestore();
		h.setResponses([
			() => {
				expect(kernel.state!.mission_id).toBe(stopped.mission_id);
				expect(kernel.state!.stagnation).toBe(1);
				expect(kernel.state!.used.ticks).toBe(2);
				return fauxAssistantMessage("The parser behavior remains unverified");
			},
			fauxAssistantMessage("This extra decision must remain unused"),
		]);
		await h.session.prompt(`resume ${stopped.mission_id}`);
		expect(kernel.state!.used.ticks).toBe(2);
		expect(kernel.state!.used.execution).toBe(0);
		expect(kernel.state!.started_at).toBe(stopped.started_at);
		expect(store.get(stopped.mission_id, report.record_id, "TerminalReport")).toEqual(report);
		expect(store.records(stopped.mission_id).filter((record) => record.record_type === "ResumeRecord")).toHaveLength(
			1,
		);
		expect(h.getPendingResponseCount(), h.session.getLastAssistantText()).toBe(1);
		expect(h.eventsOfType("agent_end")).toHaveLength(2);
	});
});
