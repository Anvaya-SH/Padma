// Sūkṣmaśastra Structural Rebase & Three-Way Conflict Analysis (Part G, S6-RBS-001..005)
// Re-resolves anchors against modified base revisions, detects AST conflicts,
// and produces new immutably linked StructuralEditPlans.

import { resolveAnchor } from "../anchors/resolver.ts";
import type { Anchor } from "../model/anchors.ts";
import type { ByteRangeEdit } from "../model/diff.ts";
import type { StructuralEditPlan } from "../model/plan.ts";
import { buildAndValidatePlan } from "../pipeline/plan-builder.ts";
import type { InMemoryArtifactStore } from "../ports/artifact-store.ts";

export interface ThreeWayConflictItem {
	readonly filePath: string;
	readonly baseRange: [number, number];
	readonly reason: string;
	readonly description: string;
}

export interface ThreeWayConflictReport {
	readonly clean: boolean;
	readonly conflicts: readonly ThreeWayConflictItem[];
}

export interface RebaseResult {
	readonly success: boolean;
	readonly newPlan?: StructuralEditPlan;
	readonly conflictReport?: ThreeWayConflictReport;
	readonly semanticRecheckRecommended: boolean;
}

/**
 * Computes three-way conflict between baseContent, currentContent (theirs), and planned edits (ours).
 */
export function analyzeThreeWayConflict(
	filePath: string,
	baseContent: string,
	currentContent: string,
	plannedEdits: readonly ByteRangeEdit[],
): ThreeWayConflictReport {
	const conflicts: ThreeWayConflictItem[] = [];

	if (baseContent === currentContent) {
		return { clean: true, conflicts: [] };
	}

	for (const edit of plannedEdits) {
		const baseSnippet = baseContent.slice(edit.start, edit.end);
		const currentSnippet = currentContent.slice(edit.start, edit.end);

		// If current content in the planned edit range has diverged from baseContent
		if (baseSnippet !== currentSnippet) {
			conflicts.push({
				filePath,
				baseRange: [edit.start, edit.end],
				reason: "CONFLICT",
				description: `Target range [${edit.start}, ${edit.end}] in '${filePath}' was modified concurrently by another writer`,
			});
		}
	}

	return {
		clean: conflicts.length === 0,
		conflicts,
	};
}

/**
 * Re-resolves an existing StructuralEditPlan against fresh workspace files (S6-RBS-001..005).
 */
export async function rebasePlan(
	plan: StructuralEditPlan,
	updatedFiles: ReadonlyMap<string, string>,
	options: {
		readonly newBaseCommit?: string;
		readonly newWorkspaceGeneration?: string;
		readonly artifactStore?: InMemoryArtifactStore;
	} = {},
): Promise<RebaseResult> {
	const rebasedAnchors: Anchor[] = [];
	let hasMovedNodes = false;
	const conflicts: ThreeWayConflictItem[] = [];

	// Re-resolve all anchors against fresh file content
	for (const anchor of plan.anchors) {
		const targetFile = anchor.targetFile ?? anchor.file_id.replace(/^file:/, "");
		const freshContent = updatedFiles.get(targetFile);

		if (freshContent === undefined) {
			conflicts.push({
				filePath: targetFile,
				baseRange: anchor.source_range ?? [0, 0],
				reason: "NOT_FOUND",
				description: `Target file '${targetFile}' not found in updated workspace`,
			});
			continue;
		}

		const bytes = new TextEncoder().encode(freshContent);
		const res = resolveAnchor(anchor, bytes);

		if (res.status === "NOT_FOUND") {
			conflicts.push({
				filePath: targetFile,
				baseRange: anchor.source_range ?? [0, 0],
				reason: "NOT_FOUND",
				description: `Anchor '${anchor.structural_selector ?? anchor.selector}' deleted or not found in updated '${targetFile}'`,
			});
			continue;
		}

		if (res.status === "AMBIGUOUS") {
			conflicts.push({
				filePath: targetFile,
				baseRange: anchor.source_range ?? [0, 0],
				reason: "AMBIGUOUS",
				description: `Anchor '${anchor.structural_selector ?? anchor.selector}' became ambiguous in updated '${targetFile}'`,
			});
			continue;
		}

		if (res.status === "MOVED") {
			hasMovedNodes = true;
			rebasedAnchors.push({
				...anchor,
				source_range: res.range,
				range: {
					startByte: res.range[0],
					endByte: res.range[1],
				},
			});
			continue;
		}

		if (res.status === "RESOLVED_UNIQUE") {
			rebasedAnchors.push({
				...anchor,
				source_range: res.range,
				range: {
					startByte: res.range[0],
					endByte: res.range[1],
				},
			});
			continue;
		}

		// STALE_PREIMAGE without resolution
		conflicts.push({
			filePath: targetFile,
			baseRange: anchor.source_range ?? [0, 0],
			reason: "CONFLICT",
			description: `File '${targetFile}' changed and anchor could not be cleanly re-established`,
		});
	}

	if (conflicts.length > 0) {
		return {
			success: false,
			conflictReport: { clean: false, conflicts },
			semanticRecheckRecommended: true,
		};
	}

	// S6-RBS-001 & S6-RBS-005: Build new plan pointing to parent_plan_id
	const newPlan = await buildAndValidatePlan({
		repoBinding: plan.repo_binding,
		activeBinding: plan.repo_binding,
		baseCommit: options.newBaseCommit ?? plan.base_commit,
		activeBaseCommit: options.newBaseCommit ?? plan.base_commit,
		workspaceGeneration: options.newWorkspaceGeneration ?? plan.workspace_generation,
		activeWorkspaceGeneration: options.newWorkspaceGeneration ?? plan.workspace_generation,
		intent: `Rebase of ${plan.plan_id}: ${plan.intent}`,
		anchors: rebasedAnchors,
		transformations: plan.transformations,
		files: updatedFiles,
		artifactStore: options.artifactStore,
	});

	const finalPlan: StructuralEditPlan = {
		...newPlan,
		parent_plan_id: plan.plan_id,
	};

	return {
		success: true,
		newPlan: finalPlan,
		conflictReport: { clean: true, conflicts: [] },
		semanticRecheckRecommended: hasMovedNodes,
	};
}
