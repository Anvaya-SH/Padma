import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { canonical, type MissionRecord, type MissionState, type RecordOf, type Resources } from "./records.ts";
import type { MissionStore } from "./store.ts";

export const MODEL_OVERRUN_SOURCE = "model-usage-overrun/1";
export const MODEL_OVERRUN_REASON =
	"Actual model usage exceeded its reservation or cumulative ceiling; no further launch, measurements retained";
const dimensions = ["input_tokens", "output_tokens", "cost"] as const;
const ceilingDimensions = [...dimensions, "elapsed_ms"] as const;
const dimension = Type.Enum(dimensions);
const schema = Compile(
	Type.Object(
		{
			version: Type.Literal("MODEL_USAGE_OVERRUN/1"),
			intent_epoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
			contract_ref: Type.String({ minLength: 1 }),
			reservation_ref: Type.String({ minLength: 1 }),
			settlement_ref: Type.String({ minLength: 1 }),
			over_reservation: Type.Array(dimension, { uniqueItems: true, maxItems: 3 }),
			over_ceiling: Type.Array(Type.Enum(ceilingDimensions), { uniqueItems: true, maxItems: 4 }),
		},
		{ additionalProperties: false },
	),
);

/** Only measured model dimensions are compared; ticks are charged at admission and time has no per-response estimate. */
export function modelOverrun(
	reservation: RecordOf<"BudgetReservation">,
	settlement: RecordOf<"BudgetReservation">,
	state: MissionState,
) {
	const actual = settlement.actual;
	if (!actual) return null;
	const over_reservation = dimensions.filter(
		(key) => actual[key] !== null && reservation.amounts[key] !== null && actual[key]! > reservation.amounts[key]!,
	);
	const over_ceiling = ceilingDimensions.filter(
		(key) => state.used[key] !== null && state.ceilings[key] !== null && state.used[key]! > state.ceilings[key]!,
	);
	if (!over_reservation.length && !over_ceiling.length) return null;
	return {
		version: "MODEL_USAGE_OVERRUN/1" as const,
		intent_epoch: state.intent_epoch ?? 1,
		contract_ref: state.contract,
		reservation_ref: reservation.record_id,
		settlement_ref: settlement.record_id,
		over_reservation,
		over_ceiling,
	};
}

/** An overflowing cumulative measurement remains unknown; it can never wrap or become free capacity. */
export function modelUsageTotals(previous: Resources, actual: Resources): Resources {
	const used = { ...previous, elapsed_ms: previous.elapsed_ms + actual.elapsed_ms };
	for (const key of dimensions) {
		const total = previous[key] === null || actual[key] === null ? null : previous[key]! + actual[key]!;
		used[key] =
			total === null || !Number.isFinite(total) || (key !== "cost" && !Number.isSafeInteger(total)) ? null : total;
	}
	return used;
}

/** An explicit resume/amendment advances the intent epoch; reading history never clears the failure. */
export function activeModelOverrun(store: MissionStore, state: MissionState): RecordOf<"EvidenceRecord"> | null {
	if (state.terminal) return null;
	const ref = store.contextReferences(state.mission_id, MODEL_OVERRUN_SOURCE, state.revision, true).at(0);
	if (!ref) return null;
	const event = store.get(state.mission_id, ref, "EvidenceRecord");
	return schema.Check(event.payload) && event.payload.intent_epoch === (state.intent_epoch ?? 1) ? event : null;
}

export function validateModelSettlement(
	reservation: RecordOf<"BudgetReservation">,
	settlement: RecordOf<"BudgetReservation">,
	state: MissionState,
	previous: MissionState,
): void {
	const actual = settlement.actual;
	if (!actual || reservation.state !== "RESERVED")
		throw new Error("Model settlement requires its current reservation and measured usage");
	const used = modelUsageTotals(previous.used, actual);
	if (
		canonical(state.used) !== canonical(used) ||
		canonical(settlement.amounts) !== canonical(reservation.amounts) ||
		settlement.protected_for_verification !== reservation.protected_for_verification ||
		actual.ticks !== 1 ||
		Object.entries(actual).some(
			([key, value]) => ![...dimensions, "elapsed_ms", "ticks"].includes(key) && value !== 0,
		)
	)
		throw new Error(
			"Model settlement must retain exact measured usage without resetting spending or charging another tick",
		);
}

export function validateInvalidModelUsage(
	store: MissionStore,
	event: RecordOf<"EvidenceRecord">,
	state: MissionState,
	previous: MissionState | undefined,
	additions: MissionRecord[],
): void {
	const payload = event.payload;
	const invalidSchema = Type.Object(
		{
			version: Type.Literal("MODEL_USAGE_INVALID/1"),
			reservation_ref: Type.String({ minLength: 1 }),
			settlement_ref: Type.String({ minLength: 1 }),
			invalid_dimensions: Type.Array(Type.Enum(dimensions), { minItems: 1, maxItems: 3, uniqueItems: true }),
		},
		{ additionalProperties: false },
	);
	// This boundary runs only for an invalid measurement publication, not every record.
	const invalid = Compile(invalidSchema);
	if (!invalid.Check(payload)) throw new Error("Invalid model measurement envelope");
	const reservation = store.get(state.mission_id, payload.reservation_ref, "BudgetReservation");
	const settlement = store.get(state.mission_id, payload.settlement_ref, "BudgetReservation");
	if (
		!previous?.reservations.includes(reservation.record_id) ||
		reservation.state !== "RESERVED" ||
		!reservation.owner_operation_id.startsWith("model:") ||
		reservation.owner_operation_id !== settlement.owner_operation_id ||
		settlement.state !== "RECONCILED" ||
		!settlement.actual ||
		settlement.revision !== event.revision ||
		!additions.some((item) => item.record_id === settlement.record_id) ||
		canonical(payload.invalid_dimensions) !==
			canonical(dimensions.filter((key) => settlement.actual![key] === null)) ||
		event.source !== "invalid-model-usage/1" ||
		event.kind !== "CONTROL" ||
		event.provenance !== "KERNEL" ||
		event.stage !== "kosa" ||
		event.failure?.code !== "PROVIDER_FAILURE" ||
		event.operation_id !== null ||
		event.failure.operation_id !== null ||
		event.failure.target_binding_ref !== null ||
		additions.filter((item) => item.record_type === "EvidenceRecord" && item.source === event.source).length !== 1
	)
		throw new Error("Invalid measurements must retain their exact current unknown settlement");
}

export function validateModelOverrun(
	store: MissionStore,
	event: RecordOf<"EvidenceRecord">,
	state: MissionState,
	previous: MissionState | undefined,
	additions: MissionRecord[],
): void {
	if (!schema.Check(event.payload)) throw new Error("Invalid model overrun envelope");
	const payload = event.payload;
	const reservation = store.get(state.mission_id, payload.reservation_ref, "BudgetReservation");
	const settlement = store.get(state.mission_id, payload.settlement_ref, "BudgetReservation");
	const expected = modelOverrun(reservation, settlement, state);
	if (
		!previous?.reservations.includes(reservation.record_id) ||
		reservation.state !== "RESERVED" ||
		!reservation.owner_operation_id.startsWith("model:") ||
		settlement.owner_operation_id !== reservation.owner_operation_id ||
		settlement.state !== "RECONCILED" ||
		settlement.revision !== event.revision ||
		!state.reservations.includes(settlement.record_id) ||
		!additions.some((record) => record.record_id === settlement.record_id) ||
		canonical(payload) !== canonical(expected) ||
		event.source !== MODEL_OVERRUN_SOURCE ||
		event.stage !== "kosa" ||
		event.kind !== "CONTROL" ||
		event.provenance !== "KERNEL" ||
		event.failure?.code !== "BUDGET_OVERRUN" ||
		event.failure.operation_id !== null ||
		event.failure.target_binding_ref !== null ||
		event.operation_id !== null ||
		event.target_generation !== null ||
		event.artifact_ref !== null ||
		event.sources.length !== 0 ||
		event.requirement_ids.length !== 0 ||
		additions.filter(
			(record) =>
				record.record_type === "EvidenceRecord" &&
				record.source === MODEL_OVERRUN_SOURCE &&
				schema.Check(record.payload) &&
				record.payload.settlement_ref === settlement.record_id,
		).length !== 1
	)
		throw new Error("Model overrun must describe one current measured settlement and its exact reservation");
}
