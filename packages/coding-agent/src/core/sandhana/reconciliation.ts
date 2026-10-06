import { editedContent } from "./code.ts";
import { digest, type MissionState, type RecordOf } from "./records.ts";
import type { MissionStore } from "./store.ts";

export const LOCAL_POSTCONDITION_LIMIT =
	"Inspection establishes only the current file state; it does not identify an actor or reconstruct intermediate effects or original usage. The original reservation is unchanged.";

/** Exact local replacement contract only. Shell/external/intermediate effects cannot be inferred from a file hash. */
export function localReplacement(store: MissionStore, operation: RecordOf<"OperationRecord">) {
	const action = store.get(operation.mission_id, operation.prepared_ref, "PreparedAction");
	const schema = store.get(operation.mission_id, action.schema_ref, "RegisteredActionSchema");
	const binding = store.get(operation.mission_id, action.binding_ref, "TargetBinding");
	if (
		action.operation_class !== "EDIT" ||
		!schema.conditional_commit ||
		!/^(write|edit|restore)\/2:/.test(schema.version) ||
		!operation.checkpoint_ref
	)
		throw new Error("Operation has no supported local replacement reconciliation contract");
	const checkpoint = store.get(operation.mission_id, operation.checkpoint_ref, "CheckpointRecord");
	if (checkpoint.target !== binding.canonical_path || checkpoint.preimage !== (binding.preimage_digest ?? "ABSENT"))
		throw new Error("Replacement checkpoint differs from the original binding");
	const args = action.arguments as Record<string, unknown>;
	let expected: string;
	if (schema.version.startsWith("write/2:") && typeof args.content === "string") expected = digest(args.content);
	else if (schema.version.startsWith("edit/2:") && Array.isArray(args.edits))
		expected = digest(
			editedContent(
				store.artifact(operation.mission_id, checkpoint.artifact_ref),
				args as { path: string; edits: { oldText: string; newText: string }[] },
			).bytes,
		);
	else if (schema.version.startsWith("restore/2:") && typeof args.checkpoint_id === "string") {
		const desired = store.get(operation.mission_id, args.checkpoint_id, "CheckpointRecord");
		if (desired.target !== binding.canonical_path) throw new Error("Restore checkpoint targets another file");
		expected =
			desired.preimage === "ABSENT" ? "ABSENT" : digest(store.artifact(operation.mission_id, desired.artifact_ref));
	} else throw new Error("Replacement arguments do not establish a supported postcondition");
	if (action.intended_effect !== (expected === "ABSENT" ? "Restore absent target" : `Content SHA256 ${expected}`))
		throw new Error("Recorded replacement postcondition differs from its actual prepared arguments");
	return { action, schema, binding, expected };
}

/** Store-level admissibility of current raw inspection. This never accepts an interpretation or digest alone. */
export function validateLocalReconciliation(
	store: MissionStore,
	state: MissionState,
	record: RecordOf<"ReconciliationRecord">,
): void {
	const original = store.get(state.mission_id, record.operation_ref, "OperationRecord");
	const replacement = localReplacement(store, original);
	const inspection = store.get(state.mission_id, record.inspection_operation_ref, "OperationRecord");
	const action = store.get(state.mission_id, inspection.prepared_ref, "PreparedAction");
	const schema = store.get(state.mission_id, action.schema_ref, "RegisteredActionSchema");
	const args = action.arguments as Record<string, unknown>;
	const binding = store.get(state.mission_id, action.binding_ref, "TargetBinding");
	const observation = store.get(state.mission_id, record.observation_ref, "EvidenceRecord");
	const contract = store.get(state.mission_id, state.contract, "MissionContract");
	if (
		original.status !== "OUTCOME_UNKNOWN" ||
		contract.reconcile_operation_id !== original.operation_id ||
		inspection.status !== "CONFIRMED_COMPLETE" ||
		action.operation_class !== "READ" ||
		!schema.structural ||
		schema.side_effect ||
		!schema.version.startsWith("read/1:") ||
		args.offset !== undefined ||
		args.limit !== undefined ||
		!state.operations.includes(inspection.record_id) ||
		binding.canonical_path !== replacement.binding.canonical_path ||
		binding.workspace_id !== replacement.binding.workspace_id ||
		binding.environment !== replacement.binding.environment ||
		!inspection.result_refs.includes(observation.record_id) ||
		observation.kind !== "OBSERVATION" ||
		observation.stage !== "phala" ||
		observation.provenance !== "ADAPTER" ||
		observation.operation_id !== inspection.operation_id ||
		!observation.artifact_ref ||
		observation.target_generation !== binding.generation
	)
		throw new Error("Reconciliation needs a governed raw inspection of the original target");
	const result: unknown = JSON.parse(store.artifact(state.mission_id, observation.artifact_ref).toString());
	const facts = observation.payload as Record<string, unknown>;
	if (
		!result ||
		typeof result !== "object" ||
		("isError" in result && result.isError === true) ||
		facts.target_unchanged !== true ||
		facts.dependencies_unchanged !== true ||
		record.limitation !== LOCAL_POSTCONDITION_LIMIT
	)
		throw new Error("Reconciliation inspection failed, changed or lacks its narrow claim limit");
	let observed: string;
	if (typeof facts.full_output_ref === "string") {
		const source = store.get(state.mission_id, facts.full_output_ref, "Artifact");
		observed = digest(store.artifact(state.mission_id, source.record_id));
		if (
			source.target !== binding.canonical_path ||
			source.generation !== binding.generation ||
			observed !== binding.preimage_digest
		)
			throw new Error("Inspection bytes do not match their bound target and generation");
	} else if (
		binding.preimage_digest === null &&
		"details" in result &&
		result.details &&
		typeof result.details === "object" &&
		"state" in result.details &&
		result.details.state === "ABSENT" &&
		"target" in result.details &&
		result.details.target === binding.canonical_path
	)
		observed = "ABSENT";
	else throw new Error("Reconciliation has no accessible current bytes or actual absence observation");
	if (
		record.expected !== replacement.expected ||
		record.observed !== observed ||
		record.result !== (observed === replacement.expected ? "POSTCONDITION_OBSERVED" : "NOT_AT_POSTCONDITION")
	)
		throw new Error("Reconciliation verdict differs from the actual local postcondition");
}
