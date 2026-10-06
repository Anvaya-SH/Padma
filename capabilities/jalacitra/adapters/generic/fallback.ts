// Jālacitra Generic Fallback Adapter (Part I8, J5-GEN-ADP-001)

import type { ProvenanceClass } from "../../model/provenance.ts";
import type { BlindSpotCode } from "../../model/reason-codes.ts";
import type { ConfigInput, ExtractContext, ExtractResult, FileInfo, LanguageAdapter } from "../adapter.ts";

export class GenericFallbackAdapter implements LanguageAdapter {
	readonly id = "generic_fallback";
	readonly version = "1.0.0";
	readonly languages = ["*"];
	readonly provenanceClasses: ProvenanceClass[] = ["PARSED"];
	readonly blindSpotKinds: BlindSpotCode[] = ["UNSUPPORTED_LANGUAGE"];

	grammarVersions(): Record<string, string> {
		return { fallback: "none" };
	}

	configFingerprintInputs(_repo: { repoRoot: string }): ConfigInput[] {
		return [];
	}

	supports(file: FileInfo): boolean {
		// Supports any non-binary text file as fallback
		return !file.isBinary;
	}

	extract(_ctx: ExtractContext, _file: FileInfo, _bytes: Uint8Array): ExtractResult {
		return {
			status: "OK",
			reasonCode: undefined,
			declarations: [],
			references: [],
			configKeys: [],
			testCases: [],
			contracts: [],
			blindSpots: {},
			diagnostics: [],
		};
	}
}
