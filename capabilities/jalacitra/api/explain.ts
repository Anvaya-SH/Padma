// Jālacitra atlas.explain Operation (Part M2, J5-API-004)

import type { EdgeRecord } from "../model/edges.ts";
import type { NodeRecord } from "../model/nodes.ts";
import type { JalacitraStore } from "../store/store.ts";
import { buildQueryResult, type QueryContext, type QueryResult, type SnapshotMeta, UsageTracker } from "./context.ts";
import { computeSnapshotCoverage } from "./coverage-helper.ts";

export interface ExplainParams {
	node_id?: string;
	edge_id?: string;
}

export interface NodeExplanation {
	target_kind: "node";
	node: NodeRecord;
	container_chain: NodeRecord[];
	in_degree: number;
	out_degree: number;
	in_degree_by_kind: Record<string, number>;
	out_degree_by_kind: Record<string, number>;
	in_degree_by_class: Record<string, number>;
	out_degree_by_class: Record<string, number>;
	extraction_info?: {
		adapter_id: string;
		adapter_version: string;
		status: string;
		reason_code: string | null;
		blind_spots: Record<string, number>;
	};
	config_dependencies: string[];
	file_dependencies: string[];
}

export interface EdgeExplanation {
	target_kind: "edge";
	edge: EdgeRecord;
	src_node: NodeRecord | null;
	dst_node: NodeRecord | null;
	config_dependencies: string[];
	file_dependencies: string[];
}

export type ExplainData = NodeExplanation | EdgeExplanation;

export function explain(
	ctx: QueryContext,
	store: JalacitraStore,
	params: ExplainParams,
): QueryResult<ExplainData | null> {
	const tracker = new UsageTracker();
	const repoId = ctx.repository.repository_identity;
	const currentGen = store.getCurrentGeneration();
	const genNum = currentGen?.index_generation ?? 1;

	const db = store.rawDb;

	let data: ExplainData | null = null;

	if (params.node_id) {
		const node = store.getNode(params.node_id, genNum);
		if (node) {
			const containerChain: NodeRecord[] = [];
			let parentId = node.parent_id;
			while (parentId) {
				const p = store.getNode(parentId, genNum);
				if (!p) break;
				containerChain.push(p);
				parentId = p.parent_id;
			}

			const inEdges = store.getEdgesTo(node.id, undefined, genNum);
			const outEdges = store.getEdgesFrom(node.id, undefined, genNum);
			tracker.recordRowsScanned(inEdges.length + outEdges.length);

			const inDegreeByKind: Record<string, number> = {};
			const inDegreeByClass: Record<string, number> = {};
			for (const e of inEdges) {
				inDegreeByKind[e.kind] = (inDegreeByKind[e.kind] ?? 0) + 1;
				inDegreeByClass[e.class] = (inDegreeByClass[e.class] ?? 0) + 1;
			}

			const outDegreeByKind: Record<string, number> = {};
			const outDegreeByClass: Record<string, number> = {};
			for (const e of outEdges) {
				outDegreeByKind[e.kind] = (outDegreeByKind[e.kind] ?? 0) + 1;
				outDegreeByClass[e.class] = (outDegreeByClass[e.class] ?? 0) + 1;
			}

			const fileId = node.parent_id ?? node.id;
			const extRow = db.prepare("SELECT * FROM extractions WHERE file_node_id = ?").get(fileId) as
				| Record<string, unknown>
				| undefined;

			let extractionInfo:
				| {
						adapter_id: string;
						adapter_version: string;
						status: string;
						reason_code: string | null;
						blind_spots: Record<string, number>;
				  }
				| undefined;
			if (extRow) {
				extractionInfo = {
					adapter_id: String(extRow.adapter_id),
					adapter_version: String(extRow.adapter_version),
					status: String(extRow.status),
					reason_code: extRow.reason_code ? String(extRow.reason_code) : null,
					blind_spots: typeof extRow.blind_spots === "string" ? JSON.parse(extRow.blind_spots) : {},
				};
			}

			const depRows = db
				.prepare("SELECT depends_on_file, depends_on_config FROM dependencies_of_rows WHERE row_id = ?")
				.all(node.id) as Array<{ depends_on_file: string | null; depends_on_config: string | null }>;

			const configDeps = depRows.map((r) => r.depends_on_config).filter((c): c is string => c !== null);
			const fileDeps = depRows.map((r) => r.depends_on_file).filter((f): f is string => f !== null);

			data = {
				target_kind: "node",
				node,
				container_chain: containerChain,
				in_degree: inEdges.length,
				out_degree: outEdges.length,
				in_degree_by_kind: inDegreeByKind,
				out_degree_by_kind: outDegreeByKind,
				in_degree_by_class: inDegreeByClass,
				out_degree_by_class: outDegreeByClass,
				extraction_info: extractionInfo,
				config_dependencies: configDeps,
				file_dependencies: fileDeps,
			};
		}
	} else if (params.edge_id) {
		const edge = store.getEdge(params.edge_id);
		if (edge) {
			const srcNode = store.getNode(edge.src, genNum);
			const dstNode = store.getNode(edge.dst, genNum);

			const depRows = db
				.prepare("SELECT depends_on_file, depends_on_config FROM dependencies_of_rows WHERE row_id = ?")
				.all(edge.id) as Array<{ depends_on_file: string | null; depends_on_config: string | null }>;

			const configDeps = depRows.map((r) => r.depends_on_config).filter((c): c is string => c !== null);
			const fileDeps = depRows.map((r) => r.depends_on_file).filter((f): f is string => f !== null);

			data = {
				target_kind: "edge",
				edge,
				src_node: srcNode,
				dst_node: dstNode,
				config_dependencies: configDeps,
				file_dependencies: fileDeps,
			};
		}
	}

	const snapshotMeta: SnapshotMeta = {
		snapshot_id: `snap:${repoId}:${genNum}`,
		index_generation: genNum,
		workspace_generation: currentGen?.workspace_generation ?? String(genNum),
		build_generation: currentGen?.build_generation ?? null,
	};

	const coverage = computeSnapshotCoverage(store, genNum, repoId);

	return buildQueryResult<ExplainData | null>({
		snapshot: snapshotMeta,
		freshness: { requested: ctx.freshness, delivered: "FRESH", last_verified_at: new Date().toISOString() },
		data,
		coverage,
		negative_evidence:
			data === null
				? [
						{
							checked: `explain:${params.node_id ?? params.edge_id}`,
							result: "NOT_FOUND",
							completeness: "EXACT_WITHIN_INDEX",
						},
					]
				: [],
		usage: tracker.report(),
	});
}
