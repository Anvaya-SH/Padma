import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { JsonObject } from "@anvaya.sh/padma-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { observeTarget, routeFor, signalsForExact } from "./code.ts";
import { resolveConfiguration, routeBudget, validateConfiguration } from "./configuration.ts";
import {
	canonical,
	type KernelConfiguration,
	type MissionRecord,
	type MissionState,
	makeRecord,
	POLICY_VERSION,
	type RecordOf,
	ResourceCeilingsSchema,
	type Resources,
	type Route,
	resources,
} from "./records.ts";

const obligation = Type.Object(
	{
		text: Type.String(),
		rule: Type.Union([
			Type.Literal("CONTENT"),
			Type.Literal("PROCESS"),
			Type.Literal("SEMANTIC"),
			Type.Literal("SUBJECTIVE"),
		]),
		target: Type.String(),
		expected: Type.Optional(Type.String()),
		dependencies: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);
export const StructuredCommandSchema = Type.Object(
	{
		objective: Type.String(),
		requirements: Type.Array(obligation, { minItems: 1 }),
		allow_edits: Type.Optional(Type.Boolean()),
		shell_commands: Type.Optional(Type.Array(Type.String())),
		quality_checks: Type.Optional(Type.Array(Type.String())),
		prohibitions: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);
export type StructuredCommand = Static<typeof StructuredCommandSchema>;
export interface CompiledCommand {
	state: MissionState;
	records: MissionRecord[];
	exact: { tool: "read" | "ls" | "status"; path: string } | null;
	shell_commands: string[];
	quality_checks: string[];
	reconciliation?: { operation_id: string; path: string };
	authorized_action?: { tool: string; arguments: JsonObject };
}
export interface ShellRequest {
	command: string;
	cwd?: string;
}
function naturalShellRequest(text: string): ShellRequest {
	let quote: string | null = null;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quote && (char === "\\" || char === "`") && text[index + 1] === quote) {
			index++;
			continue;
		}
		if (quote) {
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			continue;
		}
		if (/^\s+for me\??\.?$/i.test(text.slice(index))) return { command: text.slice(0, index).trim() };
		const suffix = /^\s+in\s+(?:the\s+)?(?:dir|directory|folder)\s+([\s\S]+)$/i.exec(text.slice(index));
		if (!suffix) continue;
		let cwd = suffix[1].trim();
		if (/^(?:"[^"]+"|'[^']+'|`[^`]+`)$/.test(cwd)) cwd = cwd.slice(1, -1);
		return { command: text.slice(0, index).trim(), cwd };
	}
	return { command: text.trim() };
}
export function cleanNaturalShellCommand(command: string): string {
	return naturalShellRequest(command).command;
}
/**
 * Split a leading `cd <dir> && <command>` working-directory selection from a
 * shell command. Returns null unless the whole string is exactly one cd prefix
 * followed by `&&` and a non-empty remainder. Quoted dirs and `cd /d` (cmd.exe)
 * are accepted; anything else is left untouched so grant matching stays exact.
 */
export function splitLeadingCd(command: string): { dir: string; command: string } | null {
	const match = /^\s*cd(?:\s+\/d)?\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s&|;]+))\s*&&\s*([\s\S]+?)\s*$/.exec(command);
	if (!match) return null;
	const dir = match[1] ?? match[2] ?? match[3];
	const inner = match[4];
	if (!dir || !inner || /[&|;]/.test(dir) || /^\s*cd(?:\s+\/d)?\s+/i.test(inner)) return null;
	return { dir, command: inner };
}
export function extractShellRequests(instruction: string, structured?: StructuredCommand): ShellRequest[] {
	// Structured fields and typed commands are exact authority boundaries. Their
	// contents may mention other commands as data; never parse them for grants.
	if (structured) return [...new Set(structured.shell_commands ?? [])].map((command) => ({ command }));
	const text = instruction.trimStart();
	if (/^run:\s*\S/i.test(text)) return [{ command: text.slice(4).trimStart() }];
	if (/^execute:\s*\S/i.test(text)) return [{ command: text.slice(8).trimStart() }];
	const candidates: { command: string; cwd?: string; start: number; end: number }[] = [];
	for (const match of instruction.matchAll(/\b(?:run|execute)\s+`([^`]+)`/gi))
		candidates.push({ command: match[1], start: match.index, end: match.index + match[0].length });

	const explicit =
		/(?:^|[.;!?]\s+|,\s+)(?:please\s+)?(?:can you\s+)?(?:run|execute)(?:\s+(?:a|the))?(?:\s+(?:shell|terminal|bash))?\s+command[:\s]+(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`|([^\n,;]+))/gi;
	for (const match of instruction.matchAll(explicit)) {
		const command = match[1] ?? match[2] ?? match[3];
		const request = command === undefined && match[4] ? naturalShellRequest(match[4]) : { command };
		if (request.command)
			candidates.push({
				...request,
				command: request.command,
				start: match.index,
				end: match.index + match[0].length,
			});
	}

	const direct =
		/(?:^|[.;!?]\s+|,\s+)(?:please\s+)?(?:can you\s+)?(?:run|execute)\s+(?:"([^"\n]+)"|'([^'\n]+)'|((?:python|python3|node|npm|npx|pytest|cargo|go|dotnet|bash|sh|git)\b[^\n,;]+))/gi;
	for (const match of instruction.matchAll(direct)) {
		const command = match[1] ?? match[2];
		const request = command === undefined && match[3] ? naturalShellRequest(match[3]) : { command };
		if (request.command)
			candidates.push({
				...request,
				command: request.command,
				start: match.index,
				end: match.index + match[0].length,
			});
	}

	// An outer literal wins over command-like text inside it. Overlapping
	// recognizers cannot mint a second grant from quoted data.
	const requests = new Map<string, ShellRequest>();
	let consumed = -1;
	for (const candidate of candidates.sort((a, b) => a.start - b.start || b.end - a.end)) {
		if (candidate.start < consumed) continue;
		consumed = candidate.end;
		const remaining = instruction.slice(candidate.end);
		const outside = /^\s+in\s+(?:the\s+)?(?:dir|directory|folder)\s+/i.test(remaining)
			? naturalShellRequest(`literal${remaining}`).cwd
			: undefined;
		if (outside !== undefined) consumed = instruction.length;
		const request = { command: candidate.command, cwd: candidate.cwd ?? outside };
		if (candidate.command.trim()) requests.set(canonical([request.command, request.cwd ?? null]), request);
	}
	return [...requests.values()];
}
export function extractShellCommands(instruction: string, structured?: StructuredCommand): string[] {
	return [...new Set(extractShellRequests(instruction, structured).map((request) => request.command))];
}

/** Syntax recognition only; binding, registration and authority still belong to the kernel. */
export function parseExactCommand(instruction: string): CompiledCommand["exact"] {
	// One exact literal target. Additional verbs, globs and described targets intentionally do not match.
	const match =
		/^(?:please\s+)?(read|list|status)(?:\s+file|\s+directory|\s+every entry directly inside)?\s+(?:"([^"\n]+)"|`([^`\n]+)`|([^\s*?]+))\s*(?:and show its contents\.?|and show the contents\.?)?\s*$/i.exec(
			instruction,
		);
	return match
		? {
				tool: ({ read: "read", list: "ls", status: "status" } as const)[
					match[1].toLowerCase() as "read" | "list" | "status"
				],
				path: match[2] ?? match[3] ?? match[4],
			}
		: null;
}

export function ceilings(route: Route): Resources {
	return routeBudget(resolveConfiguration(), route).ceilings;
}
export function compile(
	instruction: string,
	cwd: string,
	session: string,
	source: "USER" | "EXTENSION" = "USER",
	configured?: Partial<Resources>,
	structuralEligible: (tool: "read" | "ls" | "status") => boolean = () => true,
	configuration: KernelConfiguration = resolveConfiguration(),
): CompiledCommand {
	validateConfiguration(configuration);
	if (configured !== undefined) canonical(configured);
	const mission = randomUUID();
	const commandId = randomUUID();
	const commandRef = randomUUID();
	const root = realpathSync(cwd);
	let structured: StructuredCommand | undefined;
	if (instruction.startsWith("padma: ")) {
		const parsed: unknown = JSON.parse(instruction.slice(7));
		if (!Value.Check(StructuredCommandSchema, parsed)) throw new Error("Invalid structured Padma Code command");
		structured = parsed;
	}
	const exact = parseExactCommand(instruction);
	const signals = signalsForExact(exact !== null && structuralEligible(exact.tool));
	const route = routeFor(signals);
	const prohibitions =
		structured?.prohibitions ??
		(/\b(?:do not|don't|never|without)\s+(?:edit|write|modify|change)\b/i.test(instruction)
			? ["No workspace mutations"]
			: []);
	const editing =
		source === "USER" &&
		prohibitions.length === 0 &&
		(structured?.allow_edits === true ||
			(!structured &&
				/^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:fix|implement|edit|write|create|add|update|refactor|repair|change|replace|modify|remove|delete|set|make|adjust|patch|rewrite|optimize|format)\b/i.test(
					instruction,
				)));
	const shellRequests = extractShellRequests(instruction, structured).map((request) => ({
		command: request.command,
		cwd: observeTarget(root, request.cwd ?? ".", mission, 1, session, undefined, "DIRECTORY").binding.canonical_path,
	}));
	const shell_commands = [...new Set(shellRequests.map((request) => request.command))];
	const quality_checks = structured?.quality_checks ?? [];
	const isShellRunRequest =
		shell_commands.length === 1 &&
		(instruction.startsWith("run:") ||
			instruction.startsWith("execute:") ||
			/\b(?:run|execute)\s+(?:(?:a|the)\s+)?(?:shell\s+|terminal\s+|bash\s+)?command\b/i.test(instruction) ||
			/^(?:please\s+)?(?:can you\s+)?(?:run|execute)\b/i.test(instruction.trim()));
	const requirementInputs =
		structured?.requirements ??
		(exact
			? [
					{
						text: instruction,
						rule: ({ read: "READ", ls: "LIST", status: "STATUS" } as const)[exact.tool],
						target: exact.path,
						expected: undefined,
					},
				]
			: isShellRunRequest
				? [
						{
							text: instruction,
							rule: "PROCESS" as const,
							target: shellRequests[0].cwd,
							expected: shell_commands[0],
						},
					]
				: instruction
						.split(/;\s+|\n(?:[-*]\s+)/)
						.filter((clause) => clause.trim())
						.map((text) => ({ text, rule: "SEMANTIC" as const, target: ".", expected: undefined })));
	const requirements = requirementInputs.map((req) =>
		makeRecord(mission, 1, "Requirement", {
			requirement_id: randomUUID(),
			source_ref: commandRef,
			text: req.text,
			mandatory: true,
			rule: req.rule,
			target: resolve(root, req.target),
			expected: req.expected ?? null,
			status: "UNMET",
			generation: null,
			evidence: [],
			superseded_by: null,
			...("dependencies" in req && req.dependencies
				? { dependencies: req.dependencies.map((path) => resolve(root, path)) }
				: {}),
		}),
	);
	const spec = makeRecord(
		mission,
		1,
		"CommandSpecification",
		{
			command_id: commandId,
			original_instruction: instruction,
			source,
			amendments: [],
			objective: structured?.objective ?? instruction,
			exact_targets: exact ? [exact.path] : (structured?.requirements.map((req) => req.target) ?? []),
			requirements: requirements.map((req) => req.requirement_id),
			preferences: [],
			prohibitions,
			known_facts: ["Trusted active workspace selection"],
			uncertainty: requirements.some((req) => req.rule === "SEMANTIC")
				? ["Semantic acceptance has not yet been established; native model proposals cannot verify it"]
				: [],
			expected_artifacts: requirements.filter((req) => req.rule === "CONTENT").map((req) => req.target!),
			completion_conditions: requirements.map((req) => `${req.requirement_id}:${req.rule}`),
			authorization_scope: ["READ", ...(editing ? ["EDIT"] : []), ...shell_commands.map((cmd) => `SHELL:${cmd}`)],
		},
		commandRef,
	);
	const grants: RecordOf<"Authorization">[] =
		source === "USER"
			? [
					makeRecord(mission, 1, "Authorization", {
						authorization_id: randomUUID(),
						source_ref: spec.record_id,
						classes: exact
							? [({ read: "READ", ls: "LIST", status: "STATUS" } as const)[exact.tool]]
							: ["READ", "LIST", "STATUS", "SEARCH", ...(editing ? ["EDIT"] : [])],
						target: exact ? resolve(root, exact.path) : root,
						environment: `local:${root}`,
						policy_version: POLICY_VERSION,
						action_digest: null,
						expires_at: Date.now() + 30 * 60 * 1000,
						revoked: false,
					}),
					...[...shellRequests, ...quality_checks.map((command) => ({ command, cwd: root }))].map((request) =>
						makeRecord(mission, 1, "Authorization", {
							authorization_id: randomUUID(),
							source_ref: spec.record_id,
							classes: [`SHELL:${request.command}`],
							target: request.cwd,
							environment: `local:${root}`,
							policy_version: POLICY_VERSION,
							action_digest: null,
							expires_at: Date.now() + 30 * 60 * 1000,
							revoked: false,
						}),
					),
				]
			: [];
	const resourceOverrides: unknown = configured ?? {};
	if (!Value.Check(Type.Partial(ResourceCeilingsSchema), resourceOverrides))
		throw new Error("Invalid configured resource overrides");
	const configuredRecord = makeRecord(mission, 1, "KernelConfiguration", {
		source: "APPLICATION",
		value: configuration,
		resource_overrides: resourceOverrides,
	});
	const { ceilings: limits, verification_reserve: reserve } = routeBudget(configuration, route, resourceOverrides);
	const contract = makeRecord(mission, 1, "MissionContract", {
		command_spec_ref: spec.record_id,
		product_mode: "padma_code",
		route,
		signals,
		bindings: [],
		allowed_classes: grants.flatMap((grant) => grant.classes),
		requirements: requirements.map((req) => req.record_id),
		quality_obligations: [
			...(editing ? ["Current guarded file state and retained diff/preimage"] : []),
			...quality_checks.map((command) => `PROCESS:${command}`),
		],
		policy_version: POLICY_VERSION,
		configuration_ref: configuredRecord.record_id,
		ceilings: limits,
		verification_reserve: reserve,
		strategy: exact
			? "Exact registered observation; zero preflight"
			: "One native provider decision; narrow observations; guarded localized edits; acceptance before terminal",
		recompile_source: null,
	});
	const state: MissionState = {
		schema_version: 1,
		record_type: "MissionState",
		mission_id: mission,
		session_id: session,
		owner_pid: process.pid,
		revision: 1,
		phase: "CREATED",
		command: spec.record_id,
		contract: contract.record_id,
		requirements: requirements.map((req) => req.record_id),
		authorizations: grants.map((grant) => grant.record_id),
		operations: [],
		reservations: [],
		checkpoints: [],
		best: [],
		hypotheses: [],
		last_event: null,
		terminal: null,
		used: resources(),
		ceilings: limits,
		verification_reserve: reserve,
		route,
		stagnation: 0,
		started_at: Date.now(),
		intent_epoch: 1,
	};
	return {
		state,
		records: [configuredRecord, spec, ...requirements, ...grants, contract],
		exact,
		shell_commands: [...new Set([...shell_commands, ...quality_checks])],
		quality_checks,
	};
}
