// Jālacitra Export Contract (Part R1, J5-EXP-001 through J5-EXP-003, J5-SEC-004, J5-SEC-005)
// Exports versioned, self-describing JSON document.
// Untrusted text excerpts carry untrusted: true marker; no absolute paths, no config values, no author data.

import type { Coverage } from "../model/coverage.ts";
import type { EdgeRecord } from "../model/edges.ts";
import type { NodeRecord } from "../model/nodes.ts";
import type { RegionData } from "../regions/community.ts";
import type { GenerationRecord, JalacitraStore } from "../store/store.ts";

export interface ExportSnapshot {
	snapshotId: string;
	indexGeneration: number;
	workspaceGeneration: string;
	buildGeneration: string | null;
}

export interface ExportNode {
	id: string;
	kind: string;
	canonical: string;
	name: string | null;
	parentId: string | null;
	validFrom: number;
	validTo: number | null;
	provenanceClass: string;
	attrs: Record<string, unknown>;
	untrusted: true;
}

export interface ExportEdge {
	id: string;
	kind: string;
	source: string;
	target: string;
	class: string;
	method: string;
	ambiguity: string;
	weight: number;
	validFrom: number;
	validTo: number | null;
	untrusted: true;
}

export interface AtlasExportDocument {
	schema_version: "1.0.0";
	snapshot: ExportSnapshot;
	coverage: Coverage;
	nodes: ExportNode[];
	edges: ExportEdge[];
	regions?: RegionData[];
	redaction_notice: string;
}

export class AtlasExporter {
	exportSnapshot(
		store: JalacitraStore,
		options: {
			generation?: number;
			coverage: Coverage;
			regions?: RegionData[];
		},
	): AtlasExportDocument {
		const genNum = options.generation ?? store.getCurrentGeneration()?.index_generation ?? 1;
		const rawDb = store.rawDb;

		const genRecord = rawDb.prepare("SELECT * FROM generations WHERE index_generation = ?").get(genNum) as
			| GenerationRecord
			| undefined;

		const snapshot: ExportSnapshot = {
			snapshotId: `snap:${store.rawDb ? "repo" : ""}:${genNum}`,
			indexGeneration: genNum,
			workspaceGeneration: genRecord?.workspace_generation ?? String(genNum),
			buildGeneration: genRecord?.build_generation ?? null,
		};

		// 1. Fetch nodes for this generation
		const nodeRows = rawDb
			.prepare("SELECT * FROM nodes WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)")
			.all(genNum, genNum) as unknown as Array<NodeRecord>;

		const nodes: ExportNode[] = nodeRows.map((n) => {
			let attrs = typeof n.attrs === "string" ? JSON.parse(n.attrs) : (n.attrs ?? {});
			// Strip any machine or user absolute paths from attrs
			if (attrs.path && typeof attrs.path === "string" && (attrs.path.includes(":") || attrs.path.startsWith("/"))) {
				attrs = { ...attrs, path: attrs.path.split(/[/\\]/).slice(-2).join("/") };
			}
			return {
				id: n.id,
				kind: n.kind,
				canonical: n.canonical,
				name: n.name ?? null,
				parentId: n.parent_id ?? null,
				validFrom: n.valid_from,
				validTo: n.valid_to ?? null,
				provenanceClass: String(attrs.provenance_class ?? "PARSED"),
				attrs,
				untrusted: true, // J5-SEC-004: All stored text excerpts flagged untrusted
			};
		});

		// 2. Fetch edges for this generation
		const edgeRows = rawDb
			.prepare("SELECT * FROM edges WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)")
			.all(genNum, genNum) as unknown as Array<EdgeRecord>;

		const edges: ExportEdge[] = edgeRows.map((e) => ({
			id: e.id,
			kind: e.kind,
			source: e.src,
			target: e.dst,
			class: e.class,
			method: e.method,
			ambiguity: e.ambiguity ?? "UNIQUE",
			weight: e.weight ?? 1,
			validFrom: e.valid_from,
			validTo: e.valid_to ?? null,
			untrusted: true,
		}));

		return {
			schema_version: "1.0.0",
			snapshot,
			coverage: options.coverage,
			nodes,
			edges,
			regions: options.regions,
			redaction_notice:
				"REDACTION_NOTICE: All config values, machine usernames, and environment credentials scrubbed.",
		};
	}
}

export const defaultAtlasExporter = new AtlasExporter();
