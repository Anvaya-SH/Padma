import { Value } from "typebox/value";
import { validateConfiguration } from "./configuration.ts";
import {
	canonical,
	type KernelConfiguration,
	type MissionState,
	POLICY_VERSION,
	type RecordOf,
	ResourceCeilingsSchema,
} from "./records.ts";

/** Versioned recovery policy, independent of replacement process/application defaults. */
export function configurationForMigration(
	state: MissionState,
	contract: RecordOf<"MissionContract">,
): KernelConfiguration {
	if (
		contract.configuration_ref !== undefined ||
		contract.policy_version !== POLICY_VERSION ||
		contract.product_mode !== "padma_code" ||
		contract.route !== state.route ||
		canonical(contract.ceilings) !== canonical(state.ceilings) ||
		contract.verification_reserve !== state.verification_reserve ||
		!Value.Check(ResourceCeilingsSchema, state.ceilings)
	)
		throw new Error("Unsupported configuration-less mission policy or captured resource limits");
	const { execution, ticks, ...resources } = state.ceilings;
	const value: KernelConfiguration = {
		version: "sandhana/1",
		routes: {
			SAKSHAT: { execution: 3, ticks: 3, verification_reserve: 0 },
			MADHYAMA: { execution: 40, ticks: 12, verification_reserve: 6 },
			GAMBHIRA: { execution: 100, ticks: 40, verification_reserve: 15 },
		},
		resources,
		model: { response_tokens: 8192, input_overhead_bytes: 4096 },
		view: { tool_chars: 50000, position_chars: 8000, evidence_events: 16, recent_observations: 3 },
		artifact: { max_bytes: 8 * 1024 * 1024, retention_ms: null },
		stagnation: { diagnose: 4, stop: 7 },
		branches: { active: 3, depth: 2 },
		timeouts: { shell_ms: 120000, observation_ms: 30000 },
	};
	value.routes[state.route] = { execution, ticks, verification_reserve: state.verification_reserve };
	validateConfiguration(value);
	return value;
}
