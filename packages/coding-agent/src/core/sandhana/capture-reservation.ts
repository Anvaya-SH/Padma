import { SandhanaError } from "./errors.ts";
import { MAX_FILE_BYTES } from "./io.ts";
import { canonical, type MissionRecord, type MissionState, type RecordOf, resources } from "./records.ts";
import type { MissionStore } from "./store.ts";

/** A bounded observation of an already launched operation cannot admit another action or reset mission spending. */
export function validateCaptureReservation(
	store: MissionStore,
	record: RecordOf<"BudgetReservation">,
	state: MissionState,
	previous: MissionState | undefined,
	additions: MissionRecord[],
): void {
	const reference = record.capture_operation_ref;
	if (!previous || !reference || !previous.operations.includes(reference))
		throw new Error("Capture requires a current launched operation reference");
	const operation = store.get(state.mission_id, reference, "OperationRecord");
	if (
		operation.status !== "IN_PROGRESS" ||
		operation.started_at === null ||
		operation.invocation_charged !== true ||
		!record.owner_operation_id.startsWith(`capture:${reference}:`) ||
		record.protected_for_verification ||
		additions.length !== 1 ||
		additions[0].record_id !== record.record_id ||
		record.amounts.retrieval_bytes > MAX_FILE_BYTES ||
		canonical(record.amounts) !== canonical({ ...resources(), retrieval_bytes: record.amounts.retrieval_bytes })
	)
		throw new Error("Capture reservation must only retrieve bounded evidence for its already launched operation");
	const priorRef = previous.reservations.find(
		(ref) => store.get(state.mission_id, ref, "BudgetReservation").owner_operation_id === record.owner_operation_id,
	);
	let reservations: string[];
	let used = previous.used;
	if (record.state === "RESERVED") {
		if (priorRef || record.actual !== null) throw new Error("Capture admission requires one fresh reservation");
		const pending = previous.reservations.reduce((bytes, ref) => {
			const reservation = store.get(state.mission_id, ref, "BudgetReservation");
			return (
				bytes +
				(["RESERVED", "STARTED", "RETAINED"].includes(reservation.state) ? reservation.amounts.retrieval_bytes : 0)
			);
		}, 0);
		const total = previous.used.retrieval_bytes + pending + record.amounts.retrieval_bytes;
		if (!Number.isSafeInteger(total) || total > previous.ceilings.retrieval_bytes)
			throw new SandhanaError(
				"BUDGET_REJECTED",
				"Launched evidence capture exceeds the cumulative retrieval byte ceiling",
			);
		reservations = [...previous.reservations, record.record_id];
	} else if (record.state === "RECONCILED" && priorRef && record.actual) {
		const prior = store.get(state.mission_id, priorRef, "BudgetReservation");
		if (
			prior.state !== "RESERVED" ||
			prior.capture_operation_ref !== reference ||
			canonical(prior.amounts) !== canonical(record.amounts) ||
			record.actual.retrieval_bytes > record.amounts.retrieval_bytes ||
			canonical(record.actual) !== canonical({ ...resources(), retrieval_bytes: record.actual.retrieval_bytes })
		)
			throw new Error("Capture settlement requires its exact reservation and bounded actual retrieval bytes");
		reservations = previous.reservations.map((ref) => (ref === priorRef ? record.record_id : ref));
		used = { ...previous.used, retrieval_bytes: previous.used.retrieval_bytes + record.actual.retrieval_bytes };
	} else throw new Error("Capture may only reserve or settle retrieval for its launched operation");
	if (canonical(state) !== canonical({ ...previous, revision: previous.revision + 1, reservations, used }))
		throw new Error("Capture cannot alter authority, operations, mission progress or unrelated spending");
}
