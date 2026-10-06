import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getFileLockDir } from "../../config.ts";
import { digest, type RecordOf } from "./records.ts";

export class FileLockError extends Error {
	code: "FILE_LOCK_BUSY" | "FILE_LOCK_UNAVAILABLE" | "LEGACY_FILE_LOCK";
	constructor(code: FileLockError["code"], reason: string, cause?: unknown) {
		super(`${code}: ${reason}`, { cause });
		this.code = code;
	}
}

export function fileLockPath(target: string): string {
	const canonical = resolve(target);
	return join(
		getFileLockDir(),
		`${digest(process.platform === "win32" ? canonical.toLowerCase() : canonical)}.sqlite`,
	);
}

/** SQLite owns exclusion and crash recovery; a PID, timestamp or diagnostic row never grants lock ownership. */
export function acquireFileLock(binding: RecordOf<"TargetBinding">, operation: string): () => void {
	const directory = getFileLockDir();
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const directoryStat = lstatSync(directory);
	if (
		!directoryStat.isDirectory() ||
		directoryStat.isSymbolicLink() ||
		(process.getuid && (directoryStat.uid !== process.getuid() || (directoryStat.mode & 0o077) !== 0))
	)
		throw new FileLockError("FILE_LOCK_UNAVAILABLE", "lock directory must be owned and private");
	const path = fileLockPath(binding.canonical_path);
	// Precreate with private permissions. Retain the database inode across owners: unlinking it splits exclusion.
	try {
		closeSync(openSync(path, "wx", 0o600));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
	}
	const stat = lstatSync(path);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.nlink !== 1 ||
		stat.size > 65536 ||
		(process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) ||
		realpathSync(path) !== join(realpathSync(directory), path.slice(directory.length + 1))
	)
		throw new FileLockError("FILE_LOCK_UNAVAILABLE", "invalid lock database custody");
	const database = new DatabaseSync(path);
	try {
		database.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; PRAGMA max_page_count=16;");
		if (database.prepare("PRAGMA page_size").get()?.page_size !== 4096)
			throw new FileLockError("FILE_LOCK_UNAVAILABLE", "incompatible database page size");
		if (database.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete")
			throw new FileLockError("FILE_LOCK_UNAVAILABLE", "incompatible journal mode");
		database.exec("BEGIN IMMEDIATE");
		const version = database.prepare("PRAGMA user_version").get()?.user_version;
		if (version === 0) {
			if (database.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get())
				throw new FileLockError("FILE_LOCK_UNAVAILABLE", "unversioned database contains foreign records");
			database.exec(`CREATE TABLE lock_identity (target TEXT NOT NULL) STRICT;
				CREATE TABLE last_acquisition (mission TEXT NOT NULL, operation TEXT NOT NULL, session TEXT NOT NULL, pid INTEGER NOT NULL) STRICT;
				PRAGMA user_version=1;`);
			database.prepare("INSERT INTO lock_identity VALUES (?)").run(fileLockPath(binding.canonical_path));
		} else if (version !== 1) throw new FileLockError("FILE_LOCK_UNAVAILABLE", "incompatible lock protocol");
		const identity = database.prepare("SELECT target FROM lock_identity").all();
		if (identity.length !== 1 || identity[0].target !== path)
			throw new FileLockError("FILE_LOCK_UNAVAILABLE", "lock target identity differs");
		database.exec("DELETE FROM last_acquisition");
		database
			.prepare("INSERT INTO last_acquisition VALUES (?, ?, ?, ?)")
			.run(binding.mission_id, operation, binding.session_id, process.pid);
	} catch (error) {
		database.close();
		if (error instanceof Error && "errcode" in error && (error.errcode === 5 || error.errcode === 6))
			throw new FileLockError("FILE_LOCK_BUSY", "another cooperating writer owns this target", error);
		throw error instanceof FileLockError
			? error
			: new FileLockError("FILE_LOCK_UNAVAILABLE", "lock database could not be validated", error);
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		try {
			// This row describes the last acquisition, not completion or current ownership. MissionStore owns outcome truth.
			database.exec("COMMIT");
		} finally {
			database.close();
		}
	};
}
