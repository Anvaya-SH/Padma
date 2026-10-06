// Sūkṣmaśastra Config-Migration Transformation (Part E2, S6-TX-001..003, Decision D-4)
// Format- and comment-preserving edits for JSON, JSONC, and YAML configuration files.
// Refuses executable configuration files with FORMAT_SKIPPED_EXECUTABLE_CONFIG.

import type { ByteRangeEdit } from "../model/diff.ts";
import { SukshmashastraError } from "../model/reason-codes.ts";

export interface ConfigUpdateSpec {
	readonly keyPath: string[]; // e.g. ["compilerOptions", "strict"]
	readonly newValue: unknown;
}

export interface ConfigMigrationResult {
	readonly edits: ByteRangeEdit[];
	readonly newContent: string;
}

/**
 * Checks if a config file is an executable script rather than declarative data.
 */
export function isExecutableConfig(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	return lower.endsWith(".js") || lower.endsWith(".cjs") || lower.endsWith(".mjs") || lower.endsWith(".ts");
}

/**
 * Migrates or updates properties in a configuration file (JSON, JSONC, YAML).
 */
export function migrateConfig(
	filePath: string,
	content: string,
	updates: readonly ConfigUpdateSpec[],
): ConfigMigrationResult {
	// Guard against executable configs (Decision D-4, S6-SEC-002)
	if (isExecutableConfig(filePath)) {
		throw new SukshmashastraError(
			"FORMAT_SKIPPED_EXECUTABLE_CONFIG",
			`Configuration file '${filePath}' is executable; declarative migration is skipped for security`,
		);
	}

	const lower = filePath.toLowerCase();
	const isJson = lower.endsWith(".json");
	const isJsonc = lower.endsWith(".jsonc");
	const isYaml = lower.endsWith(".yaml") || lower.endsWith(".yml");

	if (!isJson && !isJsonc && !isYaml) {
		throw new SukshmashastraError(
			"UNSUPPORTED_LANGUAGE",
			`Configuration file format for '${filePath}' is not supported (only JSON, JSONC, YAML)`,
		);
	}

	// For standard JSON and JSONC, apply key updates while preserving structure
	const edits: ByteRangeEdit[] = [];
	let modified = content;

	for (const update of updates) {
		const targetKey = update.keyPath[update.keyPath.length - 1];
		const formattedValue = JSON.stringify(update.newValue);

		if (isYaml) {
			// Find YAML key: e.g. "key: oldValue"
			const yamlRegex = new RegExp(`^([ \\t]*${targetKey}:\\s*)([^#\\r\\n]+)(.*)$`, "m");
			const match = yamlRegex.exec(modified);
			if (match) {
				const start = match.index + match[1].length;
				const end = start + match[2].length;
				const yamlVal = typeof update.newValue === "string" ? update.newValue : JSON.stringify(update.newValue);
				edits.push({
					start,
					end,
					newText: yamlVal,
					description: `Update YAML key ${targetKey}`,
				});
				modified = modified.slice(0, start) + yamlVal + modified.slice(end);
			}
		} else {
			// JSON / JSONC: find property "targetKey": oldValue
			const jsonPropRegex = new RegExp(`("${targetKey}"\\s*:\\s*)([^,\\}\\r\\n]+)`, "g");
			const match = jsonPropRegex.exec(modified);
			if (match) {
				const start = match.index + match[1].length;
				const end = start + match[2].length;
				edits.push({
					start,
					end,
					newText: formattedValue,
					description: `Update config property "${targetKey}"`,
				});
				modified = modified.slice(0, start) + formattedValue + modified.slice(end);
			}
		}
	}

	return {
		edits,
		newContent: modified,
	};
}
