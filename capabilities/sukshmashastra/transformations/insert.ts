// Sūkṣmaśastra Insert Transformation (Part E2, S6-TX-001..003)
// Inserts code BEFORE, AFTER, or INSIDE a container node.

import { checkSyntax } from "../engine/syntax-validator.ts";
import type { Anchor } from "../model/anchors.ts";
import type { ByteRangeEdit } from "../model/diff.ts";
import { SukshmashastraError } from "../model/reason-codes.ts";

export type InsertionPlacement = "BEFORE" | "AFTER" | "INSIDE_START" | "INSIDE_END";

export interface InsertResult {
	readonly edits: ByteRangeEdit[];
	readonly affectedNodes: string[];
}

/**
 * Inserts code relative to an anchored syntax node.
 */
export function insertNode(
	source: string,
	anchor: Anchor,
	placement: InsertionPlacement,
	textToInsert: string,
): InsertResult {
	if (!anchor.range) {
		throw new SukshmashastraError("NOT_FOUND", `Anchor '${anchor.id}' has no resolved byte range for insert`);
	}

	let offset = 0;
	let formattedText = textToInsert;

	// Detect line ending (CRLF vs LF)
	const isCRLF = source.includes("\r\n");
	const nl = isCRLF ? "\r\n" : "\n";

	switch (placement) {
		case "BEFORE": {
			offset = anchor.range.startByte;
			// Ensure trailing newline
			if (!formattedText.endsWith("\n")) {
				formattedText = `${formattedText}${nl}`;
			}
			break;
		}
		case "AFTER": {
			offset = anchor.range.endByte;
			// Ensure leading newline
			if (!formattedText.startsWith("\n") && !formattedText.startsWith("\r\n")) {
				formattedText = `${nl}${formattedText}`;
			}
			break;
		}
		case "INSIDE_START": {
			// Find opening brace '{'
			const searchSlice = source.slice(anchor.range.startByte, anchor.range.endByte);
			const braceIdx = searchSlice.indexOf("{");
			if (braceIdx === -1) {
				throw new SukshmashastraError(
					"NOT_FOUND",
					`Cannot insert INSIDE_START: anchor '${anchor.id}' contains no container '{'`,
				);
			}
			offset = anchor.range.startByte + braceIdx + 1;
			formattedText = `${nl}\t${formattedText.trim()}${nl}`;
			break;
		}
		case "INSIDE_END": {
			// Find closing brace '}' before end of range
			const searchSlice = source.slice(anchor.range.startByte, anchor.range.endByte);
			const lastBraceIdx = searchSlice.lastIndexOf("}");
			if (lastBraceIdx === -1) {
				throw new SukshmashastraError(
					"NOT_FOUND",
					`Cannot insert INSIDE_END: anchor '${anchor.id}' contains no container '}'`,
				);
			}
			offset = anchor.range.startByte + lastBraceIdx;
			formattedText = `${nl}\t${formattedText.trim()}${nl}`;
			break;
		}
		default:
			throw new Error(`Unknown placement: ${placement}`);
	}

	// Syntax check on tentative insertion
	const tentative = source.slice(0, offset) + formattedText + source.slice(offset);
	const syntaxCheck = checkSyntax(tentative, anchor.targetFile ?? anchor.file_id ?? "source.ts");
	if (!syntaxCheck.valid) {
		throw new SukshmashastraError(
			"REJECTED_SYNTAX_ERROR",
			`Insertion introduces syntax error: ${syntaxCheck.diagnostics.map((d) => d.message).join(", ")}`,
		);
	}

	const edit: ByteRangeEdit = {
		start: offset,
		end: offset,
		newText: formattedText,
		description: `Insert ${placement} anchor ${anchor.selector}`,
	};

	return {
		edits: [edit],
		affectedNodes: [anchor.anchor_id ?? anchor.id ?? ""],
	};
}
