// Sūkṣmaśastra Worker Plan Merger (Part G, S6-RBS-003)
// Merges concurrent, non-overlapping StructuralEditPlans from different workers into a unified plan.

import type { Anchor } from "../model/anchors.ts";
import type { ByteRangeEdit } from "../model/diff.ts";
import type { StructuralEditPlan, Transformation } from "../model/plan.ts";
import { SukshmashastraError } from "../model/reason-codes.ts";
import { buildAndValidatePlan } from "../pipeline/plan-builder.ts";
import type { InMemoryArtifactStore } from "../ports/artifact-store.ts";
import { dispatchTransformation } from "../transformations/index.ts";

export interface MergeResult {
	readonly success: boolean;
	readonly mergedPlan?: StructuralEditPlan;
	readonly conflictReason?: string;
}

/**
 * Checks if two byte ranges overlap.
 */
function rangesOverlap(a: [number, number], b: [number, number]): boolean {
	return Math.max(a[0], b[0]) < Math.min(a[1], b[1]);
}

/**
 * Merges two distinct worker plans if they touch disjoint AST ranges (S6-RBS-003).
 */
export async function mergeWorkerPlans(
	planA: StructuralEditPlan,
	planB: StructuralEditPlan,
	files: ReadonlyMap<string, string>,
	artifactStore?: InMemoryArtifactStore,
): Promise<MergeResult> {
	// 1. Verify identical target repository binding
	if (
		planA.repo_binding.canonical_path !== planB.repo_binding.canonical_path ||
		planA.repo_binding.repository_identity !== planB.repo_binding.repository_identity
	) {
		throw new SukshmashastraError(
			"BINDING_MISMATCH",
			"Cannot merge worker plans targeting different repository bindings",
		);
	}

	// 2. Identify shared target files and check for overlapping AST changes
	const anchorsMapA = new Map(planA.anchors.map((a) => [a.anchor_id, a]));
	const anchorsMapB = new Map(planB.anchors.map((a) => [a.anchor_id, a]));
	for (const a of planA.anchors) if (a.id) anchorsMapA.set(a.id, a);
	for (const a of planB.anchors) if (a.id) anchorsMapB.set(a.id, a);

	const filesTouchedA = new Set(planA.transformations.map((t) => t.target_file));
	const filesTouchedB = new Set(planB.transformations.map((t) => t.target_file));

	for (const sharedFile of filesTouchedA) {
		if (filesTouchedB.has(sharedFile)) {
			const content = files.get(sharedFile);
			if (!content) {
				return {
					success: false,
					conflictReason: `Shared file '${sharedFile}' missing from context`,
				};
			}

			// Generate edits from both plans on sharedFile
			const editsA: ByteRangeEdit[] = [];
			for (const tx of planA.transformations.filter((t) => t.target_file === sharedFile)) {
				const res = await dispatchTransformation(content, tx, anchorsMapA);
				editsA.push(...res.edits);
			}

			const editsB: ByteRangeEdit[] = [];
			for (const tx of planB.transformations.filter((t) => t.target_file === sharedFile)) {
				const res = await dispatchTransformation(content, tx, anchorsMapB);
				editsB.push(...res.edits);
			}

			// Check for overlapping byte ranges
			for (const eA of editsA) {
				for (const eB of editsB) {
					if (rangesOverlap([eA.start, eA.end], [eB.start, eB.end])) {
						return {
							success: false,
							conflictReason: `Plans touch overlapping AST ranges in '${sharedFile}': [${eA.start}, ${eA.end}] vs [${eB.start}, ${eB.end}]`,
						};
					}
				}
			}
		}
	}

	// 3. Combine anchors and transformations without duplicates
	const combinedAnchors: Anchor[] = [...planA.anchors];
	const seenAnchorIds = new Set(planA.anchors.map((a) => a.anchor_id ?? a.id));

	for (const a of planB.anchors) {
		const key = a.anchor_id ?? a.id;
		if (!seenAnchorIds.has(key)) {
			combinedAnchors.push(a);
			seenAnchorIds.add(key);
		}
	}

	const combinedTransformations: Transformation[] = [...planA.transformations, ...planB.transformations];

	// 4. Build unified validated plan
	const mergedPlan = await buildAndValidatePlan({
		repoBinding: planA.repo_binding,
		activeBinding: planA.repo_binding,
		baseCommit: planA.base_commit,
		activeBaseCommit: planA.base_commit,
		workspaceGeneration: planA.workspace_generation,
		activeWorkspaceGeneration: planA.workspace_generation,
		intent: `Merged (${planA.plan_id} + ${planB.plan_id}): ${planA.intent} & ${planB.intent}`,
		anchors: combinedAnchors,
		transformations: combinedTransformations,
		files,
		artifactStore,
	});

	return {
		success: true,
		mergedPlan,
	};
}
