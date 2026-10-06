import { dirname, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { localCheck } from "./checks.ts";
import { inside } from "./code.ts";
import { canonical, type MissionState, type RecordOf } from "./records.ts";
import type { MissionStore } from "./store.ts";
import { vitestCases } from "./vitest-results.ts";

export const BEHAVIOR_RULE = "CODE_BEHAVIOR_TESTS/1";
export const BEHAVIOR_PLAN_RULE = "CODE_BEHAVIOR_PLAN/1";
export const CoverageProposalSchema = Type.Object(
	{
		requirement_id: Type.String({ minLength: 1 }),
		command: Type.String({ minLength: 1, maxLength: 2000 }),
		case_names: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), {
			minItems: 1,
			maxItems: 8,
			uniqueItems: true,
		}),
		applicability: Type.Union([Type.Literal("SUPPORTED"), Type.Literal("INCONCLUSIVE")]),
		explanation: Type.String({ minLength: 40, maxLength: 1600 }),
		citations: Type.Array(
			Type.Object(
				{
					observation_id: Type.String({ minLength: 1 }),
					quote: Type.String({ minLength: 24, maxLength: 2000 }),
					role: Type.Union([Type.Literal("IMPLEMENTATION"), Type.Literal("TEST_ASSERTION")]),
					case_name: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
				},
				{ additionalProperties: false },
			),
			{ minItems: 2, maxItems: 12 },
		),
	},
	{ additionalProperties: false },
);
export type CoverageProposal = Static<typeof CoverageProposalSchema>;
export const CoverageResponseSchema = Type.Object(
	{ results: Type.Array(CoverageProposalSchema, { minItems: 1, maxItems: 16 }) },
	{ additionalProperties: false },
);
export const CoverageAssessmentSchema = Type.Object(
	{
		registered_rule: Type.Literal(BEHAVIOR_RULE),
		proposal: CoverageProposalSchema,
		model_usage_ref: Type.String({ minLength: 1 }),
		contract_ref: Type.String({ minLength: 1 }),
		intent_epoch: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);
export const BehaviorPlanSchema = Type.Object(
	{
		registered_rule: Type.Literal(BEHAVIOR_PLAN_RULE),
		proposal: CoverageProposalSchema,
		model_usage_ref: Type.String({ minLength: 1 }),
		contract_ref: Type.String({ minLength: 1 }),
		intent_epoch: Type.Integer({ minimum: 1 }),
		dependencies: Type.Record(Type.String(), Type.String()),
	},
	{ additionalProperties: false },
);

/** Flat Node TAP cases only. Missing summaries, suites, duplicate names and omitted cases are not passing proof. */
export function nodeTestCases(output: string): Map<string, "PASSED" | "FAILED" | "SKIPPED"> {
	if (output.length > 128000 || !/^TAP version 13\r?$/m.test(output))
		throw new Error("Missing bounded Node TAP result");
	const cases = new Map<string, "PASSED" | "FAILED" | "SKIPPED">();
	for (const match of output.matchAll(/^(ok|not ok) (\d+) - ([^\r\n]+)\r?$/gm)) {
		const name = match[3].replace(/\s+# (?:SKIP|TODO).*$/i, "");
		if (cases.has(name) || Number(match[2]) !== cases.size + 1) throw new Error("Ambiguous test case identity");
		cases.set(name, /\s+# (?:SKIP|TODO)\b/i.test(match[3]) ? "SKIPPED" : match[1] === "ok" ? "PASSED" : "FAILED");
	}
	const total = /^# tests (\d+)\r?$/m.exec(output);
	const failed = /^# fail (\d+)\r?$/m.exec(output);
	if (
		!total ||
		!failed ||
		cases.size === 0 ||
		cases.size !== Number(total[1]) ||
		!new RegExp(`^1\\.\\.${cases.size}\\r?$`, "m").test(output)
	)
		throw new Error("No complete flat test case result; suites require a supported reporter");
	if ([...cases.values()].filter((result) => result === "FAILED").length !== Number(failed[1]))
		throw new Error("Inconsistent test summary");
	return cases;
}

function rawResult(
	store: MissionStore,
	state: MissionState,
	observation: RecordOf<"EvidenceRecord">,
): Record<string, unknown> {
	if (
		observation.kind !== "OBSERVATION" ||
		observation.provenance !== "ADAPTER" ||
		observation.stage !== "phala" ||
		!observation.artifact_ref
	)
		throw new Error("Coverage needs actual retained adapter results");
	const operation = state.operations
		.map((id) => store.get(state.mission_id, id, "OperationRecord"))
		.find((op) => op.operation_id === observation.operation_id);
	if (
		!operation ||
		!operation.result_refs.includes(observation.record_id) ||
		!["CONFIRMED_COMPLETE", "FAILED"].includes(operation.status)
	)
		throw new Error("Coverage source is not a settled governed result");
	const value: unknown = JSON.parse(store.artifact(state.mission_id, observation.artifact_ref).toString());
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid adapter result");
	return value as Record<string, unknown>;
}

function rawText(result: Record<string, unknown>): string {
	const parts = result.content;
	return Array.isArray(parts)
		? parts
				.filter(
					(part): part is { type: "text"; text: string } =>
						!!part &&
						typeof part === "object" &&
						"type" in part &&
						part.type === "text" &&
						"text" in part &&
						typeof part.text === "string",
				)
				.map((part) => part.text)
				.join("\n")
		: "";
}

function processOutput(
	store: MissionStore,
	state: MissionState,
	facts: Record<string, unknown>,
	result: Record<string, unknown>,
): string {
	if (typeof facts.full_output_ref === "string")
		return store.artifact(state.mission_id, facts.full_output_ref).toString();
	const structured = result.structuredContent;
	if (
		structured &&
		typeof structured === "object" &&
		"output" in structured &&
		typeof structured.output === "string"
	) {
		if (
			("truncated" in structured && structured.truncated === true) ||
			("output_complete" in structured && structured.output_complete === false)
		)
			throw new Error("Incomplete process output cannot establish named test results");
		return structured.output;
	}
	return rawText(result);
}

export interface BehaviorEvidence {
	result: "PASSED" | "FAILED" | "INCONCLUSIVE";
	operation_id: string;
	generation: string;
	dependencies: Record<string, string>;
	sources: string[];
	implementation_targets: string[];
}

/** Retained inputs can justify one coverage question. They do not establish semantic applicability or passing proof. */
export function behaviorAssessmentSources(
	store: MissionStore,
	state: MissionState,
	requirements: RecordOf<"Requirement">[],
): {
	checks: string[];
	sources: string[];
	dependencies: Record<string, string>;
	targets: { path: string; generation: string }[];
} {
	const operations = state.operations.map((ref) => store.get(state.mission_id, ref, "OperationRecord"));
	const history = store.records(state.mission_id);
	const checks: string[] = [];
	const sources = new Set<string>();
	const dependencies: Record<string, string> = {};
	const targets: { path: string; generation: string }[] = [];
	const seen = new Set<string>();
	for (const operation of operations.toReversed()) {
		const action = store.get(state.mission_id, operation.prepared_ref, "PreparedAction");
		if (!action.operation_class.startsWith("SHELL:") || seen.has(action.operation_class)) continue;
		seen.add(action.operation_class);
		try {
			const binding = store.get(state.mission_id, action.binding_ref, "TargetBinding");
			if (!requirements.some((requirement) => requirement.target === binding.canonical_path)) continue;
			const check = localCheck(action.operation_class.slice("SHELL:".length), binding.worktree_identity);
			if (!check || (check.runner === "VITEST" && !action.operation_class.split(/\s+/).includes("--reporter=json")))
				continue;
			const observation = store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
			const process = rawResult(store, state, observation);
			const facts = observation.payload as Record<string, unknown>;
			if (
				facts?.dependencies_unchanged !== true ||
				!observation.target_generation ||
				!facts.dependencies ||
				typeof facts.dependencies !== "object" ||
				Array.isArray(facts.dependencies)
			)
				continue;
			const generations = facts.dependencies as Record<string, string>;
			if (Object.values(generations).some((generation) => typeof generation !== "string")) continue;
			const output = processOutput(store, state, facts, process);
			if (check.runner === "NODE_TEST") nodeTestCases(output);
			else vitestCases(output, check.targets);
			const reads: { path: string; ref: string; changed: boolean }[] = [];
			for (const read of operations) {
				const prepared = store.get(state.mission_id, read.prepared_ref, "PreparedAction");
				const args = prepared.arguments as Record<string, unknown>;
				if (
					prepared.operation_class !== "READ" ||
					args.offset !== undefined ||
					args.limit !== undefined ||
					read.status !== "CONFIRMED_COMPLETE"
				)
					continue;
				const target = store.get(state.mission_id, prepared.binding_ref, "TargetBinding");
				if (target.workspace_id !== binding.workspace_id || !inside(binding.canonical_path, target.canonical_path))
					continue;
				const source = store.get(state.mission_id, read.result_refs[0], "EvidenceRecord");
				const sourceFacts = source.payload as Record<string, unknown>;
				if (
					sourceFacts?.target_unchanged !== true ||
					generations[target.canonical_path] !== source.target_generation ||
					rawResult(store, state, source).isError === true
				)
					continue;
				const candidate = history.findLast(
					(record) =>
						record.record_type === "Artifact" &&
						record.purpose === "DELIVERED" &&
						record.target === target.canonical_path &&
						record.generation === source.target_generation,
				);
				const changed =
					!!candidate &&
					state.checkpoints.some(
						(ref) => store.get(state.mission_id, ref, "CheckpointRecord").artifact_ref === candidate.record_id,
					);
				if (changed) store.artifact(state.mission_id, candidate!.record_id);
				reads.push({ path: target.canonical_path, ref: source.record_id, changed });
			}
			if (
				!reads.some((read) => read.changed && !check.targets.includes(read.path)) ||
				!check.targets.some((path) => reads.some((read) => read.path === path))
			)
				continue;
			checks.push(observation.record_id);
			sources.add(observation.record_id);
			for (const read of reads) sources.add(read.ref);
			Object.assign(dependencies, generations);
			targets.push({ path: binding.canonical_path, generation: observation.target_generation });
			if (checks.length === 16) break;
		} catch {
			// Missing or incomplete retained inputs do not justify another provider request.
		}
	}
	return { checks, sources: [...sources], dependencies, targets };
}

/** Coverage is a bounded model interpretation. This rule separately requires real cases, current source links and a restorable changed artifact. */
export function behaviorPlanningSources(
	store: MissionStore,
	state: MissionState,
	requirements: RecordOf<"Requirement">[],
): {
	checks: string[];
	sources: string[];
	dependencies: Record<string, string>;
	targets: { path: string; generation: string }[];
} {
	const sources: string[] = [];
	const dependencies: Record<string, string> = {};
	const changed = new Set<string>();
	const tests: { path: string; text: string }[] = [];
	for (const ref of state.operations.toReversed()) {
		const operation = store.get(state.mission_id, ref, "OperationRecord");
		const action = store.get(state.mission_id, operation.prepared_ref, "PreparedAction");
		const args = action.arguments as Record<string, unknown>;
		if (
			operation.status !== "CONFIRMED_COMPLETE" ||
			action.operation_class !== "READ" ||
			args.offset !== undefined ||
			args.limit !== undefined
		)
			continue;
		const binding = store.get(state.mission_id, action.binding_ref, "TargetBinding");
		if (
			binding.canonical_path in dependencies ||
			!requirements.some((req) => req.target && inside(req.target, binding.canonical_path))
		)
			continue;
		try {
			const source = store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
			const result = rawResult(store, state, source);
			const facts = source.payload as Record<string, unknown>;
			if (facts.target_unchanged !== true || result.isError === true || !source.target_generation) continue;
			dependencies[binding.canonical_path] = source.target_generation;
			sources.push(source.record_id);
			if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(binding.canonical_path))
				tests.push({ path: binding.canonical_path, text: rawText(result) });
			if (
				state.checkpoints.some((id) => {
					const point = store.get(state.mission_id, id, "CheckpointRecord");
					const artifact = store.get(state.mission_id, point.artifact_ref, "Artifact");
					return (
						artifact.purpose === "DELIVERED" &&
						artifact.target === binding.canonical_path &&
						artifact.generation === source.target_generation
					);
				})
			)
				changed.add(binding.canonical_path);
		} catch {
			/* Incomplete source capture cannot justify a planning request. */
		}
	}
	if (
		!tests.some((test) =>
			[...test.text.matchAll(/(?:require\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:from|import)\s*['"]([^'"]+)['"])/g)].some(
				(match) => changed.has(resolve(dirname(test.path), match[1] ?? match[2])),
			),
		)
	)
		return { checks: [], sources: [], dependencies: {}, targets: [] };
	return { checks: [], sources, dependencies, targets: [] };
}

export function behaviorEvidence(
	store: MissionStore,
	state: MissionState,
	requirement: RecordOf<"Requirement">,
	proposal: CoverageProposal,
): BehaviorEvidence {
	if (
		requirement.rule !== "SEMANTIC" ||
		requirement.status === "SUPERSEDED" ||
		requirement.requirement_id !== proposal.requirement_id ||
		!requirement.target
	)
		throw new Error("Coverage does not match an active semantic obligation");
	const operation = state.operations
		.map((id) => store.get(state.mission_id, id, "OperationRecord"))
		.findLast(
			(op) =>
				store.get(state.mission_id, op.prepared_ref, "PreparedAction").operation_class ===
				`SHELL:${proposal.command}`,
		);
	if (!operation || !operation.result_refs.length) throw new Error("Named check has not actually run");
	const action = store.get(state.mission_id, operation.prepared_ref, "PreparedAction");
	const binding = store.get(state.mission_id, action.binding_ref, "TargetBinding");
	const check = localCheck(proposal.command, binding.worktree_identity);
	if (
		!check ||
		binding.canonical_path !== requirement.target ||
		(check.runner === "VITEST" && !proposal.command.split(/\s+/).includes("--reporter=json"))
	)
		throw new Error("Behavior rule requires a scoped named Node TAP or Vitest JSON test run");
	const observation = store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
	const process = rawResult(store, state, observation);
	const facts = observation.payload as Record<string, unknown>;
	if (
		!facts ||
		facts.dependencies_unchanged !== true ||
		!facts.dependencies ||
		typeof facts.dependencies !== "object" ||
		Array.isArray(facts.dependencies) ||
		!observation.target_generation
	)
		throw new Error("Check dependency generations are missing or changed during execution");
	const dependencies = facts.dependencies as Record<string, string>;
	if (Object.values(dependencies).some((value) => typeof value !== "string"))
		throw new Error("Invalid dependency vector");
	const output = processOutput(store, state, facts, process);
	const cases = check.runner === "NODE_TEST" ? nodeTestCases(output) : vitestCases(output, check.targets);
	if (proposal.case_names.some((name) => !cases.has(name))) throw new Error("Named behavioral cases are missing");
	const citations = behaviorCitations(store, state, requirement, proposal, dependencies, binding, check);
	const structured = process.structuredContent;
	const zeroExit =
		structured && typeof structured === "object" && "exit_code" in structured && structured.exit_code === 0;
	const selected = proposal.case_names.map((name) => cases.get(name)!);
	return {
		result:
			proposal.applicability !== "SUPPORTED"
				? "INCONCLUSIVE"
				: selected.includes("FAILED")
					? "FAILED"
					: selected.every((result) => result === "PASSED") &&
							zeroExit &&
							process.isError !== true &&
							operation.status === "CONFIRMED_COMPLETE"
						? "PASSED"
						: "INCONCLUSIVE",
		operation_id: operation.operation_id,
		generation: observation.target_generation,
		dependencies,
		sources: [...new Set([observation.record_id, ...citations.sources])],
		implementation_targets: citations.implementation_targets,
	};
}

function behaviorCitations(
	store: MissionStore,
	state: MissionState,
	requirement: RecordOf<"Requirement">,
	proposal: CoverageProposal,
	dependencies: Record<string, string>,
	binding: RecordOf<"TargetBinding">,
	check: { targets: string[] },
): { sources: string[]; implementation_targets: string[] } {
	if (!requirement.target) throw new Error("Behavioral obligation needs a target");
	const assertions = new Map<string, { path: string; text: string; quote: string }>();
	const implementations: string[] = [];
	const sources: string[] = [];
	for (const citation of proposal.citations) {
		const source = store.get(state.mission_id, citation.observation_id, "EvidenceRecord");
		const result = rawResult(store, state, source);
		const op = state.operations
			.map((id) => store.get(state.mission_id, id, "OperationRecord"))
			.find((value) => value.operation_id === source.operation_id)!;
		const prepared = store.get(state.mission_id, op.prepared_ref, "PreparedAction");
		const target = store.get(state.mission_id, prepared.binding_ref, "TargetBinding");
		const args = prepared.arguments as Record<string, unknown>;
		const sourceFacts = source.payload as Record<string, unknown>;
		if (
			prepared.operation_class !== "READ" ||
			args.offset !== undefined ||
			args.limit !== undefined ||
			result.isError === true ||
			sourceFacts?.target_unchanged !== true ||
			!inside(requirement.target, target.canonical_path) ||
			target.workspace_id !== binding.workspace_id ||
			dependencies[target.canonical_path] !== source.target_generation
		)
			throw new Error("Citation is not a complete read of the checked source generation");
		const text = rawText(result);
		if (!text.includes(citation.quote)) throw new Error("Citation quote is absent from actual source bytes");
		sources.push(source.record_id);
		if (citation.role === "TEST_ASSERTION") {
			const definition = /^\s*(?:test|it)(?:\.\w+)?\s*\(\s*(['"])([^'"]+)\1/.exec(citation.quote);
			if (
				!citation.case_name ||
				!proposal.case_names.includes(citation.case_name) ||
				!check.targets.includes(target.canonical_path) ||
				definition?.[2] !== citation.case_name ||
				[...citation.quote.matchAll(/\b(?:test|it)(?:\.\w+)?\s*\(/g)].length !== 1 ||
				!/\b(?:assert(?:\.[a-zA-Z]+)?|expect)\s*\(/.test(citation.quote)
			)
				throw new Error("Case needs an assertion citation in an executed test file");
			assertions.set(citation.case_name, { path: target.canonical_path, text, quote: citation.quote });
		} else {
			const artifact = store
				.records(state.mission_id)
				.findLast(
					(record) =>
						record.record_type === "Artifact" &&
						record.purpose === "DELIVERED" &&
						record.target === target.canonical_path &&
						record.generation === source.target_generation,
				);
			if (
				!artifact ||
				artifact.record_type !== "Artifact" ||
				!state.checkpoints.some(
					(ref) => store.get(state.mission_id, ref, "CheckpointRecord").artifact_ref === artifact.record_id,
				)
			)
				throw new Error("Implementation citation needs a real recoverable changed candidate");
			store.artifact(state.mission_id, artifact.record_id);
			implementations.push(target.canonical_path);
		}
	}
	if (!implementations.length || proposal.case_names.some((name) => !assertions.has(name)))
		throw new Error("Named behavioral cases or applicable implementation proof are missing");
	for (const assertion of assertions.values()) {
		const imports = [
			...assertion.text.matchAll(/(?:require\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:from|import)\s*['"]([^'"]+)['"])/g),
		].map((match) => resolve(dirname(assertion.path), match[1] ?? match[2]));
		if (!implementations.some((path) => imports.includes(path)))
			throw new Error("Test does not directly import the cited changed implementation");
		const aliases: string[] = [];
		for (const match of assertion.text.matchAll(
			/(?:import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\))/g,
		))
			if (implementations.includes(resolve(dirname(assertion.path), match[2] ?? match[4])))
				aliases.push(match[1] ?? match[3]);
		for (const match of assertion.text.matchAll(
			/(?:import|const|let|var)\s+\{([^}]+)\}\s*(?:from\s*|=\s*require\s*\(\s*)['"]([^'"]+)['"]/g,
		))
			if (implementations.includes(resolve(dirname(assertion.path), match[2])))
				aliases.push(
					...match[1].split(",").map(
						(name) =>
							name
								.trim()
								.split(/\s+as\s+|\s*:\s*/)
								.at(-1)!,
					),
				);
		const asserted = assertion.quote.slice(assertion.quote.search(/\b(?:assert(?:\.[a-zA-Z]+)?|expect)\s*\(/));
		if (
			!aliases.some(
				(alias) =>
					/^[A-Za-z_$][\w$]*$/.test(alias) &&
					new RegExp(`\\b${alias.replace(/\$/g, "\\$")}\\s*(?:\\(|\\.)`).test(asserted),
			)
		)
			throw new Error("Assertion does not exercise an imported implementation binding");
	}
	return { sources: [...new Set(sources)], implementation_targets: [...new Set(implementations)] };
}

/** A source-bound first check is an admission plan; it carries no test result or completion verdict. */
export function behaviorPlanEvidence(
	store: MissionStore,
	state: MissionState,
	requirement: RecordOf<"Requirement">,
	proposal: CoverageProposal,
): { sources: string[]; dependencies: Record<string, string>; implementation_targets: string[] } {
	if (
		requirement.rule !== "SEMANTIC" ||
		requirement.status === "SUPERSEDED" ||
		requirement.requirement_id !== proposal.requirement_id ||
		!requirement.target ||
		proposal.applicability !== "SUPPORTED"
	)
		throw new Error("Check plan needs an active supported behavioral obligation");
	const dependencies: Record<string, string> = {};
	let binding: RecordOf<"TargetBinding"> | undefined;
	for (const citation of proposal.citations) {
		const source = store.get(state.mission_id, citation.observation_id, "EvidenceRecord");
		const operation = state.operations
			.map((ref) => store.get(state.mission_id, ref, "OperationRecord"))
			.find((op) => op.operation_id === source.operation_id);
		if (!operation || !source.target_generation) throw new Error("Plan lacks an actual source observation");
		const action = store.get(state.mission_id, operation.prepared_ref, "PreparedAction");
		const target = store.get(state.mission_id, action.binding_ref, "TargetBinding");
		if (dependencies[target.canonical_path] && dependencies[target.canonical_path] !== source.target_generation)
			throw new Error("Plan cites conflicting source generations");
		dependencies[target.canonical_path] = source.target_generation;
		binding ??= target;
	}
	if (!binding || binding.worktree_identity !== requirement.target)
		throw new Error("Behavioral check plan must bind the obligation's workspace");
	const check = localCheck(proposal.command, binding.worktree_identity);
	if (!check || (check.runner === "VITEST" && !proposal.command.split(/\s+/).includes("--reporter=json")))
		throw new Error("Plan requires a bounded named Node TAP or Vitest JSON check");
	const citations = behaviorCitations(store, state, requirement, proposal, dependencies, binding, check);
	return { ...citations, dependencies };
}

export function validateBehaviorPlan(
	store: MissionStore,
	state: MissionState,
	record: RecordOf<"EvidenceRecord">,
): void {
	if (
		!Value.Check(BehaviorPlanSchema, record.payload) ||
		record.kind !== "INTERPRETATION" ||
		record.provenance !== "MODEL" ||
		record.stage !== "pramana" ||
		record.operation_id !== null ||
		record.target_generation !== null
	)
		throw new Error("Invalid behavioral check plan");
	const data = record.payload;
	const requirement = state.requirements
		.map((ref) => store.get(state.mission_id, ref, "Requirement"))
		.find((req) => req.requirement_id === data.proposal.requirement_id);
	const usage = store.get(state.mission_id, data.model_usage_ref, "BudgetReservation");
	if (
		!requirement ||
		store.get(state.mission_id, data.contract_ref, "MissionContract").command_spec_ref !== state.command ||
		data.intent_epoch !== (state.intent_epoch ?? 1) ||
		!state.reservations.includes(usage.record_id) ||
		!usage.owner_operation_id.startsWith("model:") ||
		usage.state !== "RECONCILED" ||
		!usage.actual ||
		usage.actual.input_tokens === null ||
		usage.actual.output_tokens === null
	)
		throw new Error("Plan lacks current intent and settled model usage");
	const proof = behaviorPlanEvidence(store, state, requirement, data.proposal);
	if (
		canonical(proof.sources) !== canonical(record.sources) ||
		canonical(proof.dependencies) !== canonical(data.dependencies) ||
		canonical(record.requirement_ids) !== canonical([requirement.requirement_id])
	)
		throw new Error("Check plan does not match retained source evidence");
}

export function validateBehaviorVerification(
	store: MissionStore,
	state: MissionState,
	requirement: RecordOf<"Requirement">,
	record: RecordOf<"EvidenceRecord">,
): void {
	const payload = record.payload as Record<string, unknown>;
	if (
		record.provenance !== "KERNEL" ||
		payload?.registered_rule !== BEHAVIOR_RULE ||
		typeof payload.assessment_ref !== "string"
	)
		throw new Error("Semantic verification needs the registered behavior rule");
	const assessment = store.get(state.mission_id, payload.assessment_ref, "EvidenceRecord");
	if (
		assessment.kind !== "INTERPRETATION" ||
		assessment.provenance !== "MODEL" ||
		!Value.Check(CoverageAssessmentSchema, assessment.payload)
	)
		throw new Error("Coverage assessment is not a bounded model interpretation");
	const data = assessment.payload;
	const usage = store.get(state.mission_id, data.model_usage_ref, "BudgetReservation");
	const contract = store.get(state.mission_id, data.contract_ref, "MissionContract");
	if (
		!state.reservations.includes(usage.record_id) ||
		usage.state !== "RECONCILED" ||
		!usage.owner_operation_id.startsWith("model:") ||
		!usage.actual ||
		usage.actual.input_tokens === null ||
		usage.actual.output_tokens === null ||
		contract.command_spec_ref !== state.command ||
		data.intent_epoch !== (state.intent_epoch ?? 1)
	)
		throw new Error("Coverage lacks settled model usage or current intent");
	const evidence = behaviorEvidence(store, state, requirement, data.proposal);
	if (
		payload.rule !== "SEMANTIC" ||
		payload.result !== evidence.result ||
		record.operation_id !== evidence.operation_id ||
		record.target_generation !== evidence.generation ||
		canonical(payload.case_names) !== canonical(data.proposal.case_names) ||
		canonical(payload.dependencies) !== canonical(evidence.dependencies) ||
		canonical(record.sources) !== canonical(evidence.sources) ||
		canonical(assessment.sources) !== canonical(evidence.sources) ||
		!assessment.requirement_ids.includes(requirement.requirement_id)
	)
		throw new Error("Semantic verdict does not match actual cited check evidence");
}

/** Prior coverage establishes which work is a check or a specific repair, never that a changed candidate passes. */
export function protectedBehaviorWork(
	store: MissionStore,
	state: MissionState,
	action: RecordOf<"PreparedAction">,
	repairReport: RecordOf<"VerificationReport"> | null,
	currentDependencies: (dependencies: Record<string, string>) => boolean,
): boolean {
	const target = store.get(state.mission_id, action.binding_ref, "TargetBinding").canonical_path;
	const args = action.arguments as Record<string, unknown>;
	if (action.operation_class.startsWith("SHELL:")) {
		for (const record of store.records(state.mission_id).toReversed()) {
			if (record.record_type !== "EvidenceRecord" || !Value.Check(BehaviorPlanSchema, record.payload)) continue;
			try {
				validateBehaviorPlan(store, state, record);
				if (!currentDependencies(record.payload.dependencies)) continue;
				const proposal = record.payload.proposal;
				const requirement = state.requirements
					.map((ref) => store.get(state.mission_id, ref, "Requirement"))
					.find((req) => req.requirement_id === proposal.requirement_id)!;
				if (target === requirement.target && action.operation_class === `SHELL:${proposal.command}`) return true;
			} catch {
				/* An invalid or superseded plan cannot spend protected capacity. */
			}
		}
	}
	for (const ref of state.requirements) {
		const requirement = store.get(state.mission_id, ref, "Requirement");
		if (requirement.rule !== "SEMANTIC" || requirement.status === "SUPERSEDED") continue;
		for (const evidenceRef of requirement.evidence) {
			try {
				const evidence = store.get(state.mission_id, evidenceRef, "EvidenceRecord");
				validateBehaviorVerification(store, state, requirement, evidence);
				const payload = evidence.payload as { assessment_ref: string };
				const assessment = store.get(state.mission_id, payload.assessment_ref, "EvidenceRecord");
				if (!Value.Check(CoverageAssessmentSchema, assessment.payload)) continue;
				const proposal = assessment.payload.proposal;
				if (proposal.applicability !== "SUPPORTED") continue;
				if (target === requirement.target && action.operation_class === `SHELL:${proposal.command}`) return true;
				const completeRead =
					action.operation_class === "READ" && args.offset === undefined && args.limit === undefined;
				const specificRepair =
					action.operation_class === "EDIT" &&
					repairReport?.results.some(
						(result) =>
							result.requirement_id === requirement.requirement_id &&
							result.result === "FAILED" &&
							result.evidence.includes(evidenceRef),
					);
				if (!completeRead && !specificRepair) continue;
				for (const citation of proposal.citations) {
					if (specificRepair && citation.role !== "IMPLEMENTATION") continue;
					const source = store.get(state.mission_id, citation.observation_id, "EvidenceRecord");
					const operation = state.operations
						.map((id) => store.get(state.mission_id, id, "OperationRecord"))
						.find((op) => op.operation_id === source.operation_id)!;
					const sourceAction = store.get(state.mission_id, operation.prepared_ref, "PreparedAction");
					if (store.get(state.mission_id, sourceAction.binding_ref, "TargetBinding").canonical_path === target)
						return true;
				}
			} catch {
				// Missing, superseded or incompatible coverage cannot classify reserve spending.
			}
		}
	}
	return false;
}
