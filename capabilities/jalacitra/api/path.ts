// Jālacitra atlas.path Operation (Part M2, J5-ALG-005)

import type { EdgeKind, EdgeRecord } from "../model/edges.ts";
import type { NodeRecord } from "../model/nodes.ts";
import { PROVENANCE_RANK, type ProvenanceClass, weakestProvenance } from "../model/provenance.ts";
import type { JalacitraStore } from "../store/store.ts";
import { buildQueryResult, type QueryContext, type QueryResult, type SnapshotMeta, UsageTracker } from "./context.ts";
import { computeSnapshotCoverage } from "./coverage-helper.ts";

export interface PathParams {
	from: string;
	to: string;
	edge_kinds?: EdgeKind[];
	max_depth?: number;
	k_paths?: number;
}

export interface GraphPath {
	nodes: NodeRecord[];
	edges: EdgeRecord[];
	provenance_class: ProvenanceClass;
	hops: number;
}

export interface PathData {
	from_id: string;
	to_id: string;
	found: boolean;
	no_path_within_bound?: number;
	paths: GraphPath[];
}

export function findPath(ctx: QueryContext, store: JalacitraStore, params: PathParams): QueryResult<PathData> {
	const tracker = new UsageTracker();
	const repoId = ctx.repository.repository_identity;
	const currentGen = store.getCurrentGeneration();
	const genNum = currentGen?.index_generation ?? 1;

	const maxDepth = Math.min(Math.max(1, params.max_depth ?? 5), 10);
	const kPaths = Math.min(Math.max(1, params.k_paths ?? 3), 10);
	const allowedEdgeKinds = params.edge_kinds ? new Set(params.edge_kinds) : null;

	const startNode = store.getNode(params.from, genNum);
	const endNode = store.getNode(params.to, genNum);

	if (!startNode || !endNode) {
		const snapshotMeta: SnapshotMeta = {
			snapshot_id: `snap:${repoId}:${genNum}`,
			index_generation: genNum,
			workspace_generation: currentGen?.workspace_generation ?? String(genNum),
			build_generation: currentGen?.build_generation ?? null,
		};
		return buildQueryResult<PathData>({
			snapshot: snapshotMeta,
			freshness: { requested: ctx.freshness, delivered: "FRESH", last_verified_at: new Date().toISOString() },
			data: {
				from_id: params.from,
				to_id: params.to,
				found: false,
				no_path_within_bound: maxDepth,
				paths: [],
			},
			coverage: computeSnapshotCoverage(store, genNum, repoId),
			negative_evidence: [
				{
					checked: `endpoints:${params.from}->${params.to}`,
					result: "ENDPOINT_NODE_NOT_FOUND",
					completeness: "EXACT_WITHIN_INDEX",
				},
			],
			usage: tracker.report(),
		});
	}

	interface QueueEntry {
		currId: string;
		pathNodes: string[];
		pathEdges: EdgeRecord[];
	}

	const queue: QueueEntry[] = [{ currId: params.from, pathNodes: [params.from], pathEdges: [] }];

	const foundPaths: Array<{ nodeIds: string[]; edges: EdgeRecord[] }> = [];
	let shortestLength = Infinity;

	while (queue.length > 0) {
		const entry = queue.shift();
		if (!entry) break;

		if (entry.pathEdges.length > shortestLength) {
			break;
		}

		if (entry.currId === params.to && entry.pathEdges.length > 0) {
			foundPaths.push({ nodeIds: entry.pathNodes, edges: entry.pathEdges });
			shortestLength = entry.pathEdges.length;
			if (foundPaths.length >= kPaths * 2) {
				break;
			}
			continue;
		}

		if (entry.pathEdges.length >= maxDepth) {
			continue;
		}

		// Forward edges
		const outgoing = store.getEdgesFrom(entry.currId, undefined, genNum);
		tracker.recordRowsScanned(outgoing.length);

		for (const edge of outgoing) {
			if (allowedEdgeKinds && !allowedEdgeKinds.has(edge.kind)) continue;
			if (!ctx.allow_provenance.includes(edge.class)) continue;
			if (entry.pathNodes.includes(edge.dst)) continue; // cycle prevention

			queue.push({
				currId: edge.dst,
				pathNodes: [...entry.pathNodes, edge.dst],
				pathEdges: [...entry.pathEdges, edge],
			});
		}
	}

	// Score and sort paths according to J5-ALG-005:
	// 1. Prefer stronger provenance classes (sum of PROVENANCE_RANK)
	// 2. Fewer ambiguous edges (count non-UNIQUE)
	// 3. Lexicographic canonical identities
	const scoredPaths = foundPaths.map((p) => {
		const provScore = p.edges.reduce((sum, e) => sum + (PROVENANCE_RANK[e.class] ?? 1), 0);
		const ambiguousCount = p.edges.filter((e) => e.ambiguity !== "UNIQUE").length;
		const nodes = p.nodeIds.map((id) => store.getNode(id, genNum)).filter((n): n is NodeRecord => n !== null);
		const canonicalStr = nodes.map((n) => n.canonical).join(" -> ");
		const weakest = weakestProvenance(p.edges.map((e) => e.class));

		return {
			nodes,
			edges: p.edges,
			hops: p.edges.length,
			provenance_class: weakest,
			provScore,
			ambiguousCount,
			canonicalStr,
		};
	});

	scoredPaths.sort((a, b) => {
		if (a.hops !== b.hops) return a.hops - b.hops;
		if (b.provScore !== a.provScore) return b.provScore - a.provScore; // higher score first
		if (a.ambiguousCount !== b.ambiguousCount) return a.ambiguousCount - b.ambiguousCount; // fewer ambiguous first
		return a.canonicalStr.localeCompare(b.canonicalStr);
	});

	const selectedPaths: GraphPath[] = scoredPaths.slice(0, kPaths).map((p) => ({
		nodes: p.nodes,
		edges: p.edges,
		provenance_class: p.provenance_class,
		hops: p.hops,
	}));

	tracker.recordRowsReturned(selectedPaths.length);

	const snapshotMeta: SnapshotMeta = {
		snapshot_id: `snap:${repoId}:${genNum}`,
		index_generation: genNum,
		workspace_generation: currentGen?.workspace_generation ?? String(genNum),
		build_generation: currentGen?.build_generation ?? null,
	};

	const coverage = computeSnapshotCoverage(store, genNum, repoId);

	const data: PathData = {
		from_id: params.from,
		to_id: params.to,
		found: selectedPaths.length > 0,
		no_path_within_bound: selectedPaths.length === 0 ? maxDepth : undefined,
		paths: selectedPaths,
	};

	return buildQueryResult<PathData>({
		snapshot: snapshotMeta,
		freshness: { requested: ctx.freshness, delivered: "FRESH", last_verified_at: new Date().toISOString() },
		data,
		coverage,
		usage: tracker.report(),
	});
}
