// Jālacitra atlas.resolve_symbol Operation (Part M2, J5-RES-005, J5-API-002)

import type { LocationHandle } from "../model/ids.ts";
import type { NodeKind, NodeRecord } from "../model/nodes.ts";
import { compareProvenance, type ProvenanceClass } from "../model/provenance.ts";
import type { JalacitraStore } from "../store/store.ts";
import { buildQueryResult, type QueryContext, type QueryResult, type SnapshotMeta, UsageTracker } from "./context.ts";
import { computeSnapshotCoverage } from "./coverage-helper.ts";

export interface ResolveSymbolParams {
	name: string;
	kind?: NodeKind;
	within?: string; // parent_id or file_id
	ambiguity_policy?: "REPORT" | "STRICT" | "BEST_EFFORT";
}

export interface SymbolCandidate {
	node: NodeRecord;
	canonical: string;
	location: LocationHandle | null;
	exported: boolean;
	class: ProvenanceClass;
	evidence_method: string;
}

export function resolveSymbol(
	ctx: QueryContext,
	store: JalacitraStore,
	params: ResolveSymbolParams,
): QueryResult<SymbolCandidate[]> {
	const tracker = new UsageTracker();
	const repoId = ctx.repository.repository_identity;
	const currentGen = store.getCurrentGeneration();
	const genNum = currentGen?.index_generation ?? 1;

	const db = store.rawDb;
	const ambiguityPolicy = params.ambiguity_policy ?? ctx.ambiguity_policy ?? "REPORT";

	let query = `
		SELECT n.*, f.content_digest, f.path as file_path 
		FROM nodes n
		LEFT JOIN files f ON n.parent_id = f.node_id OR n.id = f.node_id
		WHERE n.valid_from <= ? AND (n.valid_to IS NULL OR n.valid_to > ?)
		  AND (n.name = ? OR n.canonical LIKE ?)
	`;
	const queryParams: Array<string | number | null> = [genNum, genNum, params.name, `%:${params.name}`];

	if (params.kind) {
		query += " AND n.kind = ?";
		queryParams.push(params.kind);
	}
	if (params.within) {
		query += " AND (n.parent_id = ? OR n.canonical LIKE ?)";
		queryParams.push(params.within, `%${params.within}%`);
	}

	const rows = db.prepare(query).all(...queryParams) as Array<Record<string, unknown>>;
	tracker.recordRowsScanned(rows.length);

	const candidates: SymbolCandidate[] = [];

	for (const row of rows) {
		const attrs = typeof row.attrs === "string" ? JSON.parse(row.attrs) : (row.attrs ?? {});
		if (row.file_path) {
			attrs.file_path = String(row.file_path);
		}
		const provClass: ProvenanceClass = (attrs.provenance_class as ProvenanceClass) ?? "PARSED";

		if (!ctx.allow_provenance.includes(provClass)) {
			continue;
		}

		const node: NodeRecord = {
			id: String(row.id),
			kind: row.kind as NodeKind,
			canonical: String(row.canonical),
			name: row.name ? String(row.name) : null,
			parent_id: row.parent_id ? String(row.parent_id) : null,
			valid_from: Number(row.valid_from),
			valid_to: row.valid_to !== null ? Number(row.valid_to) : null,
			attrs,
		};

		let location: LocationHandle | null = null;
		if (attrs.start_byte !== undefined && attrs.end_byte !== undefined) {
			location = {
				file_id: node.parent_id ?? node.id,
				start_byte: Number(attrs.start_byte),
				end_byte: Number(attrs.end_byte),
				start_line: Number(attrs.start_line ?? 1),
				end_line: Number(attrs.end_line ?? 1),
				content_digest_of_file: String(row.content_digest ?? ""),
				generation: genNum,
			};
		}

		candidates.push({
			node,
			canonical: node.canonical,
			location,
			exported: Boolean(attrs.exported),
			class: provClass,
			evidence_method: String(attrs.method ?? "syntax_ast"),
		});
	}

	// Deterministic ordering: class strength, then canonical identity
	candidates.sort((a, b) => {
		const classCmp = compareProvenance(a.class, b.class);
		if (classCmp !== 0) return classCmp;
		return a.canonical.localeCompare(b.canonical);
	});

	let returnedCandidates = candidates;
	if (ambiguityPolicy === "STRICT" && candidates.length > 1) {
		returnedCandidates = [];
	} else if (ambiguityPolicy === "BEST_EFFORT" && candidates.length > 1) {
		returnedCandidates = [candidates[0]];
	}

	tracker.recordRowsReturned(returnedCandidates.length);

	const snapshotMeta: SnapshotMeta = {
		snapshot_id: `snap:${repoId}:${genNum}`,
		index_generation: genNum,
		workspace_generation: currentGen?.workspace_generation ?? String(genNum),
		build_generation: currentGen?.build_generation ?? null,
	};

	const coverage = computeSnapshotCoverage(store, genNum, repoId);

	const negativeEvidence = [];
	if (candidates.length === 0) {
		negativeEvidence.push({
			checked: `exact_name:${params.name}`,
			classes: ctx.allow_provenance,
			result: "NO_MATCH",
			completeness: coverage.completeness,
		});
	} else if (ambiguityPolicy === "STRICT" && candidates.length > 1) {
		negativeEvidence.push({
			checked: `strict_unambiguous:${params.name}`,
			result: `AMBIGUOUS_${candidates.length}_CANDIDATES`,
			completeness: coverage.completeness,
		});
	}

	return buildQueryResult<SymbolCandidate[]>({
		snapshot: snapshotMeta,
		freshness: {
			requested: ctx.freshness,
			delivered: "FRESH",
			last_verified_at: new Date().toISOString(),
		},
		data: returnedCandidates,
		coverage,
		negative_evidence: negativeEvidence,
		usage: tracker.report(),
	});
}
