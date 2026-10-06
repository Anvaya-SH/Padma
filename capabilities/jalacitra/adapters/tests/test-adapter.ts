// Jālacitra Test Framework Adapter (Part I7, J5-TST-001)

import type { ProvenanceClass } from "../../model/provenance.ts";
import type { BlindSpotCode } from "../../model/reason-codes.ts";
import type { ConfigInput, ExtractContext, ExtractResult, FileInfo, LanguageAdapter, RawTestCase } from "../adapter.ts";

export class TestFrameworkAdapter implements LanguageAdapter {
	readonly id = "test_framework";
	readonly version = "1.0.0";
	readonly languages = ["typescript", "javascript"];
	readonly provenanceClasses: ProvenanceClass[] = ["PARSED"];
	readonly blindSpotKinds: BlindSpotCode[] = ["MACRO_OR_TEMPLATE"];

	grammarVersions(): Record<string, string> {
		return { tests: "1.0.0" };
	}

	configFingerprintInputs(_repo: { repoRoot: string }): ConfigInput[] {
		return [];
	}

	supports(file: FileInfo): boolean {
		return file.class === "test";
	}

	extract(_ctx: ExtractContext, file: FileInfo, bytes: Uint8Array): ExtractResult {
		const text = new TextDecoder().decode(bytes);
		const testCases: RawTestCase[] = [];
		const blindSpots: Record<string, number> = {};

		// Match test.each(...)("title", ...) or describe("title", ...)
		const eachRegex = /(describe|it|test)\.each\s*\([^)]*\)\s*\(\s*(?:["'`]([^"'`]+)["'`]|([^,)]+))\s*,/g;

		for (let match = eachRegex.exec(text); match !== null; match = eachRegex.exec(text)) {
			const literalTitle = match[2];
			const dynamicTitle = match[3];
			const start = match.index;
			const end = start + match[0].length;

			if (literalTitle) {
				testCases.push({
					framework: "vitest_jest_nodetest",
					qualifiedName: literalTitle,
					kind: "param_family",
					range: {
						startByte: start,
						endByte: end,
						startLine: 1,
						endLine: 1,
						contentDigest: file.contentDigest,
					},
				});
			} else if (dynamicTitle) {
				blindSpots.MACRO_OR_TEMPLATE = (blindSpots.MACRO_OR_TEMPLATE ?? 0) + 1;
				testCases.push({
					framework: "vitest_jest_nodetest",
					qualifiedName: "<dynamic>",
					kind: "param_family",
					range: {
						startByte: start,
						endByte: end,
						startLine: 1,
						endLine: 1,
						contentDigest: file.contentDigest,
					},
					attrs: { dynamic_title: true },
				});
			}
		}

		// Match normal describe("suite", ...), it("case", ...), test("case", ...)
		const blockRegex = /(describe|it|test)\s*\(\s*(?:["'`]([^"'`]+)["'`]|([^,)]+))\s*,/g;
		for (let match = blockRegex.exec(text); match !== null; match = blockRegex.exec(text)) {
			const blockType = match[1] === "describe" ? "suite" : "case";
			const literalTitle = match[2];
			const dynamicTitle = match[3];

			const start = match.index;
			const end = start + match[0].length;

			if (literalTitle) {
				testCases.push({
					framework: "vitest_jest_nodetest",
					qualifiedName: literalTitle,
					kind: blockType,
					range: {
						startByte: start,
						endByte: end,
						startLine: 1,
						endLine: 1,
						contentDigest: file.contentDigest,
					},
				});
			} else if (dynamicTitle) {
				blindSpots.MACRO_OR_TEMPLATE = (blindSpots.MACRO_OR_TEMPLATE ?? 0) + 1;
				testCases.push({
					framework: "vitest_jest_nodetest",
					qualifiedName: "<dynamic>",
					kind: blockType,
					range: {
						startByte: start,
						endByte: end,
						startLine: 1,
						endLine: 1,
						contentDigest: file.contentDigest,
					},
					attrs: { dynamic_title: true },
				});
			}
		}

		testCases.sort((a, b) => a.range.startByte - b.range.startByte);

		return {
			status: "OK",
			declarations: [],
			references: [],
			configKeys: [],
			testCases,
			contracts: [],
			blindSpots,
			diagnostics: [],
		};
	}
}
