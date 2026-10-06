// Jālacitra atlas.discard Operation (Part M2, J5-INV-012)

import type { JalacitraStore } from "../store/store.ts";
import { buildQueryResult, type QueryContext, type QueryResult, type SnapshotMeta, UsageTracker } from "./context.ts";
import { computeSnapshotCoverage } from "./coverage-helper.ts";

export interface DiscardParams {
	scope: "all" | "historical_only";
	confirm: boolean;
}

export interface DiscardData {
	confirmed: boolean;
	discarded: boolean;
	scope: "all" | "historical_only";
	pruned_generations?: number[];
	deleted_nodes?: number;
	deleted_edges?: number;
	reason?: string;
}

export function discard(ctx: QueryContext, store: JalacitraStore, params: DiscardParams): QueryResult<DiscardData> {
	const tracker = new UsageTracker();
	const repoId = ctx.repository.repository_identity;
	const currentGen = store.getCurrentGeneration();
	const genNum = currentGen?.index_generation ?? 0;

	if (!params.confirm) {
		const snapshotMeta: SnapshotMeta = {
			snapshot_id: `snap:${repoId}:${genNum}`,
			index_generation: genNum,
			workspace_generation: currentGen?.workspace_generation ?? String(genNum),
			build_generation: currentGen?.build_generation ?? null,
		};
		return buildQueryResult<DiscardData>({
			snapshot: snapshotMeta,
			freshness: { requested: ctx.freshness, delivered: "UNVERIFIED", last_verified_at: new Date().toISOString() },
			data: {
				confirmed: false,
				discarded: false,
				scope: params.scope,
				reason: "CONFIRMATION_REQUIRED: Discard operation requires explicit confirm=true flag",
			},
			coverage: computeSnapshotCoverage(store, genNum, repoId),
			usage: tracker.report(),
		});
	}

	let prunedGenerations: number[] = [];
	let deletedNodes = 0;
	let deletedEdges = 0;

	if (params.scope === "historical_only") {
		const pruneResult = store.pruneGenerations(new Set(), 1);
		prunedGenerations = pruneResult.prunedGenerations;
		deletedNodes = pruneResult.deletedNodes;
		deletedEdges = pruneResult.deletedEdges;
	} else if (params.scope === "all") {
		// Wipe tables
		const db = store.rawDb;
		db.exec("DELETE FROM dependencies_of_rows;");
		db.exec("DELETE FROM region_members;");
		db.exec("DELETE FROM regions;");
		db.exec("DELETE FROM edges;");
		db.exec("DELETE FROM extractions;");
		db.exec("DELETE FROM files;");
		db.exec("DELETE FROM nodes;");
		db.exec("DELETE FROM build_journal;");
		db.exec("DELETE FROM generations;");
		db.exec("DELETE FROM meta;");
	}

	const snapshotMeta: SnapshotMeta = {
		snapshot_id: `snap:${repoId}:0`,
		index_generation: 0,
		workspace_generation: "0",
		build_generation: null,
	};

	const data: DiscardData = {
		confirmed: true,
		discarded: true,
		scope: params.scope,
		pruned_generations: prunedGenerations,
		deleted_nodes: deletedNodes,
		deleted_edges: deletedEdges,
	};

	return buildQueryResult<DiscardData>({
		snapshot: snapshotMeta,
		freshness: { requested: ctx.freshness, delivered: "FRESH", last_verified_at: new Date().toISOString() },
		data,
		coverage: {
			scope: { repo_id: repoId, snapshot_id: `snap:${repoId}:0`, generation: 0 },
			files_considered: 0,
			files_indexed: 0,
			files_skipped: [],
			languages: [],
			known_blind_spots: [],
			completeness: "UNKNOWN",
			limitations: ["Index was discarded"],
		},
		usage: tracker.report(),
	});
}
