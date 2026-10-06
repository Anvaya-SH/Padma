import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensurePrivateDirectory, windowsPrivateStorageAction } from "../../utils/private-storage.ts";
import { validateMissionState } from "./records.ts";

interface StorageIdentity {
	logical: string;
	origin: string;
	fingerprint: string | null;
	adopted: boolean;
}

function regularFile(path: string): boolean {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
			throw new Error("Private mission storage file custody changed");
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

/** The public path contains only a versioned redirect; retained mission bytes live in this owned directory. */
export function privateMissionDirectory(logical: string): string {
	return join(
		dirname(resolve(logical)),
		".sandhana-storage",
		createHash("sha256").update(resolve(logical).toLowerCase()).digest("hex"),
	);
}

function snapshot(
	path: string,
	inspectOwner = false,
): { version: number; fingerprint: string | null; redirect: StorageIdentity | null } {
	if (!regularFile(path)) return { version: -1, fingerprint: null, redirect: null };
	const files = [path, `${path}-journal`, `${path}-wal`, `${path}-shm`].filter(regularFile);
	windowsPrivateStorageAction(files.map((path) => ({ path, directory: false })));
	const db = new DatabaseSync(path);
	try {
		db.exec("PRAGMA busy_timeout=0; PRAGMA temp_store=MEMORY; BEGIN EXCLUSIVE;");
		const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
		if (version === 2) {
			const rows = db.prepare("SELECT logical, origin FROM private_store").all();
			if (rows.length !== 1 || typeof rows[0].logical !== "string" || typeof rows[0].origin !== "string")
				throw new Error("Invalid private mission redirect");
			return {
				version,
				fingerprint: null,
				redirect: { logical: rows[0].logical, origin: rows[0].origin, fingerprint: null, adopted: true },
			};
		}
		if (version !== 1)
			throw new Error(`Unsupported Sandhana store version ${version}; retained data must not be reset`);
		if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete")
			throw new Error("Legacy mission storage requires a quiescent DELETE journal before migration");
		const objects = db
			.prepare("SELECT name, type FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name")
			.all();
		if (
			objects.some((row) => row.type !== "table") ||
			!["artifacts,missions,records", "artifacts,missions,private_identity,records"].includes(
				objects.map((row) => row.name).join(","),
			)
		)
			throw new Error("Legacy mission schema differs; retained data must not be reset");
		const hash = createHash("sha256");
		for (const table of ["missions", "records", "artifacts"]) {
			hash.update(table);
			for (const row of db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).iterate()) {
				if (table === "missions") {
					const state: unknown = JSON.parse(String(row.state));
					validateMissionState(state);
					if (inspectOwner && state.owner_pid !== process.pid) {
						let alive = true;
						try {
							process.kill(state.owner_pid, 0);
						} catch (error) {
							alive = !(error instanceof Error && "code" in error && error.code === "ESRCH");
						}
						if (alive) throw new Error("A live owner still holds legacy mission storage; migration must wait");
					}
				}
				for (const value of Object.values(row)) {
					const bytes = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
					hash.update(`${bytes.length}:`).update(bytes);
				}
			}
		}
		return { version, fingerprint: hash.digest("hex"), redirect: null };
	} finally {
		db.close();
	}
}

function redirectFile(path: string, identity: StorageIdentity): void {
	if (regularFile(path)) {
		const saved = snapshot(path).redirect;
		if (!saved || saved.logical !== identity.logical || saved.origin !== identity.origin)
			throw new Error("Private mission publication identity differs");
		return;
	}
	const db = new DatabaseSync(path);
	try {
		db.exec(
			"PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE private_store (logical TEXT NOT NULL, origin TEXT NOT NULL) STRICT;",
		);
		db.prepare("INSERT INTO private_store VALUES (?, ?)").run(identity.logical, identity.origin);
		db.exec("PRAGMA user_version=2; COMMIT;");
	} finally {
		db.close();
	}
}

/** Windows migration retains the old physical database as the replacement backup. No mission record is rewritten. */
export function openPrivateMissionStore(
	path: string,
	initialize: (database: DatabaseSync) => void,
): { database: DatabaseSync; path: string } {
	if (process.platform !== "win32" || path === ":memory:") {
		const database = new DatabaseSync(path);
		try {
			initialize(database);
		} catch (error) {
			database.close();
			throw error;
		}
		return { database, path };
	}
	const logical = resolve(path);
	const key = logical.toLowerCase();
	const directory = privateMissionDirectory(logical);
	ensurePrivateDirectory(dirname(directory));
	ensurePrivateDirectory(directory);
	const actual = join(directory, "mission.sqlite");
	const lockPath = join(directory, "lock.sqlite");
	const planPath = join(directory, "identity.sqlite");
	const retained = [actual, lockPath, planPath]
		.flatMap((path) => [path, `${path}-journal`, `${path}-wal`, `${path}-shm`])
		.filter(regularFile);
	if (retained.length) windowsPrivateStorageAction(retained.map((path) => ({ path, directory: false })));
	try {
		closeSync(openSync(lockPath, "wx", 0o600));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
	}
	regularFile(lockPath);
	const lock = new DatabaseSync(lockPath);
	let database: DatabaseSync | undefined;
	try {
		lock.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;");
		const hasPlan = regularFile(planPath);
		const current = snapshot(logical, true);
		if (!hasPlan && (current.version === 2 || regularFile(actual)))
			throw new Error("Private mission storage identity is missing; retained data must not be reset");
		const plan = new DatabaseSync(planPath);
		let identity: StorageIdentity;
		try {
			plan.exec("PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY;");
			if (!hasPlan) {
				identity = { logical: key, origin: randomUUID(), fingerprint: current.fingerprint, adopted: false };
				plan.exec(
					"BEGIN IMMEDIATE; CREATE TABLE identity (logical TEXT NOT NULL, origin TEXT NOT NULL, fingerprint TEXT, adopted INTEGER NOT NULL) STRICT;",
				);
				plan.prepare("INSERT INTO identity VALUES (?, ?, ?, 0)").run(key, identity.origin, identity.fingerprint);
				plan.exec("PRAGMA user_version=1; COMMIT;");
			} else {
				const rows = plan.prepare("SELECT * FROM identity").all();
				const row = rows[0];
				if (
					plan.prepare("PRAGMA user_version").get()?.user_version !== 1 ||
					rows.length !== 1 ||
					row.logical !== key ||
					typeof row.origin !== "string" ||
					![0, 1].includes(Number(row.adopted)) ||
					!(row.fingerprint === null || typeof row.fingerprint === "string")
				)
					throw new Error("Private mission storage identity differs; retained data must not be reset");
				identity = { logical: key, origin: row.origin, fingerprint: row.fingerprint, adopted: row.adopted === 1 };
			}
			if (current.redirect && (current.redirect.logical !== key || current.redirect.origin !== identity.origin))
				throw new Error("Private mission redirect belongs to another history");
			const hasActual = regularFile(actual);
			if ((identity.adopted || current.version === 2) && !hasActual)
				throw new Error("Private mission history is missing; retained data must not be reset");
			if (identity.adopted && current.version === 1)
				throw new Error("Legacy and adopted mission histories conflict; retained data must not be reset");
			if (!identity.adopted && identity.fingerprint !== null) {
				if (current.version === 1 && current.fingerprint !== identity.fingerprint)
					throw new Error("Legacy mission history changed during migration");
				if (hasActual && snapshot(actual).fingerprint !== identity.fingerprint)
					throw new Error("Retained migration backup differs from original mission history");
				if (!hasActual && current.version !== 1)
					throw new Error("Legacy mission history is missing; retained data must not be reset");
			} else if (!identity.adopted && current.version === 1)
				throw new Error("Unexpected legacy mission history conflicts with new storage");
			const publication = join(directory, "redirect.sqlite");
			if (current.version !== 2) {
				redirectFile(publication, identity);
				if (current.version === 1)
					windowsPrivateStorageAction([], {
						source: publication,
						target: logical,
						backup: hasActual ? null : actual,
					});
			}
			if (!regularFile(actual)) {
				if (identity.fingerprint !== null)
					throw new Error("Retained migration backup is missing; retained data must not be reset");
				closeSync(openSync(actual, "wx", 0o600));
			}
			if (
				!identity.adopted &&
				identity.fingerprint !== null &&
				snapshot(actual).fingerprint !== identity.fingerprint
			)
				throw new Error("Published migration backup differs from the original mission history");
			database = new DatabaseSync(actual);
			if (
				(identity.adopted || identity.fingerprint !== null) &&
				database.prepare("PRAGMA user_version").get()?.user_version !== 1
			)
				throw new Error("Private mission history is incompatible or empty; retained data must not be reset");
			if (identity.adopted) {
				const identities = database.prepare("SELECT logical, origin FROM private_identity").all();
				if (identities.length !== 1 || identities[0].logical !== key || identities[0].origin !== identity.origin)
					throw new Error("Private mission database belongs to another history");
			}
			initialize(database);
			if (!identity.adopted) {
				database.exec(
					"BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS private_identity (logical TEXT NOT NULL, origin TEXT NOT NULL) STRICT; DELETE FROM private_identity;",
				);
				database.prepare("INSERT INTO private_identity VALUES (?, ?)").run(key, identity.origin);
				database.exec("COMMIT;");
			}
			if (current.version === -1) {
				// File.Move refuses an existing destination even if another writer creates it during publication.
				windowsPrivateStorageAction([], undefined, { source: publication, target: logical });
			}
			if (!identity.adopted) plan.exec("BEGIN IMMEDIATE; UPDATE identity SET adopted=1; COMMIT;");
		} finally {
			plan.close();
		}
		if (!database) throw new Error("Private mission database was not opened");
		return { database, path: actual };
	} catch (error) {
		database?.close();
		throw error;
	} finally {
		lock.close();
	}
}
