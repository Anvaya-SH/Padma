import { Value } from "typebox/value";
import { DEFAULT_CONTEXT_LIMITS, SourceFamilySchema } from "./avartana/contracts.ts";
import {
	type BudgetChangeInput,
	canonical,
	type KernelConfiguration,
	KernelConfigurationInputSchema,
	KernelConfigurationSchema,
	type ResourceCeilings,
	ResourceCeilingsSchema,
	type Route,
} from "./records.ts";

export const DEFAULT_AVARTANA_CONFIGURATION = {
	version: "AVARTANA_CONFIG/1" as const,
	semantic: true,
	cache_bytes: 8 * 1024 ** 2,
	evidence_fraction: 0.2,
	scan_bytes: DEFAULT_CONTEXT_LIMITS.scanBytes,
	return_bytes: DEFAULT_CONTEXT_LIMITS.returnBytes,
	hits: 64,
	ranges: 12,
	elapsed_ms: 30000,
	leaf_calls: 6,
	recursion_depth: 1,
	compaction_threshold: 0.8,
	source_families: [
		"filesystem_text",
		"git_object",
		"git_worktree_diff",
		"tool_artifact",
		"mission_evidence",
		"mission_position",
		"prior_attempts",
		"structured_text",
		"live_tool_stream",
	],
};
/** Historical route quotas are available only by explicit application selection. */
export const LEGACY_ROUTE_CALIBRATION: KernelConfiguration["routes"] = {
	SAKSHAT: { execution: 3, ticks: 3, verification_reserve: 0 },
	MADHYAMA: { execution: 40, ticks: 12, verification_reserve: 6 },
	GAMBHIRA: { execution: 100, ticks: 40, verification_reserve: 15 },
};

export const DEFAULT_KERNEL_CONFIGURATION: KernelConfiguration = {
	version: "sandhana/1",
	calibration_profile: "STANDARD/1",
	avartana: DEFAULT_AVARTANA_CONFIGURATION,
	routes: {
		SAKSHAT: { execution: 256, ticks: 128, verification_reserve: 0 },
		MADHYAMA: { execution: 256, ticks: 128, verification_reserve: 0 },
		GAMBHIRA: { execution: 256, ticks: 128, verification_reserve: 0 },
	},
	resources: {
		preflight: 2,
		input_tokens: 500000,
		output_tokens: 64000,
		output_bytes: 32 * 1024 * 1024,
		artifact_bytes: 64 * 1024 * 1024,
		retrieval_bytes: 64 * 1024 * 1024,
		elapsed_ms: 30 * 60 * 1000,
		cost: 10,
		refinement: 2,
	},
	model: { response_tokens: 8192, input_overhead_bytes: 4096 },
	view: { tool_chars: 50000, position_chars: 8000, evidence_events: 16, recent_observations: 3 },
	artifact: { max_bytes: 8 * 1024 * 1024, retention_ms: null },
	stagnation: { diagnose: 4, stop: 7 },
	branches: { active: 3, depth: 2 },
	// Builds and other foreground commands can outlast two minutes. Keep a finite
	// shell backstop aligned with the default mission allowance; applications may narrow it.
	timeouts: { shell_ms: 30 * 60 * 1000, observation_ms: 30000 },
};

export function validateConfiguration(value: unknown): asserts value is KernelConfiguration {
	canonical(value);
	if (!Value.Check(KernelConfigurationSchema, value)) throw new Error("Invalid versioned kernel configuration");
	if (value.avartana?.source_families.some((family) => !Value.Check(SourceFamilySchema, family)))
		throw new Error("Unknown context source family");
	if (value.artifact.retention_ms !== null && !Number.isSafeInteger(Date.now() + value.artifact.retention_ms))
		throw new Error("Artifact retention deadline overflow");
	if (value.stagnation.stop <= value.stagnation.diagnose) throw new Error("Stagnation stop must follow diagnosis");
	for (const route of Object.values(value.routes))
		if (route.verification_reserve > route.execution) throw new Error("Verification reserve exceeds route ceiling");
}

/** Application defaults are copied and validated before dispatch. Repository text is never loaded here. */
export function resolveConfiguration(input?: unknown): KernelConfiguration {
	const result = structuredClone(DEFAULT_KERNEL_CONFIGURATION);
	if (input !== undefined) {
		canonical(input);
		if (!Value.Check(KernelConfigurationInputSchema, input))
			throw new Error("Invalid versioned kernel configuration input");
		if (input.calibration_profile) result.calibration_profile = input.calibration_profile;
		if (input.calibration_profile === "LEGACY/1") result.routes = structuredClone(LEGACY_ROUTE_CALIBRATION);
		for (const route of ["SAKSHAT", "MADHYAMA", "GAMBHIRA"] as const)
			Object.assign(result.routes[route], input.routes?.[route]);
		Object.assign(result.resources, input.resources);
		Object.assign(result.model, input.model);
		Object.assign(result.view, input.view);
		Object.assign(result.artifact, input.artifact);
		Object.assign(result.stagnation, input.stagnation);
		Object.assign(result.branches, input.branches);
		Object.assign(result.timeouts, input.timeouts);
		if (input.operations) result.operations = { ...input.operations };
		if (input.avartana) result.avartana = { ...DEFAULT_AVARTANA_CONFIGURATION, ...input.avartana };
	}
	validateConfiguration(result);
	return result;
}

export function routeBudget(
	configuration: KernelConfiguration,
	route: Route,
	applicationOverrides: Partial<ResourceCeilings> = {},
	userChange?: { overrides: BudgetChangeInput["ceilings"]; verification_reserve: number | null },
): { ceilings: ResourceCeilings; verification_reserve: number } {
	const selected = configuration.routes[route];
	const ceilings = {
		...configuration.resources,
		execution: selected.execution,
		ticks: selected.ticks,
		...applicationOverrides,
		...userChange?.overrides,
	};
	const verification_reserve = userChange?.verification_reserve ?? selected.verification_reserve;
	canonical(ceilings);
	if (!Value.Check(ResourceCeilingsSchema, ceilings) || verification_reserve > ceilings.execution)
		throw new Error("Invalid effective resource ceiling or verification reserve");
	return { ceilings, verification_reserve };
}
