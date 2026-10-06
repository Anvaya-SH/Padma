import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { digest, type HypothesisProposal, makeRecord } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createBashTool, createReadTool } from "../src/core/tools/index.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const close of cleanup.splice(0).reverse()) close();
});
function fixture(execution = 40, instruction = "Fix the parser behavior") {
	const cwd = mkdtempSync(join(tmpdir(), "padma-hypothesis-availability-"));
	writeFileSync(join(cwd, "parser.txt"), "actual source");
	writeFileSync(join(cwd, "other.txt"), "independent source");
	const store = new MissionStore(":memory:");
	const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "availability", store, limits: { execution } });
	cleanup.push(() => {
		store.close();
		rmSync(cwd, { recursive: true, force: true });
	});
	const read = createReadTool(cwd);
	const invoke = vi.spyOn(read, "execute");
	kernel.register(read, "read");
	kernel.captureInput(instruction, "USER");
	kernel.begin("");
	const proposal: HypothesisProposal = {
		target: "parser.txt",
		cause: "INPUT_FORMAT",
		mechanism: "VALIDATE",
		failure_signature: "refuted",
		expected_result: "supported",
	};
	expect(kernel.proposeHypothesis(proposal)).toBe(true);
	return { cwd, store, kernel, proposal, invoke };
}

describe("evidence-bound hypothesis availability", () => {
	it.each(["expiry", "scope"] as const)(
		"retires a settled branch after current %s exclusion and preserves its history",
		(reason) => {
			const f = fixture();
			const before = f.kernel.state!;
			const original = f.store.get(before.mission_id, before.hypotheses[0], "Hypothesis");
			if (reason === "expiry") {
				const expiredAt =
					Math.max(
						...before.authorizations.map(
							(ref) => f.store.get(before.mission_id, ref, "Authorization").expires_at,
						),
					) + 1;
				vi.spyOn(Date, "now").mockReturnValue(expiredAt);
			} else f.kernel.amend('operations: {"deny_targets":["parser.txt"]}');
			expect(f.kernel.selectHypothesis(original.record_id)).toBe(false);
			const state = f.kernel.state!;
			const retired = f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis");
			expect(retired).toMatchObject({
				status: "REJECTED",
				attempts: original.attempts,
				supporting: original.supporting,
				contradicting: original.contradicting,
			});
			expect(f.store.get(state.mission_id, retired.rejection_ref!, "EvidenceRecord").payload).toMatchObject({
				rule: "HYPOTHESIS_UNAVAILABLE/1",
				reason: reason === "expiry" ? "NO_CURRENT_AUTHORIZATION" : "TARGET_EXCLUDED",
			});
			expect(f.store.get(state.mission_id, original.record_id, "Hypothesis")).toEqual(original);
			expect(state.used.execution).toBe(0);
			expect(f.invoke).not.toHaveBeenCalled();
			if (reason === "scope") expect(f.kernel.proposeHypothesis({ ...f.proposal, target: "other.txt" })).toBe(true);
			else expect(f.kernel.proposeHypothesis({ ...f.proposal, target: "other.txt" })).toBe(false);
		},
	);
	it("retires optional experiments when only protected check capacity remains, retaining the charged attempt", async () => {
		const f = fixture(7);
		const before = f.kernel.state!;
		await f.kernel.execute("read", "last-optional-diagnosis", { path: "parser.txt" });
		const state = f.kernel.state!;
		const retired = f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis");
		expect(retired).toMatchObject({ status: "REJECTED", attempts: 1 });
		expect(f.store.get(state.mission_id, retired.rejection_ref!, "EvidenceRecord").payload).toMatchObject({
			reason: "PROTECTED_CAPACITY",
			reservation_refs: state.reservations,
		});
		expect(state.used.execution).toBe(1);
		expect(state.verification_reserve).toBe(before.verification_reserve);
		expect(f.kernel.proposeHypothesis({ ...f.proposal, target: "other.txt" })).toBe(false);
	});
	it("does not erase a launched attempt when scope is revoked during the actual process", async () => {
		const f = fixture(40, "run: node diagnostic.cjs");
		writeFileSync(
			join(f.cwd, "diagnostic.cjs"),
			"console.log(require('node:fs').readFileSync('parser.txt', 'utf8')); console.log('SCOPE_REVOKED');",
		);
		f.kernel.register(createBashTool(f.cwd), "bash");
		let revoked = false;
		await expect(
			f.kernel.execute(
				"bash",
				"already-launched-diagnosis",
				{ command: "node diagnostic.cjs" },
				undefined,
				(partial) => {
					if (
						revoked ||
						!partial.content.some((part) => part.type === "text" && part.text.includes("SCOPE_REVOKED"))
					)
						return;
					const current = f.kernel.state!;
					expect(f.store.get(current.mission_id, current.operations[0], "OperationRecord").status).toBe(
						"IN_PROGRESS",
					);
					f.kernel.amend('operations: {"deny_targets":["parser.txt"]}');
					revoked = true;
					expect(f.store.get(current.mission_id, f.kernel.state!.hypotheses[0], "Hypothesis").status).toBe(
						"ACTIVE",
					);
				},
			),
		).rejects.toThrow("Current user constraint denies this source target");
		expect(revoked).toBe(true);
		const state = f.kernel.state!;
		expect(state.used.execution).toBe(1);
		expect(f.store.get(state.mission_id, state.operations[0], "OperationRecord").status).toBe("CONFIRMED_COMPLETE");
		const branch = f.store.get(state.mission_id, state.hypotheses[0], "Hypothesis");
		expect(branch).toMatchObject({ status: "REJECTED", attempts: 1 });
	});
	it("rejects an invented exclusion that would retire a usable branch", () => {
		const f = fixture();
		const before = f.kernel.state!;
		const hypothesis = f.store.get(before.mission_id, before.hypotheses[0], "Hypothesis");
		const payload = {
			rule: "HYPOTHESIS_UNAVAILABLE/1",
			hypothesis_ref: hypothesis.record_id,
			reason: "PROTECTED_CAPACITY",
			authorization_refs: before.authorizations,
			constraint_refs: [],
			reservation_refs: before.reservations,
		};
		const evidence = makeRecord(before.mission_id, before.revision + 1, "EvidenceRecord", {
			event_id: "forged-exclusion",
			stage: "vikalpa",
			kind: "CONTROL",
			provenance: "KERNEL",
			captured_at: Date.now(),
			target_generation: hypothesis.premise_generation,
			operation_id: null,
			source: "hypothesis-availability/1",
			payload,
			artifact_ref: null,
			digest: digest(payload),
			sensitivity: "PRIVATE",
			sources: [],
			requirement_ids: [],
			correction_of: null,
			previous: before.last_event,
		});
		const retired = makeRecord(before.mission_id, before.revision + 1, "Hypothesis", {
			...hypothesis,
			status: "REJECTED",
			rejection_ref: evidence.record_id,
		});
		expect(() =>
			f.store.commit(
				before.revision,
				{
					...before,
					revision: before.revision + 1,
					hypotheses: [retired.record_id],
					leading_hypothesis: null,
					last_event: evidence.record_id,
				},
				[evidence, retired],
			),
		).toThrow("exclusion");
		expect(f.kernel.state).toEqual(before);
	});
});
