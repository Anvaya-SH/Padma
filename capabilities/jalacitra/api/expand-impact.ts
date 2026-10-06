// Jālacitra atlas.expand_impact Operation (Part M2, J5-ALG-002, J5-ALG-004, J5-TSE-003)

import { isDependentHop } from "../model/edge-semantics.ts";
import type { EdgeKind, EdgeRecord } from "../model/edges.ts";
import type { NodeRecord } from "../model/nodes.ts";
import { compareProvenance, type ProvenanceClass, weakestProvenance } from "../model/provenance.ts";
import type { JalacitraStore } from "../store/store.ts";
import { buildQueryResult, type QueryContext, type QueryResult, type SnapshotMeta, UsageTracker } from "./context.ts";
import { computeSnapshotCoverage } from "./coverage-helper.ts";

export interface ExpandImpactParams {
	symbol_id?: string;
	file_id?: string;
	edge_types?: EdgeKind[];
	direction?: "dependents";
	depth?: number;
	max_nodes?: number;
	expand_hubs?: boolean;
	runtime_only?: boolean;
}

export interface ImpactItem {
	node: NodeRecord;
	hop_distance: number;
	provenance_class: ProvenanceClass;
	reachable_only_via_inferred: boolean;
	reachable_via_multi: boolean;
	via_candidate_group?: string;
}

export interface ExpandImpactData {
	root_id: string;
	impact_is_potential_not_proven: true; // Mandatory contract
	runtime_only_filter: boolean;
	total_impacted_nodes: number;
	items_by_hop: Record<number, ImpactItem[]>;
	items_by_provenance: Record<ProvenanceClass, ImpactItem[]>;
	blind_spots_in_region: Record<string, number>;
	unexpanded_hubs: Array<{ node_id: string; degree: number }>;
}

export const DEFAULT_IMPACT_EDGE_TYPES: EdgeKind[] = [
	"calls",
	"references",
	"imports",
	"extends",
	"overrides",
	"tests",
	"reads_config",
	"exposes",
	"generates",
];

export function expandImpact(
	ctx: QueryContext,
	store: JalacitraStore,
	params: ExpandImpactParams,
): QueryResult<ExpandImpactData> {
	const tracker = new UsageTracker();
	const repoId = ctx.repository.repository_identity;
	const currentGen = store.getCurrentGeneration();
	const genNum = currentGen?.index_generation ?? 1;

	const rootId = params.symbol_id ?? params.file_id;
	if (!rootId) {
		throw new Error("expandImpact requires symbol_id or file_id");
	}

	const maxDepth = Math.min(Math.max(1, params.depth ?? 2), 6);
	const maxNodes = Math.min(Math.max(1, params.max_nodes ?? 200), 2000);
	const expandHubs = params.expand_hubs ?? false;
	const runtimeOnly = params.runtime_only ?? false;
	const allowedEdgeTypes = new Set(params.edge_types ?? DEFAULT_IMPACT_EDGE_TYPES);

	const db = store.rawDb;

	const visited = new Set<string>([rootId]);
	const impactItems = new Map<string, ImpactItem>();
	const unexpandedHubs: Array<{ node_id: string; degree: number }> = [];
	let truncated = false;

	interface TraversalState {
		nodeId: string;
		hop: number;
		pathClasses: ProvenanceClass[];
		hasInferredInPath: boolean;
		hasMultiInPath: boolean;
		candidateGroup?: string;
	}

	const queue: TraversalState[] = [
		{
			nodeId: rootId,
			hop: 0,
			pathClasses: ["RUNTIME_CONFIRMED"],
			hasInferredInPath: false,
			hasMultiInPath: false,
		},
	];

	const affectedFileNodeIds = new Set<string>();

	while (queue.length > 0) {
		const state = queue.shift();
		if (!state) break;
		if (state.hop >= maxDepth) continue;

		// Check hub node degree
		const degRow = db
			.prepare(
				`SELECT COUNT(*) as count FROM edges 
				 WHERE (src = ? OR dst = ?) 
				   AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`,
			)
			.get(state.nodeId, state.nodeId, genNum, genNum) as { count: number } | undefined;
		const degree = Number(degRow?.count ?? 0);
		tracker.recordRowsScanned();

		if (degree > 500 && !expandHubs && state.nodeId !== rootId) {
			unexpandedHubs.push({ node_id: state.nodeId, degree });
			continue;
		}

		// In dependents traversal:
		// We want edges where isDependentHop is satisfied
		// Check edges incoming to state.nodeId (dst = state.nodeId, hop dst_to_src)
		const incomingEdges = store.getEdgesTo(state.nodeId, undefined, genNum);
		// Check edges outgoing from state.nodeId (src = state.nodeId, hop src_to_dst)
		const outgoingEdges = store.getEdgesFrom(state.nodeId, undefined, genNum);
		tracker.recordRowsScanned(incomingEdges.length + outgoingEdges.length);

		const candidateEdges: Array<{ edge: EdgeRecord; nextId: string }> = [];

		for (const edge of incomingEdges) {
			if (allowedEdgeTypes.has(edge.kind) && isDependentHop(edge.kind, "dst_to_src")) {
				candidateEdges.push({ edge, nextId: edge.src });
			}
		}

		for (const edge of outgoingEdges) {
			if (allowedEdgeTypes.has(edge.kind) && isDependentHop(edge.kind, "src_to_dst")) {
				candidateEdges.push({ edge, nextId: edge.dst });
			}
		}

		for (const { edge, nextId } of candidateEdges) {
			// Type-only filter (J5-TSE-003)
			if (runtimeOnly && edge.attrs?.type_only === true) {
				continue;
			}
			// Provenance filter
			if (!ctx.allow_provenance.includes(edge.class)) {
				continue;
			}

			const nextHop = state.hop + 1;
			const nextPathClasses = [...state.pathClasses, edge.class];
			const isEdgeInferred = edge.class === "INFERRED";
			const isEdgeMulti = edge.ambiguity === "MULTI";
			const candidateGroup = edge.candidate_group ?? state.candidateGroup;

			if (!visited.has(nextId)) {
				if (impactItems.size >= maxNodes) {
					truncated = true;
					break;
				}
				visited.add(nextId);

				const nodeRecord = store.getNode(nextId, genNum);
				if (nodeRecord) {
					const fileId = nodeRecord.parent_id ?? nodeRecord.id;
					affectedFileNodeIds.add(fileId);

					const item: ImpactItem = {
						node: nodeRecord,
						hop_distance: nextHop,
						provenance_class: weakestProvenance(nextPathClasses),
						reachable_only_via_inferred: state.hasInferredInPath || isEdgeInferred,
						reachable_via_multi: state.hasMultiInPath || isEdgeMulti,
						via_candidate_group: candidateGroup ?? undefined,
					};
					impactItems.set(nextId, item);

					queue.push({
						nodeId: nextId,
						hop: nextHop,
						pathClasses: nextPathClasses,
						hasInferredInPath: state.hasInferredInPath || isEdgeInferred,
						hasMultiInPath: state.hasMultiInPath || isEdgeMulti,
						candidateGroup,
					});
				}
			}
		}

		if (truncated) break;
	}

	// Group items by hop distance and provenance class
	const itemsByHop: Record<number, ImpactItem[]> = {};
	const itemsByProvenance: Record<ProvenanceClass, ImpactItem[]> = {
		RUNTIME_CONFIRMED: [],
		COMPILED: [],
		PARSED: [],
		INFERRED: [],
	};

	const sortedItems = Array.from(impactItems.values()).sort((a, b) => {
		if (a.hop_distance !== b.hop_distance) return a.hop_distance - b.hop_distance;
		const classCmp = compareProvenance(a.provenance_class, b.provenance_class);
		if (classCmp !== 0) return classCmp;
		return a.node.canonical.localeCompare(b.node.canonical);
	});

	for (const item of sortedItems) {
		const hop = item.hop_distance;
		if (!itemsByHop[hop]) itemsByHop[hop] = [];
		itemsByHop[hop].push(item);
		itemsByProvenance[item.provenance_class].push(item);
	}

	// Calculate blind spots in region
	const blindSpotsInRegion: Record<string, number> = {};
	for (const fileId of affectedFileNodeIds) {
		const extRow = db.prepare("SELECT blind_spots FROM extractions WHERE file_node_id = ?").get(fileId) as
			| { blind_spots: string }
			| undefined;
		if (extRow?.blind_spots) {
			try {
				const spots = JSON.parse(extRow.blind_spots) as Record<string, number>;
				for (const [k, v] of Object.entries(spots)) {
					if (typeof v === "number" && v > 0) {
						blindSpotsInRegion[k] = (blindSpotsInRegion[k] ?? 0) + v;
					}
				}
			} catch {
				// ignore
			}
		}
	}

	tracker.recordRowsReturned(sortedItems.length);

	const snapshotMeta: SnapshotMeta = {
		snapshot_id: `snap:${repoId}:${genNum}`,
		index_generation: genNum,
		workspace_generation: currentGen?.workspace_generation ?? String(genNum),
		build_generation: currentGen?.build_generation ?? null,
	};

	const coverage = computeSnapshotCoverage(store, genNum, repoId);
	// Completeness: if any blind spot in region, or truncation, or unexpanded hubs, LOWER_BOUND
	const hasBlindSpots = Object.keys(blindSpotsInRegion).length > 0;
	if (hasBlindSpots || truncated || unexpandedHubs.length > 0) {
		coverage.completeness = "LOWER_BOUND";
	}

	const data: ExpandImpactData = {
		root_id: rootId,
		impact_is_potential_not_proven: true,
		runtime_only_filter: runtimeOnly,
		total_impacted_nodes: sortedItems.length,
		items_by_hop: itemsByHop,
		items_by_provenance: itemsByProvenance,
		blind_spots_in_region: blindSpotsInRegion,
		unexpanded_hubs: unexpandedHubs,
	};

	return buildQueryResult<ExpandImpactData>({
		snapshot: snapshotMeta,
		freshness: { requested: ctx.freshness, delivered: "FRESH", last_verified_at: new Date().toISOString() },
		data,
		coverage,
		truncation: truncated
			? { truncated: true, reason: "MAX_ROWS", omitted_count_lower_bound: 1 }
			: { truncated: false },
		usage: tracker.report(),
	});
}
