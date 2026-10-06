// Jālacitra Doctor Diagnostic Tool (Part Q, J5-OBS-003)
// Performs database integrity, foreign key, CHECK constraint, and dependency consistency audits.
// Reports findings with severity; never performs silent repairs; can recommend discard.

import type { JalacitraStore } from "../store/store.ts";

export type FindingSeverity = "INFO" | "WARNING" | "ERROR";

export interface DoctorFinding {
	check: string;
	severity: FindingSeverity;
	message: string;
	details?: unknown;
}

export interface DoctorReport {
	healthy: boolean;
	totalChecks: number;
	findings: DoctorFinding[];
	recommendation: "NONE" | "RECOMMEND_REINDEX" | "RECOMMEND_DISCARD";
	checkedAt: string;
}

export class AtlasDoctor {
	audit(store: JalacitraStore): DoctorReport {
		const findings: DoctorFinding[] = [];
		const rawDb = store.rawDb;
		let healthy = true;

		// 1. PRAGMA integrity_check
		try {
			const integrityRows = rawDb.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
			if (integrityRows.length === 1 && integrityRows[0].integrity_check === "ok") {
				findings.push({
					check: "sqlite_integrity",
					severity: "INFO",
					message: "SQLite database integrity verified (ok)",
				});
			} else {
				healthy = false;
				findings.push({
					check: "sqlite_integrity",
					severity: "ERROR",
					message: "Database integrity corrupted",
					details: integrityRows,
				});
			}
		} catch (err) {
			healthy = false;
			findings.push({
				check: "sqlite_integrity",
				severity: "ERROR",
				message: `Integrity check failed: ${err instanceof Error ? err.message : String(err)}`,
			});
		}

		// 2. PRAGMA foreign_key_check
		try {
			const fkRows = rawDb.prepare("PRAGMA foreign_key_check").all();
			if (fkRows.length === 0) {
				findings.push({ check: "foreign_keys", severity: "INFO", message: "Foreign key constraints valid" });
			} else {
				healthy = false;
				findings.push({
					check: "foreign_keys",
					severity: "ERROR",
					message: `Found ${fkRows.length} foreign key violation(s)`,
					details: fkRows,
				});
			}
		} catch (err) {
			healthy = false;
			findings.push({ check: "foreign_keys", severity: "ERROR", message: `FK check failed: ${String(err)}` });
		}

		// 3. Check for orphan nodes (parent_id references non-existent node)
		try {
			const orphans = rawDb
				.prepare(
					`SELECT n.id, n.canonical, n.parent_id 
					 FROM nodes n 
					 LEFT JOIN nodes p ON n.parent_id = p.id 
					 WHERE n.parent_id IS NOT NULL AND p.id IS NULL`,
				)
				.all();
			if (orphans.length === 0) {
				findings.push({ check: "orphan_nodes", severity: "INFO", message: "No orphan nodes detected" });
			} else {
				findings.push({
					check: "orphan_nodes",
					severity: "WARNING",
					message: `Detected ${orphans.length} orphan node(s) with missing parents`,
					details: orphans.slice(0, 10),
				});
			}
		} catch (err) {
			findings.push({ check: "orphan_nodes", severity: "WARNING", message: `Orphan check failed: ${String(err)}` });
		}

		// 4. Dependency table consistency (dependencies_of_rows refers to existing edges or nodes)
		try {
			const brokenDeps = rawDb
				.prepare(
					`SELECT d.* 
					 FROM dependencies_of_rows d 
					 LEFT JOIN nodes f ON d.depends_on_file = f.id 
					 WHERE d.depends_on_file IS NOT NULL AND f.id IS NULL`,
				)
				.all();
			if (brokenDeps.length === 0) {
				findings.push({ check: "dependency_table", severity: "INFO", message: "Dependency table consistent" });
			} else {
				findings.push({
					check: "dependency_table",
					severity: "WARNING",
					message: `Detected ${brokenDeps.length} dependency reference(s) to deleted files`,
				});
			}
		} catch (err) {
			findings.push({
				check: "dependency_table",
				severity: "WARNING",
				message: `Dep table check error: ${String(err)}`,
			});
		}

		// 5. Build journal status check (interrupted builds)
		try {
			const interrupted = rawDb.prepare("SELECT * FROM build_journal WHERE state IN ('PLANNED', 'RUNNING')").all();
			if (interrupted.length > 0) {
				findings.push({
					check: "build_journal",
					severity: "WARNING",
					message: `Found ${interrupted.length} uncommitted or interrupted build journal entry/entries`,
				});
			}
		} catch {
			// Non-fatal
		}

		// Recommendation logic (never repairs silently)
		let recommendation: "NONE" | "RECOMMEND_REINDEX" | "RECOMMEND_DISCARD" = "NONE";
		if (!healthy) {
			recommendation = "RECOMMEND_DISCARD";
		} else if (findings.some((f) => f.severity === "WARNING")) {
			recommendation = "RECOMMEND_REINDEX";
		}

		return {
			healthy,
			totalChecks: findings.length,
			findings,
			recommendation,
			checkedAt: new Date().toISOString(),
		};
	}
}

export const defaultAtlasDoctor = new AtlasDoctor();
