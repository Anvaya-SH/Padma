// Jālacitra Build Journal (Part K3, J5-TXN-002, J5-LONG-003)

import type { DatabaseSync } from "node:sqlite";

export type JournalState = "PLANNED" | "RUNNING" | "COMMITTED" | "ABORTED";

export interface BuildJournalEntry {
	build_id: string;
	started_at: string;
	planned_files: number;
	committed_files: number;
	state: JournalState;
	idempotency_key: string;
}

export class BuildJournal {
	private db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	start(buildId: string, plannedFiles: number, idempotencyKey: string): BuildJournalEntry {
		const startedAt = new Date().toISOString();
		this.db
			.prepare(
				`INSERT INTO build_journal (build_id, started_at, planned_files, committed_files, state, idempotency_key)
				 VALUES (?, ?, ?, 0, 'PLANNED', ?)`,
			)
			.run(buildId, startedAt, plannedFiles, idempotencyKey);

		return {
			build_id: buildId,
			started_at: startedAt,
			planned_files: plannedFiles,
			committed_files: 0,
			state: "PLANNED",
			idempotency_key: idempotencyKey,
		};
	}

	updateProgress(buildId: string, committedFiles: number): void {
		this.db
			.prepare(
				`UPDATE build_journal
				 SET committed_files = ?, state = 'RUNNING'
				 WHERE build_id = ? AND state IN ('PLANNED', 'RUNNING')`,
			)
			.run(committedFiles, buildId);
	}

	commit(buildId: string): void {
		this.db
			.prepare(
				`UPDATE build_journal
				 SET state = 'COMMITTED'
				 WHERE build_id = ?`,
			)
			.run(buildId);
	}

	abort(buildId: string): void {
		this.db
			.prepare(
				`UPDATE build_journal
				 SET state = 'ABORTED'
				 WHERE build_id = ?`,
			)
			.run(buildId);
	}

	recoverInterrupted(): { abortedCount: number } {
		const result = this.db
			.prepare(
				`UPDATE build_journal
				 SET state = 'ABORTED'
				 WHERE state IN ('PLANNED', 'RUNNING')`,
			)
			.run();

		return { abortedCount: Number(result.changes) };
	}

	find(buildId: string): BuildJournalEntry | null {
		const row = this.db.prepare(`SELECT * FROM build_journal WHERE build_id = ?`).get(buildId) as
			| Record<string, unknown>
			| undefined;
		if (!row) return null;
		return {
			build_id: String(row.build_id),
			started_at: String(row.started_at),
			planned_files: Number(row.planned_files),
			committed_files: Number(row.committed_files),
			state: row.state as JournalState,
			idempotency_key: String(row.idempotency_key),
		};
	}

	getActive(): BuildJournalEntry | null {
		const row = this.db
			.prepare(`SELECT * FROM build_journal WHERE state IN ('PLANNED', 'RUNNING') ORDER BY started_at DESC LIMIT 1`)
			.get() as Record<string, unknown> | undefined;
		if (!row) return null;
		return {
			build_id: String(row.build_id),
			started_at: String(row.started_at),
			planned_files: Number(row.planned_files),
			committed_files: Number(row.committed_files),
			state: row.state as JournalState,
			idempotency_key: String(row.idempotency_key),
		};
	}

	findByIdempotencyKey(key: string): BuildJournalEntry | null {
		const row = this.db.prepare(`SELECT * FROM build_journal WHERE idempotency_key = ?`).get(key) as
			| Record<string, unknown>
			| undefined;
		if (!row) return null;
		return {
			build_id: String(row.build_id),
			started_at: String(row.started_at),
			planned_files: Number(row.planned_files),
			committed_files: Number(row.committed_files),
			state: row.state as JournalState,
			idempotency_key: String(row.idempotency_key),
		};
	}
}
