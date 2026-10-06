// Jālacitra atlas.status Operation (Part M2, J5-OBS-002)

import { existsSync, statSync } from "node:fs";
import type { LanguageCoverage } from "../model/coverage.ts";
import type { JalacitraStore } from "../store/store.ts";
import { buildQueryResult, type QueryContext, type QueryResult, type SnapshotMeta, UsageTracker } from "./context.ts";
import { computeSnapshotCoverage } from "./coverage-helper.ts";

export interface AtlasStatusData {
	store_exists: boolean;
	repo_identity: string;
	index_generation: number;
	workspace_generation: string | null;
	build_generation: string | null;
	last_build_committed_at: string | null;
	last_build_outcome: string;
	is_building: boolean;
	node_counts_by_kind: Record<string, number>;
	edge_counts_by_kind: Record<string, number>;
	edge_counts_by_class: Record<string, number>;
	total_nodes: number;
	total_edges: number;
	store_size_bytes: number;
	languages: LanguageCoverage[];
	blind_spot_totals: Record<string, number>;
	outstanding_invalidations: number;
}

export function status(ctx: QueryContext, store: JalacitraStore | null, dbPath?: string): QueryResult<AtlasStatusData> {
	const tracker = new UsageTracker();
	const repoId = ctx.repository.repository_identity;

	if (!store || (dbPath && !existsSync(dbPath))) {
		const emptySnapshot: SnapshotMeta = {
			snapshot_id: `snap:${repoId}:0`,
			index_generation: 0,
			workspace_generation: "0",
			build_generation: null,
		};
		return buildQueryResult<AtlasStatusData>({
			snapshot: emptySnapshot,
			freshness: {
				requested: ctx.freshness,
				delivered: "UNVERIFIED",
				downgrade_reason: "INDEX_ABSENT",
				last_verified_at: new Date().toISOString(),
			},
			data: {
				store_exists: false,
				repo_identity: repoId,
				index_generation: 0,
				workspace_generation: null,
				build_generation: null,
				last_build_committed_at: null,
				last_build_outcome: "NONE",
				is_building: false,
				node_counts_by_kind: {},
				edge_counts_by_kind: {},
				edge_counts_by_class: {},
				total_nodes: 0,
				total_edges: 0,
				store_size_bytes: 0,
				languages: [],
				blind_spot_totals: {},
				outstanding_invalidations: 0,
			},
			coverage: {
				scope: { repo_id: repoId, snapshot_id: `snap:${repoId}:0`, generation: 0 },
				files_considered: 0,
				files_indexed: 0,
				files_skipped: [],
				languages: [],
				known_blind_spots: [],
				completeness: "UNKNOWN",
				limitations: ["Store absent; indexing is required"],
			},
			usage: tracker.report(),
		});
	}

	const db = store.rawDb;
	let storeSizeBytes = 0;
	if (dbPath && dbPath !== ":memory:" && existsSync(dbPath)) {
		try {
			storeSizeBytes = statSync(dbPath).size;
		} catch {
			storeSizeBytes = 0;
		}
	}

	const currentGen = store.getCurrentGeneration();
	const genNum = currentGen?.index_generation ?? 0;
	const activeJournal = store.journal.getActive();
	const isBuilding = activeJournal !== null && activeJournal.state === "RUNNING";

	// Counts by node kind
	const nodeKindRows = db
		.prepare(
			`SELECT kind, COUNT(*) as count FROM nodes 
			 WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) 
			 GROUP BY kind`,
		)
		.all(genNum, genNum) as Array<{ kind: string; count: number }>;
	tracker.recordRowsScanned(nodeKindRows.length);
	const nodeCountsByKind: Record<string, number> = {};
	let totalNodes = 0;
	for (const r of nodeKindRows) {
		const c = Number(r.count);
		nodeCountsByKind[r.kind] = c;
		totalNodes += c;
	}

	// Counts by edge kind
	const edgeKindRows = db
		.prepare(
			`SELECT kind, COUNT(*) as count FROM edges 
			 WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) 
			 GROUP BY kind`,
		)
		.all(genNum, genNum) as Array<{ kind: string; count: number }>;
	tracker.recordRowsScanned(edgeKindRows.length);
	const edgeCountsByKind: Record<string, number> = {};
	let totalEdges = 0;
	for (const r of edgeKindRows) {
		const c = Number(r.count);
		edgeCountsByKind[r.kind] = c;
		totalEdges += c;
	}

	// Counts by edge class
	const edgeClassRows = db
		.prepare(
			`SELECT class, COUNT(*) as count FROM edges 
			 WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) 
			 GROUP BY class`,
		)
		.all(genNum, genNum) as Array<{ class: string; count: number }>;
	tracker.recordRowsScanned(edgeClassRows.length);
	const edgeCountsByClass: Record<string, number> = {};
	for (const r of edgeClassRows) {
		edgeCountsByClass[r.class] = Number(r.count);
	}

	const coverage = computeSnapshotCoverage(store, genNum, repoId);

	const blindSpotTotals: Record<string, number> = {};
	for (const bs of coverage.known_blind_spots) {
		blindSpotTotals[bs.code] = bs.count;
	}

	const snapshotMeta: SnapshotMeta = {
		snapshot_id: `snap:${repoId}:${genNum}`,
		index_generation: genNum,
		workspace_generation: currentGen?.workspace_generation ?? String(genNum),
		build_generation: currentGen?.build_generation ?? null,
	};

	const data: AtlasStatusData = {
		store_exists: true,
		repo_identity: repoId,
		index_generation: genNum,
		workspace_generation: currentGen?.workspace_generation ?? null,
		build_generation: currentGen?.build_generation ?? null,
		last_build_committed_at: currentGen?.committed_at ?? null,
		last_build_outcome: currentGen ? "COMMITTED" : "NONE",
		is_building: isBuilding,
		node_counts_by_kind: nodeCountsByKind,
		edge_counts_by_kind: edgeCountsByKind,
		edge_counts_by_class: edgeCountsByClass,
		total_nodes: totalNodes,
		total_edges: totalEdges,
		store_size_bytes: storeSizeBytes,
		languages: coverage.languages,
		blind_spot_totals: blindSpotTotals,
		outstanding_invalidations: 0,
	};

	return buildQueryResult<AtlasStatusData>({
		snapshot: snapshotMeta,
		freshness: {
			requested: ctx.freshness,
			delivered: genNum > 0 ? "FRESH" : "UNVERIFIED",
			index_building: isBuilding,
			last_verified_at: new Date().toISOString(),
		},
		data,
		coverage,
		usage: tracker.report(),
	});
}
