import { Value } from "typebox/value";
import { repairedCheckProgress } from "./check-progress.ts";
import { localCheck } from "./checks.ts";
import { inside } from "./code.ts";
import { sameHypothesisApproach, selectedHypotheses } from "./hypotheses.ts";
import { observedProcessSources, processSourceDigests } from "./process-sources.ts";
import { validateLocalReconciliation } from "./reconciliation.ts";
import {
	BudgetChangeInputSchema,
	canonical,
	digest,
	type MissionRecord,
	type MissionState,
	type RecordOf,
} from "./records.ts";
import type { MissionStore } from "./store.ts";

type Progress = RecordOf<"CognitiveTick">["progress"];
export const COGNITIVE_RECOVERY_VERSION = "COGNITIVE_RECOVERY/1";

/** Recover the actual attempts since the last change in problem position, including across reopen. */
export function stagnantAttempts(store: MissionStore, state: MissionState) {
	const records = store.records(state.mission_id);
	const reset = records.findLast(
		(record) => record.record_type === "CognitiveTick" && record.status === "SETTLED" && record.progress.length > 0,
	);
	return state.operations.flatMap((ref) => {
		const operation = store.get(state.mission_id, ref, "OperationRecord");
		if (operation.started_at === null || !["CONFIRMED_COMPLETE", "FAILED"].includes(operation.status)) return [];
		const action = store.get(state.mission_id, operation.prepared_ref, "PreparedAction");
		if (action.revision <= (reset?.revision ?? 0)) return [];
		const candidate = records.findLast(
			(record) => record.record_type === "CandidateAction" && record.operation_id === operation.operation_id,
		);
		return [
			{
				operation,
				action,
				binding: store.get(state.mission_id, action.binding_ref, "TargetBinding"),
				hypotheses:
					candidate?.record_type === "CandidateAction"
						? selectedHypotheses(candidate).map((ref) => store.get(state.mission_id, ref, "Hypothesis"))
						: [],
				hypothesis:
					candidate?.record_type === "CandidateAction" && candidate.hypothesis_ref
						? store.get(state.mission_id, candidate.hypothesis_ref, "Hypothesis")
						: null,
			},
		];
	});
}

/** A correctable proposal rejection. It never authorizes an action or invents progress. */
export function diagnosisRejection(
	store: MissionStore,
	state: MissionState,
	action: RecordOf<"PreparedAction">,
	applicableVerification: boolean,
	currentSourceRefs: string[] = [],
): string | null {
	const contract = store.get(state.mission_id, state.contract, "MissionContract");
	if (!contract.configuration_ref) return "Diagnosis requires a compatible captured configuration";
	const configuration = store.get(state.mission_id, contract.configuration_ref, "KernelConfiguration").value;
	if (state.stagnation < configuration.stagnation.diagnose || applicableVerification) return null;
	const binding = store.get(state.mission_id, action.binding_ref, "TargetBinding");
	const schema = store.get(state.mission_id, action.schema_ref, "RegisteredActionSchema");
	const candidate = store
		.records(state.mission_id)
		.findLast((record) => record.record_type === "CandidateAction" && record.operation_id === action.operation_id);
	const leading =
		candidate?.record_type === "CandidateAction" && candidate.hypothesis_ref
			? store.get(state.mission_id, candidate.hypothesis_ref, "Hypothesis")
			: null;
	const targets = state.requirements.flatMap((ref) => {
		const requirement = store.get(state.mission_id, ref, "Requirement");
		return requirement.status === "SUPERSEDED" || requirement.status === "VERIFIED"
			? []
			: [
					...(requirement.target && requirement.target !== binding.worktree_identity ? [requirement.target] : []),
					...(requirement.dependencies ?? []),
				];
	});
	// A named diagnosis can establish a narrow component when the original objective has no exact path.
	targets.push(...state.hypotheses.map((ref) => store.get(state.mission_id, ref, "Hypothesis").target));
	if (
		!targets.some((target) => inside(target, binding.canonical_path)) &&
		!(leading?.status === "ACTIVE" && action.operation_class.startsWith("SHELL:"))
	)
		return "Choose an observation of an unresolved requirement or a named hypothesis target";
	const attempts = stagnantAttempts(store, state);
	const tick = state.cognitive_tick ? store.get(state.mission_id, state.cognitive_tick, "CognitiveTick") : null;
	if (tick?.status === "OPEN" && attempts.some((prior) => prior.action.revision > tick.revision))
		return "Only one optional targeted diagnosis is admitted in this decision; inspect its result before choosing another";
	if (
		binding.preimage_digest &&
		action.operation_class === "EDIT" &&
		action.intended_effect === `Content SHA256 ${binding.preimage_digest}`
	)
		return "An unchanged replacement is not a materially different attempt";
	const kind = schema.version.split("/")[0];
	const args = action.arguments as Record<string, unknown>;
	const check =
		action.operation_class.startsWith("SHELL:") && typeof args.command === "string"
			? localCheck(args.command, binding.worktree_identity)
			: null;
	const currentSources = check
		? processSourceDigests(store, state.mission_id, currentSourceRefs, action.operation_id)
		: null;
	const repeated = attempts.some((prior) => {
		const oldSchema = store.get(state.mission_id, prior.action.schema_ref, "RegisteredActionSchema");
		if (
			(oldSchema.version.split("/")[0] !== kind && !(check && prior.action.operation_class.startsWith("SHELL:"))) ||
			!inside(prior.binding.canonical_path, binding.canonical_path) ||
			!inside(binding.canonical_path, prior.binding.canonical_path)
		)
			return false;
		// Changed source bytes can justify a new observation; an mtime alone cannot.
		if (binding.preimage_digest !== prior.binding.preimage_digest) return false;
		const old = prior.action.arguments as Record<string, unknown>;
		if (kind === "read") {
			const start = typeof args.offset === "number" ? args.offset : 1;
			const end = typeof args.limit === "number" ? start + args.limit : Infinity;
			const oldStart = typeof old.offset === "number" ? old.offset : 1;
			const oldEnd = typeof old.limit === "number" ? oldStart + old.limit : Infinity;
			return oldStart <= start && oldEnd >= end;
		}
		if (check && typeof old.command === "string") {
			const priorCheck = localCheck(old.command, binding.worktree_identity);
			if (
				priorCheck &&
				priorCheck.runner === check.runner &&
				canonical([...priorCheck.targets].sort()) === canonical([...check.targets].sort())
			) {
				const observation = prior.operation.result_refs
					.map((ref) => store.get(state.mission_id, ref, "EvidenceRecord"))
					.find((record) => record.stage === "phala" && record.kind === "OBSERVATION");
				const previousSources = observation ? observedProcessSources(store, observation) : null;
				const relevant = [...check.targets, ...(leading ? [leading.target] : [])];
				return (
					!currentSources ||
					!previousSources ||
					!Object.keys(currentSources).some(
						(path) =>
							Object.hasOwn(previousSources, path) &&
							currentSources[path] !== previousSources[path] &&
							relevant.some((target) => inside(target, path)),
					)
				);
			}
		}
		return (
			digest(Object.fromEntries(Object.entries(args).filter(([key]) => key !== "path" && key !== "timeout"))) ===
			digest(Object.fromEntries(Object.entries(old).filter(([key]) => key !== "path" && key !== "timeout")))
		);
	});
	if (repeated)
		return "This experiment already ran on the same source; choose a discriminating observation or a different attempt";
	if (!schema.side_effect) return null;
	if (!leading || leading.status !== "ACTIVE")
		return "An effectful diagnosis requires an active hypothesis and its expected result";
	if (check) return null;
	if (action.operation_class.startsWith("SHELL:"))
		return "Opaque commands cannot establish a materially different diagnosis; choose a scoped foreground test";
	if (attempts.some((prior) => prior.hypothesis && sameHypothesisApproach(leading, prior.hypothesis)))
		return "Interrupt the stagnant mechanism; propose a materially different cause or correction mechanism";
	return null;
}

/** Only durable changes to obligation coverage, experimental resolution or validated recoverable state count. */
export function progressFacts(store: MissionStore, state: MissionState): Progress {
	const facts: Progress = [];
	const records = store.records(state.mission_id);
	for (const ref of state.requirements) {
		const requirement = store.get(state.mission_id, ref, "Requirement");
		if (requirement.status === "VERIFIED")
			facts.push({
				key: digest({
					kind: "REQUIREMENT",
					id: requirement.requirement_id,
					rule: requirement.rule,
					target: requirement.target,
					expected: requirement.expected,
				}),
				evidence: requirement.evidence,
			});
	}
	for (const ref of state.hypotheses) {
		const hypothesis = store.get(state.mission_id, ref, "Hypothesis");
		if (hypothesis.status === "SUPPORTED" || hypothesis.status === "CONTRADICTED")
			facts.push({
				key: digest({
					kind: "HYPOTHESIS",
					fingerprint: hypothesis.fingerprint,
					premise: hypothesis.premise_digest ?? hypothesis.premise_generation,
					result: hypothesis.status,
				}),
				evidence: hypothesis.status === "SUPPORTED" ? hypothesis.supporting : hypothesis.contradicting,
			});
	}
	for (const ref of state.checkpoints) {
		const checkpoint = store.get(state.mission_id, ref, "CheckpointRecord");
		if (checkpoint.level === "EXPERIMENTAL") continue;
		try {
			store.artifact(state.mission_id, checkpoint.artifact_ref);
		} catch {
			continue;
		}
		facts.push({
			key: digest({
				kind: "CHECKPOINT",
				target: checkpoint.target,
				preimage: checkpoint.preimage,
				level: checkpoint.level,
				coverage: [...checkpoint.coverage].sort(),
			}),
			evidence: checkpoint.verification_refs,
		});
	}
	for (const ref of state.operations) {
		const operation = store.get(state.mission_id, ref, "OperationRecord");
		if (operation.status !== "CONFIRMED_COMPLETE" || !operation.reconciliation_refs.length) continue;
		const proof = operation.reconciliation_refs
			.map((id) => store.get(state.mission_id, id, "ReconciliationRecord"))
			.findLast((record) => record.result === "POSTCONDITION_OBSERVED");
		if (!proof) continue;
		const original = store.get(state.mission_id, proof.operation_ref, "OperationRecord");
		if (original.operation_id !== operation.operation_id || original.prepared_ref !== operation.prepared_ref)
			continue;
		const selected = records.findLast(
			(record) =>
				record.record_type === "MissionContract" &&
				record.reconcile_operation_id === operation.operation_id &&
				record.revision <= proof.revision,
		);
		if (selected?.record_type !== "MissionContract") continue;
		try {
			// Recheck the original explicit selection and accessible raw inspection; a settled label alone is not progress.
			validateLocalReconciliation(store, { ...state, contract: selected.record_id }, proof);
		} catch {
			continue;
		}
		facts.push({
			key: digest({ kind: "LOCAL_POSTCONDITION", operation: operation.operation_id, expected: proof.expected }),
			evidence: [proof.observation_ref],
		});
	}
	const contract = store.get(state.mission_id, state.contract, "MissionContract");
	for (const record of records) {
		if (
			record.record_type !== "EvidenceRecord" ||
			record.kind !== "VERIFICATION" ||
			record.stage !== "pariskara" ||
			record.provenance !== "KERNEL" ||
			!record.payload ||
			typeof record.payload !== "object"
		)
			continue;
		const payload = record.payload;
		if (
			!("rule" in payload) ||
			payload.rule !== "DECLARED_PROCESS_QUALITY" ||
			!("result" in payload) ||
			payload.result !== "PASSED" ||
			!("command" in payload) ||
			typeof payload.command !== "string" ||
			!contract.quality_obligations.includes(`PROCESS:${payload.command}`)
		)
			continue;
		const observation = store.get(state.mission_id, record.sources[0], "EvidenceRecord");
		const actual = observation.payload;
		if (
			!actual ||
			typeof actual !== "object" ||
			!("isError" in actual) ||
			actual.isError !== false ||
			!("dependencies_unchanged" in actual) ||
			actual.dependencies_unchanged !== true ||
			!observation.artifact_ref
		)
			continue;
		try {
			store.artifact(state.mission_id, observation.artifact_ref);
		} catch {
			continue;
		}
		const key = digest({ kind: "QUALITY", command: payload.command });
		if (!facts.some((fact) => fact.key === key)) facts.push({ key, evidence: [record.record_id] });
	}
	facts.push(...repairedCheckProgress(store, state, records));
	for (const ref of state.requirements) {
		const req = store.get(state.mission_id, ref, "Requirement");
		if (req.status !== "BLOCKED" && req.status !== "SUPERSEDED" && req.dependencies && req.dependencies.length > 0) {
			const reqHistory = records.filter(
				(r): r is RecordOf<"Requirement"> =>
					r.record_type === "Requirement" && r.requirement_id === req.requirement_id,
			);
			if (reqHistory.some((r) => r.status === "BLOCKED")) {
				const key = digest({
					kind: "DEPENDENCY_REPAIRED",
					id: req.requirement_id,
					dependencies: [...req.dependencies].sort(),
				});
				if (!facts.some((fact) => fact.key === key)) facts.push({ key, evidence: [req.record_id] });
			}
		}
	}
	return facts.sort((left, right) => left.key.localeCompare(right.key));
}

export function knownProgress(store: MissionStore, state: MissionState): string[] {
	const historical = store
		.records(state.mission_id)
		.flatMap((record) =>
			record.record_type === "CognitiveTick" && record.status === "SETTLED"
				? record.progress.map((fact) => fact.key)
				: [],
		);
	return [...new Set([...historical, ...progressFacts(store, state).map((fact) => fact.key)])].sort();
}

export function validateCognitiveTickTransition(
	store: MissionStore,
	state: MissionState,
	previous: MissionState | undefined,
	additions: MissionRecord[],
): void {
	for (const record of additions) {
		if (record.record_type !== "EvidenceRecord" || record.source !== COGNITIVE_RECOVERY_VERSION) continue;
		const payload = record.payload;
		if (!previous || !payload || typeof payload !== "object" || Array.isArray(payload))
			throw new Error("Interrupted cognitive recovery requires its original owner and decision");
		const facts = payload as Record<string, unknown>;
		const tick = previous.cognitive_tick
			? store.get(state.mission_id, previous.cognitive_tick, "CognitiveTick")
			: null;
		const originalUsage = tick ? store.get(state.mission_id, tick.model_reservation_ref, "BudgetReservation") : null;
		const usage = originalUsage
			? previous.reservations
					.map((ref) => store.get(state.mission_id, ref, "BudgetReservation"))
					.find((reservation) => reservation.owner_operation_id === originalUsage.owner_operation_id)
			: null;
		const instruction =
			typeof facts.instruction === "string"
				? /^resume ([a-zA-Z0-9-]+)(?: budget: ([\s\S]+))?$/.exec(facts.instruction)
				: null;
		let validBudget = true;
		if (instruction?.[2]) {
			try {
				validBudget = Value.Check(BudgetChangeInputSchema, JSON.parse(instruction[2]));
			} catch {
				validBudget = false;
			}
		}
		let alive = true;
		try {
			process.kill(previous.owner_pid, 0);
		} catch (error) {
			alive = !(error instanceof Error && "code" in error && error.code === "ESRCH");
		}
		if (
			alive ||
			previous.terminal ||
			previous.owner_pid === process.pid ||
			state.owner_pid !== process.pid ||
			record.kind !== "CONTROL" ||
			record.provenance !== "KERNEL" ||
			record.stage !== "niyantr" ||
			record.operation_id !== null ||
			record.target_generation !== null ||
			record.artifact_ref !== null ||
			record.sources.length ||
			record.requirement_ids.length ||
			record.correction_of !== null ||
			record.previous !== previous.last_event ||
			record.sensitivity !== "PRIVATE" ||
			!tick ||
			tick.status !== "OPEN" ||
			!usage ||
			instruction?.[1] !== state.mission_id ||
			!validBudget ||
			canonical(payload) !==
				canonical({
					instruction: facts.instruction,
					source_revision: previous.revision,
					prior_owner_pid: previous.owner_pid,
					contract_ref: previous.contract,
					tick_ref: previous.cognitive_tick,
					model_reservation_ref: usage.record_id,
					model_usage_status: usage.state === "RECONCILED" ? "SETTLED" : "UNKNOWN_RETAINED",
				}) ||
			record.digest !== digest(payload) ||
			additions.length !== 1 ||
			state.last_event !== record.record_id ||
			canonical(state) !==
				canonical({ ...previous, revision: state.revision, owner_pid: process.pid, last_event: record.record_id })
		)
			throw new Error("Interrupted cognitive recovery cannot steal a live owner or change its account");
	}
	const ticks = additions.filter((record) => record.record_type === "CognitiveTick");
	if (!ticks.length) {
		if (
			(state.cognitive_tick ?? null) !== (previous?.cognitive_tick ?? null) ||
			state.stagnation !== (previous?.stagnation ?? 0)
		)
			throw new Error("Stagnation changes require a durable cognitive tick settlement");
		return;
	}
	if (!previous || ticks.length !== 1 || state.cognitive_tick !== ticks[0].record_id)
		throw new Error("A cognitive tick requires one current transition");
	const tick = ticks[0];
	const prior = previous.cognitive_tick ? store.get(state.mission_id, previous.cognitive_tick, "CognitiveTick") : null;
	const reservation = store.get(state.mission_id, tick.model_reservation_ref, "BudgetReservation");
	if (
		!reservation.owner_operation_id.startsWith("model:") ||
		(!previous.reservations.includes(tick.model_reservation_ref) && tick.status === "OPEN")
	)
		throw new Error("A cognitive tick requires its admitted model reservation");
	if (tick.status === "OPEN") {
		if (
			prior?.status === "OPEN" ||
			reservation.state !== "RESERVED" ||
			store
				.records(state.mission_id)
				.some(
					(record) =>
						record.record_type === "CognitiveTick" &&
						record.record_id !== tick.record_id &&
						(record.model_reservation_ref === tick.model_reservation_ref || record.tick_id === tick.tick_id),
				) ||
			tick.progress.length ||
			tick.stagnation_before !== previous.stagnation ||
			tick.stagnation_after !== previous.stagnation ||
			state.stagnation !== previous.stagnation ||
			canonical(tick.known_progress) !== canonical(knownProgress(store, previous))
		)
			throw new Error("Invalid cognitive tick baseline or repeated model decision");
	} else {
		if (
			!prior ||
			prior.status !== "OPEN" ||
			tick.tick_id !== prior.tick_id ||
			tick.model_reservation_ref !== prior.model_reservation_ref ||
			tick.stagnation_before !== prior.stagnation_before ||
			canonical(tick.known_progress) !== canonical(prior.known_progress)
		)
			throw new Error("A cognitive tick can settle its open decision exactly once");
		const progress = progressFacts(store, state).filter((fact) => !prior.known_progress.includes(fact.key));
		const expected = progress.length ? 0 : prior.stagnation_before + 1;
		if (
			canonical(progress) !== canonical(tick.progress) ||
			tick.stagnation_after !== expected ||
			state.stagnation !== expected
		)
			throw new Error("Cognitive tick progress must match new durable evidence");
	}
}
