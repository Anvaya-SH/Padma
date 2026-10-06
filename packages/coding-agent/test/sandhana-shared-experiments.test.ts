import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { signalsForExact } from "../src/core/sandhana/code.ts";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { type HypothesisProposal, makeRecord } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createBashTool, createReadTool, createWriteTool } from "../src/core/tools/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "padma-shared-experiment-"));
	const cwd = join(directory, "workspace");
	mkdirSync(cwd);
	let store = new MissionStore(join(directory, "mission.sqlite"));
	let kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "shared-experiment", store });
	kernel.register(createReadTool(cwd), "read");
	kernel.register(createWriteTool(cwd), "write");
	cleanups.push(() => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	});
	kernel.captureInput("Fix this parser", "USER");
	kernel.begin("");
	writeFileSync(join(cwd, "parser.txt"), "seed\nFIRST_SUCCESS\nSECOND_SUCCESS");
	await kernel.execute("read", "initial-observation", { path: "parser.txt" });
	const signals = signalsForExact(false);
	for (const key of ["S", "D"] as const)
		signals[key] = { severity: 2, provenance: "HISTORY", evidence: [kernel.state!.last_event!] };
	kernel.escalate(signals);
	const first: HypothesisProposal = {
		target: "parser.txt",
		cause: "INPUT_FORMAT",
		mechanism: "VALIDATE",
		failure_signature: "FIRST_FAILURE",
		expected_result: "FIRST_SUCCESS",
	};
	expect(kernel.proposeHypothesis(first)).toBe(true);
	await kernel.execute("read", "branch-premise", { path: "parser.txt", limit: 1 });
	expect(kernel.proposeHypothesis({ ...first, mechanism: "NORMALIZE", expected_result: "SECOND_SUCCESS" })).toBe(true);
	return {
		cwd,
		get store() {
			return store;
		},
		get kernel() {
			return kernel;
		},
		reopen: () => {
			store.close();
			store = new MissionStore(join(directory, "mission.sqlite"));
			kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "shared-experiment", store });
			kernel.register(createReadTool(cwd), "read");
			kernel.register(createWriteTool(cwd), "write");
		},
	};
}

describe("one actual observation for competing hypotheses", () => {
	it("shares one actual scoped foreground check across current branches without duplicating its invocation", async () => {
		const f = await fixture();
		f.kernel.register(createBashTool(f.cwd), "bash");
		writeFileSync(
			join(f.cwd, "parser.test.cjs"),
			"const fs = require('node:fs'); console.log(fs.readFileSync('parser.txt', 'utf8'));",
		);
		const before = f.kernel.state!;
		await f.kernel.execute("bash", "shared-foreground-check", { command: "node --test parser.test.cjs" });
		const state = f.kernel.state!;
		const branches = state.hypotheses.map((ref) => f.store.get(state.mission_id, ref, "Hypothesis"));
		expect(branches.map((branch) => branch.status)).toEqual(["SUPPORTED", "SUPPORTED"]);
		expect(branches.map((branch) => branch.attempts)).toEqual([2, 1]);
		expect(branches[0].supporting).toEqual(branches[1].supporting);
		expect(state.used.execution).toBe(before.used.execution + 1);
		expect(
			f.store.records(state.mission_id).findLast((record) => record.record_type === "CandidateAction"),
		).toMatchObject({ shared_experiment: { version: "SHARED_TEST/1" }, estimate: { execution: 1 } });
		f.reopen();
		expect(f.kernel.state!.hypotheses.map((ref) => f.store.get(state.mission_id, ref, "Hypothesis"))).toEqual(
			branches,
		);
	});
	it("preserves the chosen approach across an unrelated observation without charging a hypothesis attempt", async () => {
		const f = await fixture();
		const before = f.kernel.state!;
		writeFileSync(join(f.cwd, "other.txt"), "unrelated");
		await f.kernel.execute("read", "unrelated-observation", { path: "other.txt" });
		const state = f.kernel.state!;
		expect(state.leading_hypothesis).toBe(before.leading_hypothesis);
		expect(state.hypotheses).toEqual(before.hypotheses);
		expect(
			f.store.records(state.mission_id).findLast((record) => record.record_type === "CandidateAction"),
		).toMatchObject({ hypothesis_ref: null });
		expect(state.used.execution).toBe(before.used.execution + 1);
	});
	it("updates both applicable branches from one invocation and preserves the receipt after reopen", async () => {
		const f = await fixture();
		const before = f.kernel.state!;
		const originals = before.hypotheses.map((ref) => f.store.get(before.mission_id, ref, "Hypothesis"));
		await f.kernel.execute("read", "shared-source", { path: "parser.txt" });
		const state = f.kernel.state!;
		const branches = state.hypotheses.map((ref) => f.store.get(state.mission_id, ref, "Hypothesis"));
		expect(branches.map((branch) => branch.status)).toEqual(["SUPPORTED", "SUPPORTED"]);
		expect(branches.map((branch) => branch.attempts)).toEqual([2, 1]);
		expect(branches[0].supporting).toEqual(branches[1].supporting);
		expect(state.used.execution).toBe(before.used.execution + 1);
		const candidate = f.store
			.records(state.mission_id)
			.findLast((record) => record.record_type === "CandidateAction")!;
		expect(candidate).toMatchObject({
			hypothesis_ref: originals[1].record_id,
			shared_experiment: { version: "SHARED_OBSERVATION/1", hypothesis_refs: [originals[0].record_id] },
			estimate: { execution: 1 },
		});
		for (const original of originals)
			expect(f.store.get(state.mission_id, original.record_id, "Hypothesis")).toEqual(original);
		f.reopen();
		expect(f.kernel.state!.used.execution).toBe(state.used.execution);
		expect(f.kernel.state!.hypotheses.map((ref) => f.store.get(state.mission_id, ref, "Hypothesis"))).toEqual(
			branches,
		);
	});
	it("does not apply an unobserved expected result or share a correction effect", async () => {
		const f = await fixture();
		await f.kernel.execute("read", "one-result", { path: "parser.txt", offset: 2, limit: 1 });
		let state = f.kernel.state!;
		expect(state.hypotheses.map((ref) => f.store.get(state.mission_id, ref, "Hypothesis"))).toMatchObject([
			{ status: "SUPPORTED", attempts: 2 },
			{ status: "ACTIVE", attempts: 1, supporting: [] },
		]);
		await f.kernel.execute("write", "one-correction", { path: "parser.txt", content: "SECOND_SUCCESS" });
		state = f.kernel.state!;
		expect(
			f.store.records(state.mission_id).findLast((record) => record.record_type === "CandidateAction"),
		).not.toHaveProperty("shared_experiment");
		expect(state.hypotheses.map((ref) => f.store.get(state.mission_id, ref, "Hypothesis").attempts)).toEqual([2, 2]);
	});
	it("rejects a shared selection appended after its actual operation and leaves history unchanged", async () => {
		const f = await fixture();
		await f.kernel.execute("read", "actual-observation", { path: "parser.txt" });
		const state = f.kernel.state!;
		const history = f.store.records(state.mission_id);
		const candidate = history.findLast((record) => record.record_type === "CandidateAction")!;
		if (candidate.record_type !== "CandidateAction") throw new Error("Missing preparation");
		const forged = makeRecord(state.mission_id, state.revision + 1, "CandidateAction", candidate);
		expect(() => f.store.commit(state.revision, { ...state, revision: state.revision + 1 }, [forged])).toThrow();
		expect(f.store.records(state.mission_id)).toEqual(history);
	});
	it.each(["duplicate", "cost", "effect"] as const)(
		"rejects a forged %s shared experiment before launch",
		async (variant) => {
			const f = await fixture();
			await f.kernel.prepareOperation(
				variant === "effect" ? "write" : "read",
				"prepared-observation",
				variant === "effect" ? { path: "parser.txt", content: "replacement" } : { path: "parser.txt" },
			);
			const state = f.kernel.state!;
			const history = f.store.records(state.mission_id);
			const candidate = history.findLast((record) => record.record_type === "CandidateAction")!;
			const prepared = history.findLast((record) => record.record_type === "PreparedAction")!;
			if (candidate.record_type !== "CandidateAction" || prepared.record_type !== "PreparedAction")
				throw new Error("Missing preparation");
			const premise = makeRecord(
				state.mission_id,
				state.revision + 1,
				"TargetBinding",
				f.store.get(state.mission_id, candidate.hypothesis_binding_ref!, "TargetBinding"),
			);
			const operation = `forged-${variant}`;
			const forged = makeRecord(state.mission_id, state.revision + 1, "CandidateAction", {
				...candidate,
				operation_id: operation,
				hypothesis_binding_ref: premise.record_id,
				estimate: { ...candidate.estimate, execution: variant === "cost" ? 2 : 1 },
				shared_experiment: {
					version: "SHARED_OBSERVATION/1",
					hypothesis_refs: [
						variant === "duplicate"
							? candidate.hypothesis_ref!
							: state.hypotheses.find((ref) => ref !== candidate.hypothesis_ref)!,
					],
				},
			});
			const action = makeRecord(state.mission_id, state.revision + 1, "PreparedAction", {
				...prepared,
				operation_id: operation,
			});
			expect(() =>
				f.store.commit(state.revision, { ...state, revision: state.revision + 1 }, [premise, forged, action]),
			).toThrow(variant === "duplicate" ? "distinct current hypothesis" : "one registered file observation");
			expect(f.store.records(state.mission_id)).toEqual(history);
			expect(f.kernel.state!.used.execution).toBe(state.used.execution);
		},
	);
	it("prunes both actually attempted stagnant branches without duplicating cost or inventing a refutation", async () => {
		const f = await fixture();
		const before = f.kernel.state!;
		for (let index = 0; index < 4; index++) {
			const reservation = f.kernel.reserveModel(10, 10);
			f.kernel.beginCognitiveTick(reservation);
			f.kernel.reconcileModel(
				reservation,
				{ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
				1,
			);
			if (index === 0) await f.kernel.execute("read", "inconclusive-shared-test", { path: "parser.txt", limit: 1 });
			f.kernel.finishCognitiveTick();
		}
		f.kernel.governCognitiveTick();
		const state = f.kernel.state!;
		expect(state.hypotheses.map((ref) => f.store.get(state.mission_id, ref, "Hypothesis"))).toMatchObject([
			{ status: "REJECTED", attempts: 2, supporting: [], contradicting: [] },
			{ status: "REJECTED", attempts: 1, supporting: [], contradicting: [] },
		]);
		expect(state.stagnation).toBe(4);
		expect(state.used.execution).toBe(before.used.execution + 1);
		expect(state.used.ticks).toBe(4);
	});
});
