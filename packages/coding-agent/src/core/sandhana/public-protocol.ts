import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { MissionState, RecordOf, Resources } from "./records.ts";
import type { MissionStore } from "./store.ts";

const id = Type.String({ minLength: 1, maxLength: 1024 });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nullableId = Type.Union([id, Type.Null()]);
const nullableCount = Type.Union([count, Type.Null()]);
const amount = Type.Union([Type.Number({ minimum: 0 }), Type.Null()]);
const resourceVector = Type.Object(
	{
		execution: count,
		preflight: count,
		ticks: count,
		input_tokens: nullableCount,
		output_tokens: nullableCount,
		output_bytes: count,
		artifact_bytes: count,
		retrieval_bytes: count,
		elapsed_ms: Type.Number({ minimum: 0 }),
		cost: amount,
		refinement: count,
	},
	{ additionalProperties: false },
);
const terminalStatus = Type.Enum([
	"VERIFIED_COMPLETE",
	"DELIVERED_UNVERIFIED",
	"PARTIALLY_COMPLETE",
	"BLOCKED",
	"BUDGET_EXHAUSTED",
	"EXECUTION_FAILED",
	"UNSAFE_OR_UNAUTHORIZED",
	"OUTCOME_UNKNOWN",
] as const);
const operation = Type.Object(
	{
		operation_id: id,
		status: Type.Enum(["NOT_STARTED", "IN_PROGRESS", "OUTCOME_UNKNOWN", "CONFIRMED_COMPLETE", "FAILED"] as const),
		prepared_revision: count,
		target_binding_ref: id,
		action_digest: id,
	},
	{ additionalProperties: false },
);

/** Public fields are selected explicitly: no arguments, instructions, source bytes or process handles. */
export const PublicMissionSnapshotSchema = Type.Object(
	{
		version: Type.Literal("SANDHANA_PUBLIC/1"),
		mission_id: id,
		revision: count,
		product_mode: Type.Literal("padma_code"),
		route: Type.Union([Type.Literal("SAKSHAT"), Type.Literal("MADHYAMA"), Type.Literal("GAMBHIRA")]),
		phase: Type.Union([
			terminalStatus,
			Type.Enum([
				"CREATED",
				"UNDERSTANDING",
				"COMPILING",
				"EXECUTING",
				"REPLANNING",
				"REPAIRING",
				"REFINING",
				"CANDIDATE_READY",
				"VERIFYING_COMPLETION",
				"VERIFYING_QUALITY",
				"FINALIZING",
			] as const),
		]),
		workspace: Type.Union([
			Type.Object({ workspace_id: id, binding_ref: id }, { additionalProperties: false }),
			Type.Null(),
		]),
		current_operations: Type.Array(operation, { maxItems: 4 }),
		operations_omitted: count,
		progress: Type.Object(
			{ mandatory: count, verified: count, active_hypotheses: count, stagnation: count },
			{ additionalProperties: false },
		),
		remaining: Type.Array(
			Type.Object(
				{ requirement_id: id, status: Type.Enum(["UNMET", "CANDIDATE", "BLOCKED"] as const) },
				{ additionalProperties: false },
			),
			{ maxItems: 32 },
		),
		remaining_omitted: count,
		used: resourceVector,
		reserved: resourceVector,
		remaining_budget: resourceVector,
		verification_reserve: count,
		authorization_request: Type.Union([
			Type.Object(
				{
					decision_ref: id,
					operation_id: id,
					action_digest: id,
					target_binding_ref: id,
					evaluated_revision: count,
				},
				{ additionalProperties: false },
			),
			Type.Null(),
		]),
		terminal: Type.Union([
			Type.Object(
				{
					report_ref: id,
					status: terminalStatus,
					unknown_operation: nullableId,
					artifacts: Type.Array(id, { maxItems: 16 }),
					artifacts_omitted: count,
					verified: count,
					remaining: count,
					limitations: count,
					output_omitted: Type.Boolean(),
				},
				{ additionalProperties: false },
			),
			Type.Null(),
		]),
	},
	{ additionalProperties: false },
);
export type PublicMissionSnapshot = Static<typeof PublicMissionSnapshotSchema>;
const publicSnapshotValidator = Compile(PublicMissionSnapshotSchema);
const terminalStatusValidator = Compile(terminalStatus);

/** Validate public relationships before a client presents progress or consumes a live revision. */
export function isPublicMissionSnapshot(value: unknown): value is PublicMissionSnapshot {
	if (!publicSnapshotValidator.Check(value) || value.revision < 1) return false;
	const remaining = value.progress.mandatory - value.progress.verified;
	if (
		remaining < value.remaining.length ||
		value.remaining_omitted !== remaining - value.remaining.length ||
		new Set(value.remaining.map((item) => item.requirement_id)).size !== value.remaining.length ||
		new Set(value.current_operations.map((item) => item.operation_id)).size !== value.current_operations.length ||
		value.current_operations.some((item) => item.prepared_revision < 1 || item.prepared_revision > value.revision)
	)
		return false;
	const request = value.authorization_request;
	if (request) {
		if (request.evaluated_revision < 1 || request.evaluated_revision >= value.revision) return false;
		const operation = value.current_operations.find((item) => item.operation_id === request.operation_id);
		if (
			operation &&
			(operation.status !== "NOT_STARTED" ||
				operation.prepared_revision > request.evaluated_revision ||
				operation.action_digest !== request.action_digest ||
				operation.target_binding_ref !== request.target_binding_ref)
		)
			return false;
	}
	const terminal = value.terminal;
	if (terminalStatusValidator.Check(value.phase) !== (terminal !== null)) return false;
	if (!terminal) return true;
	if (
		terminal.status !== value.phase ||
		terminal.verified !== value.progress.verified ||
		terminal.remaining !== remaining ||
		(terminal.unknown_operation !== null && terminal.status !== "OUTCOME_UNKNOWN")
	)
		return false;
	if (
		value.current_operations.some((item) => item.status === "IN_PROGRESS" || item.status === "OUTCOME_UNKNOWN") &&
		(terminal.status !== "OUTCOME_UNKNOWN" || terminal.unknown_operation === null)
	)
		return false;
	if (terminal.unknown_operation !== null) {
		const operation = value.current_operations.find((item) => item.operation_id === terminal.unknown_operation);
		if (operation?.status === "NOT_STARTED" || (!operation && value.operations_omitted === 0)) return false;
	}
	if (terminal.status === "VERIFIED_COMPLETE" || terminal.status === "DELIVERED_UNVERIFIED") {
		if (
			terminal.output_omitted ||
			terminal.unknown_operation !== null ||
			value.current_operations.some((item) => item.status === "IN_PROGRESS" || item.status === "OUTCOME_UNKNOWN")
		)
			return false;
		if (terminal.status === "VERIFIED_COMPLETE" && remaining !== 0) return false;
		if (terminal.status === "DELIVERED_UNVERIFIED" && terminal.limitations === 0) return false;
	}
	return true;
}
export const RpcMissionEventSchema = Type.Object(
	{
		type: Type.Literal("sandhana_event"),
		event_id: id,
		event_type: Type.Literal("MISSION_STATE"),
		mission_id: id,
		revision: count,
		operation_id: nullableId,
		payload: PublicMissionSnapshotSchema,
	},
	{ additionalProperties: false },
);
export type RpcMissionEvent = Static<typeof RpcMissionEventSchema>;
export const PublicAuthorizationViewSchema = Type.Object(
	{
		version: Type.Literal("SANDHANA_AUTHORIZATION/1"),
		mission_id: id,
		revision: count,
		request: Type.Union([
			Type.Object(
				{
					decision_ref: id,
					prepared_ref: id,
					operation_id: id,
					action_digest: id,
					prepared_revision: count,
					evaluated_revision: count,
					intent_epoch: count,
					expires_at: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
					action: Type.Object(
						{
							tool_id: id,
							kind: Type.Enum(["READ", "LIST", "STATUS", "SEARCH", "EDIT", "PROCESS", "OTHER"] as const),
						},
						{ additionalProperties: false },
					),
					target: Type.Object(
						{ binding_ref: id, workspace_id: id, generation: id },
						{ additionalProperties: false },
					),
					effect: Type.Object(
						{
							kind: Type.Enum(["OBSERVATION", "FILE_REPLACEMENT", "TARGET_REMOVAL", "OPAQUE_PROCESS"] as const),
							side_effect: Type.Boolean(),
							postimage_digest: nullableId,
						},
						{ additionalProperties: false },
					),
					arguments_omitted: Type.Literal(true),
					requires_repreparation: Type.Literal(true),
					response: Type.Literal("EXACT_USER_INSTRUCTION"),
				},
				{ additionalProperties: false },
			),
			Type.Null(),
		]),
	},
	{ additionalProperties: false },
);
export type PublicAuthorizationView = Static<typeof PublicAuthorizationViewSchema>;
export const ActionApprovalInputSchema = Type.Object(
	{
		version: Type.Literal("SANDHANA_APPROVAL/1"),
		mission_id: id,
		revision: count,
		decision_ref: id,
		prepared_ref: id,
		action_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
	},
	{ additionalProperties: false },
);
export type ActionApprovalInput = Static<typeof ActionApprovalInputSchema>;
/** Each unknown event is checked against the shared durable record validator by the consumer. */
export const PublicMissionEventPageEnvelopeSchema = Type.Object(
	{
		snapshot: PublicMissionSnapshotSchema,
		events: Type.Array(Type.Unknown(), { maxItems: 64 }),
		next_revision: count,
		has_more: Type.Boolean(),
		history_from_revision: nullableCount,
		history_gap: Type.Boolean(),
	},
	{ additionalProperties: false },
);
export interface PublicMissionEventPage {
	snapshot: PublicMissionSnapshot;
	events: RecordOf<"PublicMissionEvent">[];
	next_revision: number;
	has_more: boolean;
	history_from_revision: number | null;
	history_gap: boolean;
}

export function projectMissionSnapshot(store: MissionStore, state: MissionState): PublicMissionSnapshot {
	const mission = state.mission_id;
	const contract = store.get(mission, state.contract, "MissionContract");
	const requirements = state.requirements.map((ref) => store.get(mission, ref, "Requirement"));
	const terminal = state.terminal ? store.get(mission, state.terminal, "TerminalReport") : null;
	const mandatory = requirements.filter((item) => item.mandatory && item.status !== "SUPERSEDED");
	// Final verification rechecks applicability; historical requirement statuses may still describe an older source.
	const verified = mandatory.filter((item) =>
		terminal ? terminal.verified.includes(item.requirement_id) : item.status === "VERIFIED",
	);
	const remaining = mandatory.filter((item) =>
		terminal ? terminal.remaining.includes(item.requirement_id) : item.status !== "VERIFIED",
	);
	const operations = state.operations.map((ref) => store.get(mission, ref, "OperationRecord"));
	// A late result changes current effect state, while the immutable report retains its original uncertainty.
	const pending = operations.filter(
		(item) =>
			["NOT_STARTED", "IN_PROGRESS", "OUTCOME_UNKNOWN"].includes(item.status) ||
			item.operation_id === terminal?.unknown_operation,
	);
	pending.sort(
		(left, right) =>
			["OUTCOME_UNKNOWN", "IN_PROGRESS", "NOT_STARTED", "CONFIRMED_COMPLETE", "FAILED"].indexOf(left.status) -
			["OUTCOME_UNKNOWN", "IN_PROGRESS", "NOT_STARTED", "CONFIRMED_COMPLETE", "FAILED"].indexOf(right.status),
	);
	const currentOperations = pending.slice(0, 4).map((item) => {
		const prepared = store.get(mission, item.prepared_ref, "PreparedAction");
		return {
			operation_id: item.operation_id,
			status: item.status,
			prepared_revision: prepared.revision,
			target_binding_ref: prepared.binding_ref,
			action_digest: prepared.action_digest,
		};
	});
	const lastOperation = operations.at(-1);
	const bindingRef =
		contract.bindings[0] ??
		(lastOperation ? store.get(mission, lastOperation.prepared_ref, "PreparedAction").binding_ref : null);
	const binding = bindingRef ? store.get(mission, bindingRef, "TargetBinding") : null;
	const request = pending.findLast(
		(item) =>
			item.status === "NOT_STARTED" &&
			item.decision_ref &&
			store.get(mission, item.decision_ref, "ScopeDecision").outcome === "NEEDS_CURRENT_AUTHORIZATION",
	);
	const decision = request?.decision_ref ? store.get(mission, request.decision_ref, "ScopeDecision") : null;
	const preparedRequest = request ? store.get(mission, request.prepared_ref, "PreparedAction") : null;
	const reserved: Resources = { ...state.used };
	for (const key of Object.keys(reserved) as (keyof Resources)[]) reserved[key] = 0;
	for (const ref of state.reservations) {
		const reservation = store.get(mission, ref, "BudgetReservation");
		if (!["RESERVED", "STARTED", "RETAINED"].includes(reservation.state)) continue;
		for (const key of Object.keys(reserved) as (keyof Resources)[]) {
			const value = reservation.amounts[key];
			if (key === "input_tokens" || key === "output_tokens" || key === "cost")
				reserved[key] = reserved[key] === null || value === null ? null : reserved[key]! + value;
			else reserved[key] += reservation.amounts[key];
		}
	}
	const capacity: Resources = { ...state.used };
	for (const key of Object.keys(capacity) as (keyof Resources)[]) {
		const ceiling = state.ceilings[key];
		const used = state.used[key];
		const held = reserved[key];
		if (key === "input_tokens" || key === "output_tokens" || key === "cost")
			capacity[key] = ceiling === null || used === null || held === null ? null : Math.max(0, ceiling - used - held);
		else capacity[key] = Math.max(0, state.ceilings[key] - state.used[key] - reserved[key]);
	}
	return {
		version: "SANDHANA_PUBLIC/1",
		mission_id: mission,
		revision: state.revision,
		product_mode: "padma_code",
		route: state.route,
		phase: state.phase,
		workspace: binding ? { workspace_id: binding.workspace_id, binding_ref: binding.record_id } : null,
		current_operations: currentOperations,
		operations_omitted: Math.max(0, pending.length - currentOperations.length),
		progress: {
			mandatory: mandatory.length,
			verified: verified.length,
			active_hypotheses: state.hypotheses.filter((ref) => store.get(mission, ref, "Hypothesis").status === "ACTIVE")
				.length,
			stagnation: state.stagnation,
		},
		remaining: remaining.slice(0, 32).map((item) => ({
			requirement_id: item.requirement_id,
			status: item.status === "CANDIDATE" || item.status === "BLOCKED" ? item.status : "UNMET",
		})),
		remaining_omitted: Math.max(0, remaining.length - 32),
		used: { ...state.used },
		reserved,
		remaining_budget: capacity,
		verification_reserve: state.verification_reserve,
		authorization_request:
			decision && preparedRequest
				? {
						decision_ref: decision.record_id,
						operation_id: decision.operation_id,
						action_digest: decision.action_digest,
						target_binding_ref: preparedRequest.binding_ref,
						evaluated_revision: decision.evaluated_revision,
					}
				: null,
		terminal: terminal
			? {
					report_ref: terminal.record_id,
					status: terminal.status,
					unknown_operation: terminal.unknown_operation,
					artifacts: terminal.artifacts.slice(0, 16),
					artifacts_omitted: Math.max(0, terminal.artifacts.length - 16),
					verified: terminal.verified.length,
					remaining: terminal.remaining.length,
					limitations: terminal.limitations.length,
					output_omitted: terminal.output_omitted ?? false,
				}
			: null,
	};
}
