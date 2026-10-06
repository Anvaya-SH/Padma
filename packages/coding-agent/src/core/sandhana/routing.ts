import { routeFor } from "./code.ts";
import {
	hypothesisExperimentApplicability,
	hypothesisObservedText,
	sameHypothesisApproach,
	selectedHypotheses,
} from "./hypotheses.ts";
import { canonical, digest, type MissionState, type RecordOf, type Signals } from "./records.ts";
import type { MissionStore } from "./store.ts";

/** Stored signals are validated before they can open a routing gate. */
function narrowSignals(signals: RecordOf<"MissionContract">["signals"]): Signals {
	for (const key of Object.keys(signals) as (keyof Signals)[]) {
		const severity = signals[key].severity;
		if (severity !== 0 && severity !== 1 && severity !== 2) throw new Error(`Unsupported ${key} routing severity`);
	}
	return signals as unknown as Signals;
}

/** Routing claims are not evidence rules: only registered, applicable facts may open a gate. */
export function validateRoutingContract(
	store: MissionStore,
	contract: RecordOf<"MissionContract">,
	state: MissionState,
	previous: MissionState | undefined,
): void {
	const mission = state.mission_id;
	const prior = previous ? store.get(mission, previous.contract, "MissionContract") : null;
	// Retain historical startup/migration/resume projections. They do not assert a new routing proof.
	if (prior && contract.route === prior.route && canonical(contract.signals) === canonical(prior.signals)) return;
	const signals = narrowSignals(contract.signals);
	if (contract.route !== routeFor(signals)) throw new Error("Mission routing gate differs from its signals");
	const spec = store.get(mission, contract.command_spec_ref, "CommandSpecification");
	const requirements = contract.requirements.map((ref) => store.get(mission, ref, "Requirement"));
	const exactObservation =
		spec.exact_targets.length === 1 &&
		requirements.length === 1 &&
		["READ", "LIST", "STATUS"].includes(requirements[0].rule);
	for (const key of Object.keys(contract.signals) as (keyof Signals)[]) {
		const signal = contract.signals[key];
		if (new Set(signal.evidence).size !== signal.evidence.length)
			throw new Error("Duplicate routing proof reference");
		const retainedLegacy = prior && canonical(signal) === canonical(prior.signals[key]);
		if (
			signal.evidence.length === 1 &&
			signal.evidence[0] === "reviewed-local-observation/1" &&
			signal.severity === 0 &&
			key !== "H" &&
			signal.provenance === (key === "A" ? "COMMAND" : "STRUCTURAL") &&
			(retainedLegacy || (!previous && exactObservation && contract.route === "SAKSHAT"))
		)
			continue;
		if (["UNKNOWN", "ESTIMATE"].includes(signal.provenance)) {
			for (const ref of signal.evidence) store.get(mission, ref, "EvidenceRecord");
			continue;
		}
		if (
			signal.provenance === "HISTORY" &&
			((key === "H" && signal.severity === 2) || (key === "A" && signal.severity === 1))
		) {
			if (!previous || !historyProof(store, previous, signal.evidence))
				throw new Error("History routing proof needs two materially different applicable refuted approaches");
			continue;
		}
		// No observation or free-form payload establishes S/D broad complexity. New structural/preflight
		// rules must register an explicit signal-specific contract before they can grant elevated routing.
		if (
			key === "A" &&
			signal.severity === 0 &&
			signal.provenance === "COMMAND" &&
			exactObservation &&
			signal.evidence.length === 1 &&
			signal.evidence[0] === spec.record_id
		)
			continue;
		throw new Error(`Unsupported ${key} routing proof or provenance`);
	}
}

function historyProof(store: MissionStore, state: MissionState, refs: string[]): boolean {
	if (refs.length < 2) return false;
	const mission = state.mission_id;
	const observations = refs.map((ref) => store.get(mission, ref, "EvidenceRecord"));
	const history = store.records(mission).filter((record) => record.revision <= state.revision);
	const approaches: { hypothesis: RecordOf<"Hypothesis">; experiments: Set<string> }[] = [];
	const applicableRefs = new Set<string>();
	for (const ref of state.hypotheses) {
		const hypothesis = store.get(mission, ref, "Hypothesis");
		if (
			hypothesis.normalization_version !== "CONTROLLED_HYPOTHESIS/1" ||
			hypothesis.status !== "CONTRADICTED" ||
			hypothesis.attempts < 1
		)
			continue;
		const experiments = new Set<string>();
		for (const observation of observations) {
			if (observation.revision > state.revision || !hypothesis.contradicting.includes(observation.record_id))
				continue;
			const candidate = history.findLast(
				(record) => record.record_type === "CandidateAction" && record.operation_id === observation.operation_id,
			);
			if (candidate?.record_type !== "CandidateAction") continue;
			const selected = selectedHypotheses(candidate)
				.map((id) => store.get(mission, id, "Hypothesis"))
				.find(
					(branch) =>
						branch.hypothesis_id === hypothesis.hypothesis_id &&
						branch.premise_binding_ref === hypothesis.premise_binding_ref,
				);
			if (!selected || !hypothesisExperimentApplicability(store, selected, observation).resolvable) continue;
			const payload = observation.payload;
			if (!payload || typeof payload !== "object" || !("isError" in payload) || payload.isError !== true) continue;
			const text = hypothesisObservedText(store, observation);
			if (!text.includes(hypothesis.failure_signature) || text.includes(hypothesis.expected_result)) continue;
			const operation = state.operations
				.map((id) => store.get(mission, id, "OperationRecord"))
				.find(
					(operation) =>
						operation.operation_id === observation.operation_id &&
						operation.result_refs.includes(observation.record_id),
				);
			if (!operation || !["CONFIRMED_COMPLETE", "FAILED"].includes(operation.status)) continue;
			const action = store.get(mission, operation.prepared_ref, "PreparedAction");
			experiments.add(
				digest({
					tool: action.tool_id,
					arguments: action.arguments,
					target: store.get(mission, action.binding_ref, "TargetBinding").canonical_path,
				}),
			);
			applicableRefs.add(observation.record_id);
		}
		if (experiments.size) approaches.push({ hypothesis, experiments });
	}
	return (
		applicableRefs.size === refs.length &&
		approaches.some((left, index) =>
			approaches
				.slice(index + 1)
				.some(
					(right) =>
						!sameHypothesisApproach(left.hypothesis, right.hypothesis) &&
						[...left.experiments].some((experiment) => !right.experiments.has(experiment)),
				),
		)
	);
}
