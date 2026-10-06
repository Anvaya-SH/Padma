import { Value } from "typebox/value";
import { SandhanaError } from "./errors.ts";
import { type ActionApprovalInput, ActionApprovalInputSchema } from "./public-protocol.ts";
import { actionDigest, canonical, type RecordOf } from "./records.ts";
import type { MissionStore } from "./store.ts";

export function parseActionApproval(instruction: string): ActionApprovalInput {
	let request: unknown;
	try {
		request = JSON.parse(instruction.slice("authorize: ".length));
	} catch {
		throw new SandhanaError("INVALID_ACTION_SCHEMA", "Invalid exact-action authorization response");
	}
	if (!instruction.startsWith("authorize: ") || !Value.Check(ActionApprovalInputSchema, request))
		throw new SandhanaError("INVALID_ACTION_SCHEMA", "Invalid exact-action authorization response");
	return request;
}

/** Admission reads only retained state. The response creates no target authority until fresh preparation. */
export function validateActionApproval(
	store: MissionStore,
	request: ActionApprovalInput,
	excludeRef?: string,
): RecordOf<"PreparedAction"> {
	const view = store.publicAuthorization(request.mission_id);
	if (request.revision !== view.revision)
		throw new SandhanaError("REVISION_CONFLICT", "Authorization response names a stale mission revision");
	if (
		!view.request ||
		request.decision_ref !== view.request.decision_ref ||
		request.prepared_ref !== view.request.prepared_ref ||
		request.action_digest !== view.request.action_digest ||
		store
			.records(request.mission_id)
			.some(
				(record) =>
					record.record_type === "ActionApproval" &&
					record.record_id !== excludeRef &&
					record.request.decision_ref === request.decision_ref,
			)
	)
		throw new SandhanaError(
			"AUTHORIZATION_REQUIRED",
			"Authorization response does not name the current unconsumed request",
		);
	const action = store.get(request.mission_id, request.prepared_ref, "PreparedAction");
	if (action.risk === 3)
		throw new SandhanaError(
			"SCOPE_DENIED",
			"Tier 3 requires a reviewed safeguard adapter; approval cannot lower risk",
		);
	return action;
}

/** Rebinding may change record identity and intent epoch, never the consented payload, effect or target. */
export function validateApprovedPreparation(
	store: MissionStore,
	approval: RecordOf<"ActionApproval">,
	action: RecordOf<"PreparedAction">,
	binding: RecordOf<"TargetBinding">,
	schema: RecordOf<"RegisteredActionSchema">,
): void {
	const original = store.get(action.mission_id, approval.request.prepared_ref, "PreparedAction");
	const originalBinding = store.get(action.mission_id, original.binding_ref, "TargetBinding");
	const originalSchema = store.get(action.mission_id, original.schema_ref, "RegisteredActionSchema");
	const context = { operation_id: action.operation_id, target_binding_ref: action.binding_ref };
	if (approval.expires_at <= Date.now() || approval.intent_epoch !== action.intent_epoch)
		throw new SandhanaError("AUTHORIZATION_REQUIRED", "Exact-action approval expired or its intent changed", context);
	if (
		action.operation_class !== original.operation_class ||
		action.schema_version_ref !== originalSchema.version ||
		canonical({ ...schema, record_id: originalSchema.record_id, revision: originalSchema.revision }) !==
			canonical(originalSchema) ||
		actionDigest({ ...action, binding_ref: original.binding_ref, intent_epoch: original.intent_epoch }) !==
			approval.request.action_digest ||
		canonical({
			...binding,
			record_id: originalBinding.record_id,
			revision: originalBinding.revision,
			binding_id: originalBinding.binding_id,
			establishment_evidence: originalBinding.establishment_evidence,
		}) !== canonical(originalBinding)
	)
		throw new SandhanaError(
			"BINDING_STALE",
			"Fresh preparation differs from the exact approved action or target",
			context,
		);
}
