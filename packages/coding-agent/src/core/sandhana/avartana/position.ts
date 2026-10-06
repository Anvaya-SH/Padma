import type { AgentMessage, AgentTool } from "@anvaya.sh/padma-agent-core";
import { canonical, digest, type MissionState, type RecordOf } from "../records.ts";
import type { MissionStore } from "../store.ts";
import { type AuthorityRef, ContextError, type DerivedRef, type EvidenceRef } from "./contracts.ts";
import { modelSafe } from "./render.ts";

export function missionPosition(store: MissionStore, state: MissionState) {
	const mission = state.mission_id;
	const authority = (id: string): AuthorityRef => ({ kind: "authority", mission, id });
	const spec = store.get(mission, state.command, "CommandSpecification");
	const contract = store.get(mission, state.contract, "MissionContract");
	return {
		version: "MISSION_POSITION/1" as const,
		missionId: mission,
		revision: state.revision,
		eventWatermark: state.last_event,
		originalRequest: authority(state.command),
		objective: spec.objective,
		originalInstruction: spec.original_instruction,
		asaya: authority(state.command),
		sankalpa: authority(state.contract),
		intentEpoch: state.intent_epoch ?? 1,
		requirements: state.requirements.map((id) => store.get(mission, id, "Requirement")),
		prohibitions: spec.prohibitions,
		ambiguity: spec.uncertainty,
		exactTargets: spec.exact_targets,
		amendments: (contract.amendment_refs ?? []).map(authority),
		constraints: state.operation_constraints ?? [],
		targets: [
			...new Map(
				contract.bindings.map((ref) => {
					const target = store.get(mission, ref, "TargetBinding");
					return [target.canonical_path, target] as const;
				}),
			).values(),
		],
		route: state.route,
		policy: { ref: authority(state.contract), version: contract.policy_version },
		authorizations: state.authorizations.map((id) => ({
			ref: authority(id),
			grant: store.get(mission, id, "Authorization"),
			validity: "REVALIDATE_AT_READ_AND_DISPATCH" as const,
		})),
		budget: {
			ref: authority(state.reservations.at(-1) ?? state.command),
			owner: {
				service: "MissionStore" as const,
				missionId: mission,
				revision: state.revision,
				meaning:
					"Live accounting snapshot; ref is its last ledger record (or original configuration), not a fabricated immutable state ID",
			},

			used: state.used,
			ceilings: state.ceilings,
			verificationReserve: state.verification_reserve,
			reservations: state.reservations
				.map((id) => store.get(mission, id, "BudgetReservation"))
				.filter((reservation) => ["RESERVED", "STARTED", "RETAINED"].includes(reservation.state)),
			enforcement: "LIVE_OWNER" as const,
		},
		operations: state.operations.map((ref) => {
			const operation = store.get(mission, ref, "OperationRecord");
			const action = store.get(mission, operation.prepared_ref, "PreparedAction");
			return {
				operation,
				preparedRef: authority(action.record_id),
				actionDigest: action.action_digest,
				targetBinding: authority(action.binding_ref),
				reconciliationRequired: ["IN_PROGRESS", "OUTCOME_UNKNOWN"].includes(operation.status),
			};
		}),
		schedules: (state.schedules ?? []).map((id) => store.get(mission, id, "OperationSchedule")),
		pendingVerification: state.requirements
			.map((id) => store.get(mission, id, "Requirement"))
			.filter((req) => req.status !== "SUPERSEDED")
			.map((req) => ({
				id: req.requirement_id,
				recordedStatus: req.status,
				evidence: req.evidence.map((id): EvidenceRef => ({ kind: "evidence", mission, id })),
				applicability: "REVALIDATE_CURRENT_GENERATION" as const,
			})),
		bestRecoverable: state.best.map((id) => ({
			ref: authority(id),
			checkpoint: store.get(mission, id, "CheckpointRecord"),
			applicability: "REVALIDATE_BLOB_RETENTION_DIGEST_AND_CURRENT_TARGET_BEFORE_RESTORING" as const,
		})),
		hypotheses: state.hypotheses.map((id) => store.get(mission, id, "Hypothesis")),
		leadingHypothesis: state.leading_hypothesis ?? null,
		contextConflicts: store.contextReferences(mission, "AVARTANA_CONFLICT/1", state.revision).map((id) => ({
			ref: { kind: "derived" as const, mission, id },
			state: "UNRESOLVED_SCOPE_OR_GENERATION" as const,
		})),
		recentContext: ["AVARTANA_DERIVATION/1", "AVARTANA_RETRIEVAL/1"].flatMap((source) =>
			store
				.contextReferences(mission, source, state.revision, true)
				.map((id) => ({ kind: "derived" as const, mission, id })),
		),
		stagnation: state.stagnation,
		phase: state.phase,
		terminal: state.terminal ? authority(state.terminal) : null,
	};
}
export type MissionPosition = ReturnType<typeof missionPosition>;
export function attemptIndex(store: MissionStore, state: MissionState) {
	const records = store.records(state.mission_id);
	return records
		.filter((record): record is RecordOf<"CandidateAction"> => record.record_type === "CandidateAction")
		.map((candidate) => {
			const action = records.find(
				(record): record is RecordOf<"PreparedAction"> =>
					record.record_type === "PreparedAction" && record.operation_id === candidate.operation_id,
			);
			const op = state.operations
				.map((id) => store.get(state.mission_id, id, "OperationRecord"))
				.find((op) => op.operation_id === candidate.operation_id);
			return {
				candidateRef: candidate.record_id,
				operationId: candidate.operation_id,
				hypothesis: candidate.hypothesis_ref,
				question: candidate.rationale,
				preparedRef: action?.record_id ?? null,
				actionDigest: action?.action_digest ?? null,
				targetGeneration: action?.target_generation ?? null,
				intendedObservation: candidate.expected_effect,
				status: op?.status ?? "PROPOSED_UNEXECUTED",
				observations: op?.result_refs ?? [],
				reconciliation: op?.reconciliation_refs ?? [],
				verification: records
					.filter(
						(record) =>
							record.record_type === "EvidenceRecord" &&
							record.kind === "VERIFICATION" &&
							record.operation_id === candidate.operation_id,
					)
					.map((record) => record.record_id),
				limitation:
					op?.status === "OUTCOME_UNKNOWN"
						? "Unknown effects: not a failed attempt eligible for replay"
						: "Historical attempt; changed arguments, revision, environment or policy require revalidation",
			};
		});
}
export interface Capsule {
	version: "SARASANGRAHA_CAPSULE/1";
	basisRevision: number;
	eventWatermark: string | null;
	position: MissionPosition;
	protectedDigest: string;
	parent: DerivedRef | null;
	evidence: EvidenceRef[];
}
export function buildCapsule(store: MissionStore, state: MissionState): Capsule {
	const position = missionPosition(store, state);
	const previous = store.contextReferences(state.mission_id, "SARASANGRAHA_CAPSULE/1", state.revision, true).at(0);
	return {
		version: "SARASANGRAHA_CAPSULE/1",
		basisRevision: state.revision,
		eventWatermark: state.last_event,
		position,
		protectedDigest: digest(position),
		parent: previous ? { kind: "derived", mission: state.mission_id, id: previous } : null,
		evidence: position.pendingVerification.flatMap((req) => req.evidence),
	};
}
export function validateCapsule(store: MissionStore, state: MissionState, capsule: Capsule): void {
	if (capsule.version !== "SARASANGRAHA_CAPSULE/1")
		throw new ContextError("MALFORMED_REQUEST", "Unsupported capsule version; reconstruct from authority");
	if (state.revision !== capsule.basisRevision || state.last_event !== capsule.eventWatermark)
		throw new ContextError(
			"REVISION_CONFLICT",
			"Mission changed during capsule construction; rebuild from current authority",
		);
	const expected = buildCapsule(store, state);
	if (
		canonical(expected.parent) !== canonical(capsule.parent) ||
		canonical(expected.evidence) !== canonical(capsule.evidence) ||
		canonical(expected.position) !== canonical(capsule.position) ||
		digest(capsule.position) !== capsule.protectedDigest
	)
		throw new ContextError("CITATION_FAILURE", "Protected position differs from authoritative state");
}
export interface ContextPacket {
	version: "CONTEXT_PACKET/1";
	basisRevision: number;
	eventWatermark: string | null;
	position: MissionPosition;
	messages: AgentMessage[];
	estimatedTokens: number;
	compaction: boolean;
}
/** Source bodies never enter a system role. Context estimates use UTF-8 bytes as a conservative token bound. */
export function assemblePacket(
	position: MissionPosition,
	messages: AgentMessage[],
	tools: AgentTool[],
	window: number,
	output: number,
	overhead: number,
	compact: boolean,
	authorityText?: string,
): ContextPacket {
	const capacity = window - output - overhead;
	if (!Number.isSafeInteger(capacity) || capacity <= 0)
		throw new ContextError("CAPACITY", "No supported input capacity after completion and instruction reserve");
	const trusted = messages.filter(
		(message) =>
			message.role === "system" &&
			!(typeof message.content === "string" && message.content.startsWith('{"controller":"sandhana"')),
	);
	const authority: AgentMessage = {
		role: "system",
		content: authorityText ?? JSON.stringify(modelSafe({ controller: "sandhana", position })),
		timestamp: 0,
	};
	const schemaBytes = Buffer.byteLength(
		JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters }))),
	);
	const data = messages.filter((message) => message.role !== "system");
	const immediate = data.findLast((message) => message.role === "user") ?? {
		role: "user" as const,
		content:
			"Continue from the authoritative mission position. Reopen original evidence through its references; do not replay historical effects.",
		timestamp: 0,
	};
	const protectedMessages = [...trusted, authority, immediate];
	const size = (items: AgentMessage[]) => Buffer.byteLength(JSON.stringify(items)) + schemaBytes;
	if (size(protectedMessages) > capacity)
		throw new ContextError(
			"CAPACITY",
			"Mandatory requirements, authority and unresolved lifecycle do not fit; narrow the decision, not the authority",
		);
	let selected = compact
		? protectedMessages
		: [...trusted, authority, ...data, ...(data.includes(immediate) ? [] : [immediate])];
	if (compact) {
		// Keep complete assistant/tool batches only. The retained history remains in session/store.
		const boundary = data.findLastIndex((message) => message.role === "assistant");
		const recent = boundary >= 0 && data.indexOf(immediate) < boundary ? data.slice(boundary) : [];
		if (size([...selected, ...recent]) <= capacity) selected = [...selected, ...recent];
	}
	if (size(selected) > capacity)
		return assemblePacket(position, messages, tools, window, output, overhead, true, authorityText);
	return {
		version: "CONTEXT_PACKET/1",
		basisRevision: position.revision,
		eventWatermark: position.eventWatermark,
		position,
		messages: selected,
		estimatedTokens: size(selected),
		compaction: compact,
	};
}
