// Jālacitra Schema Migrations (Part H4, J5-STORE-003)

import type { DatabaseSync } from "node:sqlite";

export const CURRENT_SCHEMA_VERSION = 1;

export interface Migration {
	fromVersion: number;
	toVersion: number;
	run(db: DatabaseSync): void;
}

export const MIGRATIONS: Migration[] = [
	// Forward migrations from v1 to subsequent versions will be appended here.
];

export function getSchemaVersion(db: DatabaseSync): number {
	const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
	return Number(row?.user_version ?? 0);
}

export function setSchemaVersion(db: DatabaseSync, version: number): void {
	db.exec(`PRAGMA user_version = ${version};`);
}

export function migrate(db: DatabaseSync, ddl: string): { initialVersion: number; finalVersion: number } {
	const current = getSchemaVersion(db);

	if (current > CURRENT_SCHEMA_VERSION) {
		throw new Error(
			`SCHEMA_NEWER: Store version ${current} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
		);
	}

	if (current === 0) {
		db.exec(ddl);
		setSchemaVersion(db, CURRENT_SCHEMA_VERSION);
		return { initialVersion: 0, finalVersion: CURRENT_SCHEMA_VERSION };
	}

	let v = current;
	for (const m of MIGRATIONS) {
		if (m.fromVersion === v && m.toVersion <= CURRENT_SCHEMA_VERSION) {
			m.run(db);
			v = m.toVersion;
			setSchemaVersion(db, v);
		}
	}

	return { initialVersion: current, finalVersion: v };
}
