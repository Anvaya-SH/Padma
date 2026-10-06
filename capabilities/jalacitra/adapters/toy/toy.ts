// Jālacitra Toy Language Adapter (Part I8, J5-GEN-ADP-001)

import { computeDigest } from "../../inventory/digest.ts";
import type { ProvenanceClass } from "../../model/provenance.ts";
import type { BlindSpotCode } from "../../model/reason-codes.ts";
import type {
	ConfigInput,
	ExtractContext,
	ExtractResult,
	FileInfo,
	LanguageAdapter,
	RawDeclaration,
	RawRange,
	RawReference,
} from "../adapter.ts";

export class ToyLanguageAdapter implements LanguageAdapter {
	readonly id = "toy_language";
	readonly version = "1.0.0";
	readonly languages = ["toy"];
	readonly provenanceClasses: ProvenanceClass[] = ["PARSED"];
	readonly blindSpotKinds: BlindSpotCode[] = ["PARSER_ERROR_RECOVERY"];

	grammarVersions(): Record<string, string> {
		return { toy: "0.1.0" };
	}

	configFingerprintInputs(_repo: { repoRoot: string }): ConfigInput[] {
		return [];
	}

	supports(file: FileInfo): boolean {
		return file.path.endsWith(".toy");
	}

	extract(_ctx: ExtractContext, file: FileInfo, bytes: Uint8Array): ExtractResult {
		const text = new TextDecoder().decode(bytes);
		const lines = text.split("\n");

		const declarations: RawDeclaration[] = [];
		const references: RawReference[] = [];
		let hadErrors = false;
		let byteOffset = 0;

		for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
			const line = lines[lineIdx];
			const trimmed = line.trim();

			// 1. Import: "import <mod>;"
			const importMatch = trimmed.match(/^import\s+([A-Za-z0-9_]+);/);
			if (importMatch) {
				const modName = importMatch[1];
				const startByte = byteOffset + line.indexOf(trimmed);
				const endByte = startByte + trimmed.length;
				const range: RawRange = {
					startByte,
					endByte,
					startLine: lineIdx + 1,
					endLine: lineIdx + 1,
					contentDigest: file.contentDigest,
				};
				references.push({
					referenceKind: "imports",
					rawText: trimmed,
					targetSpecifier: modName,
					range,
				});
			}

			// 2. Function declaration: "fn <name> {"
			const fnMatch = trimmed.match(/^fn\s+([A-Za-z0-9_]+)\s*\{/);
			if (fnMatch) {
				const fnName = fnMatch[1];
				const startByte = byteOffset + line.indexOf(trimmed);
				const endByte = startByte + trimmed.length;
				const range: RawRange = {
					startByte,
					endByte,
					startLine: lineIdx + 1,
					endLine: lineIdx + 1,
					contentDigest: file.contentDigest,
				};
				declarations.push({
					name: fnName,
					qualifiedName: fnName,
					kind: "function",
					visibility: "public",
					exported: true,
					range,
					signatureDigest: computeDigest(`fn ${fnName}()`),
				});
			}

			// 3. Call: "call <name>;"
			const callMatch = trimmed.match(/^call\s+([A-Za-z0-9_]+);/);
			if (callMatch) {
				const callee = callMatch[1];
				const startByte = byteOffset + line.indexOf(trimmed);
				const endByte = startByte + trimmed.length;
				const range: RawRange = {
					startByte,
					endByte,
					startLine: lineIdx + 1,
					endLine: lineIdx + 1,
					contentDigest: file.contentDigest,
				};
				references.push({
					referenceKind: "calls",
					calleeShape: "identifier",
					rawText: trimmed,
					targetSpecifier: callee,
					range,
				});
			}

			// 4. Invalid syntax error simulation: "SYNTAX_ERROR"
			if (trimmed.includes("SYNTAX_ERROR")) {
				hadErrors = true;
			}

			// +1 for newline character
			byteOffset += line.length + 1;
		}

		return {
			status: hadErrors ? "PARTIAL" : "OK",
			reasonCode: hadErrors ? "PARSER_ERROR_RECOVERY" : undefined,
			declarations,
			references,
			configKeys: [],
			testCases: [],
			contracts: [],
			blindSpots: hadErrors ? { PARSER_ERROR_RECOVERY: 1 } : {},
			diagnostics: hadErrors
				? [
						{
							code: "SYNTAX_ERROR",
							message: "Encountered unparseable token in source",
							excerpt: "SYNTAX_ERROR",
						},
					]
				: [],
		};
	}
}
