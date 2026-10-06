import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { canonical, type MissionRecord, type MissionState, type RecordOf } from "./records.ts";
import type { MissionStore } from "./store.ts";

export const TOOL_OVERRUN_SOURCE = "tool-usage-overrun/1";
export const TOOL_OVERRUN_REASON =
	"Actual launched usage exceeded its reservation or cumulative ceiling; result retained";
const bounded = ["output_bytes", "artifact_bytes"] as const;
const measured = [
	"execution",
	"preflight",
	"output_bytes",
	"artifact_bytes",
	"retrieval_bytes",
	"elapsed_ms",
	"refinement",
] as const;
const schema = Compile(
	Type.Object(
		{
			version: Type.Literal("TOOL_USAGE_OVERRUN/1"),
			intent_epoch: Type.Integer({ minimum: 1 }),
			reservation_ref: Type.String({ minLength: 1 }),
			settlement_ref: Type.String({ minLength: 1 }),
			operation_ref: Type.String({ minLength: 1 }),
			over_reservation: Type.Array(Type.Enum(bounded), { uniqueItems: true, maxItems: 2 }),
			over_ceiling: Type.Array(Type.Enum(measured), { uniqueItems: true, maxItems: 7 }),
		},
		{ additionalProperties: false },
	),
);

export function toolOverrun(
	reservation: RecordOf<"BudgetReservation">,
	settlement: RecordOf<"BudgetReservation">,
	operation: RecordOf<"OperationRecord">,
	state: MissionState,
	at: number,
) {
	if (!settlement.actual) return null;
	const over_reservation = bounded.filter((key) => settlement.actual![key] > reservation.amounts[key]);
	const over_ceiling = measured.filter(
		(key) =>
			(key === "elapsed_ms" ? Math.max(state.used.elapsed_ms, at - state.started_at) : state.used[key]) >
			state.ceilings[key],
	);
	if (!over_reservation.length && !over_ceiling.length) return null;
	return {
		version: "TOOL_USAGE_OVERRUN/1" as const,
		intent_epoch: state.intent_epoch ?? 1,
		reservation_ref: reservation.record_id,
		settlement_ref: settlement.record_id,
		operation_ref: operation.record_id,
		over_reservation,
		over_ceiling,
	};
}

export function activeToolOverrun(store: MissionStore, state: MissionState): boolean {
	if (state.terminal) return false;
	const ref = store.contextReferences(state.mission_id, TOOL_OVERRUN_SOURCE, state.revision, true).at(0);
	if (!ref) return false;
	const event = store.get(state.mission_id, ref, "EvidenceRecord");
	return schema.Check(event.payload) && event.payload.intent_epoch === (state.intent_epoch ?? 1);
}

export function validateToolOverrun(
	store: MissionStore,
	event: RecordOf<"EvidenceRecord">,
	state: MissionState,
	previous: MissionState | undefined,
	additions: MissionRecord[],
): void {
	if (!schema.Check(event.payload)) throw new Error("Invalid tool usage overrun envelope");
	const payload = event.payload;
	const reservation = store.get(state.mission_id, payload.reservation_ref, "BudgetReservation");
	const settlement = store.get(state.mission_id, payload.settlement_ref, "BudgetReservation");
	const operation = store.get(state.mission_id, payload.operation_ref, "OperationRecord");
	const action = store.get(state.mission_id, operation.prepared_ref, "PreparedAction");
	if (
		!previous?.reservations.includes(reservation.record_id) ||
		!["STARTED", "RETAINED"].includes(reservation.state) ||
		reservation.owner_operation_id !== operation.operation_id ||
		settlement.owner_operation_id !== operation.operation_id ||
		!["RECONCILED", "RETAINED"].includes(settlement.state) ||
		settlement.revision !== event.revision ||
		operation.reservation_ref !== settlement.record_id ||
		!state.operations.includes(operation.record_id) ||
		!state.reservations.includes(settlement.record_id) ||
		operation.started_at === null ||
		!operation.result_refs.some((ref) =>
			additions.some(
				(item) =>
					item.record_id === ref &&
					item.record_type === "EvidenceRecord" &&
					item.stage === "phala" &&
					item.kind === "OBSERVATION" &&
					item.operation_id === operation.operation_id,
			),
		) ||
		!additions.some((item) => item.record_id === settlement.record_id) ||
		canonical(payload) !== canonical(toolOverrun(reservation, settlement, operation, state, event.captured_at)) ||
		event.source !== TOOL_OVERRUN_SOURCE ||
		event.stage !== "kosa" ||
		event.kind !== "CONTROL" ||
		event.provenance !== "KERNEL" ||
		event.operation_id !== operation.operation_id ||
		event.failure?.code !== "BUDGET_OVERRUN" ||
		event.failure.operation_id !== operation.operation_id ||
		event.failure.target_binding_ref !== action.binding_ref ||
		event.artifact_ref !== null ||
		event.sources.length !== 1 ||
		!operation.result_refs.includes(event.sources[0]) ||
		additions.filter(
			(item) =>
				item.record_type === "EvidenceRecord" &&
				item.source === TOOL_OVERRUN_SOURCE &&
				item.operation_id === operation.operation_id,
		).length !== 1
	)
		throw new Error("Tool overrun must retain the exact launched outcome, reservation and measured settlement");
}
