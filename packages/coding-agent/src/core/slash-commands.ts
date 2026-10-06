import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";
import { normalizeSanskrit } from "./ui-language.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	/** ASCII Sanskrit spelling, suitable for every keyboard. */
	name: string;
	displayName: string;
	/** Internal handler name, also accepted as an English spelling. */
	command: string;
	description: string;
	argumentHint?: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{
		name: "dhyana",
		displayName: "Dhyāna",
		command: "thinking",
		description: "[thinking] Adjust reasoning depth",
		argumentHint: "<level>",
	},
	{
		name: "pratimana",
		displayName: "Pratimāna",
		command: "model",
		description: "[model] Select a model",
		argumentHint: "<provider/model>",
	},
	{ name: "niyama", displayName: "Niyama", command: "settings", description: "[settings] Configure Padma" },
	{
		name: "vamsa",
		displayName: "Vaṃśa",
		command: "tree",
		description: "[session tree] Navigate conversation branches",
	},
	{
		name: "parimita",
		displayName: "Parimita",
		command: "scoped-models",
		description: "[scoped models] Choose models for cycling",
	},
	{
		name: "niryata",
		displayName: "Niryāta",
		command: "export",
		description: "[export] Save HTML or JSONL",
		argumentHint: "<path>",
	},
	{
		name: "ayata",
		displayName: "Āyāta",
		command: "import",
		description: "[import] Open a JSONL conversation",
		argumentHint: "<path.jsonl>",
	},
	{
		name: "samvibhaga",
		displayName: "Saṃvibhāga",
		command: "share",
		description: "[share] Share a conversation as a gist",
	},
	{
		name: "truti",
		displayName: "Truṭi",
		command: "bug",
		description: "[bug report] Report a Padma issue",
		argumentHint: "<description>",
	},
	{ name: "pratilipi", displayName: "Pratilipi", command: "copy", description: "[copy] Copy the last response" },
	{
		name: "namadheya",
		displayName: "Nāmadheya",
		command: "name",
		description: "[name] Name this conversation",
		argumentHint: "<name>",
	},
	{
		name: "samvada",
		displayName: "Saṃvāda",
		command: "session",
		description: "[session] Show conversation information and usage",
	},
	{ name: "vrttanta", displayName: "Vṛttānta", command: "changelog", description: "[changelog] Read release changes" },
	{ name: "kunjika", displayName: "Kuñjikā", command: "hotkeys", description: "[shortcuts] Show keyboard shortcuts" },
	{ name: "sakha", displayName: "Śākhā", command: "fork", description: "[fork] Branch from an earlier message" },
	{
		name: "pratirupa",
		displayName: "Pratirūpa",
		command: "clone",
		description: "[clone] Duplicate this conversation",
	},
	{ name: "visvasa", displayName: "Viśvāsa", command: "trust", description: "[trust] Configure project trust" },
	{
		name: "adhikara",
		displayName: "Adhikāra",
		command: "access",
		description: "[access] Select agent access mode (auto or full)",
		argumentHint: "<auto|full>",
	},
	{
		name: "pravesa",
		displayName: "Praveśa",
		command: "login",
		description: "[login] Connect a provider",
		argumentHint: "<provider>",
	},
	{ name: "nirgamana", displayName: "Nirgamana", command: "logout", description: "[logout] Remove saved credentials" },
	{ name: "nava", displayName: "Nava", command: "new", description: "[new session] Start a conversation" },
	{
		name: "sarasangraha",
		displayName: "Sārasaṅgraha",
		command: "compact",
		description: "[compact] Summarize context",
		argumentHint: "<instructions>",
	},
	{
		name: "avartana",
		displayName: "Āvartana",
		command: "context",
		description: "[context] Inspect context sources and status",
		argumentHint: "<status|sources>",
	},
	{
		name: "smritikosha",
		displayName: "Smṛtikoṣa",
		command: "memory",
		description: "[memory] Search or manage persistent memory",
		argumentHint: "<search|show|status> <args>",
	},
	{
		name: "punaragamana",
		displayName: "Punarāgamana",
		command: "resume",
		description: "[resume] Return to a saved conversation",
	},
	{
		name: "punarnavikarana",
		displayName: "Punarnavīkaraṇa",
		command: "reload",
		description: "[reload] Reload resources and configuration",
	},
	{ name: "prasthana", displayName: "Prasthāna", command: "quit", description: `[quit] Close ${APP_NAME}` },
];

const commandNames = new Map<string, string>();
for (const entry of BUILTIN_SLASH_COMMANDS) {
	for (const name of [entry.name, entry.displayName, entry.command]) {
		commandNames.set(normalizeSanskrit(name), entry.name);
	}
}
commandNames.set("models", "pratimana");
commandNames.set("clear", "nava");
commandNames.set("exit", "prasthana");

export interface BuiltinAutocompleteEntry {
	name: string;
	description: string;
	argumentHint?: string;
}

/**
 * Autocomplete entries for every built-in: Sanskrit names only.
 * English spellings stay hidden from the picker but still redirect
 * via normalizeBuiltinCommand (e.g. `/login` -> `/pravesa`).
 */
export function builtinAutocompleteEntries(): BuiltinAutocompleteEntry[] {
	return BUILTIN_SLASH_COMMANDS.map((command) => ({
		name: command.name,
		description: `${command.displayName} ${command.description}`,
		...(command.argumentHint && { argumentHint: command.argumentHint }),
	}));
}

/** Normalize only the command token. Quoted paths and other arguments are preserved verbatim. */
export function normalizeBuiltinCommand(text: string): string {
	const match = /^\/([^\s]+)([\s\S]*)$/.exec(text);
	if (!match) return text;
	const command = commandNames.get(normalizeSanskrit(match[1]));
	return command ? `/${command}${match[2]}` : text;
}

export function isBuiltinCommand(name: string): boolean {
	return commandNames.has(normalizeSanskrit(name));
}
