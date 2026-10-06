import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openPrivateMissionStore } from "../private-store.ts";
import { canonical } from "../records.ts";
import {
	containsSecret,
	type MemoryApplicability,
	type MemoryHit,
	type MemoryKind,
	type MemoryLifecycle,
	type MemoryOrigin,
	type MemoryRecord,
	normalizeKey,
} from "./types.ts";

type SqlValue = string | number | null | Buffer | undefined;

function toSql(value: SqlValue): string | number | null | Buffer {
	return value ?? null;
}

function runSql(db: DatabaseSync, sql: string, values: SqlValue[]): number {
	const stmt = db.prepare(sql) as unknown as {
		run: (...args: (string | number | null | Buffer)[]) => { changes: number | bigint };
	};
	const result = stmt.run(...values.map(toSql));
	return Number(result.changes);
}

function allSql<T>(db: DatabaseSync, sql: string, values: SqlValue[]): T[] {
	const stmt = db.prepare(sql) as unknown as { all: (...args: (string | number | null | Buffer)[]) => T[] };
	return stmt.all(...values.map(toSql));
}

function getSql<T>(db: DatabaseSync, sql: string, values: SqlValue[]): T | undefined {
	const stmt = db.prepare(sql) as unknown as { get: (...args: (string | number | null | Buffer)[]) => T | undefined };
	return stmt.get(...values.map(toSql));
}

export interface RecallQuery {
	query: string;
	userScope?: string;
	projectScope?: string;
	repositoryScope?: string;
	kinds?: MemoryKind[];
	topK?: number;
	includeStale?: boolean;
	includeRevoked?: boolean;
}

export interface StoreInput {
	kind: MemoryKind;
	subject: string;
	content: Record<string, unknown>;
	origin: MemoryOrigin;
	userScope?: string;
	projectScope?: string;
	repositoryScope?: string;
	environmentFingerprint?: string;
	applicabilityPredicates?: string[];
	requiredPermissions?: string[];
	actionSchemaIds?: string[];
	supportingEvidence?: MemoryRecord["supportingEvidence"];
	sourceMissionIds?: string[];
	confidence?: number;
	expiresAt?: string;
	invalidationTriggers?: string[];
}

const VALID_KINDS: MemoryKind[] = [
	"PROJECT_CONVENTION",
	"FAILURE_SIGNATURE",
	"PROCEDURE",
	"USER_PREFERENCE",
	"USER_GOAL",
	"INFERRED_PATTERN",
	"SESSION_BINDING",
];

function nowIso(): string {
	return new Date().toISOString();
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9_]+/g)
		.filter((token) => token.length >= 3)
		.slice(0, 64);
}

/** Embedded persistent memory. Structured tables plus a token index; no vector service required. */
export class SmritikoshaStore {
	private db: DatabaseSync | null = null;
	readonly path: string;
	private storagePath: string;
	constructor(path: string) {
		this.path = path;
		this.storagePath = path;
	}

	private ensureDb(): DatabaseSync {
		if (this.db) return this.db;
		const path = this.storagePath;
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const opened = openPrivateMissionStore(path === ":memory:" ? ":memory:" : path, (database) => {
			database.exec(
				`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY;
        CREATE TABLE IF NOT EXISTS memory_records (
          id TEXT PRIMARY KEY, version INTEGER NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL,
          normalized_key TEXT NOT NULL, content TEXT NOT NULL, origin TEXT NOT NULL, lifecycle TEXT NOT NULL,
          user_scope TEXT, project_scope TEXT, repository_scope TEXT, environment_fingerprint TEXT,
          predicates TEXT NOT NULL, permissions TEXT, action_schemas TEXT,
          evidence TEXT NOT NULL, counterexamples TEXT NOT NULL, missions TEXT NOT NULL,
          confidence REAL, support_count INTEGER NOT NULL, last_validated_at TEXT, expires_at TEXT,
          invalidation_triggers TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_versions (
          id TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL, recorded_at TEXT NOT NULL,
          PRIMARY KEY(id, version)
        );
        CREATE TABLE IF NOT EXISTS memory_index_terms (
          memory_id TEXT NOT NULL, term TEXT NOT NULL, PRIMARY KEY(memory_id, term)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory_records(kind);
        CREATE INDEX IF NOT EXISTS idx_memory_lifecycle ON memory_records(lifecycle);
        CREATE INDEX IF NOT EXISTS idx_memory_key ON memory_records(normalized_key);
        CREATE INDEX IF NOT EXISTS idx_memory_term ON memory_index_terms(term);`,
			);
			const version = database.prepare("PRAGMA user_version").get()?.user_version;
			if (version === 0) database.exec("PRAGMA user_version=1;");
			else if (version !== 1 && version !== 2) throw new Error(`Unsupported Smritikosha store version ${version}`);
		});
		this.db = opened.database;
		return this.db;
	}

	close(): void {
		try {
			this.db?.close();
		} catch {
			/* best effort */
		} finally {
			this.db = null;
		}
	}

	counts(): {
		total: number;
		byLifecycle: Record<string, number>;
		byKind: Record<string, number>;
		pendingCandidates: number;
	} {
		const rows = allSql<{ lifecycle: string; kind: string; n: number }>(
			this.ensureDb(),
			"SELECT lifecycle, kind, COUNT(*) AS n FROM memory_records GROUP BY lifecycle, kind",
			[],
		);
		const byLifecycle: Record<string, number> = {};
		const byKind: Record<string, number> = {};
		let total = 0;
		for (const row of rows) {
			byLifecycle[row.lifecycle] = (byLifecycle[row.lifecycle] ?? 0) + Number(row.n);
			byKind[row.kind] = (byKind[row.kind] ?? 0) + Number(row.n);
			total += Number(row.n);
		}
		return { total, byLifecycle, byKind, pendingCandidates: byLifecycle["CANDIDATE"] ?? 0 };
	}

	private rowToRecord(row: Record<string, unknown>): MemoryRecord {
		return {
			memoryId: String(row["id"]),
			version: Number(row["version"]),
			kind: String(row["kind"]) as MemoryRecord["kind"],
			subject: String(row["subject"]),
			normalizedKey: String(row["normalized_key"]),
			content: JSON.parse(String(row["content"])) as Record<string, unknown>,
			origin: String(row["origin"]) as MemoryOrigin,
			lifecycle: String(row["lifecycle"]) as MemoryLifecycle,
			userScope: row["user_scope"] == null ? undefined : String(row["user_scope"]),
			projectScope: row["project_scope"] == null ? undefined : String(row["project_scope"]),
			repositoryScope: row["repository_scope"] == null ? undefined : String(row["repository_scope"]),
			environmentFingerprint:
				row["environment_fingerprint"] == null ? undefined : String(row["environment_fingerprint"]),
			applicabilityPredicates: JSON.parse(String(row["predicates"])) as string[],
			requiredPermissions:
				row["permissions"] == null ? undefined : (JSON.parse(String(row["permissions"])) as string[]),
			actionSchemaIds:
				row["action_schemas"] == null ? undefined : (JSON.parse(String(row["action_schemas"])) as string[]),
			supportingEvidence: JSON.parse(String(row["evidence"])),
			counterexampleEvidence: JSON.parse(String(row["counterexamples"])),
			sourceMissionIds: JSON.parse(String(row["missions"])),
			confidence: row["confidence"] == null ? undefined : Number(row["confidence"]),
			supportCount: Number(row["support_count"]),
			lastValidatedAt: row["last_validated_at"] == null ? undefined : String(row["last_validated_at"]),
			expiresAt: row["expires_at"] == null ? undefined : String(row["expires_at"]),
			invalidationTriggers:
				row["invalidation_triggers"] == null
					? undefined
					: (JSON.parse(String(row["invalidation_triggers"])) as string[]),
			createdAt: String(row["created_at"]),
			updatedAt: String(row["updated_at"]),
		};
	}

	get(id: string): MemoryRecord | null {
		const row = getSql<Record<string, unknown>>(this.ensureDb(), "SELECT * FROM memory_records WHERE id=?", [id]);
		return row ? this.rowToRecord(row) : null;
	}

	list(lifecycle?: MemoryLifecycle, limit = 100): MemoryRecord[] {
		const rows = lifecycle
			? allSql<Record<string, unknown>>(
					this.ensureDb(),
					"SELECT * FROM memory_records WHERE lifecycle=? ORDER BY updated_at DESC LIMIT ?",
					[lifecycle, limit],
				)
			: allSql<Record<string, unknown>>(
					this.ensureDb(),
					"SELECT * FROM memory_records ORDER BY updated_at DESC LIMIT ?",
					[limit],
				);
		return rows.map((row) => this.rowToRecord(row));
	}

	admit(input: StoreInput): MemoryRecord {
		if (!VALID_KINDS.includes(input.kind)) throw new Error(`Unknown memory kind ${input.kind}`);
		if (!input.subject.trim() || input.subject.length > 2000) throw new Error("Memory subject must be 1..2000 chars");
		const serialized = canonical(input.content);
		if (serialized.length > 32 * 1024) throw new Error("Memory content exceeds 32 KiB bound");
		if (containsSecret(input.subject) || containsSecret(serialized)) {
			throw new Error("Secrets, tokens and credentials must never become ordinary reusable memory");
		}
		const key = normalizeKey(input.subject);
		const existing = allSql<Record<string, unknown>>(
			this.ensureDb(),
			"SELECT * FROM memory_records WHERE normalized_key=? AND lifecycle != 'REVOKED' LIMIT 20",
			[key],
		);
		for (const row of existing) {
			const record = this.rowToRecord(row);
			const sameScope =
				(record.userScope ?? null) === (input.userScope ?? null) &&
				(record.projectScope ?? null) === (input.projectScope ?? null) &&
				(record.repositoryScope ?? null) === (input.repositoryScope ?? null) &&
				record.kind === input.kind;
			if (sameScope && canonical(record.content) === serialized) {
				throw new Error(`Duplicate memory ${record.memoryId}: correct it instead of re-admitting`);
			}
		}
		const id = `mem_${randomUUID()}`;
		const timestamp = nowIso();
		const lifecycle: MemoryLifecycle = input.origin === "EXPLICIT_USER" ? "VERIFIED" : "CANDIDATE";
		const record: MemoryRecord = {
			memoryId: id,
			version: 1,
			kind: input.kind,
			subject: input.subject.slice(0, 2000),
			normalizedKey: key,
			content: input.content,
			origin: input.origin,
			lifecycle,
			userScope: input.userScope,
			projectScope: input.projectScope,
			repositoryScope: input.repositoryScope,
			environmentFingerprint: input.environmentFingerprint,
			applicabilityPredicates: input.applicabilityPredicates ?? [],
			requiredPermissions: input.requiredPermissions,
			actionSchemaIds: input.actionSchemaIds,
			supportingEvidence: input.supportingEvidence ?? [],
			counterexampleEvidence: [],
			sourceMissionIds: input.sourceMissionIds ?? [],
			confidence: input.confidence,
			supportCount: input.origin === "INFERRED" ? 1 : undefined,
			lastValidatedAt: lifecycle === "VERIFIED" ? timestamp : undefined,
			expiresAt: input.expiresAt,
			invalidationTriggers: input.invalidationTriggers,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		this.ensureDb().exec("BEGIN IMMEDIATE");
		try {
			runSql(
				this.ensureDb(),
				`INSERT INTO memory_records VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				[
					record.memoryId,
					record.version,
					record.kind,
					record.subject,
					record.normalizedKey,
					JSON.stringify(record.content),
					record.origin,
					record.lifecycle,
					record.userScope ?? null,
					record.projectScope ?? null,
					record.repositoryScope ?? null,
					record.environmentFingerprint ?? null,
					JSON.stringify(record.applicabilityPredicates),
					record.requiredPermissions ? JSON.stringify(record.requiredPermissions) : null,
					record.actionSchemaIds ? JSON.stringify(record.actionSchemaIds) : null,
					JSON.stringify(record.supportingEvidence),
					JSON.stringify(record.counterexampleEvidence),
					JSON.stringify(record.sourceMissionIds),
					record.confidence ?? null,
					record.supportCount ?? 0,
					record.lastValidatedAt ?? null,
					record.expiresAt ?? null,
					record.invalidationTriggers ? JSON.stringify(record.invalidationTriggers) : null,
					record.createdAt,
					record.updatedAt,
				],
			);
			runSql(this.ensureDb(), "INSERT INTO memory_versions VALUES (?,?,?,?)", [
				record.memoryId,
				record.version,
				JSON.stringify(record),
				timestamp,
			]);
			for (const term of new Set(tokenize(`${record.subject} ${serialized}`))) {
				runSql(this.ensureDb(), "INSERT OR IGNORE INTO memory_index_terms VALUES (?,?)", [record.memoryId, term]);
			}
			this.ensureDb().exec("COMMIT");
		} catch (error) {
			this.ensureDb().exec("ROLLBACK");
			throw error;
		}
		return record;
	}

	mutate(id: string, expectedVersion: number, apply: (record: MemoryRecord) => MemoryRecord): MemoryRecord {
		const current = this.get(id);
		if (!current) throw new Error(`Memory ${id} not found`);
		if (current.version !== expectedVersion) {
			throw new Error(`Stale memory write for ${id}: expected version ${expectedVersion}, found ${current.version}`);
		}
		const next = apply(structuredClone(current));
		if (next.memoryId !== id) throw new Error("Memory identity is immutable");
		next.version = current.version + 1;
		next.updatedAt = nowIso();
		if (containsSecret(next.subject) || containsSecret(canonical(next.content))) {
			throw new Error("Secrets must never become ordinary reusable memory");
		}
		this.ensureDb().exec("BEGIN IMMEDIATE");
		try {
			const changed = runSql(
				this.ensureDb(),
				`UPDATE memory_records SET version=?, subject=?, normalized_key=?, content=?, origin=?, lifecycle=?,
          user_scope=?, project_scope=?, repository_scope=?, environment_fingerprint=?, predicates=?, permissions=?,
          action_schemas=?, evidence=?, counterexamples=?, missions=?, confidence=?, support_count=?,
          last_validated_at=?, expires_at=?, invalidation_triggers=?, updated_at=? WHERE id=? AND version=?`,
				[
					next.version,
					next.subject,
					next.normalizedKey ?? normalizeKey(next.subject),
					JSON.stringify(next.content),
					next.origin,
					next.lifecycle,
					next.userScope ?? null,
					next.projectScope ?? null,
					next.repositoryScope ?? null,
					next.environmentFingerprint ?? null,
					JSON.stringify(next.applicabilityPredicates),
					next.requiredPermissions ? JSON.stringify(next.requiredPermissions) : null,
					next.actionSchemaIds ? JSON.stringify(next.actionSchemaIds) : null,
					JSON.stringify(next.supportingEvidence),
					JSON.stringify(next.counterexampleEvidence),
					JSON.stringify(next.sourceMissionIds),
					next.confidence ?? null,
					next.supportCount ?? 0,
					next.lastValidatedAt ?? null,
					next.expiresAt ?? null,
					next.invalidationTriggers ? JSON.stringify(next.invalidationTriggers) : null,
					next.updatedAt,
					id,
					expectedVersion,
				],
			);
			if (changed !== 1) throw new Error(`Concurrent memory write for ${id}`);
			runSql(this.ensureDb(), "INSERT INTO memory_versions VALUES (?,?,?,?)", [
				id,
				next.version,
				JSON.stringify(next),
				next.updatedAt,
			]);
			runSql(this.ensureDb(), "DELETE FROM memory_index_terms WHERE memory_id=?", [id]);
			for (const term of new Set(tokenize(`${next.subject} ${canonical(next.content)}`))) {
				runSql(this.ensureDb(), "INSERT OR IGNORE INTO memory_index_terms VALUES (?,?)", [id, term]);
			}
			this.ensureDb().exec("COMMIT");
		} catch (error) {
			try {
				this.ensureDb().exec("ROLLBACK");
			} catch {
				/* already rolled back */
			}
			throw error;
		}
		return next;
	}

	recall(query: RecallQuery): MemoryHit[] {
		const topK = Math.min(Math.max(query.topK ?? 5, 1), 8);
		const terms = tokenize(query.query);
		const conditions: string[] = [];
		const params: SqlValue[] = [];
		if (!query.includeRevoked) conditions.push(`lifecycle != 'REVOKED'`);
		if (!query.includeStale) conditions.push(`lifecycle != 'STALE'`);
		if (query.kinds?.length) {
			conditions.push(`kind IN (${query.kinds.map(() => "?").join(",")})`);
			for (const kind of query.kinds) params.push(kind);
		}
		if (query.userScope !== undefined) conditions.push(`(user_scope IS NULL OR user_scope = ?)`);
		if (query.userScope !== undefined) params.push(query.userScope);
		if (query.projectScope !== undefined) conditions.push(`(project_scope IS NULL OR project_scope = ?)`);
		if (query.projectScope !== undefined) params.push(query.projectScope);
		if (query.repositoryScope !== undefined) conditions.push(`(repository_scope IS NULL OR repository_scope = ?)`);
		if (query.repositoryScope !== undefined) params.push(query.repositoryScope);
		const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
		const candidates = allSql<Record<string, unknown>>(
			this.ensureDb(),
			`SELECT * FROM memory_records ${where} ORDER BY updated_at DESC LIMIT 200`,
			params,
		);
		const scored: { record: MemoryRecord; score: number; reason: string }[] = [];
		for (const row of candidates) {
			const record = this.rowToRecord(row);
			if (record.expiresAt && record.expiresAt <= nowIso()) continue;
			let score = 0;
			const reasons: string[] = [];
			const haystack = `${record.subject} ${canonical(record.content)}`.toLowerCase();
			let lexical = 0;
			for (const term of terms) {
				if (haystack.includes(term)) lexical += 2;
			}
			let indexHits = 0;
			if (terms.length) {
				const placeholders = terms.map(() => "?").join(",");
				const counted = getSql<{ n: number }>(
					this.ensureDb(),
					`SELECT COUNT(*) AS n FROM memory_index_terms WHERE memory_id=? AND term IN (${placeholders})`,
					[record.memoryId, ...terms],
				);
				indexHits = Number(counted?.n ?? 0);
			}
			score += lexical + indexHits;
			if (lexical > 0 || indexHits > 0) reasons.push(`lexical match (${lexical + indexHits})`);
			if (query.repositoryScope && record.repositoryScope === query.repositoryScope) {
				score += 5;
				reasons.push("exact repository scope");
			} else if (
				query.repositoryScope &&
				record.repositoryScope &&
				record.repositoryScope !== query.repositoryScope
			) {
				continue;
			}
			if (query.projectScope && record.projectScope === query.projectScope) {
				score += 4;
				reasons.push("exact project scope");
			}
			if (query.userScope && record.userScope === query.userScope) {
				score += 3;
				reasons.push("exact user scope");
			}
			if (record.origin === "EXPLICIT_USER") {
				score += 3;
				reasons.push("explicit user statement");
			} else if (record.origin === "OBSERVED") {
				score += 2;
				reasons.push("observed outcome");
			} else if (record.origin === "INFERRED") {
				score += 0;
				reasons.push("inferred pattern (weak)");
			}
			if (record.lifecycle === "VERIFIED") {
				score += 2;
				reasons.push("verified lifecycle");
			}
			if (record.supportCount && record.supportCount > 1) {
				score += Math.min(record.supportCount, 3);
				reasons.push(`support x${record.supportCount}`);
			}
			if (score <= 0 && terms.length > 0) continue;
			scored.push({ record, score, reason: reasons.join("; ") || "scope-eligible recency" });
		}
		scored.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			const explicit = (record: MemoryRecord): number =>
				record.origin === "EXPLICIT_USER" ? 0 : record.origin === "INFERRED" ? 2 : 1;
			if (explicit(a.record) !== explicit(b.record)) return explicit(a.record) - explicit(b.record);
			return b.record.updatedAt.localeCompare(a.record.updatedAt);
		});
		return scored.slice(0, topK).map(({ record, reason }) => ({
			record,
			applicability: this.applicabilityOf(record, query),
			reason,
			lastValidation: record.lastValidatedAt ?? null,
			revalidationRequired: this.needsRevalidation(record),
			conflicts: this.conflictsOf(record),
		}));
	}

	private applicabilityOf(record: MemoryRecord, query: RecallQuery): MemoryApplicability {
		if (record.lifecycle === "REVOKED") return "INCOMPATIBLE";
		if (record.lifecycle === "STALE") return "STALE";
		if (record.expiresAt && record.expiresAt <= nowIso()) return "STALE";
		if (query.repositoryScope && record.repositoryScope && record.repositoryScope !== query.repositoryScope)
			return "INCOMPATIBLE";
		if (this.needsRevalidation(record)) return "REQUIRES_REVALIDATION";
		if (record.origin === "INFERRED" || record.lifecycle === "CANDIDATE") return "POSSIBLY_APPLICABLE";
		return "APPLICABLE";
	}

	private needsRevalidation(record: MemoryRecord): boolean {
		if (record.kind === "PROCEDURE" || record.kind === "PROJECT_CONVENTION" || record.kind === "FAILURE_SIGNATURE") {
			if (!record.lastValidatedAt) return true;
			const age = Date.now() - Date.parse(record.lastValidatedAt);
			if (!Number.isFinite(age) || age > 30 * 24 * 60 * 60 * 1000) return true;
		}
		if (record.counterexampleEvidence.length > 0) return true;
		return false;
	}

	private conflictsOf(record: MemoryRecord): string[] {
		const rows = allSql<{ id: string }>(
			this.ensureDb(),
			"SELECT id FROM memory_records WHERE normalized_key=? AND id != ? AND lifecycle != 'REVOKED' LIMIT 5",
			[record.normalizedKey ?? normalizeKey(record.subject), record.memoryId],
		);
		return rows.map((row) => String(row.id));
	}
}
