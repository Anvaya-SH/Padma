import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { redact } from "./redaction.ts";

const recovery = {
	INVALID_ACTION_SCHEMA: ["Correct the proposal against the registered schema; prepare a new action."],
	UNREGISTERED_OPERATION: ["Choose a current registered operation or stop; unsupported effects remain denied."],
	TARGET_MISSING: ["Observe the exact target again only if its existence changed; do not substitute another target."],
	BINDING_STALE: ["Observe current target and intent; prepare and authorize a new action digest."],
	PREIMAGE_CONFLICT: [
		"Read the intervening content and reprepare; never overwrite or restore the old preimage blindly.",
	],
	REVISION_CONFLICT: ["Reload committed steering and usage; revalidate the intended transition."],
	AUTHORIZATION_REQUIRED: [
		"Obtain a current grant covering this exact operation and target; reprepare if the action changed.",
	],
	SCOPE_DENIED: ["Stop this action; an alternative must independently satisfy current scope and policy."],
	BUDGET_REJECTED: [
		"Stop new optional work; only an explicit applicable budget amendment can add capacity without resetting usage.",
	],
	BUDGET_OVERRUN: ["Retain actual spending and results; stop further launch and review current capacity."],
	PROVIDER_FAILURE: [
		"Retain known or unmeasured model usage; a bounded new decision needs current authority, capacity and a useful changed or transient condition.",
	],
	TOOL_FAILURE_KNOWN: [
		"Inspect confirmed state and retained output; a new attempt needs valid authority, capacity and a useful changed condition.",
	],
	EFFECT_OUTCOME_UNKNOWN: [
		"Inspect authoritative operation or target state; reconcile the prior outcome before any new effect. Never blindly replay.",
	],
	ARTIFACT_UNAVAILABLE: [
		"Recover accessible original evidence or perform a new authorized observation; a digest or summary cannot verify the claim.",
	],
	VERIFICATION_INCONCLUSIVE: [
		"Obtain applicable requirement-specific evidence within current authority and capacity.",
	],
	STAGNATION: [
		"Use materially new evidence or a distinct authorized approach, or stop; repeated proposals cannot reset the ledger.",
	],
	UNAVAILABLE_CAPABILITY: [
		"Use an implemented registered alternative or stop; no successful placeholder is available.",
	],
	STATE_CONFLICT: ["Inspect current durable state and validate a legal transition; do not replay an effect."],
	ID_PAYLOAD_CONFLICT: ["Retain the original record; a different payload requires a new validated identity."],
};
export type FailureCode = keyof typeof recovery;
const reference = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);
export const FailureSchema = Type.Object(
	{
		version: Type.Literal("SANDHANA_FAILURE/1"),
		code: Type.Enum(Object.keys(recovery) as FailureCode[]),
		explanation: Type.String({ minLength: 1, maxLength: 1000 }),
		operation_id: reference,
		target_binding_ref: reference,
		retry: Type.Object(
			{
				automatic: Type.Literal(false),
				conditions: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 4 }),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export type Failure = Static<typeof FailureSchema>;
export interface FailureContext {
	operation_id?: string | null;
	target_binding_ref?: string | null;
}
const validator = Compile(FailureSchema);
export function isFailure(value: unknown): value is Failure {
	return (
		validator.Check(value) &&
		value.retry.conditions.length === recovery[value.code].length &&
		value.retry.conditions.every((condition, index) => condition === recovery[value.code][index])
	);
}

/** Codes are selected at a validator/adapter boundary, never inferred from model prose. */
export class SandhanaError extends Error {
	readonly failure: Failure;
	constructor(code: FailureCode, explanation: string, context: FailureContext = {}) {
		super(redact(explanation.slice(0, 1256)).slice(0, 1000) || "Boundary failed; inspect current mission state.");
		this.name = "SandhanaError";
		this.failure = {
			version: "SANDHANA_FAILURE/1",
			code,
			explanation: this.message,
			operation_id: context.operation_id ?? null,
			target_binding_ref: context.target_binding_ref ?? null,
			retry: { automatic: false, conditions: [...recovery[code]] },
		};
	}
}
