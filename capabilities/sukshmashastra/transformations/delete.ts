// Sūkṣmaśastra Delete Transformation (Part E2, S6-TX-001..003)
// Safely deletes an anchored syntax node. Rejects deletion if live references remain.

import { checkSyntax } from "../engine/syntax-validator.ts";
import type { Anchor } from "../model/anchors.ts";
import type { ByteRangeEdit } from "../model/diff.ts";
import { SukshmashastraError } from "../model/reason-codes.ts";

export interface ActiveReference {
	readonly file: string;
	readonly startByte: number;
	readonly endByte: number;
}

export interface DeleteResult {
	readonly edits: ByteRangeEdit[];
	readonly affectedNodes: string[];
}

/**
 * Deletes an anchored node from source text.
 * Throws DELETE_REFERENCES_REMAIN if live references exist outside the node.
 */
export function deleteNode(
	source: string,
	anchor: Anchor,
	activeReferences: readonly ActiveReference[] = [],
): DeleteResult {
	if (!anchor.range) {
		throw new SukshmashastraError("NOT_FOUND", `Anchor '${anchor.id}' has no resolved byte range for delete`);
	}

	const start = anchor.range.startByte;
	const end = anchor.range.endByte;

	// Check if any reference lies outside this node's range
	const externalRefs = activeReferences.filter((ref) => ref.startByte < start || ref.endByte > end);

	if (externalRefs.length > 0) {
		throw new SukshmashastraError(
			"DELETE_REFERENCES_REMAIN",
			`Cannot delete '${anchor.identifier}': ${externalRefs.length} active reference(s) remain in ${externalRefs[0].file}`,
		);
	}

	// Expand range to cleanly delete surrounding newline / indentation
	let deleteStart = start;
	let deleteEnd = end;

	// Check if preceding characters on the line are just whitespace
	const prevLineBreak = source.lastIndexOf("\n", start - 1);
	const lineStart = prevLineBreak === -1 ? 0 : prevLineBreak + 1;
	const isPrecededOnlyByWhitespace = source.slice(lineStart, start).trim().length === 0;

	// Check if following characters on that same line are just whitespace
	const nextLineBreak = source.indexOf("\n", end);
	const lineEnd = nextLineBreak === -1 ? source.length : nextLineBreak;
	const isFollowedOnlyByWhitespace = source.slice(end, lineEnd).trim().length === 0;

	if (isPrecededOnlyByWhitespace && isFollowedOnlyByWhitespace) {
		deleteStart = lineStart;
		deleteEnd = nextLineBreak === -1 ? source.length : nextLineBreak + 1;
	}

	// Syntax check on tentative deletion
	const tentative = source.slice(0, deleteStart) + source.slice(deleteEnd);
	const syntaxCheck = checkSyntax(tentative, anchor.targetFile ?? anchor.file_id ?? "source.ts");
	if (!syntaxCheck.valid) {
		throw new SukshmashastraError(
			"REJECTED_SYNTAX_ERROR",
			`Deletion leaves syntax error: ${syntaxCheck.diagnostics.map((d) => d.message).join(", ")}`,
		);
	}

	const edit: ByteRangeEdit = {
		start: deleteStart,
		end: deleteEnd,
		newText: "",
		description: `Delete node ${anchor.selector}`,
	};

	return {
		edits: [edit],
		affectedNodes: [anchor.anchor_id ?? anchor.id ?? ""],
	};
}
