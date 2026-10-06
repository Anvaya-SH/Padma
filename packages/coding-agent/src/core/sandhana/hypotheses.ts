import { Type } from "typebox";
import { Value } from "typebox/value";
import { inside, secretPath } from "./code.ts";
import { isToolOutput } from "./output.ts";
import { ProcessSourceSnapshotSchema, processSourceDigests } from "./process-sources.ts";
import {
	canonical,
	digest,
	HypothesisProposalSchema,
	type MissionRecord,
	type MissionState,
	type RecordOf,
} from "./records.ts";
import type { MissionStore } from "./store.ts";

type Identity = Pick<
	RecordOf<"Hypothesis">,
	"target" | "cause" | "mechanism" | "failure_signature" | "expected_result"
>;

const mergeSchema = Type.Object(
	{
		version: Type.Literal("EQUIVALENT_HYPOTHESIS/1"),
		hypothesis_ref: Type.String({ minLength: 1 }),
		binding_ref: Type.String({ minLength: 1 }),
		proposal: HypothesisProposalSchema,
	},
	{ additionalProperties: false },
);
const revocationSchema = Type.Object(
	{
		rule: Type.Literal("HYPOTHESIS_AUTHORIZATION_REVOKED/1"),
		hypothesis_ref: Type.String({ minLength: 1 }),
		authorization_refs: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
	},
	{ additionalProperties: false },
);
const unavailableSchema = Type.Object(
	{
		rule: Type.Literal("HYPOTHESIS_UNAVAILABLE/1"),
		hypothesis_ref: Type.String({ minLength: 1 }),
		reason: Type.Enum(["TARGET_EXCLUDED", "NO_CURRENT_AUTHORIZATION", "PROTECTED_CAPACITY"]),
		authorization_refs: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
		constraint_refs: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
		reservation_refs: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
	},
	{ additionalProperties: false },
);

/** Exclude only provably unavailable experiments; a partial grant overlap can still support a narrower diagnosis. */
export function hypothesisExclusion(
	store: MissionStore,
	state: MissionState,
	target: string,
	environment: string,
	at: number,
): "TARGET_EXCLUDED" | "NO_CURRENT_AUTHORIZATION" | "PROTECTED_CAPACITY" | null {
	if (
		secretPath(target) ||
		(state.operation_constraints ?? []).some((constraint) => inside(constraint.target, target))
	)
		return "TARGET_EXCLUDED";
	const contract = store.get(state.mission_id, state.contract, "MissionContract");
	if (
		!state.authorizations.some((ref) => {
			const grant = store.get(state.mission_id, ref, "Authorization");
			return (
				!grant.revoked &&
				grant.expires_at >= at &&
				grant.policy_version === contract.policy_version &&
				grant.environment === environment &&
				grant.classes.length > 0 &&
				(inside(grant.target, target) || inside(target, grant.target))
			);
		})
	)
		return "NO_CURRENT_AUTHORIZATION";
	const pending = state.reservations.reduce((total, ref) => {
		const reservation = store.get(state.mission_id, ref, "BudgetReservation");
		return (
			total + (["RESERVED", "STARTED", "RETAINED"].includes(reservation.state) ? reservation.amounts.execution : 0)
		);
	}, 0);
	return state.used.execution + pending >= state.ceilings.execution - state.verification_reserve
		? "PROTECTED_CAPACITY"
		: null;
}

/** Complete revocation excludes every experiment; a denied individual action need not exclude its hypothesis. */
export function hypothesesRevoked(store: MissionStore, state: MissionState): boolean {
	return (
		state.authorizations.length > 0 &&
		state.authorizations.every((ref) => {
			const grant = store.get(state.mission_id, ref, "Authorization");
			if (!grant.revoked || grant.source_ref === state.command) return false;
			return store.get(state.mission_id, grant.source_ref, "Amendment").revokes;
		})
	);
}

/** Started or uncertain experiments must retain their branch until the actual attempt can be accounted for. */
export function hypothesisInFlight(
	store: MissionStore,
	state: MissionState,
	hypothesis: RecordOf<"Hypothesis">,
): boolean {
	const records = store.records(state.mission_id);
	return state.operations.some((ref) => {
		const operation = store.get(state.mission_id, ref, "OperationRecord");
		if (!["IN_PROGRESS", "OUTCOME_UNKNOWN"].includes(operation.status)) return false;
		const candidate = records.findLast(
			(record) => record.record_type === "CandidateAction" && record.operation_id === operation.operation_id,
		);
		return (
			candidate?.record_type === "CandidateAction" &&
			selectedHypotheses(candidate).some(
				(ref) => store.get(state.mission_id, ref, "Hypothesis").hypothesis_id === hypothesis.hypothesis_id,
			)
		);
	});
}

/** Reusing a current prediction retains proposal history, but cannot create an experiment or reset its premise. */
export function validateHypothesisMerge(
	store: MissionStore,
	receipt: RecordOf<"EvidenceRecord">,
	state: MissionState,
	previous: MissionState | undefined,
	additions: MissionRecord[],
): void {
	const data = receipt.payload;
	if (!previous || !Value.Check(mergeSchema, data)) throw new Error("Invalid equivalent hypothesis merge");
	const hypothesis = store.get(state.mission_id, data.hypothesis_ref, "Hypothesis");
	const binding = store.get(state.mission_id, data.binding_ref, "TargetBinding");
	if (
		receipt.source !== "hypothesis-normalization/1" ||
		receipt.stage !== "vikalpa" ||
		receipt.kind !== "CONTROL" ||
		receipt.provenance !== "KERNEL" ||
		receipt.operation_id !== null ||
		receipt.artifact_ref !== null ||
		receipt.sources.length ||
		receipt.requirement_ids.length ||
		receipt.correction_of !== null ||
		receipt.previous !== previous.last_event ||
		receipt.target_generation !== binding.generation ||
		!previous.hypotheses.includes(hypothesis.record_id) ||
		hypothesis.status !== "ACTIVE" ||
		hypothesis.normalization_version !== "CONTROLLED_HYPOTHESIS/1" ||
		data.proposal.target !== binding.canonical_path ||
		hypothesisFingerprint(data.proposal) !== hypothesis.fingerprint ||
		(data.proposal.parent_ref !== undefined && data.proposal.parent_ref !== hypothesis.parent_ref) ||
		!binding.valid ||
		binding.session_id !== state.session_id ||
		binding.revision !== receipt.revision ||
		!hypothesisPremiseMatches(store, hypothesis, binding, previous.revision) ||
		additions.length !== 2 ||
		!additions.some((record) => record.record_id === binding.record_id) ||
		canonical(state) !==
			canonical({
				...previous,
				revision: receipt.revision,
				leading_hypothesis: hypothesis.record_id,
				last_event: receipt.record_id,
			})
	)
		throw new Error("Equivalent merge requires one current eligible prediction and unchanged experiment history");
}

export function selectedHypotheses(candidate: RecordOf<"CandidateAction">): string[] {
	return candidate.hypothesis_ref
		? [candidate.hypothesis_ref, ...(candidate.shared_experiment?.hypothesis_refs ?? [])]
		: [];
}

export function hypothesisFingerprint(fields: Identity): string {
	return digest({
		version: "CONTROLLED_HYPOTHESIS/1",
		target: process.platform === "win32" ? fields.target.toLowerCase() : fields.target,
		cause: fields.cause,
		mechanism: fields.mechanism,
		// Exact signatures and expected results identify the prediction. Approach equivalence separately rejects rephrasing.
		failure_signature: fields.failure_signature,
		expected_result: fields.expected_result,
	});
}

export function sameHypothesisApproach(left: Identity, right: Identity): boolean {
	return (
		left.cause === right.cause &&
		left.mechanism === right.mechanism &&
		(process.platform === "win32"
			? left.target.toLowerCase() === right.target.toLowerCase()
			: left.target === right.target)
	);
}

/** A known guarded correction extends the experiment; an external replacement does not. */
export function hypothesisPremiseMatches(
	store: MissionStore,
	hypothesis: RecordOf<"Hypothesis">,
	binding: RecordOf<"TargetBinding">,
	maximumRevision = Number.MAX_SAFE_INTEGER,
): boolean {
	if (!inside(hypothesis.target, binding.canonical_path) || !inside(binding.canonical_path, hypothesis.target))
		return false;
	if (!hypothesis.premise_binding_ref) return binding.generation === hypothesis.premise_generation;
	const original = store.get(hypothesis.mission_id, hypothesis.premise_binding_ref, "TargetBinding");
	if (
		binding.workspace_id !== original.workspace_id ||
		binding.environment !== original.environment ||
		binding.worktree_identity !== original.worktree_identity ||
		binding.repository_identity !== original.repository_identity
	)
		return false;
	const allowed = new Set([hypothesis.premise_digest ?? hypothesis.premise_generation]);
	if (allowed.has(binding.preimage_digest ?? binding.generation)) return true;
	const records = store.records(hypothesis.mission_id).filter((record) => record.revision <= maximumRevision);
	for (const candidate of records) {
		if (
			candidate.record_type !== "CandidateAction" ||
			!candidate.hypothesis_ref ||
			candidate.revision <= (hypothesis.created_revision ?? 0)
		)
			continue;
		const selected = store.get(hypothesis.mission_id, candidate.hypothesis_ref, "Hypothesis");
		if (
			selected.hypothesis_id !== hypothesis.hypothesis_id ||
			selected.premise_binding_ref !== hypothesis.premise_binding_ref
		)
			continue;
		const operation = records.findLast(
			(record) => record.record_type === "OperationRecord" && record.operation_id === candidate.operation_id,
		);
		if (operation?.record_type !== "OperationRecord" || operation.status !== "CONFIRMED_COMPLETE") continue;
		const action = store.get(hypothesis.mission_id, operation.prepared_ref, "PreparedAction");
		const before = store.get(hypothesis.mission_id, action.binding_ref, "TargetBinding");
		const schema = store.get(hypothesis.mission_id, action.schema_ref, "RegisteredActionSchema");
		if (
			before.canonical_path !== hypothesis.target ||
			!allowed.has(before.preimage_digest ?? before.generation) ||
			!schema.conditional_commit ||
			!/^(?:write|edit|restore)\/2:/.test(schema.version)
		)
			continue;
		const result = operation.result_refs
			.map((ref) => store.get(hypothesis.mission_id, ref, "EvidenceRecord"))
			.find((record) => record.stage === "phala" && record.kind === "OBSERVATION");
		const payload = result?.payload;
		if (
			!result ||
			result.provenance !== "ADAPTER" ||
			!payload ||
			typeof payload !== "object" ||
			!("isError" in payload) ||
			payload.isError !== false ||
			!("unknown" in payload) ||
			payload.unknown !== false
		)
			continue;
		for (const artifact of records) {
			if (
				artifact.record_type !== "Artifact" ||
				artifact.purpose !== "DELIVERED" ||
				artifact.target !== hypothesis.target ||
				artifact.revision !== result.revision ||
				!("after_generation" in payload) ||
				artifact.generation !== payload.after_generation ||
				action.intended_effect !== `Content SHA256 ${artifact.digest}`
			)
				continue;
			try {
				store.artifact(hypothesis.mission_id, artifact.record_id);
				allowed.add(artifact.digest);
			} catch {
				/* Expired or unavailable bytes cannot extend the current experiment. */
			}
		}
	}
	return allowed.has(binding.preimage_digest ?? binding.generation);
}

export function hypothesisExperimentApplicability(
	store: MissionStore,
	hypothesis: RecordOf<"Hypothesis">,
	observation: RecordOf<"EvidenceRecord">,
): { attempted: boolean; resolvable: boolean } {
	const records = store.records(hypothesis.mission_id);
	const operation = records.findLast(
		(record) =>
			record.record_type === "OperationRecord" &&
			record.operation_id === observation.operation_id &&
			record.result_refs.includes(observation.record_id),
	);
	if (
		observation.kind !== "OBSERVATION" ||
		observation.provenance !== "ADAPTER" ||
		observation.stage !== "phala" ||
		operation?.record_type !== "OperationRecord" ||
		operation.started_at === null ||
		operation.status === "NOT_STARTED"
	)
		return { attempted: false, resolvable: false };
	const action = store.get(hypothesis.mission_id, operation.prepared_ref, "PreparedAction");
	const target = store.get(hypothesis.mission_id, action.binding_ref, "TargetBinding");
	const data = observation.payload;
	let related = inside(hypothesis.target, target.canonical_path);
	if (!related && data && typeof data === "object") {
		related = Boolean(
			"dependencies" in data &&
				data.dependencies &&
				typeof data.dependencies === "object" &&
				Object.hasOwn(data.dependencies, hypothesis.target),
		);
		if (!related && "process_sources" in data && Value.Check(ProcessSourceSnapshotSchema, data.process_sources)) {
			// The admitted source vector survives a failed post-launch capture or revoked read scope.
			const sources = processSourceDigests(
				store,
				hypothesis.mission_id,
				data.process_sources.before,
				action.operation_id,
			);
			const path = process.platform === "win32" ? hypothesis.target.toLowerCase() : hypothesis.target;
			related = sources !== null && Object.hasOwn(sources, path);
		}
	}
	if (!related) return { attempted: false, resolvable: false };
	const candidate = records.findLast(
		(record) =>
			record.record_type === "CandidateAction" &&
			record.operation_id === observation.operation_id &&
			selectedHypotheses(record).includes(hypothesis.record_id),
	);
	if (candidate?.record_type !== "CandidateAction" || !candidate.hypothesis_binding_ref)
		return { attempted: false, resolvable: false };
	const before = store.get(hypothesis.mission_id, candidate.hypothesis_binding_ref, "TargetBinding");
	// A committed selection records eligibility before start; later evidence loss cannot erase an actual attempt.
	if (
		candidate.hypothesis_selection_version !== "HYPOTHESIS_SELECTION/1" &&
		!hypothesisPremiseMatches(store, hypothesis, before, candidate.revision - 1)
	)
		return { attempted: false, resolvable: false };
	// Steering invalidates current conclusions, but cannot erase an experiment that already started.
	if (action.intent_epoch !== (store.load(hypothesis.mission_id).intent_epoch ?? 1))
		return { attempted: true, resolvable: false };
	const payload = observation.payload;
	if (!payload || typeof payload !== "object") return { attempted: true, resolvable: false };
	if (
		!["CONFIRMED_COMPLETE", "FAILED"].includes(operation.status) ||
		!observation.artifact_ref ||
		!("unknown" in payload) ||
		payload.unknown !== false
	)
		return { attempted: true, resolvable: false };
	if (
		("omitted" in payload && payload.omitted === true) ||
		!("capture_limitations" in payload) ||
		!Array.isArray(payload.capture_limitations) ||
		payload.capture_limitations.length > 0
	)
		return { attempted: true, resolvable: false };
	if (!("hypothesis_after_ref" in payload) || typeof payload.hypothesis_after_ref !== "string")
		return { attempted: true, resolvable: false };
	const after = store.get(hypothesis.mission_id, payload.hypothesis_after_ref, "TargetBinding");
	if (
		target.environment !== before.environment ||
		target.workspace_id !== before.workspace_id ||
		after.environment !== before.environment ||
		after.workspace_id !== before.workspace_id
	)
		return { attempted: true, resolvable: false };
	const unchanged = (before.preimage_digest ?? before.generation) === (after.preimage_digest ?? after.generation);
	const ownCorrection =
		target.canonical_path === hypothesis.target &&
		action.intended_effect === `Content SHA256 ${after.preimage_digest}`;
	let stableSources = true;
	if ("process_sources" in payload) {
		stableSources =
			Value.Check(ProcessSourceSnapshotSchema, payload.process_sources) &&
			payload.process_sources.complete &&
			"dependencies_unchanged" in payload &&
			payload.dependencies_unchanged === true;
		if (
			stableSources &&
			before.preimage_digest !== null &&
			Value.Check(ProcessSourceSnapshotSchema, payload.process_sources)
		) {
			const sources = processSourceDigests(
				store,
				hypothesis.mission_id,
				payload.process_sources.before,
				candidate.operation_id,
			);
			const path = process.platform === "win32" ? hypothesis.target.toLowerCase() : hypothesis.target;
			stableSources = sources?.[path] === before.preimage_digest;
		}
	} else if ("dependencies" in payload && payload.dependencies && typeof payload.dependencies === "object") {
		const deps = payload.dependencies as Record<string, string>;
		const path = process.platform === "win32" ? hypothesis.target.toLowerCase() : hypothesis.target;
		const depKey = Object.keys(deps).find((k) =>
			process.platform === "win32" ? k.toLowerCase() === path : k === path,
		);
		if (depKey !== undefined) {
			if (!("dependencies_unchanged" in payload) || payload.dependencies_unchanged !== true) {
				stableSources = false;
			} else if (
				before.generation &&
				deps[depKey] !== before.generation &&
				deps[depKey] !== before.preimage_digest
			) {
				stableSources = false;
			}
		}
	}
	try {
		hypothesisObservedText(store, observation);
	} catch {
		return { attempted: true, resolvable: false };
	}
	return {
		attempted: true,
		resolvable: stableSources && (unchanged || ownCorrection) && hypothesisPremiseMatches(store, hypothesis, after),
	};
}

export function hypothesisObservedText(store: MissionStore, observation: RecordOf<"EvidenceRecord">): string {
	const payload = observation.payload;
	if (
		payload &&
		typeof payload === "object" &&
		"full_output_ref" in payload &&
		typeof payload.full_output_ref === "string"
	) {
		const operation = store
			.records(observation.mission_id)
			.findLast(
				(record) => record.record_type === "OperationRecord" && record.operation_id === observation.operation_id,
			);
		const action =
			operation?.record_type === "OperationRecord"
				? store.get(observation.mission_id, operation.prepared_ref, "PreparedAction")
				: null;
		const schema = action ? store.get(observation.mission_id, action.schema_ref, "RegisteredActionSchema") : null;
		const args = action?.arguments as Record<string, unknown> | undefined;
		// A retained binding source is wider than a requested read span; only the experiment's returned span tests it.
		if (!schema?.version.startsWith("read/1:") || (args?.offset === undefined && args?.limit === undefined))
			return store.artifact(observation.mission_id, payload.full_output_ref).toString();
	}
	if (!observation.artifact_ref) throw new Error("Hypothesis experiment output is unavailable");
	const output: unknown = JSON.parse(store.artifact(observation.mission_id, observation.artifact_ref).toString());
	if (!isToolOutput(output)) throw new Error("Hypothesis experiment requires actual tool output");
	return output.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

export function hypothesisObservationApplies(
	store: MissionStore,
	hypothesis: Pick<RecordOf<"Hypothesis">, "mission_id" | "target">,
	observation: RecordOf<"EvidenceRecord">,
): boolean {
	if (
		observation.kind !== "OBSERVATION" ||
		observation.provenance !== "ADAPTER" ||
		observation.stage !== "phala" ||
		!observation.operation_id ||
		!observation.artifact_ref
	)
		return false;
	const operation = store
		.records(hypothesis.mission_id)
		.findLast(
			(record) =>
				record.record_type === "OperationRecord" &&
				record.operation_id === observation.operation_id &&
				record.result_refs.includes(observation.record_id),
		);
	if (operation?.record_type !== "OperationRecord" || !["CONFIRMED_COMPLETE", "FAILED"].includes(operation.status))
		return false;
	const action = store.get(hypothesis.mission_id, operation.prepared_ref, "PreparedAction");
	const binding = store.get(hypothesis.mission_id, action.binding_ref, "TargetBinding");
	const payload = observation.payload;
	if (
		inside(hypothesis.target, binding.canonical_path) ||
		Boolean(
			payload &&
				typeof payload === "object" &&
				"dependencies" in payload &&
				payload.dependencies &&
				typeof payload.dependencies === "object" &&
				Object.hasOwn(payload.dependencies, hypothesis.target),
		)
	)
		return true;
	if (
		payload &&
		typeof payload === "object" &&
		"process_sources" in payload &&
		Value.Check(ProcessSourceSnapshotSchema, payload.process_sources)
	) {
		const sources = processSourceDigests(
			store,
			hypothesis.mission_id,
			payload.process_sources.before,
			action.operation_id,
		);
		const path = process.platform === "win32" ? hypothesis.target.toLowerCase() : hypothesis.target;
		return sources !== null && Object.hasOwn(sources, path);
	}
	return false;
}

/** Resolution closes a supported experiment only when the current mission actually verified its target. */
export function hypothesisCanResolve(
	store: MissionStore,
	state: MissionState,
	hypothesis: RecordOf<"Hypothesis">,
	terminal: RecordOf<"TerminalReport">,
): boolean {
	if (
		hypothesis.status !== "SUPPORTED" ||
		terminal.status !== "VERIFIED_COMPLETE" ||
		terminal.contract_ref !== state.contract ||
		state.terminal !== terminal.record_id ||
		!terminal.verification_report_ref
	)
		return false;
	const report = store.get(state.mission_id, terminal.verification_report_ref, "VerificationReport");
	const requirements = state.requirements
		.map((ref) => store.get(state.mission_id, ref, "Requirement"))
		.filter(
			(requirement) =>
				requirement.mandatory && requirement.status !== "SUPERSEDED" && requirement.target === hypothesis.target,
		);
	if (
		!requirements.length ||
		report.completion_status !== "PASSED" ||
		!["PASSED", "NOT_APPLICABLE"].includes(report.quality) ||
		requirements.some(
			(requirement) =>
				requirement.status !== "VERIFIED" ||
				!report.results.some(
					(result) =>
						result.requirement_id === requirement.requirement_id &&
						result.result === "PASSED" &&
						canonical(result.evidence) === canonical(requirement.evidence),
				),
		)
	)
		return false;
	const records = store.records(state.mission_id);
	return hypothesis.supporting.some((ref) => {
		try {
			const observation = store.get(state.mission_id, ref, "EvidenceRecord");
			const candidate = records.findLast(
				(record) => record.record_type === "CandidateAction" && record.operation_id === observation.operation_id,
			);
			if (candidate?.record_type !== "CandidateAction") return false;
			const selected = selectedHypotheses(candidate)
				.map((id) => store.get(state.mission_id, id, "Hypothesis"))
				.find(
					(branch) =>
						branch.hypothesis_id === hypothesis.hypothesis_id &&
						branch.premise_binding_ref === hypothesis.premise_binding_ref,
				);
			if (!selected || !hypothesisExperimentApplicability(store, selected, observation).resolvable) return false;
			const payload = observation.payload;
			if (
				!payload ||
				typeof payload !== "object" ||
				!("hypothesis_after_ref" in payload) ||
				typeof payload.hypothesis_after_ref !== "string"
			)
				return false;
			const after = store.get(state.mission_id, payload.hypothesis_after_ref, "TargetBinding");
			return (
				after.canonical_path === hypothesis.target &&
				requirements.every((requirement) => requirement.generation === after.generation) &&
				hypothesisObservedText(store, observation).includes(hypothesis.expected_result)
			);
		} catch {
			return false;
		}
	});
}

/** Enforce normalization and applicability even when a caller writes directly to the store. */
export function validateHypothesis(
	store: MissionStore,
	record: RecordOf<"Hypothesis">,
	previousRefs: readonly string[],
	state: MissionState,
): void {
	const previous = previousRefs.map((ref) => store.get(record.mission_id, ref, "Hypothesis"));
	const prior = previous.find((hypothesis) => hypothesis.hypothesis_id === record.hypothesis_id);
	if (!record.normalization_version) {
		if (!prior || prior.normalization_version) throw new Error("New hypotheses require controlled categories");
	} else {
		const proposal = {
			target: record.target,
			cause: record.cause,
			mechanism: record.mechanism,
			failure_signature: record.failure_signature,
			expected_result: record.expected_result,
		};
		if (!Value.Check(HypothesisProposalSchema, proposal) || record.fingerprint !== hypothesisFingerprint(record))
			throw new Error("Invalid controlled hypothesis fingerprint/categories");
		if (!record.premise_binding_ref) throw new Error("Controlled hypothesis requires its bound premise");
		const binding = store.get(record.mission_id, record.premise_binding_ref, "TargetBinding");
		if (
			binding.canonical_path !== record.target ||
			binding.generation !== record.premise_generation ||
			record.premise_digest !== (binding.preimage_digest ?? binding.generation)
		)
			throw new Error("Hypothesis premise does not match its exact bound target");
	}
	if (!Number.isSafeInteger(record.attempts) || record.attempts < 0) throw new Error("Invalid hypothesis attempts");
	const observations = [...record.supporting, ...record.contradicting, ...(record.branch_evidence ?? [])].map((ref) =>
		store.get(record.mission_id, ref, "EvidenceRecord"),
	);
	if (observations.some((observation) => !hypothesisObservationApplies(store, record, observation)))
		throw new Error("Hypothesis premises need applicable actual adapter observations");
	for (const other of previous) {
		if (other.hypothesis_id === record.hypothesis_id || !sameHypothesisApproach(record, other)) continue;
		if (
			record.fingerprint === other.fingerprint ||
			(record.failure_signature === other.failure_signature &&
				record.premise_generation === other.premise_generation) ||
			!observations.some(
				(observation) =>
					observation.revision > (other.created_revision ?? other.revision) &&
					observation.artifact_ref &&
					hypothesisObservedText(store, observation).includes(record.failure_signature),
			)
		)
			throw new Error("Repeated hypothesis approach needs a newly observed problem signature");
	}
	if (!prior) {
		if (
			record.attempts !== 0 ||
			record.status !== "ACTIVE" ||
			record.supporting.length ||
			record.contradicting.length ||
			record.rejection_ref !== undefined ||
			record.resolution_ref !== undefined
		)
			throw new Error("A proposed hypothesis cannot invent an experiment result");
		return;
	}
	if (record.status === "ACTIVE" && record.premise_generation !== prior.premise_generation) {
		if (
			!sameHypothesisApproach(record, prior) ||
			record.rejection_ref !== undefined ||
			record.resolution_ref !== undefined ||
			record.failure_signature !== prior.failure_signature ||
			(record.premise_digest !== undefined && record.premise_digest === prior.premise_digest) ||
			record.attempts !== prior.attempts ||
			!observations.some(
				(observation) =>
					observation.revision > prior.revision && observation.target_generation === record.premise_generation,
			)
		)
			throw new Error("Reopening a hypothesis requires an observed changed premise");
		return;
	}
	const immutable = [
		"normalization_version",
		"fingerprint",
		"target",
		"cause",
		"mechanism",
		"cause_detail",
		"mechanism_detail",
		"failure_signature",
		"expected_result",
		"premise_generation",
		"premise_digest",
		"premise_binding_ref",
		"parent_ref",
		"depth",
		"created_revision",
		"branch_evidence",
	] as const;
	if (record.status === "RESOLVED" && record.resolution_ref && prior.status === "SUPPORTED") {
		const terminal = store.get(record.mission_id, record.resolution_ref, "TerminalReport");
		if (
			terminal.revision !== record.revision ||
			immutable.some((key) => canonical(record[key] ?? null) !== canonical(prior[key] ?? null)) ||
			record.attempts !== prior.attempts ||
			record.rejection_ref !== prior.rejection_ref ||
			canonical(record.supporting) !== canonical(prior.supporting) ||
			canonical(record.contradicting) !== canonical(prior.contradicting) ||
			!hypothesisCanResolve(store, state, prior, terminal)
		)
			throw new Error(
				"Resolved hypothesis requires unchanged experiment history and current verified target evidence",
			);
		return;
	}
	if (record.status === "REJECTED" && record.rejection_ref && prior.status === "ACTIVE") {
		const rejection = store.get(record.mission_id, record.rejection_ref, "EvidenceRecord");
		const payload = rejection.payload;
		if (
			immutable.some((key) => canonical(record[key] ?? null) !== canonical(prior[key] ?? null)) ||
			record.resolution_ref !== prior.resolution_ref ||
			record.attempts !== prior.attempts ||
			canonical(record.supporting) !== canonical(prior.supporting) ||
			canonical(record.contradicting) !== canonical(prior.contradicting) ||
			rejection.kind !== "CONTROL" ||
			rejection.provenance !== "KERNEL" ||
			rejection.stage !== "vikalpa" ||
			!payload ||
			typeof payload !== "object" ||
			!("rule" in payload) ||
			!("hypothesis_ref" in payload) ||
			payload.hypothesis_ref !== prior.record_id
		)
			throw new Error("A rejected approach requires its unchanged history and a kernel retirement decision");
		if (payload.rule === "HYPOTHESIS_AUTHORIZATION_REVOKED/1") {
			if (
				!Value.Check(revocationSchema, payload) ||
				rejection.revision !== record.revision ||
				rejection.source !== "hypothesis-authorization/1" ||
				rejection.operation_id !== null ||
				rejection.target_generation !== prior.premise_generation ||
				rejection.artifact_ref !== null ||
				rejection.sources.length ||
				canonical(payload.authorization_refs) !== canonical(state.authorizations) ||
				!hypothesesRevoked(store, state) ||
				hypothesisInFlight(store, state, prior) ||
				state.leading_hypothesis === prior.record_id ||
				state.leading_hypothesis === record.record_id
			)
				throw new Error(
					"Authorization pruning requires complete sourced revocation and settled experiment history",
				);
			return;
		}
		if (payload.rule === "HYPOTHESIS_UNAVAILABLE/1") {
			const binding = store.get(record.mission_id, prior.premise_binding_ref!, "TargetBinding");
			if (
				!Value.Check(unavailableSchema, payload) ||
				rejection.source !== "hypothesis-availability/1" ||
				rejection.revision !== record.revision ||
				rejection.operation_id !== null ||
				rejection.artifact_ref !== null ||
				rejection.target_generation !== prior.premise_generation ||
				rejection.sources.length > 0 ||
				canonical(payload.authorization_refs) !== canonical(state.authorizations) ||
				canonical(payload.constraint_refs) !==
					canonical([
						...new Set((state.operation_constraints ?? []).map((constraint) => constraint.source_ref)),
					]) ||
				canonical(payload.reservation_refs) !== canonical(state.reservations) ||
				payload.reason !==
					hypothesisExclusion(store, state, prior.target, binding.environment, rejection.captured_at) ||
				hypothesisInFlight(store, state, prior) ||
				state.leading_hypothesis === prior.record_id ||
				state.leading_hypothesis === record.record_id
			)
				throw new Error(
					"Hypothesis exclusion requires current scoped authority or protected-capacity evidence and settled history",
				);
			return;
		}
		if (payload.rule === "HYPOTHESIS_PREMISE_CHANGED/1") {
			if (
				!("binding_ref" in payload) ||
				typeof payload.binding_ref !== "string" ||
				!("observation_ref" in payload) ||
				typeof payload.observation_ref !== "string"
			)
				throw new Error("Changed premise rejection requires its captured binding and observation");
			const binding = store.get(record.mission_id, payload.binding_ref, "TargetBinding");
			const observed = store.get(record.mission_id, payload.observation_ref, "EvidenceRecord");
			const facts = {
				canonical_path: binding.canonical_path,
				workspace_id: binding.workspace_id,
				environment: binding.environment,
				generation: binding.generation,
				preimage_digest: binding.preimage_digest,
			};
			if (
				binding.canonical_path !== prior.target ||
				!binding.valid ||
				binding.revision !== record.revision ||
				observed.revision !== record.revision ||
				rejection.revision !== record.revision ||
				observed.kind !== "OBSERVATION" ||
				observed.stage !== "adana" ||
				observed.provenance !== "ADAPTER" ||
				observed.source !== "local-hypothesis-premise/1" ||
				observed.target_generation !== binding.generation ||
				canonical(observed.payload) !== canonical(facts) ||
				canonical(binding.establishment_evidence) !== canonical([observed.record_id]) ||
				canonical(rejection.sources) !== canonical([observed.record_id]) ||
				hypothesisPremiseMatches(store, prior, binding, record.revision - 1)
			)
				throw new Error("Changed premise rejection needs an actual captured ineligible premise");
			return;
		}
		if (payload.rule !== "STAGNANT_APPROACH/1" || !("tick_ref" in payload) || typeof payload.tick_ref !== "string")
			throw new Error("A stagnant approach requires its current tick");
		const tick = store.get(record.mission_id, payload.tick_ref, "CognitiveTick");
		const settledState = store.load(record.mission_id);
		const contract = store.get(record.mission_id, settledState.contract, "MissionContract");
		const configuration = contract.configuration_ref
			? store.get(record.mission_id, contract.configuration_ref, "KernelConfiguration").value
			: null;
		const reset = store
			.records(record.mission_id)
			.findLast(
				(item) => item.record_type === "CognitiveTick" && item.status === "SETTLED" && item.progress.length > 0,
			);
		const attempted = store.records(record.mission_id).some((item) => {
			if (item.record_type !== "CandidateAction" || !item.hypothesis_ref || item.revision <= (reset?.revision ?? 0))
				return false;
			if (
				!selectedHypotheses(item).some(
					(ref) => store.get(record.mission_id, ref, "Hypothesis").hypothesis_id === prior.hypothesis_id,
				)
			)
				return false;
			return settledState.operations.some((ref) => {
				const operation = store.get(record.mission_id, ref, "OperationRecord");
				return (
					operation.operation_id === item.operation_id &&
					operation.started_at !== null &&
					["CONFIRMED_COMPLETE", "FAILED"].includes(operation.status)
				);
			});
		});
		if (
			!configuration ||
			settledState.cognitive_tick !== tick.record_id ||
			tick.status !== "SETTLED" ||
			tick.progress.length ||
			tick.stagnation_after < configuration.stagnation.diagnose ||
			!attempted
		)
			throw new Error(
				"A stagnant approach requires an actual attempted hypothesis and the current no-progress tick",
			);
		return;
	}
	if (
		immutable.some((key) => canonical(record[key] ?? null) !== canonical(prior[key] ?? null)) ||
		prior.status !== "ACTIVE" ||
		record.attempts !== prior.attempts + 1 ||
		record.rejection_ref !== prior.rejection_ref ||
		record.resolution_ref !== prior.resolution_ref
	)
		throw new Error("Hypothesis identity/result cannot be rewritten without an actual experiment");
	const attempt = store
		.records(record.mission_id)
		.findLast(
			(candidate) =>
				candidate.record_type === "CandidateAction" &&
				selectedHypotheses(candidate).includes(prior.record_id) &&
				candidate.revision > prior.revision,
		);
	if (attempt?.record_type !== "CandidateAction") throw new Error("Hypothesis attempt needs a selected experiment");
	const result = store
		.records(record.mission_id)
		.findLast(
			(observation) =>
				observation.record_type === "EvidenceRecord" &&
				observation.operation_id === attempt.operation_id &&
				observation.stage === "phala" &&
				observation.kind === "OBSERVATION",
		);
	if (result?.record_type !== "EvidenceRecord") throw new Error("Hypothesis attempt needs its actual result");
	const applicable = hypothesisExperimentApplicability(store, prior, result);
	if (!applicable.attempted) throw new Error("Hypothesis experiment does not apply to its bound premise");
	const output = applicable.resolvable ? hypothesisObservedText(store, result) : "";
	const supports = applicable.resolvable && prior.expected_result.length > 0 && output.includes(prior.expected_result);
	const contradicts = Boolean(
		applicable.resolvable &&
			result.payload &&
			typeof result.payload === "object" &&
			"isError" in result.payload &&
			result.payload.isError === true &&
			prior.failure_signature.length > 0 &&
			output.includes(prior.failure_signature),
	);
	if (
		record.status !== (supports ? "SUPPORTED" : contradicts ? "CONTRADICTED" : "ACTIVE") ||
		canonical(record.supporting) !==
			canonical(supports ? [...prior.supporting, result.record_id] : prior.supporting) ||
		canonical(record.contradicting) !==
			canonical(contradicts ? [...prior.contradicting, result.record_id] : prior.contradicting)
	)
		throw new Error("Hypothesis resolution must match the selected experiment observation");
}
