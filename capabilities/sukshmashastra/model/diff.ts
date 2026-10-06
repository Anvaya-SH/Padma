// Sūkṣmaśastra Range-Replacement and Unified Diff Engine (Decision D-2, S6-TX-002, S6-PIPE-001)

import { generateUnifiedPatch } from "../../../packages/coding-agent/src/core/tools/edit-diff.ts";
import { SukshmashastraError } from "./reason-codes.ts";

export interface ByteRangeEdit {
	readonly start: number;
	readonly end: number;
	readonly newText: string;
	readonly description?: string;
}

export interface DiffHunk {
	readonly oldStart: number;
	readonly oldLines: number;
	readonly newStart: number;
	readonly newLines: number;
	readonly header: string;
	readonly lines: string[];
}

export interface FileDiffPreview {
	readonly path: string;
	readonly oldContent: string;
	readonly newContent: string;
	readonly patch: string;
	readonly addedLines: number;
	readonly removedLines: number;
	readonly hunksCount: number;
}

export interface UnifiedDiffReport {
	readonly files: FileDiffPreview[];
	readonly totalFiles: number;
	readonly totalAddedLines: number;
	readonly totalRemovedLines: number;
	readonly rawUnifiedDiff: string;
}

/**
 * Checks for overlapping range replacements in a file.
 * Returns true if valid (no overlaps), or throws SukshmashastraError("EDIT_OVERLAP") if overlap detected.
 */
export function validateNoOverlappingEdits(edits: readonly ByteRangeEdit[]): void {
	if (edits.length <= 1) return;

	// Sort primarily by start offset ascending, then by end offset
	const sorted = [...edits].sort((a, b) => {
		if (a.start !== b.start) return a.start - b.start;
		return a.end - b.end;
	});

	for (let i = 0; i < sorted.length - 1; i++) {
		const current = sorted[i];
		const next = sorted[i + 1];

		// If next starts before current ends, they overlap
		if (next.start < current.end) {
			throw new SukshmashastraError(
				"EDIT_OVERLAP",
				`Edits overlap between [${current.start}, ${current.end}] and [${next.start}, ${next.end}]`,
			);
		}
	}
}

/**
 * Applies a list of non-overlapping byte-range edits to original text.
 * Edits are sorted in descending order of start position so preceding offsets remain unaffected.
 */
export function applyRangeEdits(original: string, edits: readonly ByteRangeEdit[]): string {
	if (edits.length === 0) return original;

	validateNoOverlappingEdits(edits);

	// Sort descending by start offset
	const sorted = [...edits].sort((a, b) => b.start - a.start);

	let result = original;
	for (const edit of sorted) {
		if (edit.start < 0 || edit.end > result.length || edit.start > edit.end) {
			throw new Error(`Invalid range edit [${edit.start}, ${edit.end}] on text of length ${result.length}`);
		}
		result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
	}

	return result;
}

/**
 * Computes a unified diff between original and modified text for a file path.
 */
export function computeFileDiff(path: string, original: string, modified: string): FileDiffPreview {
	const patch = generateUnifiedPatch(path, original, modified);

	// Count additions and deletions from patch lines
	let added = 0;
	let removed = 0;
	let hunks = 0;

	for (const line of patch.split("\n")) {
		if (line.startsWith("@@")) {
			hunks++;
		} else if (line.startsWith("+") && !line.startsWith("+++")) {
			added++;
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			removed++;
		}
	}

	return {
		path,
		oldContent: original,
		newContent: modified,
		patch,
		addedLines: added,
		removedLines: removed,
		hunksCount: hunks,
	};
}

/**
 * Aggregates file diff previews into a complete UnifiedDiffReport.
 */
export function createUnifiedDiffReport(fileDiffs: FileDiffPreview[]): UnifiedDiffReport {
	let totalAdded = 0;
	let totalRemoved = 0;
	const patchParts: string[] = [];

	for (const fd of fileDiffs) {
		totalAdded += fd.addedLines;
		totalRemoved += fd.removedLines;
		if (fd.patch.trim()) {
			patchParts.push(fd.patch);
		}
	}

	return {
		files: fileDiffs,
		totalFiles: fileDiffs.length,
		totalAddedLines: totalAdded,
		totalRemovedLines: totalRemoved,
		rawUnifiedDiff: patchParts.join("\n"),
	};
}
