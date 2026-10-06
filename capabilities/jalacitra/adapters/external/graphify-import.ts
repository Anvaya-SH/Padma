// Jālacitra External Graph Hint Importer (Part R2, J5-IMP-001, J5-IMP-002)
// Reads Graphify-style graph.json as external hints.
// All imported edges are INFERRED, never promoted, scoped to generation.

import { existsSync, readFileSync } from "node:fs";
import { canonicalEdgeId, deriveId } from "../../model/ids.ts";
import type { JalacitraStore } from "../../store/store.ts";

export interface ExternalGraphNode {
	id: string;
	label?: string;
	file?: string;
	kind?: string;
}

export interface ExternalGraphEdge {
	source: string;
	target: string;
	relation?: string;
	tool?: string;
	tool_version?: string;
}

export interface ExternalGraphData {
	nodes?: ExternalGraphNode[];
	edges?: ExternalGraphEdge[];
	graph?: {
		nodes?: ExternalGraphNode[];
		edges?: ExternalGraphEdge[];
	};
}

export interface ImportHintsResult {
	success: boolean;
	edgesImported: number;
	nodesImported: number;
	skippedCount: number;
	provenanceClass: "INFERRED"; // Always INFERRED, never promoted (J5-IMP-001)
}

const MAX_EXTERNAL_FILE_SIZE = 10 * 1024 * 1024; // 10 MiB limit (Part O ceiling)
const MAX_IMPORTED_EDGES = 50_000;

export class ExternalHintImporter {
	importHints(
		store: JalacitraStore,
		params: {
			filePath: string;
			repoIdentity: string;
			generation?: number;
		},
	): ImportHintsResult {
		if (!existsSync(params.filePath)) {
			throw new Error(`External hint file not found: ${params.filePath}`);
		}

		const rawDb = store.rawDb;
		const currentGen = params.generation ?? store.getCurrentGeneration()?.index_generation ?? 1;

		// 1. Read file with Part O size ceiling
		const content = readFileSync(params.filePath, "utf8");
		if (Buffer.byteLength(content, "utf8") > MAX_EXTERNAL_FILE_SIZE) {
			throw new Error("FILE_TOO_LARGE: External hint file exceeds 10 MiB ceiling");
		}

		let parsed: ExternalGraphData;
		try {
			parsed = JSON.parse(content);
		} catch (err) {
			throw new Error(`PARSE_FAILED: Invalid JSON in external graph file: ${String(err)}`);
		}

		const rawNodes = parsed.nodes ?? parsed.graph?.nodes ?? [];
		const rawEdges = parsed.edges ?? parsed.graph?.edges ?? [];

		let nodesImported = 0;
		let edgesImported = 0;
		let skippedCount = 0;

		// 2. Insert nodes if missing
		for (const n of rawNodes) {
			const nodeId = deriveId(`repo:${params.repoIdentity}:ext:${n.id}`);
			const canonical = `repo:${params.repoIdentity}:ext:${n.id}`;

			try {
				rawDb
					.prepare(
						`INSERT OR IGNORE INTO nodes (id, kind, canonical, name, valid_from, valid_to, attrs)
						 VALUES (?, 'symbol', ?, ?, ?, NULL, ?)`,
					)
					.run(
						nodeId,
						canonical,
						n.label ?? n.id,
						currentGen,
						JSON.stringify({ external_hint: true, provenance_class: "INFERRED" }),
					);
				nodesImported++;
			} catch {
				skippedCount++;
			}
		}

		// 3. Insert edges as INFERRED (never promoted)
		for (const e of rawEdges) {
			if (edgesImported >= MAX_IMPORTED_EDGES) {
				skippedCount++;
				continue;
			}

			const srcNodeId = deriveId(`repo:${params.repoIdentity}:ext:${e.source}`);
			const dstNodeId = deriveId(`repo:${params.repoIdentity}:ext:${e.target}`);
			const edgeKind = e.relation ?? "references";
			const edgeId = deriveId(canonicalEdgeId(edgeKind, srcNodeId, dstNodeId, "INFERRED", "external_import"));

			try {
				rawDb
					.prepare(
						`INSERT OR REPLACE INTO edges 
						 (id, kind, src, dst, class, method, tool_name, tool_version, ambiguity, weight, valid_from, valid_to, attrs)
						 VALUES (?, ?, ?, ?, 'INFERRED', 'external_import', ?, ?, 'UNIQUE', 1, ?, NULL, ?)`,
					)
					.run(
						edgeId,
						edgeKind,
						srcNodeId,
						dstNodeId,
						e.tool ?? "graphify",
						e.tool_version ?? "1.0",
						currentGen,
						JSON.stringify({ external_import: true }),
					);
				edgesImported++;
			} catch {
				skippedCount++;
			}
		}

		return {
			success: true,
			nodesImported,
			edgesImported,
			skippedCount,
			provenanceClass: "INFERRED",
		};
	}
}

export const defaultExternalHintImporter = new ExternalHintImporter();
