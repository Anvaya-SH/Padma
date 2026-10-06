// Sūkṣmaśastra Move Transformation (Part E2, S6-TX-001..003)
// Moves declarations between files, updates imports, and prevents cycles.

import path from "node:path";
import type { Anchor } from "../model/anchors.ts";
import type { ByteRangeEdit } from "../model/diff.ts";
import { SukshmashastraError } from "../model/reason-codes.ts";
import { addImport } from "./rewrite-imports.ts";

export interface MoveResult {
	readonly sourceEdits: ByteRangeEdit[];
	readonly targetEdits: ByteRangeEdit[];
	readonly affectedNodes: string[];
}

/**
 * Computes a relative import path from fromFile to toFile.
 */
function getRelativeImportPath(fromFile: string, toFile: string): string {
	const dir = path.dirname(fromFile);
	let rel = path.relative(dir, toFile).replace(/\\/g, "/");
	// Strip .ts, .tsx, .js extension
	rel = rel.replace(/\.(ts|tsx|js|jsx)$/, "");
	if (!rel.startsWith(".")) {
		rel = `./${rel}`;
	}
	return rel;
}

/**
 * Moves a declaration from sourceFile to targetFile.
 */
export function moveDeclaration(
	sourceFile: string,
	sourceContent: string,
	targetFile: string,
	targetContent: string,
	anchor: Anchor,
	existingImports: Record<string, string[]> = {},
): MoveResult {
	if (!anchor.range) {
		throw new SukshmashastraError("NOT_FOUND", `Anchor '${anchor.id}' has no resolved byte range for move`);
	}

	// 1. Cycle detection: check if targetFile already depends directly on sourceFile
	const targetDeps = existingImports[targetFile] ?? [];
	const sourceNormalized = sourceFile.replace(/\\/g, "/");
	if (targetDeps.some((dep) => dep.includes(sourceNormalized) || sourceNormalized.includes(dep))) {
		throw new SukshmashastraError(
			"CONFLICT",
			`Move would create circular dependency: '${targetFile}' already imports from '${sourceFile}'`,
		);
	}

	const nodeText = sourceContent.slice(anchor.range.startByte, anchor.range.endByte);

	// Ensure exported in target
	let exportedText = nodeText.trim();
	if (!exportedText.startsWith("export ")) {
		exportedText = `export ${exportedText}`;
	}

	// 2. Remove declaration from sourceContent
	let delStart = anchor.range.startByte;
	let delEnd = anchor.range.endByte;
	const prevLineBreak = sourceContent.lastIndexOf("\n", delStart - 1);
	const lineStart = prevLineBreak === -1 ? 0 : prevLineBreak + 1;
	const isPrecededOnlyByWhitespace = sourceContent.slice(lineStart, delStart).trim().length === 0;
	const nextLineBreak = sourceContent.indexOf("\n", delEnd);

	if (isPrecededOnlyByWhitespace && nextLineBreak !== -1) {
		delStart = lineStart;
		delEnd = nextLineBreak + 1;
	}

	const sourceEdits: ByteRangeEdit[] = [
		{
			start: delStart,
			end: delEnd,
			newText: "",
			description: `Remove ${anchor.identifier} from ${sourceFile}`,
		},
	];

	// 3. Add import in sourceFile from targetFile
	const relImport = getRelativeImportPath(sourceFile, targetFile);
	const importEdits = addImport(sourceContent, {
		moduleSpecifier: relImport,
		namedImports: [anchor.identifier ?? anchor.structural_selector ?? ""],
	});
	sourceEdits.push(...importEdits);

	// 4. Insert into targetFile
	const isCRLF = targetContent.includes("\r\n");
	const nl = isCRLF ? "\r\n" : "\n";
	const targetEdits: ByteRangeEdit[] = [
		{
			start: targetContent.length,
			end: targetContent.length,
			newText: `${nl}${nl}${exportedText}${nl}`,
			description: `Insert moved ${anchor.identifier ?? ""} into ${targetFile}`,
		},
	];

	return {
		sourceEdits,
		targetEdits,
		affectedNodes: [anchor.anchor_id ?? anchor.id ?? ""],
	};
}
