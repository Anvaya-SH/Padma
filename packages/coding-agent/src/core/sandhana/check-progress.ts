import { resolve } from "node:path";
import { nodeTestCases } from "./acceptance.ts";
import { localCheck, processCommandPaths } from "./checks.ts";
import { inside } from "./code.ts";
import { observedProcessStates } from "./process-sources.ts";
import { digest, type MissionRecord, type MissionState, type RecordOf } from "./records.ts";
import type { MissionStore } from "./store.ts";
import { vitestCases } from "./vitest-results.ts";

interface CheckObservation {
	evidence: RecordOf<"EvidenceRecord">;
	observation: RecordOf<"EvidenceRecord">;
	result: "PASSED" | "FAILED";
	sources: Record<string, string | null>;
	adapter: string;
	cases: Map<string, "PASSED" | "FAILED" | "SKIPPED"> | null;
}

/** Repaired checks are observed source transitions, not new record IDs or repeated green output. */
export function repairedCheckProgress(
	store: MissionStore,
	state: MissionState,
	records: MissionRecord[],
): RecordOf<"CognitiveTick">["progress"] {
	const contract = store.get(state.mission_id, state.contract, "MissionContract");
	const root = contract.bindings
		.map((ref) => store.get(state.mission_id, ref, "TargetBinding"))
		.find((binding) => binding.canonical_path === binding.worktree_identity);
	if (!root) return [];
	const requirements = state.requirements
		.map((ref) => store.get(state.mission_id, ref, "Requirement"))
		.filter((requirement) => requirement.mandatory && requirement.status !== "SUPERSEDED");
	const declarations: { command: string; requirement: RecordOf<"Requirement"> | null }[] = [
		...contract.quality_obligations.flatMap((rule) =>
			rule.startsWith("PROCESS:") ? [{ command: rule.slice("PROCESS:".length), requirement: null }] : [],
		),
		...requirements.flatMap((requirement) =>
			requirement.rule === "PROCESS" && requirement.expected ? [{ command: requirement.expected, requirement }] : [],
		),
	];
	const operations = new Map(
		state.operations.map((ref) => {
			const operation = store.get(state.mission_id, ref, "OperationRecord");
			return [operation.operation_id, operation];
		}),
	);
	const facts: RecordOf<"CognitiveTick">["progress"] = [];
	for (const { command, requirement } of declarations) {
		const check = localCheck(command, root.worktree_identity);
		const targets = [
			...processCommandPaths(command),
			...(requirement ? [requirement] : requirements).flatMap((req) => [
				...(req.dependencies ?? []),
				...(req.target && req.target !== root.worktree_identity ? [req.target] : []),
			]),
		].map((path) => resolve(root.worktree_identity, path));
		const checks = new Map<string, CheckObservation>();
		for (const record of records) {
			if (
				record.record_type !== "EvidenceRecord" ||
				record.kind !== "VERIFICATION" ||
				record.provenance !== "KERNEL"
			)
				continue;
			const payload = record.payload;
			if (!payload || typeof payload !== "object" || Array.isArray(payload) || !("result" in payload)) continue;
			if (payload.result !== "PASSED" && payload.result !== "FAILED") continue;
			if (
				requirement
					? record.stage !== "pramana" ||
						!record.requirement_ids.includes(requirement.requirement_id) ||
						!("rule" in payload) ||
						payload.rule !== "PROCESS" ||
						!("target" in payload) ||
						payload.target !== requirement.target ||
						!("exact_command" in payload) ||
						payload.exact_command !== command
					: record.stage !== "pariskara" ||
						record.requirement_ids.length !== 0 ||
						!("rule" in payload) ||
						payload.rule !== "DECLARED_PROCESS_QUALITY" ||
						!("command" in payload) ||
						payload.command !== command
			)
				continue;
			try {
				const operation = record.operation_id ? operations.get(record.operation_id) : null;
				if (
					!operation ||
					!["CONFIRMED_COMPLETE", "FAILED"].includes(operation.status) ||
					record.sources.length !== 1
				)
					continue;
				const action = store.get(state.mission_id, operation.prepared_ref, "PreparedAction");
				const binding = store.get(state.mission_id, action.binding_ref, "TargetBinding");
				const observation = store.get(state.mission_id, record.sources[0], "EvidenceRecord");
				if (
					action.operation_class !== `SHELL:${command}` ||
					binding.workspace_id !== root.workspace_id ||
					binding.environment !== root.environment ||
					binding.repository_identity !== root.repository_identity ||
					binding.worktree_identity !== root.worktree_identity ||
					(requirement && binding.canonical_path !== requirement.target) ||
					!operation.result_refs.includes(observation.record_id) ||
					observation.operation_id !== operation.operation_id ||
					observation.target_generation !== record.target_generation ||
					observation.revision >= record.revision ||
					!observation.artifact_ref
				)
					continue;
				const sources = observedProcessStates(store, observation);
				if (!sources) continue;
				const raw: unknown = JSON.parse(store.artifact(state.mission_id, observation.artifact_ref).toString());
				if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("structuredContent" in raw)) continue;
				const result = raw.structuredContent;
				if (
					!result ||
					typeof result !== "object" ||
					!("exit_code" in result) ||
					typeof result.exit_code !== "number" ||
					!Number.isInteger(result.exit_code) ||
					!("output_complete" in result) ||
					result.output_complete !== true ||
					(payload.result === "PASSED"
						? result.exit_code !== 0 ||
							("isError" in raw && raw.isError === true) ||
							operation.status !== "CONFIRMED_COMPLETE"
						: result.exit_code === 0)
				)
					continue;
				let cases: CheckObservation["cases"] = null;
				const actual = observation.payload;
				const output =
					actual &&
					typeof actual === "object" &&
					"full_output_ref" in actual &&
					typeof actual.full_output_ref === "string"
						? store.artifact(state.mission_id, actual.full_output_ref).toString()
						: "content" in raw && Array.isArray(raw.content)
							? raw.content
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
				if (check?.runner === "NODE_TEST") {
					cases = nodeTestCases(output);
				} else if (check?.runner === "VITEST" && command.includes("--reporter=json")) {
					try {
						cases = vitestCases(output, check.targets);
					} catch {
						cases = null;
					}
				}
				const schema = store.get(state.mission_id, action.schema_ref, "RegisteredActionSchema");
				checks.set(operation.operation_id, {
					evidence: record,
					observation,
					result: payload.result,
					sources,
					adapter: digest({ tool: action.tool_id, version: schema.version }),
					cases,
				});
			} catch {
				// Missing or invalid raw observations cannot prove a repair.
			}
		}
		let previous: CheckObservation | null = null;
		for (const check of [...checks.values()].sort(
			(left, right) => left.observation.revision - right.observation.revision,
		)) {
			if (previous?.result === "FAILED" && check.result === "PASSED" && previous.adapter === check.adapter) {
				// A skipped failing case leaves its blocker unresolved; a later actual pass may still prove the repair.
				if (
					previous.cases &&
					![...previous.cases].some(([name, result]) => result === "FAILED" && check.cases?.get(name) === "PASSED")
				)
					continue;
				// Unchanged absence metadata preserves older file-digest keys; actual file/absence transitions remain.
				const previousSources = previous.sources;
				const before = Object.fromEntries(
					Object.entries(previousSources).filter(
						([path, value]) =>
							targets.some((target) => inside(target, path)) &&
							(value !== null || (Object.hasOwn(check.sources, path) && check.sources[path] !== null)),
					),
				);
				const after = Object.fromEntries(
					Object.entries(check.sources).filter(
						([path, value]) =>
							targets.some((target) => inside(target, path)) &&
							(value !== null || (Object.hasOwn(previousSources, path) && previousSources[path] !== null)),
					),
				);
				if (Object.keys(before).some((path) => Object.hasOwn(after, path) && before[path] !== after[path])) {
					const key = digest({
						kind: "CHECK_REPAIRED",
						command,
						requirement: requirement?.requirement_id ?? null,
						target: requirement?.target ?? root.canonical_path,
						workspace: root.workspace_id,
						environment: root.environment,
						adapter: check.adapter,
						before,
						after,
					});
					if (!facts.some((fact) => fact.key === key))
						facts.push({ key, evidence: [previous.evidence.record_id, check.evidence.record_id] });
				}
			}
			previous = check;
		}
	}
	return facts;
}
