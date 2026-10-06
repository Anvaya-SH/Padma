// Jālacitra Storage Engine (Part H4, J5-STORE-001 through J5-STORE-005)

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Ambiguity } from "../model/ambiguity.ts";
import type { EdgeKind, EdgeRecord } from "../model/edges.ts";
import type { FileClass, NodeKind, NodeRecord } from "../model/nodes.ts";
import type { ProvenanceClass } from "../model/provenance.ts";
import { BuildJournal } from "./journal.ts";
import { migrate } from "./migrations.ts";
import { evaluateShrinkGuard, type ShrinkGuardLimits } from "./shrink-guard.ts";

export interface GenerationRecord {
	index_generation: number;
	workspace_generation: string | null;
	build_generation: string | null;
	base_commit: string | null;
	dirty: boolean;
	config_fingerprint: string;
	committed_at: string;
	note: string | null;
}

export interface FileRecord {
	node_id: string;
	path: string;
	language: string | null;
	class: FileClass;
	size_bytes: number;
	content_digest: string;
	mtime_ns?: string | number | null;
	is_binary: boolean;
}

export interface ExtractionRecord {
	file_node_id: string;
	adapter_id: string;
	adapter_version: string;
	grammar_version: string | null;
	config_fingerprint: string;
	content_digest: string;
	status: "OK" | "PARTIAL" | "FAILED" | "SKIPPED";
	reason_code: string | null;
	blind_spots: Record<string, number>;
	extracted_at_generation: number;
}

type SqlParam = null | number | bigint | string | Uint8Array;

export interface UsageLogEntry {
	op_id: string;
	op_kind: string;
	started_at: string;
	wall_ms: number;
	files_read: number;
	bytes_read: number;
	rows_written: number;
	rows_returned: number;
	output_bytes: number;
	mission_id?: string | null;
	outcome: string;
}

export class JalacitraStore {
	private db: DatabaseSync;
	readonly dbPath: string;
	readonly journal: BuildJournal;
	private inTransaction = false;

	constructor(dbPath: string, repoIdentity?: string) {
		this.dbPath = dbPath;
		if (dbPath !== ":memory:") {
			mkdirSync(dirname(dbPath), { recursive: true });
		}

		this.db = new DatabaseSync(dbPath);
		this.db.exec(`
			PRAGMA foreign_keys = ON;
			PRAGMA busy_timeout = 5000;
		`);

		// Load schema
		const schemaPath = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "schema.sql");
		let ddl: string;
		if (existsSync(schemaPath)) {
			ddl = readFileSync(schemaPath, "utf8");
		} else {
			ddl = DEFAULT_DDL;
		}

		migrate(this.db, ddl);
		this.journal = new BuildJournal(this.db);

		// Handle recovery from crash
		const recovered = this.journal.recoverInterrupted();
		if (recovered.abortedCount > 0) {
			this.runIntegrityCheck();
		}

		if (repoIdentity) {
			this.setMeta("repo_identity", repoIdentity);
		}
	}

	close(): void {
		this.db.close();
	}

	get rawDb(): DatabaseSync {
		return this.db;
	}

	runIntegrityCheck(): { ok: boolean; foreignKeyViolations: number; integrity: string } {
		const integrityRow = this.db.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
		const integrity = integrityRow?.integrity_check ?? "unknown";
		const fkRows = this.db.prepare("PRAGMA foreign_key_check").all();
		return {
			ok: integrity === "ok" && fkRows.length === 0,
			foreignKeyViolations: fkRows.length,
			integrity,
		};
	}

	setMeta(key: string, value: string): void {
		this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
	}

	getMeta(key: string): string | null {
		const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
		return row ? row.value : null;
	}

	beginTransaction(): void {
		if (this.inTransaction) return;
		this.db.exec("BEGIN IMMEDIATE;");
		this.inTransaction = true;
	}

	commitTransaction(): void {
		if (!this.inTransaction) return;
		this.db.exec("COMMIT;");
		this.inTransaction = false;
	}

	rollbackTransaction(): void {
		if (!this.inTransaction) return;
		this.db.exec("ROLLBACK;");
		this.inTransaction = false;
	}

	mintGeneration(
		workspaceGen: string | null,
		buildGen: string | null,
		baseCommit: string | null,
		dirty: boolean,
		configFingerprint: string,
		note?: string | null,
	): number {
		const maxRow = this.db.prepare("SELECT MAX(index_generation) as max_gen FROM generations").get() as
			| { max_gen: number | null }
			| undefined;
		const nextGen = (maxRow?.max_gen ?? 0) + 1;
		const committedAt = new Date().toISOString();

		this.db
			.prepare(
				`INSERT INTO generations (index_generation, workspace_generation, build_generation, base_commit, dirty, config_fingerprint, committed_at, note)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(nextGen, workspaceGen, buildGen, baseCommit, dirty ? 1 : 0, configFingerprint, committedAt, note ?? null);

		return nextGen;
	}

	getCurrentGeneration(): GenerationRecord | null {
		const row = this.db.prepare("SELECT * FROM generations ORDER BY index_generation DESC LIMIT 1").get() as
			| Record<string, unknown>
			| undefined;
		if (!row) return null;
		return {
			index_generation: Number(row.index_generation),
			workspace_generation: row.workspace_generation ? String(row.workspace_generation) : null,
			build_generation: row.build_generation ? String(row.build_generation) : null,
			base_commit: row.base_commit ? String(row.base_commit) : null,
			dirty: Number(row.dirty) === 1,
			config_fingerprint: String(row.config_fingerprint),
			committed_at: String(row.committed_at),
			note: row.note ? String(row.note) : null,
		};
	}

	getGeneration(indexGen: number): GenerationRecord | null {
		const row = this.db.prepare("SELECT * FROM generations WHERE index_generation = ?").get(indexGen) as
			| Record<string, unknown>
			| undefined;
		if (!row) return null;
		return {
			index_generation: Number(row.index_generation),
			workspace_generation: row.workspace_generation ? String(row.workspace_generation) : null,
			build_generation: row.build_generation ? String(row.build_generation) : null,
			base_commit: row.base_commit ? String(row.base_commit) : null,
			dirty: Number(row.dirty) === 1,
			config_fingerprint: String(row.config_fingerprint),
			committed_at: String(row.committed_at),
			note: row.note ? String(row.note) : null,
		};
	}

	insertNode(node: NodeRecord): void {
		const attrsJson = JSON.stringify(node.attrs ?? {});
		this.db
			.prepare(
				`INSERT OR REPLACE INTO nodes (id, kind, canonical, name, parent_id, valid_from, valid_to, attrs)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				node.id,
				node.kind,
				node.canonical,
				node.name ?? null,
				node.parent_id ?? null,
				node.valid_from,
				node.valid_to ?? null,
				attrsJson,
			);
	}

	batchInsertNodes(nodes: NodeRecord[]): void {
		const stmt = this.db.prepare(
			`INSERT OR REPLACE INTO nodes (id, kind, canonical, name, parent_id, valid_from, valid_to, attrs)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const node of nodes) {
			stmt.run(
				node.id,
				node.kind,
				node.canonical,
				node.name ?? null,
				node.parent_id ?? null,
				node.valid_from,
				node.valid_to ?? null,
				JSON.stringify(node.attrs ?? {}),
			);
		}
	}

	closeNodes(nodeIds: string[], validToGen: number, _reason?: string): void {
		const stmt = this.db.prepare(`UPDATE nodes SET valid_to = ? WHERE id = ? AND valid_to IS NULL`);
		for (const id of nodeIds) {
			stmt.run(validToGen, id);
		}
	}

	getNode(id: string, atGeneration?: number): NodeRecord | null {
		let query = "SELECT * FROM nodes WHERE id = ?";
		const params: SqlParam[] = [id];
		if (atGeneration !== undefined) {
			query += " AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)";
			params.push(atGeneration, atGeneration);
		} else {
			query += " AND valid_to IS NULL";
		}
		const row = this.db.prepare(query).get(...params) as Record<string, unknown> | undefined;
		if (!row) return null;
		return {
			id: String(row.id),
			kind: row.kind as NodeKind,
			canonical: String(row.canonical),
			name: row.name ? String(row.name) : null,
			parent_id: row.parent_id ? String(row.parent_id) : null,
			valid_from: Number(row.valid_from),
			valid_to: row.valid_to !== null ? Number(row.valid_to) : null,
			attrs: typeof row.attrs === "string" ? JSON.parse(row.attrs) : {},
		};
	}

	findNodesByKind(kind: NodeKind, atGeneration?: number): NodeRecord[] {
		let query = "SELECT * FROM nodes WHERE kind = ?";
		const params: SqlParam[] = [kind];
		if (atGeneration !== undefined) {
			query += " AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)";
			params.push(atGeneration, atGeneration);
		} else {
			query += " AND valid_to IS NULL";
		}
		const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
		return rows.map((row) => ({
			id: String(row.id),
			kind: row.kind as NodeKind,
			canonical: String(row.canonical),
			name: row.name ? String(row.name) : null,
			parent_id: row.parent_id ? String(row.parent_id) : null,
			valid_from: Number(row.valid_from),
			valid_to: row.valid_to !== null ? Number(row.valid_to) : null,
			attrs: typeof row.attrs === "string" ? JSON.parse(String(row.attrs)) : {},
		}));
	}

	countNodes(atGeneration?: number): number {
		let query = "SELECT COUNT(*) as count FROM nodes";
		const params: SqlParam[] = [];
		if (atGeneration !== undefined) {
			query += " WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)";
			params.push(atGeneration, atGeneration);
		} else {
			query += " WHERE valid_to IS NULL";
		}
		const row = this.db.prepare(query).get(...params) as { count: number } | undefined;
		return Number(row?.count ?? 0);
	}

	insertFile(file: FileRecord): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO files (node_id, path, language, class, size_bytes, content_digest, mtime_ns, is_binary)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				file.node_id,
				file.path,
				file.language ?? null,
				file.class,
				file.size_bytes,
				file.content_digest,
				file.mtime_ns !== null && file.mtime_ns !== undefined ? String(file.mtime_ns) : null,
				file.is_binary ? 1 : 0,
			);
	}

	getFile(nodeId: string): FileRecord | null {
		const row = this.db.prepare("SELECT * FROM files WHERE node_id = ?").get(nodeId) as
			| Record<string, unknown>
			| undefined;
		if (!row) return null;
		return {
			node_id: String(row.node_id),
			path: String(row.path),
			language: row.language ? String(row.language) : null,
			class: row.class as FileClass,
			size_bytes: Number(row.size_bytes),
			content_digest: String(row.content_digest),
			mtime_ns: row.mtime_ns !== null ? String(row.mtime_ns) : null,
			is_binary: Number(row.is_binary) === 1,
		};
	}

	getFileByPath(repoRelativePath: string, atGeneration?: number): FileRecord | null {
		let query = "SELECT f.* FROM files f JOIN nodes n ON f.node_id = n.id WHERE f.path = ?";
		const params: SqlParam[] = [repoRelativePath];
		if (atGeneration !== undefined) {
			query += " AND n.valid_from <= ? AND (n.valid_to IS NULL OR n.valid_to > ?)";
			params.push(atGeneration, atGeneration);
		} else {
			query += " AND n.valid_to IS NULL";
		}
		const row = this.db.prepare(query).get(...params) as Record<string, unknown> | undefined;
		if (!row) return null;
		return {
			node_id: String(row.node_id),
			path: String(row.path),
			language: row.language ? String(row.language) : null,
			class: row.class as FileClass,
			size_bytes: Number(row.size_bytes),
			content_digest: String(row.content_digest),
			mtime_ns: row.mtime_ns !== null ? String(row.mtime_ns) : null,
			is_binary: Number(row.is_binary) === 1,
		};
	}

	countFiles(atGeneration?: number): number {
		let query = "SELECT COUNT(*) as count FROM files f JOIN nodes n ON f.node_id = n.id";
		const params: SqlParam[] = [];
		if (atGeneration !== undefined) {
			query += " WHERE n.valid_from <= ? AND (n.valid_to IS NULL OR n.valid_to > ?)";
			params.push(atGeneration, atGeneration);
		} else {
			query += " WHERE n.valid_to IS NULL";
		}
		const row = this.db.prepare(query).get(...params) as { count: number } | undefined;
		return Number(row?.count ?? 0);
	}

	insertExtraction(ext: ExtractionRecord): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO extractions (file_node_id, adapter_id, adapter_version, grammar_version, config_fingerprint, content_digest, status, reason_code, blind_spots, extracted_at_generation)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				ext.file_node_id,
				ext.adapter_id,
				ext.adapter_version,
				ext.grammar_version ?? null,
				ext.config_fingerprint,
				ext.content_digest,
				ext.status,
				ext.reason_code ?? null,
				JSON.stringify(ext.blind_spots ?? {}),
				ext.extracted_at_generation,
			);
	}

	getExtraction(fileNodeId: string, adapterId: string): ExtractionRecord | null {
		const row = this.db
			.prepare("SELECT * FROM extractions WHERE file_node_id = ? AND adapter_id = ?")
			.get(fileNodeId, adapterId) as Record<string, unknown> | undefined;
		if (!row) return null;
		return {
			file_node_id: String(row.file_node_id),
			adapter_id: String(row.adapter_id),
			adapter_version: String(row.adapter_version),
			grammar_version: row.grammar_version ? String(row.grammar_version) : null,
			config_fingerprint: String(row.config_fingerprint),
			content_digest: String(row.content_digest),
			status: row.status as ExtractionRecord["status"],
			reason_code: row.reason_code ? String(row.reason_code) : null,
			blind_spots: typeof row.blind_spots === "string" ? JSON.parse(row.blind_spots) : {},
			extracted_at_generation: Number(row.extracted_at_generation),
		};
	}

	insertEdge(edge: EdgeRecord): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO edges (id, kind, src, dst, class, method, tool_name, tool_version, src_file, src_start, src_end, src_digest, evidence_ref, ambiguity, candidate_group, candidate_reason, weight, valid_from, valid_to, attrs)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				edge.id,
				edge.kind,
				edge.src,
				edge.dst,
				edge.class,
				edge.method,
				edge.tool_name ?? null,
				edge.tool_version ?? null,
				edge.src_file ?? null,
				edge.src_start ?? null,
				edge.src_end ?? null,
				edge.src_digest ?? null,
				edge.evidence_ref ?? null,
				edge.ambiguity ?? "UNIQUE",
				edge.candidate_group ?? null,
				edge.candidate_reason ?? null,
				edge.weight ?? 1,
				edge.valid_from,
				edge.valid_to ?? null,
				JSON.stringify(edge.attrs ?? {}),
			);
	}

	batchInsertEdges(edges: EdgeRecord[]): void {
		const stmt = this.db.prepare(
			`INSERT OR REPLACE INTO edges (id, kind, src, dst, class, method, tool_name, tool_version, src_file, src_start, src_end, src_digest, evidence_ref, ambiguity, candidate_group, candidate_reason, weight, valid_from, valid_to, attrs)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const edge of edges) {
			stmt.run(
				edge.id,
				edge.kind,
				edge.src,
				edge.dst,
				edge.class,
				edge.method,
				edge.tool_name ?? null,
				edge.tool_version ?? null,
				edge.src_file ?? null,
				edge.src_start ?? null,
				edge.src_end ?? null,
				edge.src_digest ?? null,
				edge.evidence_ref ?? null,
				edge.ambiguity ?? "UNIQUE",
				edge.candidate_group ?? null,
				edge.candidate_reason ?? null,
				edge.weight ?? 1,
				edge.valid_from,
				edge.valid_to ?? null,
				JSON.stringify(edge.attrs ?? {}),
			);
		}
	}

	closeEdges(edgeIds: string[], validToGen: number): void {
		const stmt = this.db.prepare(`UPDATE edges SET valid_to = ? WHERE id = ? AND valid_to IS NULL`);
		for (const id of edgeIds) {
			stmt.run(validToGen, id);
		}
	}

	countEdges(atGeneration?: number): number {
		let query = "SELECT COUNT(*) as count FROM edges";
		const params: SqlParam[] = [];
		if (atGeneration !== undefined) {
			query += " WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)";
			params.push(atGeneration, atGeneration);
		} else {
			query += " WHERE valid_to IS NULL";
		}
		const row = this.db.prepare(query).get(...params) as { count: number } | undefined;
		return Number(row?.count ?? 0);
	}

	getEdgesFrom(srcId: string, kind?: EdgeKind, atGeneration?: number): EdgeRecord[] {
		let query = "SELECT * FROM edges WHERE src = ?";
		const params: SqlParam[] = [srcId];
		if (kind) {
			query += " AND kind = ?";
			params.push(kind);
		}
		if (atGeneration !== undefined) {
			query += " AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)";
			params.push(atGeneration, atGeneration);
		} else {
			query += " AND valid_to IS NULL";
		}
		const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
		return rows.map((r) => this.mapEdgeRow(r));
	}

	getEdgesTo(dstId: string, kind?: EdgeKind, atGeneration?: number): EdgeRecord[] {
		let query = "SELECT * FROM edges WHERE dst = ?";
		const params: SqlParam[] = [dstId];
		if (kind) {
			query += " AND kind = ?";
			params.push(kind);
		}
		if (atGeneration !== undefined) {
			query += " AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)";
			params.push(atGeneration, atGeneration);
		} else {
			query += " AND valid_to IS NULL";
		}
		const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
		return rows.map((r) => this.mapEdgeRow(r));
	}

	private mapEdgeRow(row: Record<string, unknown>): EdgeRecord {
		return {
			id: String(row.id),
			kind: row.kind as EdgeKind,
			src: String(row.src),
			dst: String(row.dst),
			class: row.class as ProvenanceClass,
			method: String(row.method),
			tool_name: row.tool_name ? String(row.tool_name) : null,
			tool_version: row.tool_version ? String(row.tool_version) : null,
			src_file: row.src_file ? String(row.src_file) : null,
			src_start: row.src_start !== null ? Number(row.src_start) : null,
			src_end: row.src_end !== null ? Number(row.src_end) : null,
			src_digest: row.src_digest ? String(row.src_digest) : null,
			evidence_ref: row.evidence_ref ? String(row.evidence_ref) : null,
			ambiguity: row.ambiguity as Ambiguity,
			candidate_group: row.candidate_group ? String(row.candidate_group) : null,
			candidate_reason: row.candidate_reason ? String(row.candidate_reason) : null,
			weight: Number(row.weight),
			valid_from: Number(row.valid_from),
			valid_to: row.valid_to !== null ? Number(row.valid_to) : null,
			attrs: typeof row.attrs === "string" ? JSON.parse(row.attrs) : {},
		};
	}

	insertRowDependency(
		rowKind: "node" | "edge",
		rowId: string,
		dependsOnFileNodeId?: string | null,
		dependsOnConfig?: string | null,
	): void {
		this.db
			.prepare(
				`INSERT OR IGNORE INTO dependencies_of_rows (row_kind, row_id, depends_on_file, depends_on_config)
				 VALUES (?, ?, ?, ?)`,
			)
			.run(rowKind, rowId, dependsOnFileNodeId ?? null, dependsOnConfig ?? null);
	}

	getRowsDependingOnFile(fileNodeId: string): Array<{ rowKind: "node" | "edge"; rowId: string }> {
		const rows = this.db
			.prepare("SELECT row_kind, row_id FROM dependencies_of_rows WHERE depends_on_file = ?")
			.all(fileNodeId) as Array<{ row_kind: string; row_id: string }>;
		return rows.map((r) => ({ rowKind: r.row_kind as "node" | "edge", rowId: r.row_id }));
	}

	getRowsDependingOnConfig(configKey: string): Array<{ rowKind: "node" | "edge"; rowId: string }> {
		const rows = this.db
			.prepare("SELECT row_kind, row_id FROM dependencies_of_rows WHERE depends_on_config = ?")
			.all(configKey) as Array<{ row_kind: string; row_id: string }>;
		return rows.map((r) => ({ rowKind: r.row_kind as "node" | "edge", rowId: r.row_id }));
	}

	logUsage(entry: UsageLogEntry): void {
		this.db
			.prepare(
				`INSERT INTO usage_log (op_id, op_kind, started_at, wall_ms, files_read, bytes_read, rows_written, rows_returned, output_bytes, mission_id, outcome)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				entry.op_id,
				entry.op_kind,
				entry.started_at,
				entry.wall_ms,
				entry.files_read,
				entry.bytes_read,
				entry.rows_written,
				entry.rows_returned,
				entry.output_bytes,
				entry.mission_id ?? null,
				entry.outcome,
			);
	}

	insertRegion(
		generation: number,
		regionId: string,
		label: string,
		algorithm: string,
		seed: number,
		size: number,
	): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO regions (generation, region_id, label, algorithm, seed, size)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(generation, regionId, label, algorithm, seed, size);
	}

	insertRegionMember(generation: number, regionId: string, nodeId: string): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO region_members (generation, region_id, node_id)
				 VALUES (?, ?, ?)`,
			)
			.run(generation, regionId, nodeId);
	}

	getRegions(generation: number): Array<{ region_id: string; label: string; size: number; members: string[] }> {
		const regionRows = this.db.prepare("SELECT * FROM regions WHERE generation = ?").all(generation) as Array<
			Record<string, unknown>
		>;
		return regionRows.map((r) => {
			const memberRows = this.db
				.prepare("SELECT node_id FROM region_members WHERE generation = ? AND region_id = ?")
				.all(generation, String(r.region_id)) as Array<{ node_id: string }>;
			return {
				region_id: String(r.region_id),
				label: String(r.label),
				size: Number(r.size),
				members: memberRows.map((m) => m.node_id),
			};
		});
	}

	checkShrinkGuard(
		proposedNodes: number,
		proposedEdges: number,
		totalPrevFiles: number,
		removedFiles: number,
		limits?: ShrinkGuardLimits,
		overrideReason?: string,
	) {
		const prevGen = this.getCurrentGeneration();
		const prevNodes = prevGen ? this.countNodes(prevGen.index_generation) : 0;
		const prevEdges = prevGen ? this.countEdges(prevGen.index_generation) : 0;
		return evaluateShrinkGuard(
			prevNodes,
			proposedNodes,
			prevEdges,
			proposedEdges,
			totalPrevFiles,
			removedFiles,
			limits,
			overrideReason,
		);
	}

	getEdge(id: string): EdgeRecord | null {
		const row = this.db.prepare("SELECT * FROM edges WHERE id = ?").get(id) as Record<string, unknown> | undefined;
		if (!row) return null;
		return this.mapEdgeRow(row);
	}

	pruneGenerations(
		retainedSnapshotIds: Set<string> | number = new Set(),
		keepGenerationsCount?: number,
	): {
		prunedGenerations: number[];
		deletedNodes: number;
		deletedEdges: number;
	} {
		let snapshotIds = new Set<string>();
		let keepCount = 5;

		if (typeof retainedSnapshotIds === "number") {
			keepCount = retainedSnapshotIds;
		} else {
			snapshotIds = retainedSnapshotIds;
			if (keepGenerationsCount !== undefined) {
				keepCount = keepGenerationsCount;
			}
		}

		const allGens = this.db
			.prepare("SELECT index_generation FROM generations ORDER BY index_generation DESC")
			.all() as Array<{ index_generation: number }>;

		if (allGens.length <= keepCount) {
			return { prunedGenerations: [], deletedNodes: 0, deletedEdges: 0 };
		}

		const prunedGens: number[] = [];
		let totalDeletedNodes = 0;
		let totalDeletedEdges = 0;
		const keptGens = allGens.slice(0, keepCount);
		const oldestSurvivingGen = keptGens[keptGens.length - 1].index_generation;
		const toPrune = allGens.slice(keepCount);

		for (const g of toPrune) {
			const genNum = g.index_generation;
			if (snapshotIds.has(String(genNum))) continue;

			// Remove dead edges and nodes whose valid_to ended at or before the oldest surviving generation
			const edgesRes = this.db.prepare("DELETE FROM edges WHERE valid_to <= ?").run(oldestSurvivingGen);
			// Also clean up any edges pointing to nodes being deleted
			const deadNodes = this.db
				.prepare("SELECT id FROM nodes WHERE valid_to <= ?")
				.all(oldestSurvivingGen) as Array<{ id: string }>;
			for (const dn of deadNodes) {
				this.db.prepare("DELETE FROM files WHERE node_id = ?").run(dn.id);
				this.db.prepare("DELETE FROM extractions WHERE file_node_id = ?").run(dn.id);
				this.db
					.prepare(
						"DELETE FROM dependencies_of_rows WHERE (row_kind = 'node' AND row_id = ?) OR depends_on_file = ?",
					)
					.run(dn.id, dn.id);
			}
			const nodesRes = this.db.prepare("DELETE FROM nodes WHERE valid_to <= ?").run(oldestSurvivingGen);

			// For surviving nodes and edges that originated before oldestSurvivingGen, clamp valid_from
			this.db
				.prepare("UPDATE nodes SET valid_from = ? WHERE valid_from < ?")
				.run(oldestSurvivingGen, oldestSurvivingGen);
			this.db
				.prepare("UPDATE edges SET valid_from = ? WHERE valid_from < ?")
				.run(oldestSurvivingGen, oldestSurvivingGen);

			this.db.prepare("DELETE FROM region_members WHERE generation = ?").run(genNum);
			this.db.prepare("DELETE FROM regions WHERE generation = ?").run(genNum);
			this.db.prepare("DELETE FROM generations WHERE index_generation = ?").run(genNum);
			prunedGens.push(genNum);
			totalDeletedNodes += Number(nodesRes.changes);
			totalDeletedEdges += Number(edgesRes.changes);
		}

		return {
			prunedGenerations: prunedGens,
			deletedNodes: totalDeletedNodes,
			deletedEdges: totalDeletedEdges,
		};
	}
}

const DEFAULT_DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS generations (
  index_generation   INTEGER PRIMARY KEY,
  workspace_generation TEXT,
  build_generation   TEXT,
  base_commit        TEXT,
  dirty              INTEGER NOT NULL CHECK (dirty IN (0,1)),
  config_fingerprint TEXT NOT NULL,
  committed_at       TEXT NOT NULL,
  note               TEXT
);

CREATE TABLE IF NOT EXISTS nodes (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  canonical     TEXT NOT NULL,
  name          TEXT,
  parent_id     TEXT REFERENCES nodes(id),
  valid_from    INTEGER NOT NULL REFERENCES generations(index_generation),
  valid_to      INTEGER REFERENCES generations(index_generation),
  attrs         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attrs)),
  UNIQUE (canonical, valid_from)
);

CREATE INDEX IF NOT EXISTS nodes_kind_name ON nodes(kind, name);
CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS nodes_current ON nodes(valid_to) WHERE valid_to IS NULL;

CREATE TABLE IF NOT EXISTS files (
  node_id        TEXT PRIMARY KEY REFERENCES nodes(id),
  path           TEXT NOT NULL,
  language       TEXT,
  class          TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  content_digest TEXT NOT NULL,
  mtime_ns       TEXT,
  is_binary      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS files_path ON files(path);
CREATE INDEX IF NOT EXISTS files_digest ON files(content_digest);

CREATE TABLE IF NOT EXISTS extractions (
  file_node_id   TEXT NOT NULL REFERENCES nodes(id),
  adapter_id     TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  grammar_version TEXT,
  config_fingerprint TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  status         TEXT NOT NULL,
  reason_code    TEXT,
  blind_spots    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(blind_spots)),
  extracted_at_generation INTEGER NOT NULL,
  PRIMARY KEY (file_node_id, adapter_id)
);

CREATE TABLE IF NOT EXISTS edges (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  src            TEXT NOT NULL REFERENCES nodes(id),
  dst            TEXT NOT NULL REFERENCES nodes(id),
  class          TEXT NOT NULL CHECK (class IN ('PARSED','COMPILED','RUNTIME_CONFIRMED','INFERRED')),
  method         TEXT NOT NULL,
  tool_name      TEXT,
  tool_version   TEXT,
  src_file       TEXT REFERENCES nodes(id),
  src_start      INTEGER,
  src_end        INTEGER,
  src_digest     TEXT,
  evidence_ref   TEXT,
  ambiguity      TEXT NOT NULL DEFAULT 'UNIQUE' CHECK (ambiguity IN ('UNIQUE','MULTI','UNRESOLVED')),
  candidate_group TEXT,
  candidate_reason TEXT,
  weight         INTEGER NOT NULL DEFAULT 1,
  valid_from     INTEGER NOT NULL REFERENCES generations(index_generation),
  valid_to       INTEGER REFERENCES generations(index_generation),
  attrs          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attrs)),
  CHECK (class <> 'RUNTIME_CONFIRMED' OR evidence_ref IS NOT NULL),
  CHECK (kind <> 'observed_at_runtime' OR class = 'RUNTIME_CONFIRMED')
);

CREATE INDEX IF NOT EXISTS edges_src_kind ON edges(src, kind) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS edges_dst_kind ON edges(dst, kind) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS edges_srcfile ON edges(src_file);

CREATE TABLE IF NOT EXISTS dependencies_of_rows (
  row_kind TEXT NOT NULL CHECK (row_kind IN ('node','edge')),
  row_id   TEXT NOT NULL,
  depends_on_file TEXT REFERENCES nodes(id),
  depends_on_config TEXT,
  PRIMARY KEY (row_kind, row_id, depends_on_file, depends_on_config)
);

CREATE INDEX IF NOT EXISTS dep_by_file ON dependencies_of_rows(depends_on_file);

CREATE TABLE IF NOT EXISTS regions (
  generation   INTEGER NOT NULL REFERENCES generations(index_generation),
  region_id    TEXT NOT NULL,
  label        TEXT NOT NULL,
  algorithm    TEXT NOT NULL,
  seed         INTEGER NOT NULL,
  size         INTEGER NOT NULL,
  PRIMARY KEY (generation, region_id)
);

CREATE TABLE IF NOT EXISTS region_members (
  generation INTEGER NOT NULL,
  region_id  TEXT NOT NULL,
  node_id    TEXT NOT NULL REFERENCES nodes(id),
  PRIMARY KEY (generation, region_id, node_id)
);

CREATE TABLE IF NOT EXISTS usage_log (
  op_id TEXT PRIMARY KEY,
  op_kind TEXT NOT NULL,
  started_at TEXT NOT NULL,
  wall_ms INTEGER,
  files_read INTEGER,
  bytes_read INTEGER,
  rows_written INTEGER,
  rows_returned INTEGER,
  output_bytes INTEGER,
  mission_id TEXT,
  outcome TEXT
);

CREATE TABLE IF NOT EXISTS build_journal (
  build_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  planned_files INTEGER,
  committed_files INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('PLANNED','RUNNING','COMMITTED','ABORTED')),
  idempotency_key TEXT NOT NULL UNIQUE
);
`;
