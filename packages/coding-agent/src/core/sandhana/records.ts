import { createHash, randomUUID } from "node:crypto";
import { type Static, type TLiteral, type TSchema, type TUnion, Type } from "typebox";
import { Compile } from "typebox/compile";
import { FailureSchema } from "./errors.ts";
import { ActionApprovalInputSchema, PublicMissionSnapshotSchema } from "./public-protocol.ts";

export const SCHEMA_VERSION = 1;
export const POLICY_VERSION = "padma_code/1";
const strings = Type.Array(Type.String());
const nullableString = Type.Union([Type.String(), Type.Null()]);
const choice = <const T extends string[]>(...values: T) =>
	Type.Union(values.map((value) => Type.Literal(value))) as TUnion<{ [K in keyof T]: TLiteral<T[K]> }>;
export const RouteSchema = choice("SAKSHAT", "MADHYAMA", "GAMBHIRA");
export type Route = Static<typeof RouteSchema>;
export const TerminalStatusSchema = choice(
	"VERIFIED_COMPLETE",
	"DELIVERED_UNVERIFIED",
	"PARTIALLY_COMPLETE",
	"BLOCKED",
	"BUDGET_EXHAUSTED",
	"EXECUTION_FAILED",
	"UNSAFE_OR_UNAUTHORIZED",
	"OUTCOME_UNKNOWN",
);
export type TerminalStatus = Static<typeof TerminalStatusSchema>;
export interface Signal {
	severity: 0 | 1 | 2;
	provenance: "COMMAND" | "STRUCTURAL" | "PREFLIGHT" | "HISTORY" | "ESTIMATE" | "UNKNOWN";
	evidence: string[];
}
export type Signals = Record<"S" | "A" | "D" | "O" | "H" | "E", Signal>;
const signal = Type.Object({
	severity: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)]),
	provenance: choice("COMMAND", "STRUCTURAL", "PREFLIGHT", "HISTORY", "ESTIMATE", "UNKNOWN"),
	evidence: strings,
});
export const ResourcesSchema = Type.Object({
	execution: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	preflight: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	ticks: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	input_tokens: Type.Union([Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()]),
	output_tokens: Type.Union([Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()]),
	output_bytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	artifact_bytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	retrieval_bytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	elapsed_ms: Type.Number({ minimum: 0 }),
	cost: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
	refinement: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});
export type Resources = Static<typeof ResourcesSchema>;
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const ResourceCeilingsSchema = Type.Object(
	{
		...ResourcesSchema.properties,
		preflight: Type.Integer({ minimum: 0, maximum: 2 }),
		input_tokens: count,
		output_tokens: count,
		elapsed_ms: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		cost: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	},
	{ additionalProperties: false },
);
export type ResourceCeilings = Static<typeof ResourceCeilingsSchema>;
const routeConfiguration = Type.Object(
	{ execution: count, ticks: count, verification_reserve: count },
	{ additionalProperties: false },
);
const commonCeilings = Type.Object(
	Object.fromEntries(
		Object.entries(ResourceCeilingsSchema.properties).filter(([key]) => key !== "execution" && key !== "ticks"),
	) as Omit<typeof ResourceCeilingsSchema.properties, "execution" | "ticks">,
	{ additionalProperties: false },
);
const modelConfiguration = Type.Object(
	{ response_tokens: count, input_overhead_bytes: count },
	{ additionalProperties: false },
);
const viewConfiguration = Type.Object(
	{ tool_chars: count, position_chars: count, evidence_events: count, recent_observations: count },
	{ additionalProperties: false },
);
const artifactConfiguration = Type.Object(
	{
		max_bytes: Type.Integer({ minimum: 0, maximum: 8 * 1024 * 1024 }),
		retention_ms: Type.Union([count, Type.Null()]),
	},
	{ additionalProperties: false },
);
const stagnationConfiguration = Type.Object(
	{
		diagnose: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		stop: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	},
	{ additionalProperties: false },
);
const branchConfiguration = Type.Object(
	{ active: Type.Integer({ minimum: 0, maximum: 3 }), depth: Type.Integer({ minimum: 0, maximum: 2 }) },
	{ additionalProperties: false },
);
const timeoutConfiguration = Type.Object(
	{
		shell_ms: Type.Integer({ minimum: 0, maximum: 24 * 60 * 60 * 1000 }),
		observation_ms: Type.Integer({ minimum: 0, maximum: 30000 }),
	},
	{ additionalProperties: false },
);
const contextConfiguration = Type.Object(
	{
		version: Type.Literal("AVARTANA_CONFIG/1"),
		semantic: Type.Boolean(),
		cache_bytes: Type.Integer({ minimum: 0, maximum: 8 * 1024 ** 2 }),
		evidence_fraction: Type.Number({ minimum: 0.01, maximum: 0.5 }),
		scan_bytes: Type.Integer({ minimum: 0, maximum: 64 * 1024 ** 2 }),
		return_bytes: Type.Integer({ minimum: 0, maximum: 256 * 1024 }),
		hits: Type.Integer({ minimum: 0, maximum: 64 }),
		ranges: Type.Integer({ minimum: 0, maximum: 12 }),
		elapsed_ms: Type.Integer({ minimum: 1, maximum: 120000 }),
		leaf_calls: Type.Integer({ minimum: 0, maximum: 6 }),
		recursion_depth: Type.Integer({ minimum: 0, maximum: 2 }),
		compaction_threshold: Type.Number({ minimum: 0.5, maximum: 0.95 }),
		source_families: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 12, uniqueItems: true }),
	},
	{ additionalProperties: false },
);
export const KernelConfigurationSchema = Type.Object(
	{
		version: Type.Literal("sandhana/1"),
		routes: Type.Object(
			{ SAKSHAT: routeConfiguration, MADHYAMA: routeConfiguration, GAMBHIRA: routeConfiguration },
			{ additionalProperties: false },
		),
		avartana: Type.Optional(contextConfiguration),
		resources: commonCeilings,
		model: modelConfiguration,
		view: viewConfiguration,
		artifact: artifactConfiguration,
		stagnation: stagnationConfiguration,
		branches: branchConfiguration,
		timeouts: timeoutConfiguration,
		operations: Type.Optional(
			Type.Object({ concurrency: Type.Integer({ minimum: 1, maximum: 4 }) }, { additionalProperties: false }),
		),
	},
	{ additionalProperties: false },
);
export type KernelConfiguration = Static<typeof KernelConfigurationSchema>;
export const KernelConfigurationInputSchema = Type.Object(
	{
		version: Type.Literal("sandhana/1"),
		routes: Type.Optional(
			Type.Partial(
				Type.Object(
					{
						SAKSHAT: Type.Partial(routeConfiguration),
						MADHYAMA: Type.Partial(routeConfiguration),
						GAMBHIRA: Type.Partial(routeConfiguration),
					},
					{ additionalProperties: false },
				),
			),
		),
		avartana: Type.Optional(Type.Partial(contextConfiguration)),
		resources: Type.Optional(Type.Partial(commonCeilings)),
		model: Type.Optional(Type.Partial(modelConfiguration)),
		view: Type.Optional(Type.Partial(viewConfiguration)),
		artifact: Type.Optional(Type.Partial(artifactConfiguration)),
		stagnation: Type.Optional(Type.Partial(stagnationConfiguration)),
		branches: Type.Optional(Type.Partial(branchConfiguration)),
		timeouts: Type.Optional(Type.Partial(timeoutConfiguration)),
		operations: Type.Optional(
			Type.Object({ concurrency: Type.Integer({ minimum: 1, maximum: 4 }) }, { additionalProperties: false }),
		),
	},
	{ additionalProperties: false },
);
export type KernelConfigurationInput = Static<typeof KernelConfigurationInputSchema>;
export const BudgetChangeInputSchema = Type.Object(
	{
		version: Type.Literal(1),
		ceilings: Type.Partial(ResourceCeilingsSchema),
		verification_reserve: Type.Optional(count),
	},
	{ additionalProperties: false },
);
export type BudgetChangeInput = Static<typeof BudgetChangeInputSchema>;
export function resources(): Resources {
	return {
		execution: 0,
		preflight: 0,
		ticks: 0,
		input_tokens: 0,
		output_tokens: 0,
		output_bytes: 0,
		artifact_bytes: 0,
		retrieval_bytes: 0,
		elapsed_ms: 0,
		cost: 0,
		refinement: 0,
	};
}
const base = {
	schema_version: Type.Literal(1),
	record_id: Type.String(),
	mission_id: Type.String(),
	revision: Type.Integer({ minimum: 1 }),
};
const record = <T extends string, P extends Record<string, TSchema>>(name: T, fields: P) =>
	Type.Object({ ...base, record_type: Type.Literal(name), ...fields }, { additionalProperties: false });
export const ConfigurationRecordSchema = record("KernelConfiguration", {
	source: choice("APPLICATION", "MIGRATION"),
	value: KernelConfigurationSchema,
	resource_overrides: Type.Partial(ResourceCeilingsSchema),
});
export const CONFIGURATION_MIGRATION_LIMITATION =
	"Historical non-budget settings were not recorded; fixed CONFIGURATION_CAPTURE/1 settings apply from this revision.";
export const ConfigurationMigrationSchema = record("ConfigurationMigration", {
	version: Type.Literal("CONFIGURATION_CAPTURE/1"),
	previous_contract_ref: Type.String(),
	contract_ref: Type.String(),
	configuration_ref: Type.String(),
	limitation: Type.Literal(CONFIGURATION_MIGRATION_LIMITATION),
});
export const BudgetChangeSchema = record("BudgetChange", {
	source_ref: Type.String(),
	previous_ref: nullableString,
	request: BudgetChangeInputSchema,
	overrides: Type.Partial(ResourceCeilingsSchema),
	verification_reserve: Type.Union([count, Type.Null()]),
});
// These schemas are the serialization boundary. Tool arguments are separately validated by Pi's registered TypeBox schema.
export const CommandSpecificationSchema = record("CommandSpecification", {
	command_id: Type.String(),
	original_instruction: Type.String(),
	source: choice("USER", "EXTENSION"),
	amendments: strings,
	objective: Type.String(),
	exact_targets: strings,
	requirements: strings,
	preferences: strings,
	prohibitions: strings,
	known_facts: strings,
	uncertainty: strings,
	expected_artifacts: strings,
	completion_conditions: strings,
	authorization_scope: strings,
});
export const AmendmentSchema = record("Amendment", {
	amendment_id: Type.String(),
	instruction: Type.String(),
	source: Type.Literal("USER"),
	captured_at: Type.Number(),
	requirement_changes: strings,
	revokes: Type.Boolean(),
});
export const ResumeSchema = record("ResumeRecord", {
	source_ref: Type.String(),
	previous_terminal_ref: Type.String(),
	previous_contract_ref: Type.String(),
	contract_ref: Type.String(),
	resumed_at: Type.Number({ minimum: 0 }),
	reconcile_operation_id: Type.Optional(Type.String()),
	approval_ref: Type.Optional(Type.String()),
});
export const ActionApprovalSchema = record("ActionApproval", {
	source_ref: Type.String(),
	request: ActionApprovalInputSchema,
	intent_epoch: Type.Integer({ minimum: 1 }),
	expires_at: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});
export const RequirementSchema = record("Requirement", {
	requirement_id: Type.String(),
	source_ref: Type.String(),
	text: Type.String(),
	mandatory: Type.Boolean(),
	rule: choice("READ", "LIST", "STATUS", "CONTENT", "PROCESS", "SEMANTIC", "SUBJECTIVE"),
	target: nullableString,
	expected: nullableString,
	status: choice("UNMET", "CANDIDATE", "VERIFIED", "BLOCKED", "SUPERSEDED"),
	generation: nullableString,
	evidence: strings,
	superseded_by: nullableString,
	dependencies: Type.Optional(strings),
});
export const MissionContractSchema = record("MissionContract", {
	command_spec_ref: Type.String(),
	product_mode: choice("padma_code", "padma_cyber"),
	route: RouteSchema,
	signals: Type.Object({ S: signal, A: signal, D: signal, O: signal, H: signal, E: signal }),
	bindings: strings,
	allowed_classes: strings,
	requirements: strings,
	quality_obligations: strings,
	policy_version: Type.String(),
	configuration_ref: Type.Optional(Type.String()),
	budget_ref: Type.Optional(nullableString),
	reconcile_operation_id: Type.Optional(nullableString),
	ceilings: ResourcesSchema,
	verification_reserve: Type.Number(),
	strategy: Type.String(),
	recompile_source: nullableString,
	amendment_refs: Type.Optional(strings),
});
export const BindingSchema = record("TargetBinding", {
	binding_id: Type.String(),
	canonical_path: Type.String(),
	user_label: nullableString,
	workspace_id: Type.String(),
	session_id: Type.String(),
	repository_identity: nullableString,
	worktree_identity: Type.String(),
	environment: Type.String(),
	generation: Type.String(),
	preimage_digest: nullableString,
	establishment_evidence: strings,
	valid: Type.Boolean(),
});
export const AuthorizationSchema = record("Authorization", {
	authorization_id: Type.String(),
	source_ref: Type.String(),
	classes: strings,
	target: Type.String(),
	environment: Type.String(),
	policy_version: Type.String(),
	action_digest: nullableString,
	expires_at: Type.Number(),
	revoked: Type.Boolean(),
	prepared_ref: Type.Optional(Type.String()),
});
export const ActionSchema = record("RegisteredActionSchema", {
	tool_id: Type.String(),
	operation_class: Type.String(),
	version: Type.String(),
	arguments_digest: Type.String(),
	side_effect: Type.Boolean(),
	risk_floor: Type.Integer({ minimum: 0, maximum: 3 }),
	timeout_ms: Type.Number(),
	output_limit: Type.Number(),
	conditional_commit: Type.Boolean(),
	idempotency: choice("NONE", "OBSERVATIONAL"),
	repeatability: Type.Optional(
		choice("READ_ONLY", "NATURALLY_IDEMPOTENT", "SUPPORTED_KEY", "CONDITIONAL", "NON_REPEATABLE"),
	),
	structural: Type.Boolean(),
	contract: Type.String(),
});
export const CandidateSchema = record("CandidateAction", {
	operation_id: Type.String(),
	tool_id: Type.String(),
	arguments: Type.Unknown(),
	target: Type.String(),
	rationale: Type.String(),
	hypothesis_ref: nullableString,
	hypothesis_binding_ref: Type.Optional(Type.String({ minLength: 1 })),
	hypothesis_selection_version: Type.Optional(Type.Literal("HYPOTHESIS_SELECTION/1")),
	shared_experiment: Type.Optional(
		Type.Object(
			{
				version: Type.Enum(["SHARED_OBSERVATION/1", "SHARED_TEST/1"]),
				hypothesis_refs: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 2, uniqueItems: true }),
			},
			{ additionalProperties: false },
		),
	),
	expected_effect: Type.String(),
	required_evidence: strings,
	estimate: ResourcesSchema,
	risk: Type.Number(),
	reversibility: Type.String(),
	abandon_condition: Type.String(),
});
export const PreparedSchema = record("PreparedAction", {
	operation_id: Type.String(),
	schema_ref: Type.String(),
	schema_version_ref: Type.String(),
	tool_id: Type.String(),
	operation_class: Type.String(),
	arguments: Type.Unknown(),
	binding_ref: Type.String(),
	target_generation: Type.String(),
	preconditions: strings,
	intended_effect: Type.String(),
	risk: Type.Integer({ minimum: 0, maximum: 3 }),
	timeout_ms: Type.Number(),
	limits: ResourcesSchema,
	action_digest: Type.String(),
	intent_epoch: Type.Optional(Type.Integer({ minimum: 1 })),
	approval_ref: Type.Optional(Type.String()),
});
export const ScopeSchema = record("ScopeDecision", {
	operation_id: Type.String(),
	outcome: choice("ALLOW", "DENY", "NEEDS_CURRENT_AUTHORIZATION"),
	policy_version: Type.String(),
	action_digest: Type.String(),
	target_generation: Type.String(),
	risk: Type.Number(),
	reasons: strings,
	authorization_ref: nullableString,
	valid_until: Type.Number(),
	evaluated_revision: Type.Number(),
});
export const ReservationSchema = record("BudgetReservation", {
	owner_operation_id: Type.String(),
	capture_operation_ref: Type.Optional(Type.String({ minLength: 1 })),
	amounts: ResourcesSchema,
	protected_for_verification: Type.Boolean(),
	state: choice("RESERVED", "STARTED", "RECONCILED", "RETAINED", "RELEASED"),
	actual: Type.Union([ResourcesSchema, Type.Null()]),
});
export const OperationSchema = record("OperationRecord", {
	operation_id: Type.String(),
	prepared_ref: Type.String(),
	decision_ref: nullableString,
	reservation_ref: nullableString,
	prediction_ref: Type.String(),
	checkpoint_ref: nullableString,
	status: choice("NOT_STARTED", "IN_PROGRESS", "CONFIRMED_COMPLETE", "FAILED", "OUTCOME_UNKNOWN"),
	started_at: Type.Union([Type.Number(), Type.Null()]),
	result_refs: strings,
	reconciliation_refs: strings,
	invocation_charged: Type.Optional(Type.Boolean()),
});
export const ScheduleSchema = record("OperationSchedule", {
	version: Type.Literal("DIRGHAKRIYA/1"),
	operation_id: Type.String(),
	prepared_ref: Type.String(),
	source_revision: count,
	dependencies: Type.Array(
		Type.Object(
			{ operation_id: Type.String(), condition: choice("EFFECT_CONFIRMED", "PROCESS_SUCCEEDED") },
			{ additionalProperties: false },
		),
		{ maxItems: 16 },
	),
	status: choice(
		"QUEUED",
		"DISPATCHED",
		"RUNNING",
		"COMPLETED",
		"FAILED",
		"CANCELLED",
		"CANCEL_REQUESTED",
		"UNCERTAIN",
	),
	priority: Type.Integer({ minimum: -100, maximum: 100 }),
	claim: nullableString,
	handle: Type.Union([
		Type.Object(
			{
				token: Type.String(),
				runtime: Type.String(),
				host: Type.String(),
				environment: Type.String(),
				backend: Type.Literal("RUNTIME_CALLBACK/1"),
				reattach: Type.Literal(false),
			},
			{ additionalProperties: false },
		),
		Type.Null(),
	]),
	queued_at: Type.Number(),
	observed_at: Type.Number(),
	progress_refs: Type.Array(Type.String(), { maxItems: 16, uniqueItems: true }),
	execution_refs: Type.Optional(Type.Array(Type.String(), { maxItems: 2, uniqueItems: true })),
	reconciliation: Type.Optional(
		Type.Object(
			{
				rule: Type.Literal("NO_AUTHORITATIVE_ENDPOINT/1"),
				operation_ref: Type.String(),
				conclusion: Type.Literal("STILL_UNRESOLVED"),
				attempted_at: Type.Number(),
				limitation: Type.String({ maxLength: 500 }),
			},
			{ additionalProperties: false },
		),
	),
	progress_omitted: count,
	control_ref: Type.String(),
	reason: Type.String({ maxLength: 500 }),
});
export const ReconciliationSchema = record("ReconciliationRecord", {
	rule: Type.Literal("LOCAL_FILE_POSTCONDITION/1"),
	operation_ref: Type.String(),
	inspection_operation_ref: Type.String(),
	observation_ref: Type.String(),
	expected: Type.String(),
	observed: Type.String(),
	result: choice("POSTCONDITION_OBSERVED", "NOT_AT_POSTCONDITION", "INCONCLUSIVE"),
	limitation: Type.String(),
});
export const ArtifactSchema = record("Artifact", {
	artifact_id: Type.String(),
	digest: Type.String(),
	bytes: Type.Number(),
	sensitivity: choice("PRIVATE", "RESTRICTED"),
	retention: Type.String(),
	expires_at: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()])),
	available: Type.Boolean(),
	media_type: Type.String(),
	target: nullableString,
	generation: nullableString,
	purpose: choice("OUTPUT", "PREIMAGE", "DELIVERED"),
});
export const ProposalFailureSchema = Type.Object(
	{
		version: Type.Literal("PROPOSAL_FAILURE/1"),
		diagnostic: Type.Object(
			{
				version: Type.Literal("TOOL_PREPARATION_FAILURE/1"),
				id: Type.String({ minLength: 1 }),
				code: choice("INVALID_ACTION_SCHEMA", "UNREGISTERED_OPERATION"),
				boundary: choice("TOOL_RESOLUTION", "ARGUMENT_PREPARATION", "SCHEMA_VALIDATION"),
			},
			{ additionalProperties: false },
		),
		tool_name: Type.String(),
		tool_call_id: Type.String(),
		tick_ref: nullableString,
		count: Type.Integer({ minimum: 1 }),
		limit: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);
export const EvidenceSchema = record("EvidenceRecord", {
	failure: Type.Optional(FailureSchema),
	event_id: Type.String(),
	stage: Type.String(),
	kind: choice("PREDICTION", "OBSERVATION", "INTERPRETATION", "VERIFICATION", "CONTROL"),
	provenance: choice("USER", "ADAPTER", "KERNEL", "MODEL"),
	target_generation: nullableString,
	captured_at: Type.Number(),
	operation_id: nullableString,
	source: Type.String(),
	payload: Type.Unknown(),
	artifact_ref: nullableString,
	digest: Type.String(),
	sensitivity: choice("PRIVATE", "RESTRICTED"),
	sources: strings,
	requirement_ids: strings,
	correction_of: nullableString,
	previous: nullableString,
});
export const HypothesisCauseSchema = choice(
	"INPUT_FORMAT",
	"STATE",
	"CONTROL_FLOW",
	"DATA_FLOW",
	"DEPENDENCY",
	"CONFIGURATION",
	"RESOURCE",
	"UNKNOWN",
);
export const HypothesisMechanismSchema = choice(
	"VALIDATE",
	"NORMALIZE",
	"REORDER",
	"UPDATE_STATE",
	"TRANSFORM",
	"REPLACE_DEPENDENCY",
	"ADJUST_CONFIGURATION",
	"LIMIT_RESOURCE",
	"ISOLATE",
	"TRACE",
	"INVESTIGATE",
);
export const HypothesisProposalSchema = Type.Object(
	{
		target: Type.String({ minLength: 1, maxLength: 1000 }),
		cause: HypothesisCauseSchema,
		mechanism: HypothesisMechanismSchema,
		cause_detail: Type.Optional(Type.String({ maxLength: 500 })),
		mechanism_detail: Type.Optional(Type.String({ maxLength: 500 })),
		failure_signature: Type.String({ minLength: 1, maxLength: 500 }),
		expected_result: Type.String({ minLength: 1, maxLength: 500 }),
		parent_ref: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);
export type HypothesisProposal = Static<typeof HypothesisProposalSchema>;
export const HypothesisSchema = record("Hypothesis", {
	hypothesis_id: Type.String(),
	fingerprint: Type.String(),
	target: Type.String(),
	cause: Type.String(),
	mechanism: Type.String(),
	// Versionless prose records remain readable; new proposals use the controlled schema above.
	normalization_version: Type.Optional(Type.Literal("CONTROLLED_HYPOTHESIS/1")),
	premise_binding_ref: Type.Optional(Type.String({ minLength: 1 })),
	premise_digest: Type.Optional(Type.String({ minLength: 1 })),
	cause_detail: Type.Optional(Type.String({ maxLength: 500 })),
	mechanism_detail: Type.Optional(Type.String({ maxLength: 500 })),
	failure_signature: Type.String(),
	expected_result: Type.String(),
	supporting: strings,
	contradicting: strings,
	status: choice("UNTESTED", "ACTIVE", "SUPPORTED", "CONTRADICTED", "REJECTED", "RESOLVED"),
	attempts: Type.Number(),
	premise_generation: Type.String(),
	parent_ref: Type.Optional(nullableString),
	depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
	branch_evidence: Type.Optional(strings),
	created_revision: Type.Optional(Type.Integer({ minimum: 1 })),
	rejection_ref: Type.Optional(Type.String({ minLength: 1 })),
	resolution_ref: Type.Optional(Type.String({ minLength: 1 })),
});
export const CheckpointSchema = record("CheckpointRecord", {
	checkpoint_id: Type.String(),
	target: Type.String(),
	preimage: Type.String(),
	artifact_ref: Type.String(),
	level: choice("EXPERIMENTAL", "LOCALLY_VALIDATED", "MISSION_VERIFIED"),
	verification_refs: strings,
	coverage: strings,
	restore: Type.String(),
	restore_limits: strings,
	non_reversible: strings,
});
export const CognitiveTickSchema = record("CognitiveTick", {
	version: Type.Literal("COGNITIVE_TICK/1"),
	tick_id: Type.String({ minLength: 1 }),
	model_reservation_ref: Type.String({ minLength: 1 }),
	status: choice("OPEN", "SETTLED"),
	known_progress: strings,
	progress: Type.Array(
		Type.Object({ key: Type.String({ minLength: 1 }), evidence: strings }, { additionalProperties: false }),
	),
	stagnation_before: count,
	stagnation_after: count,
});
export const VerificationSchema = record("VerificationReport", {
	candidate_refs: strings,
	results: Type.Array(
		Type.Object({
			requirement_id: Type.String(),
			result: choice("PASSED", "FAILED", "INCONCLUSIVE"),
			evidence: strings,
			reason: Type.String(),
		}),
	),
	completion_status: choice("PASSED", "FAILED", "INCONCLUSIVE"),
	delivery_status: choice("NOT_DELIVERED", "PARTIAL", "DELIVERED"),
	quality: choice("PASSED", "FAILED", "NOT_APPLICABLE", "INCONCLUSIVE"),
	presentation: Type.Optional(Type.String()),
	presentation_omitted: Type.Optional(Type.Boolean()),
	skipped: strings,
	defects: strings,
	limitations: strings,
});
export const TerminalSchema = record("TerminalReport", {
	failure_refs: Type.Optional(strings),
	status: TerminalStatusSchema,
	contract_ref: Type.Optional(Type.String()),
	verification_report_ref: nullableString,
	artifacts: strings,
	verified: strings,
	remaining: strings,
	checks_run: strings,
	checks_skipped: strings,
	presentation: Type.Optional(Type.String()),
	output_limit_bytes: Type.Optional(count),
	output_omitted: Type.Optional(Type.Boolean()),
	output_reservation_ref: Type.Optional(Type.String()),
	limitations: strings,
	unknown_operation: nullableString,
	next_action: nullableString,
	evidence: strings,
});
export const RecordSchema = Type.Union([
	ConfigurationRecordSchema,
	ConfigurationMigrationSchema,
	BudgetChangeSchema,
	CommandSpecificationSchema,
	AmendmentSchema,
	ResumeSchema,
	ActionApprovalSchema,
	RequirementSchema,
	MissionContractSchema,
	BindingSchema,
	AuthorizationSchema,
	ActionSchema,
	CandidateSchema,
	PreparedSchema,
	ScopeSchema,
	ReservationSchema,
	OperationSchema,
	ScheduleSchema,
	ReconciliationSchema,
	ArtifactSchema,
	EvidenceSchema,
	HypothesisSchema,
	CheckpointSchema,
	CognitiveTickSchema,
	VerificationSchema,
	TerminalSchema,
	record("PublicMissionEvent", {
		event_id: Type.String({ minLength: 1 }),
		event_type: Type.Literal("MISSION_STATE"),
		operation_id: nullableString,
		payload: PublicMissionSnapshotSchema,
	}),
]);
export type MissionRecord = Static<typeof RecordSchema>;
const recordValidator = Compile(RecordSchema);
export type RecordOf<T extends MissionRecord["record_type"]> = Extract<MissionRecord, { record_type: T }>;
export type Draft<T extends MissionRecord["record_type"]> = Omit<RecordOf<T>, keyof typeof base | "record_type">;
export function makeRecord<T extends MissionRecord["record_type"]>(
	mission: string,
	revision: number,
	type: T,
	fields: Draft<T>,
	id = randomUUID(),
): RecordOf<T> {
	const value = {
		...fields,
		schema_version: SCHEMA_VERSION,
		record_type: type,
		record_id: id,
		mission_id: mission,
		revision,
	};
	validateRecord(value);
	return value as RecordOf<T>;
}
export function validateRecord(value: unknown): asserts value is MissionRecord {
	canonical(value);
	if (!recordValidator.Check(value)) throw new Error("Invalid Sandhana record schema");
	if (!value.record_id.trim() || !value.mission_id.trim() || !Number.isSafeInteger(value.revision))
		throw new Error("Invalid stable record identity/revision");
}
export function digest(value: unknown): string {
	return createHash("sha256")
		.update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonical(value))
		.digest("hex");
}
export function canonical(value: unknown): string {
	const ancestors = new Set<object>();
	const encode = (item: unknown): string => {
		if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
		if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
		if (typeof item !== "object" || item === null) throw new Error("Non-JSON value in Sandhana record");
		if (ancestors.has(item)) throw new Error("Circular Sandhana record");
		if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
			throw new Error("Runtime object cannot enter Sandhana records");
		ancestors.add(item);
		try {
			if (Array.isArray(item)) {
				const parts: string[] = [];
				for (let index = 0; index < item.length; index++) parts.push(encode(item[index]));
				return `[${parts.join(",")}]`;
			}
			return `{${Object.keys(item)
				.sort()
				.map((key) => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key])}`)
				.join(",")}}`;
		} finally {
			ancestors.delete(item);
		}
	};
	return encode(value);
}
export function actionDigest(
	action: Pick<
		RecordOf<"PreparedAction">,
		| "schema_version_ref"
		| "tool_id"
		| "target_generation"
		| "arguments"
		| "intended_effect"
		| "risk"
		| "binding_ref"
		| "timeout_ms"
		| "limits"
		| "preconditions"
		| "intent_epoch"
	>,
): string {
	return digest({
		...(action.intent_epoch === undefined ? {} : { intent_epoch: action.intent_epoch }),
		schema: action.schema_version_ref,
		tool: action.tool_id,
		generation: action.target_generation,
		arguments: action.arguments,
		effect: action.intended_effect,
		risk: action.risk,
		binding: action.binding_ref,
		timeout: action.timeout_ms,
		limits: action.limits,
		preconditions: action.preconditions,
	});
}
export type MissionPhase =
	| "CREATED"
	| "UNDERSTANDING"
	| "COMPILING"
	| "EXECUTING"
	| "REPLANNING"
	| "REPAIRING"
	| "REFINING"
	| "CANDIDATE_READY"
	| "VERIFYING_COMPLETION"
	| "VERIFYING_QUALITY"
	| "FINALIZING"
	| TerminalStatus;
export const MissionStateSchema = Type.Object(
	{
		schema_version: Type.Literal(1),
		record_type: Type.Literal("MissionState"),
		mission_id: Type.String({ minLength: 1 }),
		revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		session_id: Type.String({ minLength: 1 }),
		owner_pid: Type.Integer({ minimum: 1 }),
		phase: Type.Union([
			choice(
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
			),
			TerminalStatusSchema,
		]),
		command: Type.String({ minLength: 1 }),
		contract: Type.String({ minLength: 1 }),
		requirements: strings,
		authorizations: strings,
		operations: strings,
		schedules: Type.Optional(strings),
		operation_concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
		operation_constraints: Type.Optional(
			Type.Array(
				Type.Object({ target: Type.String(), source_ref: Type.String() }, { additionalProperties: false }),
				{ maxItems: 16 },
			),
		),
		reservations: strings,
		checkpoints: strings,
		best: strings,
		hypotheses: strings,
		last_event: nullableString,
		terminal: nullableString,
		used: ResourcesSchema,
		ceilings: ResourcesSchema,
		verification_reserve: Type.Integer({ minimum: 0 }),
		route: RouteSchema,
		stagnation: Type.Integer({ minimum: 0 }),
		started_at: Type.Number({ minimum: 0 }),
		intent_epoch: Type.Optional(Type.Integer({ minimum: 1 })),
		leading_hypothesis: Type.Optional(nullableString),
		cognitive_tick: Type.Optional(nullableString),
	},
	{ additionalProperties: false },
);
export type MissionState = Static<typeof MissionStateSchema>;
const missionStateValidator = Compile(MissionStateSchema);
export function validateMissionState(value: unknown): asserts value is MissionState {
	canonical(value);
	if (!missionStateValidator.Check(value)) throw new Error("Invalid Sandhana mission state schema");
	for (const vector of [value.used, value.ceilings]) {
		for (const [dimension, amount] of Object.entries(vector)) {
			if (amount === null) continue;
			if (
				amount < 0 ||
				([
					"execution",
					"preflight",
					"ticks",
					"input_tokens",
					"output_tokens",
					"output_bytes",
					"artifact_bytes",
					"retrieval_bytes",
					"refinement",
				].includes(dimension) &&
					!Number.isSafeInteger(amount))
			)
				throw new Error("Invalid mission resource vector");
		}
	}
}
export const terminalStates: readonly string[] = [
	"VERIFIED_COMPLETE",
	"DELIVERED_UNVERIFIED",
	"PARTIALLY_COMPLETE",
	"BLOCKED",
	"BUDGET_EXHAUSTED",
	"EXECUTION_FAILED",
	"UNSAFE_OR_UNAUTHORIZED",
	"OUTCOME_UNKNOWN",
];
export function legalTransition(from: MissionPhase, to: MissionPhase): boolean {
	if (terminalStates.includes(from)) return false;
	if (from === to) return true;
	if (terminalStates.includes(to))
		return from === "FINALIZING" || !["VERIFIED_COMPLETE", "DELIVERED_UNVERIFIED"].includes(to);
	const edges: Partial<Record<MissionPhase, MissionPhase[]>> = {
		CREATED: ["UNDERSTANDING"],
		UNDERSTANDING: ["COMPILING"],
		COMPILING: ["EXECUTING"],
		EXECUTING: ["CANDIDATE_READY", "REPLANNING", "FINALIZING"],
		REPLANNING: ["EXECUTING"],
		REPAIRING: ["EXECUTING"],
		REFINING: ["EXECUTING"],
		CANDIDATE_READY: ["VERIFYING_COMPLETION"],
		VERIFYING_COMPLETION: ["VERIFYING_QUALITY", "REPAIRING", "FINALIZING"],
		VERIFYING_QUALITY: ["REPAIRING", "REFINING", "FINALIZING"],
		FINALIZING: [],
	};
	return edges[from]?.includes(to) ?? false;
}
