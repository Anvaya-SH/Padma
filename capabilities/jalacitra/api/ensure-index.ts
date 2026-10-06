// Jālacitra atlas.ensure_index Operation (Part M2, J5-LONG-001, J5-PIPE-001)

import { type BuildOptions, IndexUpdatePipeline } from "../invalidate/update-pipeline.ts";
import type { JalacitraStore } from "../store/store.ts";
import { buildQueryResult, type QueryContext, type QueryResult, type SnapshotMeta, UsageTracker } from "./context.ts";
import { computeSnapshotCoverage } from "./coverage-helper.ts";

export interface EnsureIndexScope {
	paths?: string[];
	package_names?: string[];
	shrink_override_reason?: string;
}

export interface EnsureIndexData {
	status: "UP_TO_DATE" | "UPDATED" | "DURABLE_DISPATCHED" | "FAILED";
	generation: number;
	files_changed: number;
	nodes_count: number;
	edges_count: number;
	plan_summary: string;
	durable_handle?: {
		operation_id: string;
		stage: string;
	};
	error_reason?: string;
}

export function ensureIndex(
	ctx: QueryContext,
	store: JalacitraStore,
	scope?: EnsureIndexScope,
): QueryResult<EnsureIndexData> {
	const tracker = new UsageTracker();
	const repoId = ctx.repository.repository_identity;
	const repoRoot = ctx.repository.canonical_path;

	const pipeline = new IndexUpdatePipeline();
	const buildOpts: BuildOptions = {
		repoRoot,
		repoIdentity: repoId,
		workspaceGeneration: ctx.repository.generation ?? "1",
		shrinkOverrideReason: scope?.shrink_override_reason,
	};

	const result = pipeline.buildFullOrIncremental(store, buildOpts);
	tracker.recordFileRead(result.filesIndexed);

	const currentGen = store.getCurrentGeneration();
	const genNum = currentGen?.index_generation ?? result.generation;

	const snapshotMeta: SnapshotMeta = {
		snapshot_id: `snap:${repoId}:${genNum}`,
		index_generation: genNum,
		workspace_generation: currentGen?.workspace_generation ?? String(genNum),
		build_generation: currentGen?.build_generation ?? null,
	};

	const coverage = computeSnapshotCoverage(store, genNum, repoId);

	let opStatus: EnsureIndexData["status"] = "UPDATED";
	let planSummary = `Committed generation ${genNum} with ${result.nodesCount} nodes, ${result.edgesCount} edges.`;

	if (!result.success) {
		opStatus = "FAILED";
		planSummary = `Build failed: ${result.abortedReason ?? "Unknown error"}`;
	} else if (result.filesIndexed === 0 && genNum > 1) {
		opStatus = "UP_TO_DATE";
		planSummary = `Index is current at generation ${genNum}. Zero files changed.`;
	}

	const data: EnsureIndexData = {
		status: opStatus,
		generation: genNum,
		files_changed: result.filesIndexed,
		nodes_count: result.nodesCount,
		edges_count: result.edgesCount,
		plan_summary: planSummary,
		error_reason: result.abortedReason,
	};

	return buildQueryResult<EnsureIndexData>({
		snapshot: snapshotMeta,
		freshness: {
			requested: ctx.freshness,
			delivered: result.success ? "FRESH" : "STALE",
			downgrade_reason: result.success ? undefined : "SHRINK_GUARD",
			last_verified_at: new Date().toISOString(),
		},
		data,
		coverage,
		usage: tracker.report(),
	});
}
