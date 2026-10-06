import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { repairedCheckProgress } from "../src/core/sandhana/check-progress.ts";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { observedProcessSources } from "../src/core/sandhana/process-sources.ts";
import { makeRecord } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createBashTool, createReadTool, createWriteTool } from "../src/core/tools/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(instruction = "Inspect the parser behavior") {
	const directory = mkdtempSync(join(tmpdir(), "padma-governor-"));
	const cwd = join(directory, "workspace");
	mkdirSync(cwd);
	let store = new MissionStore(join(directory, "mission.sqlite"));
	const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "governor", store });
	kernel.register(createReadTool(cwd), "read");
	kernel.register(createBashTool(cwd), "bash");
	kernel.captureInput(instruction, "USER");
	kernel.begin("");
	cleanups.push(() => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	});
	return {
		cwd,
		get store() {
			return store;
		},
		kernel,
		reopenStore: () => {
			store.close();
			store = new MissionStore(join(directory, "mission.sqlite"));
			return store;
		},
	};
}
function openTick(kernel: SandhanaKernel) {
	const ref = kernel.reserveModel(10, 10);
	kernel.beginCognitiveTick(ref);
	kernel.reconcileModel(ref, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, 1);
	return ref;
}
describe("durable cognitive tick enforcement", () => {
	it.each(["QUALITY", "PROCESS"] as const)(
		"a previously passing %s check counts an actual repair once across resume and reopen",
		async (kind) => {
			const command = "node check.cjs";
			const f = fixture(
				`padma: ${JSON.stringify({
					objective: "repair parser behavior with a required check",
					allow_edits: true,
					quality_checks: kind === "QUALITY" ? [command] : [],
					shell_commands: [command],
					requirements: [
						{ text: "behavior", rule: "SEMANTIC", target: "parser.cjs", dependencies: ["parser.cjs"] },
						...(kind === "PROCESS"
							? [
									{
										text: "required check",
										rule: "PROCESS",
										target: ".",
										expected: command,
										dependencies: ["parser.cjs"],
									},
								]
							: []),
					],
				})}`,
			);
			const parser = join(f.cwd, "parser.cjs");
			const good = "module.exports = 'good';";
			writeFileSync(parser, good);
			writeFileSync(join(f.cwd, "check.cjs"), "if (require('./parser.cjs') !== 'good') process.exit(1);");
			writeFileSync(join(f.cwd, "other.txt"), "unrelated original");
			let kernel = f.kernel;
			kernel.register(createWriteTool(f.cwd), "write");
			await kernel.execute("read", "bind-parser", { path: "parser.cjs" });
			await kernel.execute("read", "bind-unrelated", { path: "other.txt" });
			const mission = kernel.state!.mission_id;
			for (const [index, content] of [good, "module.exports = 'bad';", good].entries()) {
				if (index) {
					kernel.captureInput(`resume ${mission}`, "USER");
					kernel.begin("");
				}
				openTick(kernel);
				if (index) await kernel.execute("write", `change:${index}`, { path: "parser.cjs", content });
				await kernel.execute("bash", `check:${index}`, { command });
				if (kind === "QUALITY") kernel.assessCandidate();
				kernel.finishCognitiveTick();
				expect(kernel.state!.stagnation).toBe(index === 1 ? 1 : 0);
				if (index === 2) {
					const tick = f.store.get(mission, kernel.state!.cognitive_tick!, "CognitiveTick");
					expect(tick.progress).toHaveLength(1);
					expect(
						tick.progress[0].evidence.map((ref) => f.store.get(mission, ref, "EvidenceRecord").payload),
					).toEqual([
						expect.objectContaining({ result: "FAILED" }),
						expect.objectContaining({ result: "PASSED" }),
					]);
					const records = f.store.records(mission);
					expect(repairedCheckProgress(f.store, kernel.state!, records)).toEqual(tick.progress);
					const artifact = f.store.artifact.bind(f.store);
					for (const ref of tick.progress[0].evidence) {
						const proof = f.store.get(mission, ref, "EvidenceRecord");
						const source = f.store.get(mission, proof.sources[0], "EvidenceRecord");
						const unavailable = vi.spyOn(f.store, "artifact").mockImplementation((id, output) => {
							if (output === source.artifact_ref) throw new Error("Unavailable check observation");
							return artifact(id, output);
						});
						try {
							expect(repairedCheckProgress(f.store, kernel.state!, records)).toEqual([]);
						} finally {
							unavailable.mockRestore();
						}
					}
				}
				kernel.finalize();
				expect(kernel.terminal!.status).not.toBe("VERIFIED_COMPLETE");
				if (index === 1) {
					kernel = new SandhanaKernel({ cwd: () => f.cwd, session: () => "governor", store: f.reopenStore() });
					kernel.register(createReadTool(f.cwd), "read");
					kernel.register(createWriteTool(f.cwd), "write");
					kernel.register(createBashTool(f.cwd), "bash");
				}
			}
			expect(kernel.state!.used.ticks).toBe(3);
			expect(kernel.state!.used.execution).toBe(7);
			// New observations, unrelated bytes and repeating the same bad-to-good source pair cannot mint another repair.
			for (const [index, content] of [good, "module.exports = 'bad';", good].entries()) {
				kernel.captureInput(`resume ${mission}`, "USER");
				kernel.begin("");
				openTick(kernel);
				if (index) await kernel.execute("write", `repeat-change:${index}`, { path: "parser.cjs", content });
				else {
					utimesSync(parser, new Date(Date.now() + 10000), new Date(Date.now() + 10000));
					writeFileSync(join(f.cwd, "other.txt"), "changed but unrelated");
				}
				await kernel.execute("bash", `repeat-check:${index}`, { command });
				if (kind === "QUALITY") kernel.assessCandidate();
				kernel.finishCognitiveTick();
				expect(kernel.state!.stagnation).toBe(index + 1);
				kernel.finalize();
			}
			expect(kernel.state!.used.ticks).toBe(6);
			expect(kernel.state!.used.execution).toBe(12);
		},
		120000,
	);
	it("a skipped failing Node case cannot count as repaired, and the eventual executed pass can", async () => {
		const command = "node --test parser.test.cjs";
		const f = fixture(
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
		const test =
			"const { test } = require('node:test'); const assert = require('node:assert/strict'); test('required behavior', () => assert.equal(require('./parser.cjs'), 'good'));";
		writeFileSync(join(f.cwd, "parser.cjs"), "module.exports = 'good';");
		writeFileSync(join(f.cwd, "parser.test.cjs"), test);
		f.kernel.register(createWriteTool(f.cwd), "write");
		for (let index = 0; index < 4; index++) {
			openTick(f.kernel);
			if (index === 1)
				await f.kernel.execute("write", "break-parser", { path: "parser.cjs", content: "module.exports = 'bad';" });
			if (index === 2)
				await f.kernel.execute("write", "skip-failure", {
					path: "parser.test.cjs",
					content: "const { test } = require('node:test'); test('required behavior', { skip: true }, () => {});",
				});
			if (index === 3) {
				await f.kernel.execute("write", "restore-check", { path: "parser.test.cjs", content: test });
				await f.kernel.execute("write", "repair-parser", {
					path: "parser.cjs",
					content: "module.exports = 'good';",
				});
			}
			await f.kernel.execute("bash", `test:${index}`, { command });
			f.kernel.finishCognitiveTick();
			expect(f.kernel.state!.stagnation).toBe(index === 3 ? 0 : index);
		}
		expect(f.kernel.state!.used.ticks).toBe(4);
		expect(f.kernel.state!.used.execution).toBe(8);
		expect(
			f.kernel.state!.requirements.map((ref) => f.store.get(f.kernel.state!.mission_id, ref, "Requirement").status),
		).toEqual(["UNMET", "VERIFIED"]);
	}, 120000);
	it("escalation requires materially different actual experiments and retains the stagnant count and usage", async () => {
		for (const different of [false, true]) {
			const first = "printf REFUTED_A; exit 1";
			const second = different ? "printf REFUTED_B; exit 1" : first;
			const f = fixture(
				`padma: ${JSON.stringify({
					objective: "diagnose behavior",
					shell_commands: [first, second],
					requirements: [{ text: "behavior", rule: "SEMANTIC", target: "." }],
				})}`,
			);
			for (const [index, command] of [first, second].entries()) {
				expect(
					f.kernel.proposeHypothesis({
						target: ".",
						cause: "INPUT_FORMAT",
						mechanism: index === 0 ? "VALIDATE" : "NORMALIZE",
						failure_signature: index === 0 || !different ? "REFUTED_A" : "REFUTED_B",
						expected_result: "SUPPORTED",
					}),
				).toBe(true);
				openTick(f.kernel);
				await f.kernel.execute("bash", `experiment:${index}`, { command });
				f.kernel.finishCognitiveTick();
				expect(f.kernel.state!.stagnation).toBe(0);
			}
			for (let index = 0; index < 7; index++) {
				openTick(f.kernel);
				f.kernel.finishCognitiveTick();
			}
			const before = f.kernel.state!;
			if (different) {
				f.kernel.governCognitiveTick();
				expect(f.kernel.state!.route).toBe("GAMBHIRA");
			} else {
				expect(() => f.kernel.governCognitiveTick()).toThrow("Configured stagnation limit");
				expect(f.kernel.state!.route).toBe("MADHYAMA");
			}
			expect(f.kernel.state!.stagnation).toBe(7);
			expect(f.kernel.state!.used.execution).toBe(before.used.execution);
			expect(f.kernel.state!.used.ticks).toBe(9);
			expect(f.kernel.state!.hypotheses).toEqual(before.hypotheses);
		}
	});
	it("new evidence IDs and timestamps for an unchanged verified fact do not reset the counter", async () => {
		const f = fixture(
			`padma: ${JSON.stringify({
				objective: "two required files",
				requirements: [
					{ text: "a", rule: "CONTENT", target: "a.txt", expected: "actual" },
					{ text: "b", rule: "CONTENT", target: "b.txt", expected: "missing" },
				],
			})}`,
		);
		writeFileSync(join(f.cwd, "a.txt"), "actual");
		openTick(f.kernel);
		await f.kernel.execute("read", "first-proof", { path: "a.txt" });
		f.kernel.finishCognitiveTick();
		expect(f.kernel.state!.stagnation).toBe(0);
		const before = f.store.get(f.kernel.state!.mission_id, f.kernel.state!.requirements[0], "Requirement");
		utimesSync(join(f.cwd, "a.txt"), new Date(Date.now() + 10000), new Date(Date.now() + 10000));
		openTick(f.kernel);
		await f.kernel.execute("read", "same-proof-new-capture", { path: "a.txt" });
		f.kernel.finishCognitiveTick();
		const after = f.store.get(f.kernel.state!.mission_id, f.kernel.state!.requirements[0], "Requirement");
		expect(after.evidence).not.toEqual(before.evidence);
		expect(after.generation).not.toBe(before.generation);
		expect(after.status).toBe("VERIFIED");
		expect(f.kernel.state!.stagnation).toBe(1);
	});
	it("resume settles an open decision once and preserves history and spending", async () => {
		const f = fixture();
		openTick(f.kernel);
		writeFileSync(join(f.cwd, "a.txt"), "unrelated bytes");
		await f.kernel.execute("read", "observed", { path: "a.txt" });
		const before = f.kernel.state!;
		const reopened = new SandhanaKernel({ cwd: () => f.cwd, session: () => "governor", store: f.reopenStore() });
		reopened.finishCognitiveTick();
		const settled = reopened.state!;
		expect(settled.stagnation).toBe(1);
		expect(settled.used).toEqual(before.used);
		reopened.finishCognitiveTick();
		expect(reopened.state).toEqual(settled);
		expect(f.store.get(before.mission_id, before.cognitive_tick!, "CognitiveTick").status).toBe("OPEN");
		openTick(reopened);
		reopened.finishCognitiveTick();
		expect(reopened.state!.stagnation).toBe(2);
		expect(reopened.state!.used.ticks).toBe(2);
	});
	it("rejects forged progress, unrecorded resets and repeated admitted decision identity", () => {
		const f = fixture();
		const reservation = openTick(f.kernel);
		const state = f.kernel.state!;
		const tick = f.store.get(state.mission_id, state.cognitive_tick!, "CognitiveTick");
		const forged = makeRecord(state.mission_id, state.revision + 1, "CognitiveTick", {
			...tick,
			status: "SETTLED",
			progress: [{ key: "novel explanation", evidence: [] }],
			stagnation_after: 0,
		});
		expect(() =>
			f.store.commit(state.revision, { ...state, revision: state.revision + 1, cognitive_tick: forged.record_id }, [
				forged,
			]),
		).toThrow("new durable evidence");
		f.kernel.finishCognitiveTick();
		const settled = f.kernel.state!;
		expect(() =>
			f.store.commit(settled.revision, { ...settled, revision: settled.revision + 1, stagnation: 0 }, []),
		).toThrow("durable cognitive tick settlement");
		expect(() => f.kernel.beginCognitiveTick(reservation)).toThrow();
		expect(f.kernel.state).toEqual(settled);
	});
	it("auxiliary model reservations share spending without being mistaken for controller decisions", () => {
		const f = fixture();
		const first = f.kernel.reserveModel(10, 10);
		const second = f.kernel.reserveModel(10, 10);
		expect(f.kernel.state!.used.ticks).toBe(2);
		expect(f.kernel.state!.stagnation).toBe(0);
		f.kernel.beginCognitiveTick(first);
		f.kernel.finishCognitiveTick();
		expect(f.kernel.state!.stagnation).toBe(1);
		expect(f.store.get(f.kernel.state!.mission_id, second, "BudgetReservation").state).toBe("RESERVED");
	});
	it("retains diagnosis admission after persistent reopen and rejects invented pruning", async () => {
		const f = fixture("Fix the parser");
		writeFileSync(join(f.cwd, "parser.txt"), "indecisive bytes");
		const proposal = {
			target: "parser.txt",
			cause: "INPUT_FORMAT" as const,
			mechanism: "VALIDATE" as const,
			failure_signature: "unproven symptom",
			expected_result: "unobserved prediction",
		};
		expect(f.kernel.proposeHypothesis(proposal)).toBe(true);
		for (let index = 0; index < 4; index++) {
			openTick(f.kernel);
			await f.kernel.execute("read", `read:${index}`, { path: "parser.txt" });
			f.kernel.finishCognitiveTick();
		}
		const state = f.kernel.state!;
		const hypothesis = f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis");
		const forged = makeRecord(state.mission_id, state.revision + 1, "Hypothesis", {
			...hypothesis,
			status: "REJECTED",
			rejection_ref: state.cognitive_tick!,
		});
		expect(() =>
			f.store.commit(
				state.revision,
				{
					...state,
					revision: state.revision + 1,
					hypotheses: [forged.record_id],
					leading_hypothesis: null,
				},
				[forged],
			),
		).toThrow();
		expect(f.kernel.state).toEqual(state);
		f.kernel.governCognitiveTick();
		const before = f.kernel.state!;
		const reopened = new SandhanaKernel({ cwd: () => f.cwd, session: () => "governor", store: f.reopenStore() });
		reopened.register(createReadTool(f.cwd), "read");
		reopened.register(createWriteTool(f.cwd), "write");
		await expect(reopened.execute("read", "repeated-after-reopen", { path: "parser.txt", limit: 1 })).rejects.toThrow(
			"DIAGNOSIS_REQUIRED",
		);
		expect(reopened.state!.stagnation).toBe(4);
		expect(reopened.state!.used.execution).toBe(before.used.execution);
		expect(f.store.get(state.mission_id, hypothesis.record_id, "Hypothesis")).toEqual(hypothesis);
		expect(f.store.get(state.mission_id, reopened.state!.hypotheses[0], "Hypothesis")).toMatchObject({
			status: "REJECTED",
			attempts: 4,
		});
		expect(reopened.proposeHypothesis({ ...proposal, expected_result: "cosmetic optimism" })).toBe(false);
		expect(reopened.proposeHypothesis({ ...proposal, mechanism: "NORMALIZE" })).toBe(true);
		openTick(reopened);
		await reopened.execute("write", "different-attempt", { path: "parser.txt", content: "changed bytes" });
		reopened.finishCognitiveTick();
		expect(reopened.state!.stagnation).toBe(5);
		expect(reopened.state!.used.ticks).toBe(5);
		expect(reopened.state!.used.execution).toBe(5);
	});
	it("a new label cannot admit an unchanged replacement as a different attempt", async () => {
		const f = fixture("Fix the parser");
		writeFileSync(join(f.cwd, "parser.txt"), "unchanged");
		f.kernel.register(createWriteTool(f.cwd), "write");
		expect(
			f.kernel.proposeHypothesis({
				target: "parser.txt",
				cause: "INPUT_FORMAT",
				mechanism: "NORMALIZE",
				failure_signature: "unproven symptom",
				expected_result: "unobserved prediction",
			}),
		).toBe(true);
		for (let index = 0; index < 4; index++) {
			openTick(f.kernel);
			f.kernel.finishCognitiveTick();
		}
		f.kernel.governCognitiveTick();
		openTick(f.kernel);
		await expect(f.kernel.execute("write", "no-op", { path: "parser.txt", content: "unchanged" })).rejects.toThrow(
			"unchanged replacement",
		);
		f.kernel.finishCognitiveTick();
		expect(f.kernel.state!.used.execution).toBe(0);
		expect(f.kernel.state!.stagnation).toBe(5);
		const state = f.kernel.state!;
		expect(f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis").attempts).toBe(0);
	});
	it("timestamps and changed unrelated files cannot admit a repeated scoped test", async () => {
		const f = fixture("Fix the parser");
		const parser = join(f.cwd, "parser.cjs");
		writeFileSync(parser, "module.exports = 'unchanged';");
		writeFileSync(join(f.cwd, "other.txt"), "unrelated original");
		writeFileSync(
			join(f.cwd, "parser.test.cjs"),
			"const { test } = require('node:test'); test('diagnostic', () => { console.log(require('./parser.cjs')); });",
		);
		await f.kernel.execute("read", "bind-parser", { path: "parser.cjs" });
		await f.kernel.execute("read", "bind-unrelated", { path: "other.txt" });
		const proposal = {
			target: "parser.cjs",
			cause: "INPUT_FORMAT" as const,
			mechanism: "VALIDATE" as const,
			failure_signature: "unproven cause",
			expected_result: "unobserved prediction",
		};
		expect(f.kernel.proposeHypothesis(proposal)).toBe(true);
		for (let index = 0; index < 4; index++) {
			openTick(f.kernel);
			await f.kernel.execute("bash", `diagnostic:${index}`, { command: "node --test parser.test.cjs" });
			f.kernel.finishCognitiveTick();
		}
		f.kernel.governCognitiveTick();
		const state = f.kernel.state!;
		const observation = f.store
			.records(state.mission_id)
			.findLast((record) => record.record_type === "EvidenceRecord" && record.stage === "phala")!;
		if (observation.record_type !== "EvidenceRecord") throw new Error("Missing actual diagnostic result");
		expect(observedProcessSources(f.store, observation)).not.toBeNull();
		expect(observedProcessSources(f.store, { ...observation, provenance: "MODEL" })).toBeNull();
		expect(observedProcessSources(f.store, { ...observation, payload: {} })).toBeNull();
		const reopened = new SandhanaKernel({ cwd: () => f.cwd, session: () => "governor", store: f.reopenStore() });
		reopened.register(createBashTool(f.cwd), "bash");
		expect(reopened.proposeHypothesis({ ...proposal, mechanism: "NORMALIZE" })).toBe(true);
		utimesSync(parser, new Date(Date.now() + 10000), new Date(Date.now() + 10000));
		writeFileSync(join(f.cwd, "other.txt"), "changed but unrelated");
		openTick(reopened);
		await expect(reopened.execute("bash", "repeated", { command: "node --test ./parser.test.cjs" })).rejects.toThrow(
			"DIAGNOSIS_REQUIRED",
		);
		reopened.finishCognitiveTick();
		expect(reopened.state!.used.execution).toBe(state.used.execution);
		expect(reopened.state!.stagnation).toBe(5);
		expect(reopened.state!.used.ticks).toBe(5);
		// Four real Node processes plus durable source capture can exceed 30 seconds on Windows.
	}, 60000);
});
