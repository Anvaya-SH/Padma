// Jālacitra atlas.neighbors Operation (Part M2, J5-ALG-001, J5-ALG-004)

import type { EdgeKind, EdgeRecord } from "../model/edges.ts";
import type { NodeRecord } from "../model/nodes.ts";
import { compareProvenance } from "../model/provenance.ts";
import type { JalacitraStore } from "../store/store.ts";
import { buildQueryResult, type QueryContext, type QueryResult, type SnapshotMeta, UsageTracker } from "./context.ts";
import { computeSnapshotCoverage } from "./coverage-helper.ts";

export interface NeighborsParams {
	node_id: string;
	edge_kinds?: EdgeKind[];
	direction?: "forward" | "backward" | "both";
	depth?: number;
	max_nodes?: number;
	expand_hubs?: boolean;
}

export interface HubNodeNotice {
	node_id: string;
	degree: number;
}

export interface NeighborsData {
	root_node_id: string;
	nodes: NodeRecord[];
	edges: EdgeRecord[];
	frontier_truncated: boolean;
	unexpanded_hubs: HubNodeNotice[];
}

export const DEFAULT_HUB_DEGREE_THRESHOLD = 500;

export function neighbors(
	ctx: QueryContext,
	store: JalacitraStore,
	params: NeighborsParams,
): QueryResult<NeighborsData> {
	const tracker = new UsageTracker();
	const repoId = ctx.repository.repository_identity;
	const currentGen = store.getCurrentGeneration();
	const genNum = currentGen?.index_generation ?? 1;

	const maxDepth = Math.min(Math.max(1, params.depth ?? 1), 4);
	const maxNodes = Math.min(Math.max(1, params.max_nodes ?? 100), 2000);
	const direction = params.direction ?? "both";
	const expandHubs = params.expand_hubs ?? false;
	const allowedEdgeKinds = params.edge_kinds ? new Set(params.edge_kinds) : null;

	const db = store.rawDb;

	const visitedNodes = new Set<string>();
	const collectedNodes = new Map<string, NodeRecord>();
	const collectedEdges = new Map<string, EdgeRecord>();
	const unexpandedHubs: HubNodeNotice[] = [];
	let frontierTruncated = false;

	// Initial node
	const rootNode = store.getNode(params.node_id, genNum);
	if (!rootNode) {
		const emptyMeta: SnapshotMeta = {
			snapshot_id: `snap:${repoId}:${genNum}`,
			index_generation: genNum,
			workspace_generation: currentGen?.workspace_generation ?? String(genNum),
			build_generation: currentGen?.build_generation ?? null,
		};
		return buildQueryResult<NeighborsData>({
			snapshot: emptyMeta,
			freshness: { requested: ctx.freshness, delivered: "FRESH", last_verified_at: new Date().toISOString() },
			data: {
				root_node_id: params.node_id,
				nodes: [],
				edges: [],
				frontier_truncated: false,
				unexpanded_hubs: [],
			},
			coverage: computeSnapshotCoverage(store, genNum, repoId),
			negative_evidence: [
				{ checked: `node_id:${params.node_id}`, result: "NODE_NOT_FOUND", completeness: "EXACT_WITHIN_INDEX" },
			],
			usage: tracker.report(),
		});
	}

	collectedNodes.set(rootNode.id, rootNode);
	visitedNodes.add(rootNode.id);

	interface QueueItem {
		id: string;
		depth: number;
	}
	const queue: QueueItem[] = [{ id: rootNode.id, depth: 0 }];

	while (queue.length > 0) {
		const item = queue.shift();
		if (!item) break;
		if (item.depth >= maxDepth) continue;

		// Check hub degree (J5-ALG-004)
		const degreeRow = db
			.prepare(
				`SELECT COUNT(*) as count FROM edges 
				 WHERE (src = ? OR dst = ?) 
				   AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`,
			)
			.get(item.id, item.id, genNum, genNum) as { count: number } | undefined;
		const degree = Number(degreeRow?.count ?? 0);
		tracker.recordRowsScanned();

		if (degree > DEFAULT_HUB_DEGREE_THRESHOLD && !expandHubs && item.id !== rootNode.id) {
			unexpandedHubs.push({ node_id: item.id, degree });
			continue;
		}

		// Fetch outgoing edges if direction is forward or both
		let incidentEdges: EdgeRecord[] = [];
		if (direction === "forward" || direction === "both") {
			incidentEdges = incidentEdges.concat(store.getEdgesFrom(item.id, undefined, genNum));
		}
		if (direction === "backward" || direction === "both") {
			incidentEdges = incidentEdges.concat(store.getEdgesTo(item.id, undefined, genNum));
		}
		tracker.recordRowsScanned(incidentEdges.length);

		for (const edge of incidentEdges) {
			if (allowedEdgeKinds && !allowedEdgeKinds.has(edge.kind)) {
				continue;
			}
			if (!ctx.allow_provenance.includes(edge.class)) {
				continue;
			}

			collectedEdges.set(edge.id, edge);

			const neighborId = edge.src === item.id ? edge.dst : edge.src;
			if (!visitedNodes.has(neighborId)) {
				if (collectedNodes.size >= maxNodes) {
					frontierTruncated = true;
					break;
				}
				visitedNodes.add(neighborId);
				const neighborNode = store.getNode(neighborId, genNum);
				if (neighborNode) {
					collectedNodes.set(neighborNode.id, neighborNode);
					queue.push({ id: neighborId, depth: item.depth + 1 });
				}
			}
		}

		if (frontierTruncated) break;
	}

	// Deterministic sorting (J5-API-002)
	const sortedNodes = Array.from(collectedNodes.values()).sort(
		(a, b) => a.kind.localeCompare(b.kind) || a.canonical.localeCompare(b.canonical),
	);
	const sortedEdges = Array.from(collectedEdges.values()).sort((a, b) => {
		const classCmp = compareProvenance(a.class, b.class);
		if (classCmp !== 0) return classCmp;
		const kindCmp = a.kind.localeCompare(b.kind);
		if (kindCmp !== 0) return kindCmp;
		return a.id.localeCompare(b.id);
	});

	tracker.recordRowsReturned(sortedNodes.length + sortedEdges.length);

	const snapshotMeta: SnapshotMeta = {
		snapshot_id: `snap:${repoId}:${genNum}`,
		index_generation: genNum,
		workspace_generation: currentGen?.workspace_generation ?? String(genNum),
		build_generation: currentGen?.build_generation ?? null,
	};

	const coverage = computeSnapshotCoverage(store, genNum, repoId);

	const data: NeighborsData = {
		root_node_id: params.node_id,
		nodes: sortedNodes,
		edges: sortedEdges,
		frontier_truncated: frontierTruncated,
		unexpanded_hubs: unexpandedHubs,
	};

	return buildQueryResult<NeighborsData>({
		snapshot: snapshotMeta,
		freshness: { requested: ctx.freshness, delivered: "FRESH", last_verified_at: new Date().toISOString() },
		data,
		coverage,
		truncation: frontierTruncated
			? { truncated: true, reason: "MAX_ROWS", omitted_count_lower_bound: 1 }
			: { truncated: false },
		usage: tracker.report(),
	});
}
