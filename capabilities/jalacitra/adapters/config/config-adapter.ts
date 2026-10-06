// Jālacitra Config Key-Name Adapter (Part I6, J5-CFG-001, J5-INV-008, J5-SEC-005)

import type { ProvenanceClass } from "../../model/provenance.ts";
import type { BlindSpotCode } from "../../model/reason-codes.ts";
import type {
	ConfigInput,
	ExtractContext,
	ExtractResult,
	FileInfo,
	LanguageAdapter,
	RawConfigKey,
} from "../adapter.ts";

export class ConfigAdapter implements LanguageAdapter {
	readonly id = "config";
	readonly version = "1.0.0";
	readonly languages = ["json", "yaml", "toml", "env"];
	readonly provenanceClasses: ProvenanceClass[] = ["PARSED"];
	readonly blindSpotKinds: BlindSpotCode[] = [];

	grammarVersions(): Record<string, string> {
		return { config: "1.0.0" };
	}

	configFingerprintInputs(_repo: { repoRoot: string }): ConfigInput[] {
		return [];
	}

	supports(file: FileInfo): boolean {
		const lower = file.path.toLowerCase();
		const name = lower.split("/").pop() ?? "";
		return (
			name.endsWith(".json") ||
			name.endsWith(".yaml") ||
			name.endsWith(".yml") ||
			name.endsWith(".toml") ||
			name.startsWith(".env")
		);
	}

	extract(_ctx: ExtractContext, file: FileInfo, bytes: Uint8Array): ExtractResult {
		const name = file.path.split("/").pop() ?? "";
		const text = new TextDecoder().decode(bytes);
		const configKeys: RawConfigKey[] = [];
		const maxKeys = 500;
		let truncated = false;

		// 1. .env files: extract key names only, values NEVER
		if (name.startsWith(".env")) {
			const lines = text.split("\n");
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("#")) continue;
				const eqIdx = trimmed.indexOf("=");
				if (eqIdx > 0) {
					const key = trimmed.slice(0, eqIdx).trim();
					if (key && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
						configKeys.push({
							name: key,
							scope: "env_var",
						});
						if (configKeys.length >= maxKeys) {
							truncated = true;
							break;
						}
					}
				}
			}
		}

		// 2. JSON config files: extract key paths (values never)
		else if (name.endsWith(".json")) {
			try {
				const obj = JSON.parse(text);
				this.extractJsonKeys(obj, "", configKeys, 1, 6, maxKeys);
				if (configKeys.length >= maxKeys) {
					truncated = true;
				}
			} catch {
				// unparseable
			}
		}

		return {
			status: truncated ? "PARTIAL" : "OK",
			reasonCode: truncated ? "CONFIG_TRUNCATED" : undefined,
			declarations: [],
			references: [],
			configKeys,
			testCases: [],
			contracts: [],
			blindSpots: {},
			diagnostics: [],
		};
	}

	private extractJsonKeys(
		val: unknown,
		prefix: string,
		out: RawConfigKey[],
		currentDepth: number,
		maxDepth: number,
		maxKeys: number,
	): void {
		if (currentDepth > maxDepth || out.length >= maxKeys) return;
		if (val && typeof val === "object" && !Array.isArray(val)) {
			for (const k of Object.keys(val)) {
				const fullKey = prefix ? `${prefix}.${k}` : k;
				out.push({
					name: fullKey,
					scope: "file_key",
				});
				if (out.length >= maxKeys) return;
				this.extractJsonKeys(
					(val as Record<string, unknown>)[k],
					fullKey,
					out,
					currentDepth + 1,
					maxDepth,
					maxKeys,
				);
			}
		}
	}
}
