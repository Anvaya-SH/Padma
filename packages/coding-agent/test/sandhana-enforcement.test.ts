import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localCheck } from "../src/core/sandhana/checks.ts";
import { bindTarget, signalsForExact } from "../src/core/sandhana/code.ts";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import {
	canonical,
	digest,
	type HypothesisProposal,
	makeRecord,
	type Resources,
	resources,
	validateMissionState,
} from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createBashTool, createReadTool, createWriteTool } from "../src/core/tools/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(limits?: Partial<Resources>, beforeDispatch?: () => Promise<void>) {
	const cwd = mkdtempSync(join(tmpdir(), "padma-enforcement-"));
	const store = new MissionStore(":memory:");
	const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "enforcement", store, limits, beforeDispatch });
	const read = kernel.register(createReadTool(cwd), "read");
	const write = kernel.register(createWriteTool(cwd), "write");
	const bash = kernel.register(createBashTool(cwd), "bash");
	cleanups.push(() => {
		store.close();
		rmSync(cwd, { recursive: true, force: true });
	});
	return {
		cwd,
		store,
		kernel,
		read,
		write,
		bash,
		start: (instruction: string) => {
			kernel.captureInput(instruction, "USER");
			return kernel.begin(instruction);
		},
	};
}
describe("Sandhana evidence and recovery enforcement", () => {
	it("invalid JSON cannot be silently converted into a different durable payload", () => {
		const sparse = Array<unknown>(2);
		sparse[1] = "x";
		for (const value of [undefined, NaN, Infinity, () => 1, new Date(), { key: undefined }, sparse])
			expect(() => canonical(value)).toThrow();
		const circular: { self?: unknown } = {};
		circular.self = circular;
		expect(() => canonical(circular)).toThrow("Circular");
		expect(canonical({ z: 1, a: { b: 2 } })).toBe('{"a":{"b":2},"z":1}');
	});
	it("a passing process cannot verify a later change to an existing observed source file", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "good");
		writeFileSync(
			join(f.cwd, "check.cjs"),
			"require('node:assert/strict').equal(require('node:fs').readFileSync('a.txt','utf8'), 'good');",
		);
		f.start(
			`padma: ${JSON.stringify({ objective: "check behavior", shell_commands: ["node check.cjs"], requirements: [{ text: "check", rule: "PROCESS", target: ".", expected: "node check.cjs" }] })}`,
		);
		await f.read.execute("read", { path: "a.txt" });
		await f.bash.execute("check", { command: "node check.cjs" });
		expect(f.kernel.ready()).toBe(true);
		writeFileSync(join(f.cwd, "a.txt"), "bad!");
		expect(f.kernel.ready()).toBe(false);
		expect(f.kernel.finalize().status).toBe("PARTIALLY_COMPLETE");
	});
	it("content dependencies invalidate proof and a current complete read can establish it again", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "old");
		writeFileSync(join(f.cwd, "dependency.txt"), "before");
		f.start(
			`padma: ${JSON.stringify({
				objective: "exact content with a declared dependency",
				allow_edits: true,
				requirements: [
					{ text: "content", rule: "CONTENT", target: "a.txt", expected: "new", dependencies: ["dependency.txt"] },
				],
			})}`,
		);
		await f.kernel.execute("write", "candidate", { path: "a.txt", content: "new" });
		expect(f.kernel.ready()).toBe(true);
		writeFileSync(join(f.cwd, "dependency.txt"), "after");
		expect(f.kernel.ready()).toBe(false);
		await f.kernel.runAcceptanceChecks(new AbortController().signal);
		expect(f.kernel.ready()).toBe(true);
		const state = f.kernel.state!;
		const requirement = f.store.get(state.mission_id, state.requirements[0], "Requirement");
		const evidence = f.store.get(state.mission_id, requirement.evidence[0], "EvidenceRecord");
		const observation = f.store.get(state.mission_id, evidence.sources[0], "EvidenceRecord");
		expect(evidence.payload).toMatchObject({ dependencies: { [join(f.cwd, "dependency.txt")]: expect.any(String) } });
		expect(f.store.artifact(state.mission_id, observation.artifact_ref!).toString()).toContain('"text":"new"');
		const forged = makeRecord(state.mission_id, state.revision + 1, "EvidenceRecord", {
			...evidence,
			payload: { ...(evidence.payload as object), dependencies: {} },
		});
		// The payload digest must be valid so this attacks rule applicability, not serialization.
		const validDigest = makeRecord(state.mission_id, state.revision + 1, "EvidenceRecord", {
			...forged,
			digest: digest(forged.payload),
		});
		expect(() => f.store.commit(state.revision, { ...state, revision: state.revision + 1 }, [validDigest])).toThrow(
			"dependency vector",
		);
		expect(f.kernel.finalize().status).toBe("VERIFIED_COMPLETE");
		expect(f.kernel.state!.used.execution).toBe(2);
	});
	it("a dependency changed during dispatch produces inconclusive content proof", async () => {
		let changed = false;
		const f = fixture(undefined, async () => {
			if (!changed) {
				writeFileSync(join(f.cwd, "dependency.txt"), "changed during dispatch");
				changed = true;
			}
		});
		writeFileSync(join(f.cwd, "dependency.txt"), "before");
		f.start(
			`padma: ${JSON.stringify({
				objective: "content",
				allow_edits: true,
				requirements: [
					{ text: "content", rule: "CONTENT", target: "a.txt", expected: "new", dependencies: ["dependency.txt"] },
				],
			})}`,
		);
		await f.kernel.execute("write", "candidate", { path: "a.txt", content: "new" });
		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("new");
		expect(f.kernel.ready()).toBe(false);
		const state = f.kernel.state!;
		const req = f.store.get(state.mission_id, state.requirements[0], "Requirement");
		expect(f.store.get(state.mission_id, req.evidence[0], "EvidenceRecord").payload).toMatchObject({
			result: "INCONCLUSIVE",
		});
		await f.kernel.runAcceptanceChecks(new AbortController().signal);
		expect(f.kernel.finalize().status).toBe("VERIFIED_COMPLETE");
	});
	it("a partial read cannot verify content and a full mismatching read records a concrete failure", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "wrong\nsecond");
		f.start(
			`padma: ${JSON.stringify({ objective: "inspect exact bytes", requirements: [{ text: "content", rule: "CONTENT", target: "a.txt", expected: "right" }] })}`,
		);
		await f.kernel.execute("read", "partial", { path: "a.txt", limit: 1 });
		expect(f.kernel.ready()).toBe(false);
		await f.kernel.runAcceptanceChecks(new AbortController().signal);
		const report = f.kernel.finalize();
		expect(report.status).toBe("EXECUTION_FAILED");
		expect(
			f.store.get(report.mission_id, report.verification_report_ref!, "VerificationReport").results[0].result,
		).toBe("FAILED");
	});
	it("restoration is another governed operation and cannot overwrite an intervening user edit", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "old");
		f.start("Fix a.txt");
		await f.write.execute("write", { path: "a.txt", content: "new" });
		const state = f.kernel.state!;
		const checkpoint = state.checkpoints[0];
		const expected = bindTarget(f.cwd, "a.txt", state.mission_id, state.revision + 1, "enforcement").generation;
		await f.kernel.restoreCheckpoint(checkpoint, expected);
		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("old");
		expect(f.kernel.state!.used.execution).toBe(2);
		writeFileSync(join(f.cwd, "a.txt"), "human edit");
		await expect(f.kernel.restoreCheckpoint(checkpoint, expected)).rejects.toThrow("PREIMAGE_CONFLICT");
		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("human edit");
		expect(f.kernel.state!.used.execution).toBe(2);
	});
	it("a created file with missing parents has a real guarded absence restoration", async () => {
		const f = fixture();
		f.start("Create nested/a.txt");
		await f.write.execute("write", { path: "nested/a.txt", content: "new" });
		const state = f.kernel.state!;
		const expected = bindTarget(
			f.cwd,
			"nested/a.txt",
			state.mission_id,
			state.revision + 1,
			"enforcement",
		).generation;
		await f.kernel.restoreCheckpoint(state.checkpoints[0], expected);
		expect(existsSync(join(f.cwd, "nested/a.txt"))).toBe(false);
		expect(f.kernel.state!.used.execution).toBe(2);
	});
	it("cost and retrieval reservations compete in the same transaction as other resources", () => {
		const f = fixture();
		f.start("Fix a.txt");
		for (const dimension of ["cost", "retrieval_bytes", "ticks", "elapsed_ms"] as const) {
			const state = f.kernel.state!;
			const amount = (state.ceilings[dimension] ?? 0) + 1;
			const reservation = makeRecord(state.mission_id, state.revision + 1, "BudgetReservation", {
				owner_operation_id: `resource:${dimension}`,
				amounts: { ...resources(), [dimension]: amount },
				protected_for_verification: false,
				state: "RESERVED",
				actual: null,
			});
			expect(() =>
				f.store.commit(
					state.revision,
					{ ...state, revision: state.revision + 1, reservations: [reservation.record_id] },
					[reservation],
				),
			).toThrow("ceiling");
			expect(f.kernel.state!.revision).toBe(state.revision);
		}
	});
	it("source reads are admitted before IO and every recheck settles into the same ledger", async () => {
		const blocked = fixture({ retrieval_bytes: 3 });
		writeFileSync(join(blocked.cwd, "a.txt"), "data");
		blocked.start("read a.txt");
		expect(await blocked.read.execute("read", { path: "a.txt" })).toMatchObject({
			details: { sandhana_stop: "BUDGET_EXHAUSTED" },
		});
		expect(blocked.kernel.state!.used.execution).toBe(0);
		expect(blocked.kernel.state!.used.retrieval_bytes).toBe(0);
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "data");
		f.start("read a.txt");
		await f.read.execute("read", { path: "a.txt" });
		f.kernel.finalize();
		const state = f.kernel.state!;
		const charged = state.reservations
			.map((id) => f.store.get(state.mission_id, id, "BudgetReservation"))
			.filter((item) => item.owner_operation_id.startsWith("retrieval:") || item.capture_operation_ref !== undefined)
			.reduce((sum, item) => sum + (item.actual?.retrieval_bytes ?? 0), 0);
		expect(state.used.retrieval_bytes).toBeGreaterThan(4);
		expect(charged).toBe(state.used.retrieval_bytes);
	});
	it("reopening a terminal mission projects the same report without executing it again", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "data");
		f.start("read a.txt");
		await f.read.execute("read", { path: "a.txt" });
		const report = f.kernel.finalize();
		const reconnected = new SandhanaKernel({ cwd: () => f.cwd, session: () => "enforcement", store: f.store });
		expect(reconnected.terminal).toEqual(report);
		expect(reconnected.state!.used.execution).toBe(1);
		expect(reconnected.finalize().record_id).toBe(report.record_id);
	});
	it("explicit preservation clauses and later amendments remain mandatory without resetting cost", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "old");
		f.start("Fix empty parser values; preserve valid values");
		await f.read.execute("read", { path: "a.txt" });
		const before = f.kernel.state!;
		expect(before.requirements).toHaveLength(2);
		f.kernel.amend("Also preserve comments");
		const after = f.kernel.state!;
		expect(after.requirements).toHaveLength(3);
		expect(after.used.execution).toBe(before.used.execution);
		expect(f.store.get(after.mission_id, after.command, "CommandSpecification").original_instruction).toBe(
			"Fix empty parser values; preserve valid values",
		);
		expect(after.authorizations).toEqual(before.authorizations);
		expect(f.kernel.finalize().remaining).toHaveLength(3);
	});
	it("duplicate model usage settles exactly once and conflicting measurements are rejected", () => {
		const f = fixture();
		f.start("Fix a.txt");
		const reservation = f.kernel.reserveModel(100, 100, 1);
		const usage = { input: 10, output: 20, cacheRead: 5, cacheWrite: 0, cost: { total: 0.1 } };
		f.kernel.reconcileModel(reservation, usage, 10);
		const state = f.kernel.state!;
		f.kernel.reconcileModel(reservation, usage, 10);
		expect(f.kernel.state).toEqual(state);
		const persisted = f.store.get(state.mission_id, state.reservations[0], "BudgetReservation");
		expect(persisted.actual?.input_tokens).toBe(15);
		f.kernel.reconcileModel(reservation, usage, 10);
		expect(() => f.kernel.reconcileModel(reservation, { ...usage, output: 21 }, 10)).toThrow("ID_PAYLOAD_CONFLICT");
	});
	it("actual model overrun settles with other reservations outstanding and forbids another launch", async () => {
		const f = fixture({ cost: 3 });
		f.start("Fix a.txt");
		const first = f.kernel.reserveModel(100, 100, 1);
		const second = f.kernel.reserveModel(100, 100, 1);
		const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 4 } };
		f.kernel.reconcileModel(first, usage, 10);
		expect(f.kernel.state!.used.cost).toBe(4);
		expect(() => f.kernel.reserveModel(100, 100)).toThrow("ceiling");
		await expect(f.kernel.execute("read", "after-overrun", { path: "a.txt" })).rejects.toThrow("no further launch");
		f.kernel.reconcileModel(second, { ...usage, cost: { total: 0.1 } }, 5);
		expect(f.kernel.state!.used.cost).toBe(4.1);
		const report = f.kernel.finalize();
		expect(report.status).toBe("BUDGET_EXHAUSTED");
		const modelOwners = [first, second].map(
			(ref) => f.store.get(report.mission_id, ref, "BudgetReservation").owner_operation_id,
		);
		expect(
			f.kernel
				.state!.reservations.map((id) => f.store.get(f.kernel.state!.mission_id, id, "BudgetReservation"))
				.filter((item) => modelOwners.includes(item.owner_operation_id))
				.map((item) => item.state),
		).toEqual(["RECONCILED", "RECONCILED"]);
		expect(f.store.get(report.mission_id, report.output_reservation_ref!, "BudgetReservation")).toMatchObject({
			state: "RECONCILED",
			actual: { execution: 0 },
			owner_operation_id: `terminal:${f.kernel.state!.contract}`,
		});
	});
	it("post-dispatch retrieval exhaustion retains the actual successful process result", async () => {
		const script = "console.log('retained actual result');";
		const f = fixture({ retrieval_bytes: Buffer.byteLength(script) + 1 });
		writeFileSync(join(f.cwd, "check.cjs"), script);
		f.start("run: node check.cjs");
		await expect(f.kernel.execute("bash", "launched", { command: "node check.cjs" })).rejects.toThrow(
			"retrieval reservation",
		);
		const state = f.kernel.state!;
		expect(state.used.execution).toBe(1);
		const operation = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
		expect(operation.status).toBe("CONFIRMED_COMPLETE");
		const result = f.store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
		expect(result.payload).toMatchObject({
			dependencies_unchanged: false,
			capture_limitations: [expect.stringContaining("retrieval")],
		});
		const actual = JSON.parse(f.store.artifact(state.mission_id, result.artifact_ref!).toString()) as {
			structuredContent: { exit_code: number };
			content: { text: string }[];
		};
		expect(actual.structuredContent.exit_code).toBe(0);
		expect(actual.content[0].text).toContain("retained actual result");
		expect(f.kernel.finalize("BUDGET_EXHAUSTED").status).toBe("BUDGET_EXHAUSTED");
	});
	it("an uncertain last permitted invocation retains its result without reserving the invocation twice", async () => {
		const f = fixture({ execution: 7 });
		writeFileSync(join(f.cwd, "check.cjs"), "console.log('settled');");
		f.start("run: node check.cjs");
		for (let index = 0; index < 6; index++)
			await f.kernel.execute("bash", `settled:${index}`, { command: "node check.cjs" });
		writeFileSync(
			join(f.cwd, "check.cjs"),
			"require('node:fs').writeFileSync('effect.txt','committed'); setTimeout(() => {}, 10000);",
		);
		// Allow native process startup on loaded Windows hosts before timing out the ten-second wait.
		await expect(f.kernel.execute("bash", "uncertain", { command: "node check.cjs", timeout: 3 })).rejects.toThrow(
			"may have taken effect",
		);
		const state = f.kernel.state!;
		expect(state.used.execution).toBe(7);
		expect(readFileSync(join(f.cwd, "effect.txt"), "utf8")).toBe("committed");
		const operation = f.store.get(state.mission_id, state.operations.at(-1)!, "OperationRecord");
		expect(operation.status).toBe("OUTCOME_UNKNOWN");
		expect(operation.result_refs).toHaveLength(1);
		const reservation = f.store.get(state.mission_id, operation.reservation_ref!, "BudgetReservation");
		expect(reservation).toMatchObject({ state: "RETAINED", amounts: { execution: 0 }, actual: { execution: 1 } });
		await expect(f.kernel.execute("bash", "duplicate", { command: "node check.cjs" })).rejects.toThrow(
			"Unresolved operation",
		);
		expect(f.kernel.finalize().status).toBe("OUTCOME_UNKNOWN");
	});
	it("a repair instruction covers scoped local tests without granting arbitrary shell execution or semantic proof", async () => {
		const f = fixture();
		writeFileSync(
			join(f.cwd, "parser.test.cjs"),
			"const test = require('node:test'); const assert = require('node:assert/strict'); test('local assertion', () => assert.equal(1,1));",
		);
		f.start("Fix empty parser values; preserve valid values");
		const result = await f.kernel.execute("bash", "test", { command: "node --test parser.test.cjs" });
		expect(result.structuredContent).toMatchObject({ exit_code: 0 });
		expect(f.kernel.state!.used.execution).toBe(1);
		expect(f.kernel.ready()).toBe(false);
		await expect(f.kernel.execute("bash", "arbitrary", { command: "printf unrelated" })).rejects.toThrow(
			"does not cover",
		);
		expect(f.kernel.state!.used.execution).toBe(1);
		for (const command of [
			"node --test ../escape.test.cjs",
			"node --test parser.test.cjs; printf injected",
			"node --require preload.cjs --test parser.test.cjs",
			"node --test $(printf parser.test.cjs)",
			"node --test parser.test.cjs > output.txt",
			"node arbitrary.cjs",
		])
			expect(localCheck(command, f.cwd)).toBeNull();
	});
	it("revoked literal shell authority cannot mint a fresh grant on a later proposal", async () => {
		const f = fixture();
		f.start("run: printf forbidden");
		f.kernel.revoke();
		await expect(f.kernel.execute("bash", "after-revocation", { command: "printf forbidden" })).rejects.toThrow(
			"does not cover",
		);
		expect(f.kernel.state!.used.execution).toBe(0);
	});
	it("persisted state rejects malformed phases, fractional dispatch usage and duplicate owner reservations", () => {
		const f = fixture();
		f.start("Fix a.txt");
		const state = f.kernel.state!;
		expect(() => validateMissionState({ ...state, phase: "OPTIMISTIC_SUCCESS" })).toThrow("schema");
		expect(() => validateMissionState({ ...state, used: { ...state.used, execution: 0.5 } })).toThrow("schema");
		for (const execution of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
			expect(() =>
				makeRecord(state.mission_id, state.revision + 1, "BudgetReservation", {
					owner_operation_id: "invalid-actual",
					amounts: resources(),
					protected_for_verification: false,
					state: "RECONCILED",
					actual: { ...resources(), execution },
				}),
			).toThrow("schema");
		const first = makeRecord(state.mission_id, state.revision + 1, "BudgetReservation", {
			owner_operation_id: "same-owner",
			amounts: resources(),
			protected_for_verification: false,
			state: "RESERVED",
			actual: null,
		});
		const second = makeRecord(state.mission_id, state.revision + 1, "BudgetReservation", { ...first });
		expect(() =>
			f.store.commit(
				state.revision,
				{ ...state, revision: state.revision + 1, reservations: [first.record_id, second.record_id] },
				[first, second],
			),
		).toThrow("Duplicate reservation owner");
	});
	it("binding metadata or model verdicts cannot replace actual governed result proof", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "data");
		f.start("read a.txt");
		await f.kernel.execute("read", "read", { path: "a.txt" });
		const state = f.kernel.state!;
		const events = f.store.records(state.mission_id).filter((record) => record.record_type === "EvidenceRecord");
		const verification = events.find((event) => event.kind === "VERIFICATION")!;
		const binding = events.find((event) => event.stage === "adana" && event.kind === "OBSERVATION")!;
		for (const fields of [{ sources: [binding.record_id] }, { provenance: "MODEL" as const }]) {
			const forged = makeRecord(state.mission_id, state.revision + 1, "EvidenceRecord", {
				...verification,
				...fields,
			});
			expect(() => f.store.commit(state.revision, { ...state, revision: state.revision + 1 }, [forged])).toThrow();
		}
		const original = f.store.get(state.mission_id, state.requirements[0], "Requirement");
		const weakened = makeRecord(state.mission_id, state.revision + 1, "Requirement", {
			...original,
			text: "Just claim success",
			mandatory: false,
		});
		expect(() =>
			f.store.commit(
				state.revision,
				{ ...state, revision: state.revision + 1, requirements: [weakened.record_id] },
				[weakened],
			),
		).toThrow("explicit user amendment");
	});
	it("a decisive failed experiment resolves a hypothesis and canonical target aliases cannot reopen it", async () => {
		const f = fixture();
		f.start("run: printf refuted; exit 1");
		const hypothesis: HypothesisProposal = {
			target: ".",
			cause: "INPUT_FORMAT",
			mechanism: "VALIDATE",
			failure_signature: "refuted",
			expected_result: "supported",
		};
		expect(f.kernel.proposeHypothesis(hypothesis)).toBe(true);
		const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
		for (let index = 0; index < 3; index++) {
			const reservation = f.kernel.reserveModel(10, 10);
			f.kernel.beginCognitiveTick(reservation);
			f.kernel.reconcileModel(reservation, usage, 1);
			f.kernel.finishCognitiveTick();
		}
		expect(f.kernel.state!.stagnation).toBe(3);
		const reservation = f.kernel.reserveModel(10, 10);
		f.kernel.beginCognitiveTick(reservation);
		f.kernel.reconcileModel(reservation, usage, 1);
		await f.kernel.execute("bash", "diagnostic", { command: "printf refuted; exit 1" });
		f.kernel.finishCognitiveTick();
		expect(f.kernel.state!.stagnation).toBe(0);
		expect(f.kernel.proposeHypothesis({ ...hypothesis, target: f.cwd })).toBe(false);
		const current = f.kernel.state!;
		expect(f.store.get(current.mission_id, current.hypotheses[0], "Hypothesis").attempts).toBe(1);
	});
	it("deep-route branches need observations, enforce depth two and attach corrections only to the selected branch", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "root observation\nchild observation\nleaf observation\n");
		for (const name of ["first.cjs", "second.cjs"])
			writeFileSync(join(f.cwd, name), "console.log('refuted'); process.exitCode = 1;");
		f.start(
			`padma: ${JSON.stringify({
				objective: "Fix this component",
				allow_edits: true,
				shell_commands: ["node first.cjs", "node second.cjs"],
				requirements: [{ text: "component behavior", rule: "SEMANTIC", target: "." }],
			})}`,
		);
		for (const [mechanism, command] of [
			["VALIDATE", "node first.cjs"],
			["NORMALIZE", "node second.cjs"],
		] as const) {
			expect(
				f.kernel.proposeHypothesis({
					target: ".",
					cause: "CONFIGURATION",
					mechanism,
					failure_signature: "refuted",
					expected_result: "supported",
				}),
			).toBe(true);
			await f.kernel.execute("bash", mechanism, { command });
		}
		const before = f.kernel.state!;
		const evidence = before.hypotheses.flatMap(
			(ref) => f.store.get(before.mission_id, ref, "Hypothesis").contradicting,
		);
		const signals = signalsForExact(false);
		signals.H = { severity: 2, provenance: "HISTORY", evidence };
		signals.A = { severity: 1, provenance: "HISTORY", evidence };
		f.kernel.escalate(signals);
		expect(f.kernel.state!.route).toBe("GAMBHIRA");
		expect(f.kernel.state!.ceilings).toEqual(before.ceilings);
		const fields: HypothesisProposal = {
			target: "a.txt",
			cause: "INPUT_FORMAT",
			mechanism: "INVESTIGATE",
			failure_signature: "ALPHA_FAILURE",
			expected_result: "ALPHA_SUCCESS",
		};
		expect(f.kernel.proposeHypothesis(fields)).toBe(true);
		const root = f.kernel.state!.leading_hypothesis!;
		expect(f.kernel.proposeHypothesis({ ...fields, mechanism: "NORMALIZE", parent_ref: root })).toBe(false);
		await f.kernel.execute("read", "premise", { path: "a.txt", offset: 1, limit: 1 });
		expect(f.kernel.proposeHypothesis({ ...fields, mechanism: "NORMALIZE", parent_ref: root })).toBe(true);
		const child = f.kernel.state!.leading_hypothesis!;
		expect(f.kernel.proposeHypothesis({ ...fields, mechanism: "TRACE", parent_ref: child })).toBe(false);
		await f.kernel.execute("read", "child-experiment", { path: "a.txt", offset: 2, limit: 1 });
		expect(f.kernel.proposeHypothesis({ ...fields, mechanism: "TRACE", parent_ref: child })).toBe(true);
		const leaf = f.kernel.state!.leading_hypothesis!;
		await f.kernel.execute("read", "leaf-experiment", { path: "a.txt", offset: 3, limit: 1 });
		expect(f.kernel.proposeHypothesis({ ...fields, mechanism: "ISOLATE", parent_ref: leaf })).toBe(false);
		const state = f.kernel.state!;
		const branches = state.hypotheses.slice(2).map((id) => f.store.get(state.mission_id, id, "Hypothesis"));
		expect(branches.map((branch) => branch.depth)).toEqual([0, 1, 2]);
		// A current read is explicitly shared across branches on the same premise;
		// a consequential correction belongs only to its selected approach.
		expect(branches.map((branch) => branch.attempts)).toEqual([3, 2, 1]);
		expect(f.kernel.selectHypothesis(state.hypotheses[3])).toBe(true);
		await f.kernel.execute("write", "selected-experiment", { path: "a.txt", content: "selected correction" });
		const current = f.kernel.state!;
		expect(
			current.hypotheses.slice(2).map((id) => f.store.get(current.mission_id, id, "Hypothesis").attempts),
		).toEqual([3, 3, 1]);
		expect(current.used.execution).toBe(6);
	});
});
