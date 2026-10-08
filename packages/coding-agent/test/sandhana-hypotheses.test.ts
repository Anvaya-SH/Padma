import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	hypothesisExperimentApplicability,
	hypothesisFingerprint,
	hypothesisObservationApplies,
	hypothesisPremiseMatches,
	validateHypothesis,
} from "../src/core/sandhana/hypotheses.ts";
import { type KernelOptions, SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import {
	actionDigest,
	digest,
	type HypothesisProposal,
	makeRecord,
	type RecordOf,
	validateRecord,
} from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createBashTool, createReadTool, createWriteTool } from "../src/core/tools/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(
	instruction = "Fix the parser",
	options: Pick<KernelOptions, "beforeDispatch" | "configuration"> = {},
) {
	const directory = mkdtempSync(join(tmpdir(), "padma-hypotheses-"));
	const cwd = join(directory, "workspace");
	mkdirSync(cwd);
	let store = new MissionStore(join(directory, "mission.sqlite"));
	let kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "hypotheses", store, ...options });
	kernel.register(createReadTool(cwd), "read");
	kernel.register(createBashTool(cwd), "bash");
	kernel.register(createWriteTool(cwd), "write");
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
		get kernel() {
			return kernel;
		},
		reopen: () => {
			store.close();
			store = new MissionStore(join(directory, "mission.sqlite"));
			kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "hypotheses", store, ...options });
			kernel.register(createReadTool(cwd), "read");
			kernel.register(createBashTool(cwd), "bash");
			kernel.register(createWriteTool(cwd), "write");
		},
	};
}

const proposal: HypothesisProposal = {
	target: ".",
	cause: "INPUT_FORMAT",
	mechanism: "VALIDATE",
	failure_signature: "refuted",
	expected_result: "supported",
};

describe("controlled hypothesis identity and actual experimental evidence", () => {
	it("a valid authorization retirement cannot append invented resolution metadata", () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "parser.txt"), "before");
		expect(f.kernel.proposeHypothesis({ ...proposal, target: "parser.txt" })).toBe(true);
		const previous = f.kernel.state!;
		f.kernel.revoke();
		const state = f.kernel.state!;
		const retired = f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis");
		expect(retired.status).toBe("REJECTED");
		expect(() => validateHypothesis(f.store, retired, previous.hypotheses, state)).not.toThrow();
		expect(() =>
			validateHypothesis(f.store, { ...retired, resolution_ref: "invented-resolution" }, previous.hypotheses, state),
		).toThrow("unchanged history");
		expect(f.store.get(state.mission_id, retired.record_id, "Hypothesis")).toEqual(retired);
		expect(f.kernel.state).toEqual(state);
	});
	it.each(["complete", "partial"] as const)(
		"a %s read applies its observed range even when the complete source artifact includes the prediction",
		async (range) => {
			const f = fixture();
			writeFileSync(join(f.cwd, "parser.txt"), `${"filler\n".repeat(9000)}supported\n`);
			expect(f.kernel.proposeHypothesis({ ...proposal, target: "parser.txt" })).toBe(true);
			const result = await f.kernel.execute("read", "range-evidence", {
				path: "parser.txt",
				...(range === "partial" ? { offset: 8001, limit: 1 } : {}),
			});
			const state = f.kernel.state!;
			const hypothesis = f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis");
			expect(hypothesis).toMatchObject({ status: range === "complete" ? "SUPPORTED" : "ACTIVE", attempts: 1 });
			const operation = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
			const observation = f.store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
			const payload = observation.payload as { full_output_ref: string };
			expect(f.store.artifact(state.mission_id, payload.full_output_ref).toString().includes("supported")).toBe(
				true,
			);
			const raw = JSON.parse(f.store.artifact(state.mission_id, observation.artifact_ref!).toString()) as {
				content: { type: string; text?: string }[];
			};
			expect(raw.content.some((part) => part.text?.includes("supported"))).toBe(range === "complete");
			expect(result.content.some((part) => part.type === "text" && part.text.includes("supported"))).toBe(false);
			expect(state.used.execution).toBe(1);
		},
	);
	it("uses decoded actual text rather than serialized metadata or escaped JSON", async () => {
		const f = fixture("run: printf refuted; exit 1");
		expect(f.kernel.proposeHypothesis({ ...proposal, expected_result: "wall_time_seconds" })).toBe(true);
		await f.kernel.execute("bash", "actual-failure", { command: "printf refuted; exit 1" });
		const state = f.kernel.state!;
		expect(f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis").status).toBe("CONTRADICTED");
		const source = fixture();
		writeFileSync(join(source.cwd, "parser.txt"), "first\nsecond");
		expect(
			source.kernel.proposeHypothesis({ ...proposal, target: "parser.txt", expected_result: "first\nsecond" }),
		).toBe(true);
		await source.kernel.execute("read", "literal-newline", { path: "parser.txt" });
		const observed = source.kernel.state!;
		expect(source.store.get(observed.mission_id, observed.hypotheses[0], "Hypothesis").status).toBe("SUPPORTED");
	});
	it("rejects model synonyms and cosmetic rewrites after refutation and database reopen", async () => {
		const f = fixture("run: printf refuted; exit 1");
		f.kernel.acceptDecisionText(`<yukti>${JSON.stringify({ ...proposal, cause: "input parsing" })}</yukti>`);
		expect(f.kernel.state!.hypotheses).toEqual([]);
		f.kernel.acceptDecisionText(`<yukti>${JSON.stringify(proposal)}</yukti>`);
		await f.kernel.execute("bash", "refutation", { command: "printf refuted; exit 1" });
		const before = f.kernel.state!;
		const refuted = f.store.get(before.mission_id, before.hypotheses[0], "Hypothesis");
		expect(refuted).toMatchObject({
			status: "CONTRADICTED",
			attempts: 1,
			normalization_version: "CONTROLLED_HYPOTHESIS/1",
		});
		f.reopen();
		expect(
			f.kernel.proposeHypothesis({
				...proposal,
				target: f.cwd,
				cause_detail: "different parser prose",
				mechanism_detail: "a longer description",
				expected_result: "new optimistic prediction",
			}),
		).toBe(false);
		expect(f.kernel.proposeHypothesis({ ...proposal, failure_signature: "rephrased symptom" })).toBe(false);
		expect(f.kernel.state!.stagnation).toBe(before.stagnation);
		expect(f.kernel.state!.used.execution).toBe(before.used.execution);
		expect(f.kernel.state!.hypotheses).toEqual(before.hypotheses);
		expect(f.store.get(before.mission_id, refuted.record_id, "Hypothesis")).toEqual(refuted);
	});
	it("reopens the same identity only after an actual observation of its changed target premise", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "parser.txt"), "supported");
		writeFileSync(join(f.cwd, "other.txt"), "unrelated");
		const fields = { ...proposal, target: "parser.txt" };
		expect(f.kernel.proposeHypothesis(fields)).toBe(true);
		await f.kernel.execute("read", "support", { path: "parser.txt" });
		const first = f.store.get(f.kernel.state!.mission_id, f.kernel.state!.hypotheses[0], "Hypothesis");
		expect(first.status).toBe("SUPPORTED");
		utimesSync(join(f.cwd, "parser.txt"), new Date(Date.now() + 10000), new Date(Date.now() + 10000));
		await f.kernel.execute("read", "same-premise-new-timestamp", { path: "parser.txt" });
		expect(f.kernel.proposeHypothesis(fields)).toBe(false);
		writeFileSync(join(f.cwd, "parser.txt"), "changed actual premise");
		await f.kernel.execute("read", "unrelated", { path: "other.txt" });
		expect(f.kernel.proposeHypothesis(fields)).toBe(false);
		await f.kernel.execute("read", "current-premise", { path: "parser.txt" });
		expect(f.kernel.proposeHypothesis(fields)).toBe(true);
		const state = f.kernel.state!;
		const reopened = f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis");
		expect(reopened).toMatchObject({
			hypothesis_id: first.hypothesis_id,
			fingerprint: first.fingerprint,
			attempts: 1,
			status: "ACTIVE",
		});
		expect(reopened.premise_generation).not.toBe(first.premise_generation);
		expect(reopened.branch_evidence!.length).toBeGreaterThan(0);
		expect(f.store.get(state.mission_id, first.record_id, "Hypothesis")).toEqual(first);
		expect(state.hypotheses).toHaveLength(1);
	});
	it("requires an observed distinct symptom before treating the same mechanism as a different problem", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "parser.txt"), "supported");
		expect(f.kernel.proposeHypothesis(proposal)).toBe(true);
		await f.kernel.execute("read", "resolve-first", { path: "parser.txt" });
		const second = { ...proposal, failure_signature: "distinct observed symptom" };
		expect(f.kernel.proposeHypothesis(second)).toBe(false);
		writeFileSync(join(f.cwd, "parser.txt"), second.failure_signature);
		await f.kernel.execute("read", "distinct-symptom", { path: "parser.txt" });
		expect(f.kernel.proposeHypothesis(second)).toBe(true);
		const state = f.kernel.state!;
		expect(state.hypotheses).toHaveLength(2);
		expect(state.hypotheses.map((ref) => f.store.get(state.mission_id, ref, "Hypothesis").attempts)).toEqual([1, 0]);
	});
	it("detaches an externally replaced premise before automatic selection, including after reopen", async () => {
		const f = fixture();
		const path = join(f.cwd, "parser.txt");
		writeFileSync(path, "before");
		expect(f.kernel.proposeHypothesis({ ...proposal, target: "parser.txt" })).toBe(true);
		const original = f.store.get(f.kernel.state!.mission_id, f.kernel.state!.hypotheses[0], "Hypothesis");
		writeFileSync(path, "supported");
		f.reopen();
		expect(f.kernel.selectHypothesis(original.record_id)).toBe(false);
		await f.kernel.execute("read", "external-postimage", { path: "parser.txt" });
		const state = f.kernel.state!;
		const candidate = f.store
			.records(state.mission_id)
			.findLast((record) => record.record_type === "CandidateAction")!;
		expect(candidate).toMatchObject({ hypothesis_ref: null });
		expect(f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis")).toMatchObject({
			status: "REJECTED",
			attempts: 0,
			supporting: [],
			contradicting: [],
		});
		expect(f.store.get(state.mission_id, original.record_id, "Hypothesis")).toEqual(original);
		expect(state.leading_hypothesis).toBeNull();
		expect(state.used.execution).toBe(1);
		expect(state.used.output_bytes).toBeGreaterThan(0);
		f.reopen();
		expect(f.kernel.selectHypothesis(original.record_id)).toBe(false);
		expect(f.kernel.proposeHypothesis({ ...proposal, target: "parser.txt" })).toBe(true);
		expect(f.store.get(state.mission_id, f.kernel.state!.hypotheses[0], "Hypothesis")).toMatchObject({
			hypothesis_id: original.hypothesis_id,
			attempts: 0,
			status: "ACTIVE",
		});
	});
	it("retains an active premise across timestamp changes with identical bytes", async () => {
		const f = fixture();
		const path = join(f.cwd, "parser.txt");
		writeFileSync(path, "supported");
		expect(f.kernel.proposeHypothesis({ ...proposal, target: "parser.txt" })).toBe(true);
		const original = f.store.get(f.kernel.state!.mission_id, f.kernel.state!.hypotheses[0], "Hypothesis");
		utimesSync(path, new Date(Date.now() + 10000), new Date(Date.now() + 10000));
		expect(f.kernel.selectHypothesis(original.record_id)).toBe(true);
		await f.kernel.execute("read", "same-bytes", { path: "parser.txt" });
		const state = f.kernel.state!;
		expect(f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis")).toMatchObject({
			hypothesis_id: original.hypothesis_id,
			premise_binding_ref: original.premise_binding_ref,
			attempts: 1,
			status: "SUPPORTED",
		});
	});
	it("continues a recorded guarded correction after reopen without rewriting its premise", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "parser.txt"), "before");
		expect(f.kernel.proposeHypothesis({ ...proposal, target: "parser.txt" })).toBe(true);
		const original = f.store.get(f.kernel.state!.mission_id, f.kernel.state!.hypotheses[0], "Hypothesis");
		await f.kernel.execute("write", "guarded-correction", { path: "parser.txt", content: "supported" });
		let state = f.kernel.state!;
		expect(f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis")).toMatchObject({
			attempts: 1,
			status: "ACTIVE",
		});
		f.reopen();
		expect(f.kernel.selectHypothesis(f.kernel.state!.hypotheses[0])).toBe(true);
		await f.kernel.execute("read", "postimage-experiment", { path: "parser.txt" });
		state = f.kernel.state!;
		expect(f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis")).toMatchObject({
			hypothesis_id: original.hypothesis_id,
			fingerprint: original.fingerprint,
			premise_binding_ref: original.premise_binding_ref,
			attempts: 2,
			status: "SUPPORTED",
		});
		expect(f.store.get(state.mission_id, original.record_id, "Hypothesis")).toEqual(original);
	});
	it.each(["unchanged", "guarded correction"] as const)(
		"merges an equivalent proposal on its %s premise without replacing experiment history",
		async (variant) => {
			const f = fixture();
			writeFileSync(join(f.cwd, "parser.txt"), "before");
			const fields = { ...proposal, target: "parser.txt" };
			expect(f.kernel.proposeHypothesis(fields)).toBe(true);
			if (variant === "guarded correction")
				await f.kernel.execute("write", "merge-correction", { path: "parser.txt", content: "after" });
			f.reopen();
			const before = f.kernel.state!;
			const original = f.store.get(before.mission_id, before.hypotheses[0], "Hypothesis");
			const duplicate = { ...fields, cause_detail: "same cause, additional detail" };
			expect(f.kernel.proposeHypothesis(duplicate)).toBe(true);
			const merged = f.kernel.state!;
			expect(merged.hypotheses).toEqual(before.hypotheses);
			expect(merged.leading_hypothesis).toBe(original.record_id);
			expect(f.store.get(merged.mission_id, merged.hypotheses[0], "Hypothesis")).toEqual(original);
			expect(merged.used.execution).toBe(before.used.execution);
			expect(merged.used.ticks).toBe(before.used.ticks);
			expect(merged.used.retrieval_bytes).toBeGreaterThan(before.used.retrieval_bytes);
			expect(merged.stagnation).toBe(before.stagnation);
			const receipt = f.store
				.records(merged.mission_id)
				.findLast(
					(record) => record.record_type === "EvidenceRecord" && record.source === "hypothesis-normalization/1",
				);
			expect(receipt).toMatchObject({
				record_type: "EvidenceRecord",
				kind: "CONTROL",
				provenance: "KERNEL",
				operation_id: null,
				payload: {
					version: "EQUIVALENT_HYPOTHESIS/1",
					hypothesis_ref: original.record_id,
					proposal: { ...duplicate, target: join(f.cwd, "parser.txt") },
				},
			});
			expect(f.kernel.proposeHypothesis({ ...duplicate, expected_result: "a different prediction" })).toBe(false);
			expect(f.kernel.state!.hypotheses).toEqual(before.hypotheses);
			f.reopen();
			await f.kernel.execute("read", "merged-experiment", { path: "parser.txt" });
			expect(f.store.get(merged.mission_id, f.kernel.state!.hypotheses[0], "Hypothesis")).toMatchObject({
				hypothesis_id: original.hypothesis_id,
				premise_binding_ref: original.premise_binding_ref,
				attempts: original.attempts + 1,
				status: "ACTIVE",
			});
		},
	);
	it.each(["prediction", "premise", "model", "source", "spending", "stagnation"] as const)(
		"rejects a forged equivalent merge with changed %s",
		async (variant) => {
			const f = fixture();
			writeFileSync(join(f.cwd, "parser.txt"), "before");
			const fields = { ...proposal, target: "parser.txt" };
			expect(f.kernel.proposeHypothesis(fields)).toBe(true);
			expect(f.kernel.proposeHypothesis(fields)).toBe(true);
			const state = f.kernel.state!;
			const history = f.store.records(state.mission_id);
			const receipt = f.store.get(state.mission_id, state.last_event!, "EvidenceRecord");
			const data = receipt.payload as { binding_ref: string; hypothesis_ref: string; proposal: HypothesisProposal };
			const premise = f.store.get(state.mission_id, data.binding_ref, "TargetBinding");
			const binding = makeRecord(state.mission_id, state.revision + 1, "TargetBinding", {
				...premise,
				...(variant === "premise"
					? { generation: "external generation", preimage_digest: digest("external") }
					: {}),
			});
			const payload = {
				version: "EQUIVALENT_HYPOTHESIS/1",
				hypothesis_ref: data.hypothesis_ref,
				binding_ref: binding.record_id,
				proposal: {
					...data.proposal,
					...(variant === "prediction" ? { expected_result: "invented prediction" } : {}),
				},
			};
			const forged = makeRecord(state.mission_id, state.revision + 1, "EvidenceRecord", {
				...receipt,
				payload,
				digest: digest(payload),
				target_generation: binding.generation,
				provenance: variant === "model" ? "MODEL" : "KERNEL",
				source: variant === "source" ? "invented source" : receipt.source,
				previous: state.last_event,
			});
			expect(() =>
				f.store.commit(
					state.revision,
					{
						...state,
						revision: state.revision + 1,
						last_event: forged.record_id,
						...(variant === "spending" ? { used: { ...state.used, execution: state.used.execution + 1 } } : {}),
						...(variant === "stagnation" ? { stagnation: state.stagnation + 1 } : {}),
					},
					[binding, forged],
				),
			).toThrow(
				variant === "stagnation"
					? "Stagnation changes require a durable cognitive tick settlement"
					: "current eligible prediction and unchanged experiment history",
			);
			expect(f.kernel.state).toEqual(state);
			expect(f.store.records(state.mission_id)).toEqual(history);
		},
	);
	it.each(["revoke", "amend"] as const)(
		"prunes a fully unauthorized branch after %s while retaining its actual experiment and spending",
		async (variant) => {
			const f = fixture();
			writeFileSync(join(f.cwd, "parser.txt"), "before");
			const fields = { ...proposal, target: "parser.txt" };
			expect(f.kernel.proposeHypothesis(fields)).toBe(true);
			await f.kernel.execute("read", "before-revocation", { path: "parser.txt" });
			const before = f.kernel.state!;
			const hypothesis = f.store.get(before.mission_id, before.hypotheses[0], "Hypothesis");
			if (variant === "revoke") f.kernel.revoke();
			else f.kernel.amend("stop editing");
			const stopped = f.kernel.state!;
			const pruned = f.store.get(stopped.mission_id, stopped.hypotheses[0], "Hypothesis");
			expect(pruned).toMatchObject({
				hypothesis_id: hypothesis.hypothesis_id,
				status: "REJECTED",
				attempts: 1,
				supporting: [],
				contradicting: [],
			});
			expect(f.store.get(stopped.mission_id, pruned.rejection_ref!, "EvidenceRecord")).toMatchObject({
				kind: "CONTROL",
				provenance: "KERNEL",
				payload: {
					rule: "HYPOTHESIS_AUTHORIZATION_REVOKED/1",
					hypothesis_ref: hypothesis.record_id,
					authorization_refs: stopped.authorizations,
				},
			});
			expect(stopped.leading_hypothesis).toBeNull();
			expect(stopped.used).toEqual(before.used);
			expect(stopped.stagnation).toBe(before.stagnation);
			expect(f.store.get(stopped.mission_id, hypothesis.record_id, "Hypothesis")).toEqual(hypothesis);
			f.reopen();
			expect(f.kernel.selectHypothesis(pruned.record_id)).toBe(false);
			expect(f.kernel.proposeHypothesis(fields)).toBe(false);
			expect(f.kernel.state!.used).toEqual(stopped.used);
			expect(() => f.kernel.governCognitiveTick()).toThrow("Current action authorization was revoked");
		},
	);
	it.each(["live grants", "partial revocation", "model provenance"] as const)(
		"rejects hypothesis authorization pruning from %s",
		async (variant) => {
			const f = fixture("run: node diagnostic.cjs");
			writeFileSync(join(f.cwd, "parser.txt"), "before");
			writeFileSync(join(f.cwd, "diagnostic.cjs"), "console.log('inconclusive');");
			expect(f.kernel.proposeHypothesis({ ...proposal, target: "parser.txt" })).toBe(true);
			await f.kernel.execute("bash", "authorization-pruning-fixture", { command: "node diagnostic.cjs" });
			const state = f.kernel.state!;
			const history = f.store.records(state.mission_id);
			const hypothesis = f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis");
			const source = makeRecord(state.mission_id, state.revision + 1, "Amendment", {
				amendment_id: "partial-revocation",
				instruction: "Revoke one action authorization",
				source: "USER",
				captured_at: Date.now(),
				requirement_changes: [],
				revokes: true,
			});
			const revoked = makeRecord(state.mission_id, state.revision + 1, "Authorization", {
				...f.store.get(state.mission_id, state.authorizations.at(-1)!, "Authorization"),
				source_ref: source.record_id,
				revoked: true,
			});
			expect(state.authorizations.length).toBeGreaterThan(1);
			const grants =
				variant === "partial revocation"
					? [...state.authorizations.slice(0, -1), revoked.record_id]
					: state.authorizations;
			const payload = {
				rule: "HYPOTHESIS_AUTHORIZATION_REVOKED/1",
				hypothesis_ref: hypothesis.record_id,
				authorization_refs: grants,
			};
			const rejection = makeRecord(state.mission_id, state.revision + 1, "EvidenceRecord", {
				event_id: "forged-authorization-pruning",
				stage: "vikalpa",
				kind: "CONTROL",
				provenance: variant === "model provenance" ? "MODEL" : "KERNEL",
				target_generation: hypothesis.premise_generation,
				captured_at: Date.now(),
				operation_id: null,
				source: "hypothesis-authorization/1",
				payload,
				artifact_ref: null,
				digest: digest(payload),
				sensitivity: "PRIVATE",
				sources: [],
				requirement_ids: [],
				correction_of: null,
				previous: state.last_event,
			});
			const retired = makeRecord(state.mission_id, state.revision + 1, "Hypothesis", {
				...hypothesis,
				status: "REJECTED",
				rejection_ref: rejection.record_id,
			});
			expect(() =>
				f.store.commit(
					state.revision,
					{
						...state,
						revision: state.revision + 1,
						authorizations: grants,
						hypotheses: [retired.record_id],
						leading_hypothesis: null,
						last_event: rejection.record_id,
					},
					[...(variant === "partial revocation" ? [source, revoked] : []), rejection, retired],
				),
			).toThrow(variant === "model provenance" ? "kernel retirement decision" : "complete sourced revocation");
			expect(f.kernel.state).toEqual(state);
			expect(f.store.records(state.mission_id)).toEqual(history);
		},
	);
	it("blocks a process when its selected source changes after preparation without charging an attempt", async () => {
		let path = "";
		let invoked = false;
		const f = fixture("run: node effect.cjs", {
			beforeDispatch: async () => {
				writeFileSync(path, "externally changed");
			},
		});
		path = join(f.cwd, "parser.txt");
		writeFileSync(path, "before");
		f.kernel.register(
			createBashTool(f.cwd, {
				operations: {
					exec: async (_command, _cwd, { onData }) => {
						invoked = true;
						onData(Buffer.from("supported"));
						return { exitCode: 0, outputComplete: true };
					},
				},
			}),
			"bash",
		);
		expect(f.kernel.proposeHypothesis({ ...proposal, target: "parser.txt" })).toBe(true);
		const original = f.store.get(f.kernel.state!.mission_id, f.kernel.state!.hypotheses[0], "Hypothesis");
		await expect(f.kernel.execute("bash", "stale-at-start", { command: "node effect.cjs" })).rejects.toThrow(
			"PREIMAGE_CONFLICT",
		);
		const state = f.kernel.state!;
		expect(invoked).toBe(false);
		expect(state.used.execution).toBe(0);
		const operation = f.store
			.records(state.mission_id)
			.findLast((record) => record.record_type === "OperationRecord");
		expect(operation).toMatchObject({ status: "NOT_STARTED", started_at: null });
		expect(
			state.reservations
				.map((ref) => f.store.get(state.mission_id, ref, "BudgetReservation"))
				.some((reservation) => reservation.state === "RELEASED"),
		).toBe(true);
		expect(f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis")).toEqual(original);
	});
	it("keeps launched output and its attempt inconclusive when the premise changes during execution", async () => {
		const f = fixture("run: node effect.cjs");
		const path = join(f.cwd, "parser.txt");
		writeFileSync(path, "before");
		f.kernel.register(
			createBashTool(f.cwd, {
				operations: {
					exec: async (_command, _cwd, { onData }) => {
						writeFileSync(path, "external postimage");
						onData(Buffer.from("supported"));
						return { exitCode: 0, outputComplete: true };
					},
				},
			}),
			"bash",
		);
		expect(f.kernel.proposeHypothesis({ ...proposal, target: "parser.txt" })).toBe(true);
		await f.kernel.execute("bash", "changed-during-launch", { command: "node effect.cjs" });
		const state = f.kernel.state!;
		const hypothesis = f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis");
		expect(hypothesis).toMatchObject({ attempts: 1, status: "ACTIVE", supporting: [], contradicting: [] });
		const operation = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
		const observation = f.store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
		expect(f.store.artifact(state.mission_id, observation.artifact_ref!).toString()).toContain("supported");
		expect(state.used.execution).toBe(1);
		const forged = makeRecord(state.mission_id, state.revision + 1, "Hypothesis", {
			...hypothesis,
			attempts: 2,
			status: "SUPPORTED",
			supporting: [observation.record_id],
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
		f.reopen();
		expect(f.store.get(state.mission_id, f.kernel.state!.hypotheses[0], "Hypothesis")).toEqual(hypothesis);
		expect(f.kernel.selectHypothesis(hypothesis.record_id)).toBe(false);
	});
	it.each(["unknown", "omitted", "revoked unknown"] as const)(
		"retains a launched %s attempt without invented support",
		async (outcome) => {
			const f = fixture("run: node effect.cjs", {
				configuration: { version: "sandhana/1", artifact: { max_bytes: 4096 } },
			});
			writeFileSync(join(f.cwd, "parser.txt"), "before");
			f.kernel.register(
				createBashTool(f.cwd, {
					operations: {
						exec: async (_command, _cwd, { onData }) => {
							if (outcome === "revoked unknown") f.kernel.revoke();
							if (outcome !== "omitted") throw new Error("supported but confirmation was lost");
							// Complete native output fits; its duplicated structured/diagnostic JSON exceeds retention.
							onData(Buffer.from(`supported${"x".repeat(3000)}`));
							return { exitCode: 0, outputComplete: true };
						},
					},
				}),
				"bash",
			);
			expect(f.kernel.proposeHypothesis({ ...proposal, target: "parser.txt" })).toBe(true);
			await expect(f.kernel.execute("bash", "inconclusive-launch", { command: "node effect.cjs" })).rejects.toThrow(
				outcome !== "omitted" ? "may have taken effect" : "Complete output",
			);
			const state = f.kernel.state!;
			expect(f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis")).toMatchObject({
				attempts: 1,
				status: "ACTIVE",
				supporting: [],
				contradicting: [],
			});
			expect(f.store.get(state.mission_id, state.operations[0], "OperationRecord").status).toBe(
				outcome !== "omitted" ? "OUTCOME_UNKNOWN" : "CONFIRMED_COMPLETE",
			);
			expect(state.used.execution).toBe(1);
			expect(state.used.output_bytes).toBeGreaterThan(0);
			f.reopen();
			expect(f.store.get(state.mission_id, f.kernel.state!.hypotheses[0], "Hypothesis").attempts).toBe(1);
			if (outcome === "revoked unknown") {
				expect(f.kernel.selectHypothesis(f.kernel.state!.hypotheses[0])).toBe(false);
				expect(f.kernel.finalize().status).toBe("OUTCOME_UNKNOWN");
				expect(f.store.get(state.mission_id, f.kernel.state!.hypotheses[0], "Hypothesis").status).toBe("ACTIVE");
			}
		},
	);
	it("counts a real experiment when revocation prevents its final source capture", async () => {
		const f = fixture("run: node diagnostic.cjs");
		writeFileSync(join(f.cwd, "parser.txt"), "before");
		writeFileSync(
			join(f.cwd, "diagnostic.cjs"),
			"const fs = require('node:fs'); console.log(fs.readFileSync('parser.txt', 'utf8')); console.log('EXPERIMENT_SUPPORTED');",
		);
		expect(
			f.kernel.proposeHypothesis({ ...proposal, target: "parser.txt", expected_result: "EXPERIMENT_SUPPORTED" }),
		).toBe(true);
		let retrievalAtRevocation: number | null = null;
		await expect(
			f.kernel.execute(
				"bash",
				"revoked-hypothesis-result",
				{ command: "node diagnostic.cjs" },
				undefined,
				(partial) => {
					if (
						retrievalAtRevocation === null &&
						partial.content.some((part) => part.type === "text" && part.text.includes("EXPERIMENT_SUPPORTED"))
					) {
						f.kernel.revoke();
						retrievalAtRevocation = f.kernel.state!.used.retrieval_bytes;
						expect(
							f.store.get(f.kernel.state!.mission_id, f.kernel.state!.hypotheses[0], "Hypothesis"),
						).toMatchObject({
							status: "ACTIVE",
							attempts: 0,
						});
					}
				},
			),
		).rejects.toThrow("source read");
		expect(retrievalAtRevocation).not.toBeNull();
		const state = f.kernel.state!;
		expect(state.used.execution).toBe(1);
		expect(state.used.retrieval_bytes).toBe(retrievalAtRevocation);
		expect(f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis")).toMatchObject({
			attempts: 1,
			status: "REJECTED",
			supporting: [],
			contradicting: [],
		});
		const operation = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
		const observation = f.store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
		expect(operation.status).toBe("CONFIRMED_COMPLETE");
		expect(observation.payload).toMatchObject({ dependencies: {}, process_sources: { complete: false } });
		expect(f.store.artifact(state.mission_id, observation.artifact_ref!).toString()).toContain(
			"EXPERIMENT_SUPPORTED",
		);
	});
	it("retains a launched attempt after a budget amendment without resolving from its old decision", async () => {
		const f = fixture("run: node diagnostic.cjs");
		writeFileSync(join(f.cwd, "parser.txt"), "before");
		writeFileSync(join(f.cwd, "diagnostic.cjs"), "console.log('EXPERIMENT_SUPPORTED');");
		expect(
			f.kernel.proposeHypothesis({ ...proposal, target: "parser.txt", expected_result: "EXPERIMENT_SUPPORTED" }),
		).toBe(true);
		let amended = false;
		await f.kernel.execute(
			"bash",
			"amended-hypothesis-result",
			{ command: "node diagnostic.cjs" },
			undefined,
			(partial) => {
				if (
					!amended &&
					partial.content.some((part) => part.type === "text" && part.text.includes("EXPERIMENT_SUPPORTED"))
				) {
					amended = true;
					f.kernel.amend(`budget: ${JSON.stringify({ version: 1, ceilings: {} })}`);
				}
			},
		);
		expect(amended).toBe(true);
		const state = f.kernel.state!;
		const hypothesis = f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis");
		expect(hypothesis).toMatchObject({ attempts: 1, status: "ACTIVE", supporting: [], contradicting: [] });
		expect(state.used.execution).toBe(1);
		const operation = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
		const observation = f.store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
		expect(operation.status).toBe("CONFIRMED_COMPLETE");
		expect(observation.payload).toMatchObject({ dependencies_unchanged: true, process_sources: { complete: true } });
		expect(f.store.artifact(state.mission_id, observation.artifact_ref!).toString()).toContain(
			"EXPERIMENT_SUPPORTED",
		);
		f.reopen();
		expect(f.store.get(state.mission_id, f.kernel.state!.hypotheses[0], "Hypothesis")).toEqual(hypothesis);
	});
	it("a new requirement fences final source capture while retaining the launched result and attempt", async () => {
		const f = fixture("run: node diagnostic.cjs");
		writeFileSync(join(f.cwd, "parser.txt"), "before");
		writeFileSync(join(f.cwd, "diagnostic.cjs"), "console.log('EXPERIMENT_SUPPORTED');");
		expect(
			f.kernel.proposeHypothesis({ ...proposal, target: "parser.txt", expected_result: "EXPERIMENT_SUPPORTED" }),
		).toBe(true);
		let retrievalAtAmendment: number | null = null;
		const execution = f.kernel.execute(
			"bash",
			"changed-requirement-result",
			{ command: "node diagnostic.cjs" },
			undefined,
			(partial) => {
				if (
					retrievalAtAmendment === null &&
					partial.content.some((part) => part.type === "text" && part.text.includes("EXPERIMENT_SUPPORTED"))
				) {
					f.kernel.amend("Also preserve parser behavior");
					retrievalAtAmendment = f.kernel.state!.used.retrieval_bytes;
				}
			},
		);
		await expect(execution).rejects.toThrow("Post-dispatch capture cannot expand the admitted target scope");
		await expect(execution).rejects.toMatchObject({ failure: { code: "BINDING_STALE" } });
		expect(retrievalAtAmendment).not.toBeNull();
		const state = f.kernel.state!;
		expect(state.used.execution).toBe(1);
		expect(state.used.retrieval_bytes).toBe(retrievalAtAmendment);
		expect(state.requirements.map((ref) => f.store.get(state.mission_id, ref, "Requirement"))).toMatchObject([
			{ status: "UNMET" },
			{ status: "UNMET", text: "Also preserve parser behavior" },
		]);
		expect(f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis")).toMatchObject({
			attempts: 1,
			status: "ACTIVE",
			supporting: [],
			contradicting: [],
		});
		const operation = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
		const observation = f.store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
		expect(operation.status).toBe("CONFIRMED_COMPLETE");
		expect(observation.payload).toMatchObject({ dependencies: {}, process_sources: { complete: false } });
		expect(f.store.artifact(state.mission_id, observation.artifact_ref!).toString()).toContain(
			"EXPERIMENT_SUPPORTED",
		);
	});
	it.each(["expiry", "loss"] as const)(
		"retains a launched correction experiment across artifact %s",
		async (outcome) => {
			const now = Date.now();
			const clock = vi.spyOn(Date, "now").mockReturnValue(now);
			const f = fixture(
				`padma: ${JSON.stringify({
					objective: "repair parser behavior",
					allow_edits: true,
					shell_commands: ["node diagnostic.cjs"],
					requirements: [{ text: "behavior", rule: "SEMANTIC", target: "parser.txt" }],
				})}`,
				{
					configuration: { version: "sandhana/1", artifact: { retention_ms: 1000 } },
				},
			);
			writeFileSync(join(f.cwd, "parser.txt"), "before");
			expect(f.kernel.proposeHypothesis({ ...proposal, target: "parser.txt" })).toBe(true);
			await f.kernel.execute("write", "retained-correction", { path: "parser.txt", content: "after" });
			const corrected = f.kernel.state!;
			const delivered = f.store
				.records(corrected.mission_id)
				.findLast((record) => record.record_type === "Artifact" && record.purpose === "DELIVERED")!;
			f.kernel.register(
				createBashTool(f.cwd, {
					operations: {
						exec: async (_command, _cwd, { onData }) => {
							if (outcome === "expiry") clock.mockReturnValue(now + 1001);
							else {
								const database = new DatabaseSync(f.store.databasePath);
								try {
									database
										.prepare("DELETE FROM artifacts WHERE mission=? AND id=?")
										.run(corrected.mission_id, delivered.record_id);
								} finally {
									database.close();
								}
							}
							onData(Buffer.from("supported"));
							return { exitCode: 0, outputComplete: true };
						},
					},
				}),
				"bash",
			);
			await f.kernel.execute("bash", "correction-evidence-expired-after-start", { command: "node diagnostic.cjs" });
			const state = f.kernel.state!;
			const hypothesis = f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis");
			expect(hypothesis).toMatchObject({ attempts: 2, status: "ACTIVE", supporting: [], contradicting: [] });
			expect(state.used.execution).toBe(2);
			expect(() => f.store.artifact(state.mission_id, delivered.record_id)).toThrow(
				outcome === "expiry" ? "expired" : "unavailable",
			);
			const operation = f.store.get(state.mission_id, state.operations[1], "OperationRecord");
			const observation = f.store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
			expect(f.store.artifact(state.mission_id, observation.artifact_ref!).toString()).toContain("supported");
			f.reopen();
			expect(f.store.get(state.mission_id, f.kernel.state!.hypotheses[0], "Hypothesis")).toEqual(hypothesis);
			expect(f.kernel.selectHypothesis(hypothesis.record_id)).toBe(false);
		},
	);
	it.each(["stale", "late", "unversioned"] as const)(
		"rejects %s selection claims without changing branch history",
		async (variant) => {
			const f = fixture();
			const path = join(f.cwd, "parser.txt");
			writeFileSync(path, "before");
			expect(f.kernel.proposeHypothesis({ ...proposal, target: "parser.txt" })).toBe(true);
			await f.kernel.execute("read", "original-experiment", { path: "parser.txt" });
			if (variant === "stale") {
				writeFileSync(path, "external postimage");
				await f.kernel.execute("read", "observed-stale-premise", { path: "parser.txt" });
			}
			const state = f.kernel.state!;
			const history = f.store.records(state.mission_id);
			const candidate = history.findLast((record) => record.record_type === "CandidateAction")!;
			const action = history.findLast((record) => record.record_type === "PreparedAction")!;
			if (candidate.record_type !== "CandidateAction" || action.record_type !== "PreparedAction")
				throw new Error("Missing preparation fixture");
			const binding = makeRecord(
				state.mission_id,
				state.revision + 1,
				"TargetBinding",
				f.store.get(state.mission_id, action.binding_ref, "TargetBinding"),
			);
			const operationId = variant === "late" ? candidate.operation_id : `forged-${variant}-selection`;
			const prepared = makeRecord(state.mission_id, state.revision + 1, "PreparedAction", {
				...action,
				operation_id: operationId,
				binding_ref: binding.record_id,
				action_digest: actionDigest({ ...action, binding_ref: binding.record_id }),
			});
			const data: RecordOf<"CandidateAction"> = {
				...candidate,
				operation_id: operationId,
				hypothesis_ref: state.hypotheses[0],
				hypothesis_binding_ref: binding.record_id,
				hypothesis_selection_version: "HYPOTHESIS_SELECTION/1" as const,
			};
			if (variant === "unversioned") delete data.hypothesis_selection_version;
			const selected = makeRecord(state.mission_id, state.revision + 1, "CandidateAction", data);
			expect(() =>
				f.store.commit(state.revision, { ...state, revision: state.revision + 1 }, [binding, selected, prepared]),
			).toThrow(
				variant === "stale"
					? "eligible premise"
					: variant === "late"
						? "before its operation exists"
						: "versioned premise validation",
			);
			expect(f.kernel.state).toEqual(state);
			expect(f.store.records(state.mission_id)).toEqual(history);
		},
	);
	it("an ineligible unattempted branch releases its slot without erasing evidence or allowing cosmetic reopening", async () => {
		const f = fixture();
		const path = join(f.cwd, "parser.txt");
		writeFileSync(path, "before");
		expect(f.kernel.proposeHypothesis({ ...proposal, target: "parser.txt" })).toBe(true);
		const original = f.store.get(f.kernel.state!.mission_id, f.kernel.state!.hypotheses[0], "Hypothesis");
		writeFileSync(path, "supported");
		expect(f.kernel.proposeHypothesis({ ...proposal, target: "parser.txt", mechanism: "NORMALIZE" })).toBe(true);
		const state = f.kernel.state!;
		expect(state.hypotheses.map((ref) => f.store.get(state.mission_id, ref, "Hypothesis"))).toMatchObject([
			{ status: "REJECTED", attempts: 0, supporting: [], contradicting: [] },
			{ status: "ACTIVE", attempts: 0 },
		]);
		expect(state.used.execution).toBe(0);
		expect(state.stagnation).toBe(0);
		expect(f.store.get(state.mission_id, original.record_id, "Hypothesis")).toEqual(original);
		expect(
			f.kernel.proposeHypothesis({ ...proposal, target: "parser.txt", expected_result: "cosmetic prediction" }),
		).toBe(false);
		f.reopen();
		await f.kernel.execute("read", "new-mechanism-trial", { path: "parser.txt" });
		expect(f.store.get(state.mission_id, f.kernel.state!.hypotheses[1], "Hypothesis")).toMatchObject({
			status: "SUPPORTED",
			attempts: 1,
		});
		expect(f.kernel.proposeHypothesis({ ...proposal, target: "parser.txt" })).toBe(true);
		expect(f.store.get(state.mission_id, f.kernel.state!.hypotheses[1], "Hypothesis")).toMatchObject({
			hypothesis_id: original.hypothesis_id,
			status: "ACTIVE",
			attempts: 0,
		});
	});
	it.each(["unchanged", "model"] as const)("rejects %s premise-pruning evidence", async (variant) => {
		const f = fixture();
		writeFileSync(join(f.cwd, "parser.txt"), "before");
		expect(f.kernel.proposeHypothesis({ ...proposal, target: "parser.txt" })).toBe(true);
		const state = f.kernel.state!;
		const hypothesis = f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis");
		const binding = f.store.get(state.mission_id, hypothesis.premise_binding_ref!, "TargetBinding");
		const generation = variant === "model" ? "untrusted generation" : binding.generation;
		const preimageDigest = variant === "model" ? "untrusted digest" : binding.preimage_digest;
		const facts = {
			canonical_path: binding.canonical_path,
			workspace_id: binding.workspace_id,
			environment: binding.environment,
			generation,
			preimage_digest: preimageDigest,
		};
		const observed = makeRecord(state.mission_id, state.revision + 1, "EvidenceRecord", {
			event_id: "forged-premise",
			stage: "adana",
			kind: "OBSERVATION",
			provenance: variant === "model" ? "MODEL" : "ADAPTER",
			target_generation: generation,
			captured_at: Date.now(),
			operation_id: null,
			source: "local-hypothesis-premise/1",
			payload: facts,
			artifact_ref: null,
			digest: digest(facts),
			sensitivity: "PRIVATE",
			sources: [],
			requirement_ids: [],
			correction_of: null,
			previous: state.last_event,
		});
		const current = makeRecord(state.mission_id, state.revision + 1, "TargetBinding", {
			...binding,
			generation,
			preimage_digest: preimageDigest,
			establishment_evidence: [observed.record_id],
		});
		const payload = {
			rule: "HYPOTHESIS_PREMISE_CHANGED/1",
			hypothesis_ref: hypothesis.record_id,
			binding_ref: current.record_id,
			observation_ref: observed.record_id,
		};
		const rejection = makeRecord(state.mission_id, state.revision + 1, "EvidenceRecord", {
			event_id: "forged-rejection",
			stage: "vikalpa",
			kind: "CONTROL",
			provenance: "KERNEL",
			target_generation: generation,
			captured_at: Date.now(),
			operation_id: null,
			source: "premise-applicability/1",
			payload,
			artifact_ref: null,
			digest: digest(payload),
			sensitivity: "PRIVATE",
			sources: [observed.record_id],
			requirement_ids: [],
			correction_of: null,
			previous: observed.record_id,
		});
		const retired = makeRecord(state.mission_id, state.revision + 1, "Hypothesis", {
			...hypothesis,
			status: "REJECTED",
			rejection_ref: rejection.record_id,
		});
		expect(() =>
			f.store.commit(
				state.revision,
				{ ...state, revision: state.revision + 1, hypotheses: [retired.record_id], leading_hypothesis: null },
				[observed, current, rejection, retired],
			),
		).toThrow("actual captured ineligible premise");
		expect(f.kernel.state).toEqual(state);
	});
	it("store rejects invented refutations, altered fingerprints and erased branch history", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "parser.txt"), "irrelevant result");
		expect(f.kernel.proposeHypothesis(proposal)).toBe(true);
		await f.kernel.execute("read", "non-decisive-experiment", { path: "parser.txt" });
		const state = f.kernel.state!;
		const hypothesis = f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis");
		const observation = f.store
			.records(state.mission_id)
			.findLast((record) => record.record_type === "EvidenceRecord" && record.stage === "phala")!;
		for (const fields of [
			{ status: "CONTRADICTED" as const, contradicting: [observation.record_id] },
			{ fingerprint: hypothesisFingerprint({ ...hypothesis, mechanism: "NORMALIZE" }) },
			{ normalization_version: undefined },
		]) {
			// A versionless historical record is readable, but cannot be used as a new controlled transition.
			const data = { ...hypothesis, ...fields, attempts: hypothesis.attempts + 1 };
			if (data.normalization_version === undefined) delete data.normalization_version;
			const forged = makeRecord(state.mission_id, state.revision + 1, "Hypothesis", data);
			expect(() =>
				f.store.commit(
					state.revision,
					{
						...state,
						revision: state.revision + 1,
						hypotheses: [forged.record_id],
						leading_hypothesis: forged.record_id,
					},
					[forged],
				),
			).toThrow();
			expect(f.kernel.state).toEqual(state);
		}
		expect(() =>
			f.store.commit(
				state.revision,
				{ ...state, revision: state.revision + 1, hypotheses: [], leading_hypothesis: null },
				[],
			),
		).toThrow("history cannot be dropped");
		const historical = { ...hypothesis, cause: "legacy prose", mechanism: "legacy mechanism" };
		delete historical.normalization_version;
		validateRecord(historical);
	});
	it("enforces environment and dependency boundaries during experiment applicability", async () => {
		const f = fixture();
		const path = join(f.cwd, "parser.txt");
		writeFileSync(path, "supported");
		expect(f.kernel.proposeHypothesis({ ...proposal, target: "parser.txt" })).toBe(true);
		const state = f.kernel.state!;
		const hypothesis = f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis");
		const originalBinding = f.store.get(state.mission_id, hypothesis.premise_binding_ref!, "TargetBinding");

		// 1. Premise binding boundary tests
		const diffEnvBinding = makeRecord(state.mission_id, state.revision + 1, "TargetBinding", {
			...originalBinding,
			environment: "OTHER_ENV",
		});
		expect(hypothesisPremiseMatches(f.store, hypothesis, diffEnvBinding)).toBe(false);

		const diffWorktreeBinding = makeRecord(state.mission_id, state.revision + 1, "TargetBinding", {
			...originalBinding,
			worktree_identity: "OTHER_WORKTREE",
		});
		expect(hypothesisPremiseMatches(f.store, hypothesis, diffWorktreeBinding)).toBe(false);

		const diffRepoBinding = makeRecord(state.mission_id, state.revision + 1, "TargetBinding", {
			...originalBinding,
			repository_identity: "OTHER_REPO",
		});
		expect(hypothesisPremiseMatches(f.store, hypothesis, diffRepoBinding)).toBe(false);

		// 2. Real observation applicability test
		await f.kernel.execute("read", "test-read", { path: "parser.txt" });
		const observation = f.store
			.records(state.mission_id)
			.findLast((r) => r.record_type === "EvidenceRecord" && r.stage === "phala") as RecordOf<"EvidenceRecord">;
		expect(observation).toBeDefined();

		// Observation applies directly
		expect(hypothesisObservationApplies(f.store, hypothesis, observation)).toBe(true);

		// Observation applies via dependencies payload
		const depHypothesis = { mission_id: state.mission_id, target: "external-lib.ts" };
		expect(hypothesisObservationApplies(f.store, depHypothesis, observation)).toBe(false);

		// Observation with dependencies in payload
		const depObservation = {
			...observation,
			payload: {
				...(observation.payload as Record<string, unknown>),
				dependencies: { "external-lib.ts": "hash123" },
			},
		};
		expect(hypothesisObservationApplies(f.store, depHypothesis, depObservation)).toBe(true);

		// Observation applicability
		const applicability = hypothesisExperimentApplicability(f.store, hypothesis, observation);
		expect(applicability.attempted).toBe(true);
		expect(applicability.resolvable).toBe(true);

		// Applicability fails when dependencies are unstable
		const unstableDepObservation = {
			...observation,
			payload: {
				...(observation.payload as Record<string, unknown>),
				dependencies: { [hypothesis.target]: "other-hash" },
				dependencies_unchanged: false,
			},
		};
		const depApplicability = hypothesisExperimentApplicability(f.store, hypothesis, unstableDepObservation);
		expect(depApplicability.attempted).toBe(true);
		expect(depApplicability.resolvable).toBe(false);

		// Applicability fails when after-binding environment does not match before-binding environment
		const currentState = f.kernel.state!;
		const diffEnvAfterBinding = makeRecord(currentState.mission_id, currentState.revision + 1, "TargetBinding", {
			...originalBinding,
			environment: "OTHER_ENV",
		});
		f.store.commit(currentState.revision, { ...currentState, revision: currentState.revision + 1 }, [
			diffEnvAfterBinding,
		]);
		const diffEnvObservation = {
			...observation,
			payload: {
				...(observation.payload as Record<string, unknown>),
				hypothesis_after_ref: diffEnvAfterBinding.record_id,
			},
		};
		const envApplicability = hypothesisExperimentApplicability(f.store, hypothesis, diffEnvObservation);
		expect(envApplicability.attempted).toBe(true);
		expect(envApplicability.resolvable).toBe(false);
	});
});
