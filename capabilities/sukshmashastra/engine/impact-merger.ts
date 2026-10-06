// Sūkṣmaśastra Impact Merger & Blind Spot Scanner (Part E, Part H, S6-INV-007, S6-COV-001..004)

import type { Atlas } from "../../jalacitra/api/atlas.ts";
import type { EditCoverage, UncoveredSurfaceCode, UncoveredSurfaceEntry } from "../model/plan.ts";

export interface MergedReferenceFact {
	readonly id: string;
	readonly targetFile: string;
	readonly line: number;
	readonly provenance: "COMPILED" | "PARSED" | "INFERRED";
	readonly kind: "call" | "import" | "type_reference" | "export" | "mention";
	readonly preview: string;
}

export interface ImpactMergeResult {
	readonly references: MergedReferenceFact[];
	readonly coverage: EditCoverage;
}

export interface ImpactMergeOptions {
	readonly repoRoot: string;
	readonly targetSymbols: string[];
	readonly atlas?: Atlas;
	readonly sourceFiles?: Map<string, string>; // path -> content
	readonly isExportedFromRoot?: boolean;
	readonly mode?: "COMPILER_ASSISTED" | "GRAPH_ONLY" | "SYNTAX_ONLY";
}

/**
 * Scans file content for blind spots (reflection, dynamic imports, string mentions).
 */
export function scanFileBlindSpots(
	filePath: string,
	content: string,
	targetSymbols: string[],
): {
	uncovered: Map<UncoveredSurfaceCode, string[]>;
	stringMentions: MergedReferenceFact[];
} {
	const uncovered = new Map<UncoveredSurfaceCode, string[]>();
	const stringMentions: MergedReferenceFact[] = [];

	function addBlindSpot(code: UncoveredSurfaceCode, example: string) {
		let list = uncovered.get(code);
		if (!list) {
			list = [];
			uncovered.set(code, list);
		}
		if (list.length < 5) {
			list.push(example.slice(0, 120));
		}
	}

	// 1. Generated code check
	if (content.includes("@generated") || content.includes("DO NOT EDIT") || content.includes("Auto-generated")) {
		addBlindSpot("GENERATED_CODE", `${filePath}: File marked as generated`);
	}

	// 2. Reflection checks
	const reflectionRegex =
		/(?:Reflect\.(?:get|set|has|apply)|Object\.(?:keys|values|entries)\([^)]+\)|eval\(|new Function\()/g;
	for (let match = reflectionRegex.exec(content); match !== null; match = reflectionRegex.exec(content)) {
		addBlindSpot("REFLECTION", `${filePath}: ${match[0]}`);
	}

	// Dynamic indexing: obj[someVar]
	const dynamicIndexRegex = /([a-zA-Z0-9_$]+)\[([a-zA-Z0-9_$]+)\]/g;
	for (let match = dynamicIndexRegex.exec(content); match !== null; match = dynamicIndexRegex.exec(content)) {
		if (match[2] !== "number" && !/^\d+$/.test(match[2])) {
			addBlindSpot("REFLECTION", `${filePath}: ${match[0]}`);
		}
	}

	// 3. Dynamic imports: any import(...) expression
	const dynImportRegex = /\bimport\s*\(([^)]+)\)/g;
	for (let match = dynImportRegex.exec(content); match !== null; match = dynImportRegex.exec(content)) {
		addBlindSpot("DYNAMIC_IMPORT", `${filePath}: ${match[0]}`);
	}

	// 4. String-based references & comment mentions of target symbols
	for (const sym of targetSymbols) {
		// String literal occurrence e.g. "verifySession"
		const strRegex = new RegExp(`["'\`][^"'\`\\n]*?\\b(${sym})\\b[^"'\`\\n]*?["'\`]`, "g");
		for (let match = strRegex.exec(content); match !== null; match = strRegex.exec(content)) {
			addBlindSpot("STRING_OR_COMMENT_MENTION", `${filePath}: string literal ${match[0]}`);
			stringMentions.push({
				id: `mention:${filePath}:${match.index}`,
				targetFile: filePath,
				line: content.slice(0, match.index).split("\n").length,
				provenance: "INFERRED",
				kind: "mention",
				preview: match[0],
			});
		}

		// Comment occurrence e.g. // verifySession or /* verifySession */
		const commentRegex = new RegExp(`(?:\\/\\/|\\/\\*)[^\\n]*?\\b(${sym})\\b`, "g");
		for (let match = commentRegex.exec(content); match !== null; match = commentRegex.exec(content)) {
			addBlindSpot("STRING_OR_COMMENT_MENTION", `${filePath}: comment mention of ${sym}`);
		}
	}

	// 5. Cross language
	if (content.includes(".node") || content.includes(".wasm")) {
		addBlindSpot("CROSS_LANGUAGE", `${filePath}: Native binary or WebAssembly import`);
	}

	return { uncovered, stringMentions };
}

/**
 * Merges compiler references, Jālacitra impact edges, and syntactic/lexical mentions.
 */
export async function deriveMergedImpact(options: ImpactMergeOptions): Promise<ImpactMergeResult> {
	const references: MergedReferenceFact[] = [];
	const allUncovered = new Map<UncoveredSurfaceCode, string[]>();
	const relevantTests: Array<{ test_id: string; reason: string; provenance: string }> = [];

	const compiledCount = 0;
	let parsedCount = 0;
	let inferredCount = 0;

	// 1. Query Jālacitra Atlas if provided
	let atlasCompleteness: "EXACT_WITHIN_INDEX" | "LOWER_BOUND" | "UNKNOWN" = "UNKNOWN";

	if (options.atlas?.hasStore()) {
		try {
			const targetSymbol = options.targetSymbols[0];
			const impactQuery = options.atlas.expandImpact({
				symbol_id: targetSymbol ? `sym:${targetSymbol}` : undefined,
				depth: 3,
			});

			if (impactQuery.data) {
				atlasCompleteness =
					impactQuery.coverage.completeness === "EXACT_WITHIN_INDEX" ? "EXACT_WITHIN_INDEX" : "LOWER_BOUND";

				for (const items of Object.values(impactQuery.data.items_by_hop)) {
					for (const item of items) {
						parsedCount++;
						references.push({
							id: `atlas:${item.node.id}:${item.hop_distance}`,
							targetFile: item.node.canonical,
							line: 1,
							provenance: item.provenance_class === "INFERRED" ? "INFERRED" : "PARSED",
							kind: "call",
							preview: `atlas impact hop ${item.hop_distance}: ${item.node.canonical}`,
						});
					}
				}
			}

			// Find relevant tests
			const testQuery = options.atlas.findRelevantTests({
				changed_symbol_ids: options.targetSymbols.map((s) => `sym:${s}`),
			});

			if (testQuery.data) {
				for (const t of testQuery.data.candidates) {
					relevantTests.push({
						test_id: t.test_node.id,
						reason: t.reason,
						provenance: t.class === "INFERRED" ? "INFERRED" : "PARSED",
					});
				}
			}
		} catch {
			atlasCompleteness = "UNKNOWN";
		}
	}

	// 2. Scan source files for syntactic references and blind spots
	if (options.sourceFiles) {
		for (const [filePath, content] of options.sourceFiles.entries()) {
			const { uncovered, stringMentions } = scanFileBlindSpots(filePath, content, options.targetSymbols);

			// Merge blind spots
			for (const [code, examples] of uncovered.entries()) {
				let list = allUncovered.get(code);
				if (!list) {
					list = [];
					allUncovered.set(code, list);
				}
				for (const ex of examples) {
					if (list.length < 5) list.push(ex);
				}
			}

			// Add string mentions as inferred references
			for (const sm of stringMentions) {
				inferredCount++;
				references.push(sm);
			}

			// Check for direct calls / imports of symbol
			for (const sym of options.targetSymbols) {
				const callRegex = new RegExp(`\\b(${sym})\\s*\\(`, "g");
				for (let match = callRegex.exec(content); match !== null; match = callRegex.exec(content)) {
					parsedCount++;
					references.push({
						id: `call:${filePath}:${match.index}`,
						targetFile: filePath,
						line: content.slice(0, match.index).split("\n").length,
						provenance: "PARSED",
						kind: "call",
						preview: match[0],
					});
				}
			}
		}
	}

	// 3. External API contract check
	const externalContractChanges: Array<{ contract_id: string; change: "REMOVED" | "RENAMED" | "SIGNATURE_CHANGED" }> =
		[];
	const suggestedChecks: string[] = ["npm run check"];

	if (options.isExportedFromRoot) {
		for (const sym of options.targetSymbols) {
			externalContractChanges.push({
				contract_id: `contract:${sym}`,
				change: "RENAMED",
			});
		}
		let extList = allUncovered.get("EXTERNAL_API_CONSUMERS");
		if (!extList) {
			extList = [];
			allUncovered.set("EXTERNAL_API_CONSUMERS", extList);
		}
		extList.push(
			"Exported symbol affects public package interface; external consumers cannot be statically enumerated",
		);
		suggestedChecks.push("External API compatibility check");
	}

	// Format uncovered surface array
	const uncoveredSurface: UncoveredSurfaceEntry[] = [];
	for (const [code, examples] of allUncovered.entries()) {
		uncoveredSurface.push({
			code,
			count: examples.length,
			examples,
		});
	}

	// S6-COV-001: Atlas completeness defaults to LOWER_BOUND unless exactly verified
	if (atlasCompleteness === "UNKNOWN" && uncoveredSurface.length > 0) {
		atlasCompleteness = "LOWER_BOUND";
	}

	const coverageMode = options.mode ?? (compiledCount > 0 ? "COMPILER_ASSISTED" : "GRAPH_ONLY");

	const coverage: EditCoverage = {
		mode: coverageMode,
		references_found: {
			compiled: compiledCount,
			parsed: parsedCount,
			inferred: inferredCount,
		},
		uncovered_surface: uncoveredSurface,
		atlas_completeness: atlasCompleteness,
		relevant_tests: relevantTests,
		external_contract_changes: externalContractChanges,
		suggested_checks: suggestedChecks,
	};

	return {
		references,
		coverage,
	};
}
