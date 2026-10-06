// Sūkṣmaśastra Replace-Node Transformation (Part E2, S6-TX-001..003)
// Replaces an anchored syntax node with parsed replacement text.

import { checkSyntax } from "../engine/syntax-validator.ts";
import type { Anchor } from "../model/anchors.ts";
import type { ByteRangeEdit } from "../model/diff.ts";
import { SukshmashastraError } from "../model/reason-codes.ts";

export interface ReplaceNodeResult {
	readonly edits: ByteRangeEdit[];
	readonly affectedNodes: string[];
}

/**
 * Replaces an anchored node's byte range with replacement text.
 */
export function replaceNode(source: string, anchor: Anchor, replacementText: string): ReplaceNodeResult {
	if (!anchor.range) {
		throw new SukshmashastraError("NOT_FOUND", `Anchor '${anchor.id}' has no resolved byte range for replace_node`);
	}

	const start = anchor.range.startByte;
	const end = anchor.range.endByte;

	if (start < 0 || end > source.length || start > end) {
		throw new SukshmashastraError(
			"NOT_FOUND",
			`Anchor range [${start}, ${end}] out of bounds for source length ${source.length}`,
		);
	}

	// Verify that replaced whole file will still be syntactically coherent
	const tentative = source.slice(0, start) + replacementText + source.slice(end);
	const syntaxCheck = checkSyntax(tentative, anchor.targetFile ?? anchor.file_id ?? "source.ts");
	if (!syntaxCheck.valid) {
		throw new SukshmashastraError(
			"REJECTED_SYNTAX_ERROR",
			`Replacement introduces syntax error: ${syntaxCheck.diagnostics.map((d) => d.message).join(", ")}`,
		);
	}

	const edit: ByteRangeEdit = {
		start,
		end,
		newText: replacementText,
		description: `Replace node ${anchor.selector}`,
	};

	return {
		edits: [edit],
		affectedNodes: [anchor.anchor_id ?? anchor.id ?? ""],
	};
}
