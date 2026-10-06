// Jālacitra TypeScript Adapter (Part I4, J5-TS-001 through J5-TS-003)

import { version as tsVersion } from "typescript";
import type { ProvenanceClass } from "../../model/provenance.ts";
import type { BlindSpotCode } from "../../model/reason-codes.ts";
import type { ConfigInput, ExtractContext, ExtractResult, FileInfo, LanguageAdapter } from "../adapter.ts";
import { walkTypeScriptAst } from "./ast-walker.ts";

export class TypeScriptAdapter implements LanguageAdapter {
	readonly id = "typescript";
	readonly version = "1.0.0";
	readonly languages = ["typescript", "javascript", "tsx", "jsx"];
	readonly provenanceClasses: ProvenanceClass[] = ["PARSED"];
	readonly blindSpotKinds: BlindSpotCode[] = [
		"DYNAMIC_DISPATCH",
		"DYNAMIC_IMPORT",
		"EVAL_OR_EXEC",
		"STRING_BASED_REFERENCE",
		"CROSS_LANGUAGE_BOUNDARY",
		"PARSER_ERROR_RECOVERY",
	];

	grammarVersions(): Record<string, string> {
		return { typescript: tsVersion };
	}

	configFingerprintInputs(_repo: { repoRoot: string }): ConfigInput[] {
		// Fingerprint inputs will be computed from tsconfig and package.json files
		return [];
	}

	supports(file: FileInfo): boolean {
		const lower = file.path.toLowerCase();
		return (
			lower.endsWith(".ts") ||
			lower.endsWith(".tsx") ||
			lower.endsWith(".js") ||
			lower.endsWith(".jsx") ||
			lower.endsWith(".mjs") ||
			lower.endsWith(".cjs") ||
			lower.endsWith(".mts") ||
			lower.endsWith(".cts")
		);
	}

	extract(_ctx: ExtractContext, file: FileInfo, bytes: Uint8Array): ExtractResult {
		return walkTypeScriptAst(file, bytes);
	}
}
