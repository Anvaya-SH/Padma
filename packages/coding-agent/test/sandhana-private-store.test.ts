import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/core/sandhana/compiler.ts";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { privateMissionDirectory } from "../src/core/sandhana/private-store.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { assertShellDispatchReady } from "../src/core/tools/dispatch-guard.ts";
import { getShellEnv } from "../src/utils/shell.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "padma-private-mission-"));
	const cwd = join(directory, "workspace");
	mkdirSync(cwd);
	writeFileSync(join(cwd, "a.txt"), "original");
	const path = join(directory, "mission.sqlite");
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	return { directory, cwd, path };
}
function open(path: string): MissionStore {
	const store = new MissionStore(path);
	cleanups.push(() => store.close());
	return store;
}

describe.skipIf(process.platform !== "win32")("Windows private mission history", () => {
	it("uses a versioned metadata redirect and reopens the same stored account", () => {
		const f = fixture();
		const first = open(f.path);
		const initial = compile("read a.txt", f.cwd, "private", "USER");
		first.commit(0, initial.state, initial.records);
		const retained = first.records(initial.state.mission_id);
		expect(retained.filter((record) => record.record_type !== "PublicMissionEvent")).toEqual(initial.records);
		expect(retained.filter((record) => record.record_type === "PublicMissionEvent")).toHaveLength(1);
		expect(first.databasePath).toBe(join(privateMissionDirectory(f.path), "mission.sqlite"));
		const redirect = new DatabaseSync(f.path, { readOnly: true });
		try {
			expect(redirect.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
			expect(redirect.prepare("SELECT name FROM sqlite_schema WHERE name='missions'").get()).toBeUndefined();
		} finally {
			redirect.close();
		}
		const second = open(f.path);
		expect(second.load(initial.state.mission_id)).toEqual(initial.state);
		expect(second.records(initial.state.mission_id)).toEqual(retained);
	});
	it("preserves unknown effects, retained reservations and actual result artifacts during migration", async () => {
		const f = fixture();
		const source = open(f.path);
		const kernel = new SandhanaKernel({ cwd: () => f.cwd, session: () => "private", store: source });
		let invocations = 0;
		kernel.register(
			{
				name: "bash",
				label: "Lost fixture response",
				description: "Fixture mutation",
				parameters: Type.Object({ command: Type.String() }),
				execute: async (_callId, value) => {
					const args = value as { command: string };
					assertShellDispatchReady({ command: args.command, cwd: f.cwd, env: getShellEnv() });
					invocations++;
					writeFileSync(join(f.cwd, "a.txt"), "possible effect");
					throw new Error("fixture response lost");
				},
			},
			"bash",
		);
		writeFileSync(join(f.cwd, "check.cjs"), "// exact fixture command\n");
		kernel.captureInput("run: node check.cjs", "USER");
		kernel.begin("");
		await expect(kernel.execute("bash", "lost", { command: "node check.cjs" })).rejects.toThrow();
		expect(kernel.finalize().status).toBe("OUTCOME_UNKNOWN");
		const state = kernel.state!;
		const records = source.records(state.mission_id);
		const legacy = join(f.directory, "legacy.sqlite");
		copyFileSync(source.databasePath, legacy);
		const migrated = open(legacy);
		expect(migrated.load(state.mission_id)).toEqual(state);
		expect(migrated.records(state.mission_id)).toEqual(records);
		for (const record of records)
			if (record.record_type === "Artifact" && record.available)
				expect(migrated.artifact(state.mission_id, record.record_id)).toEqual(
					source.artifact(state.mission_id, record.record_id),
				);
		const resumed = new SandhanaKernel({ cwd: () => f.cwd, session: () => "private", store: migrated });
		resumed.captureInput(`resume ${state.mission_id}`, "USER");
		expect(() => resumed.begin("")).toThrow("authoritative reconciliation");
		expect(invocations).toBe(1);
		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("possible effect");
	});
	it("recovers after actual process death immediately after native replacement", () => {
		const f = fixture();
		const first = open(f.path);
		const initial = compile("read a.txt", f.cwd, "private", "USER");
		first.commit(0, initial.state, initial.records);
		const retained = first.records(initial.state.mission_id);
		const legacy = join(f.directory, "legacy.sqlite");
		copyFileSync(first.databasePath, legacy);
		const crash = join(f.directory, "crash.mjs");
		writeFileSync(
			crash,
			`
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { MissionStore } from ${JSON.stringify(pathToFileURL(resolve("src/core/sandhana/store.ts")).href)};
const original = childProcess.execFileSync;
childProcess.execFileSync = function(file, args, options) {
    const result = original(file, args, options);
    const request = JSON.parse(options?.env?.PADMA_PRIVATE_STORAGE_REQUEST ?? '{}');
    if (request.replace) process.kill(process.pid, 'SIGKILL');
    return result;
};
syncBuiltinESMExports();
new MissionStore(process.argv[2]);
`,
		);
		// The dead child is the importer, while this parent still owns the stored mission.
		const legacyDb = new DatabaseSync(legacy);
		try {
			legacyDb
				.prepare("UPDATE missions SET state=? WHERE id=?")
				.run(JSON.stringify({ ...initial.state, owner_pid: 2147483647 }), initial.state.mission_id);
		} finally {
			legacyDb.close();
		}
		expect(() =>
			execFileSync(process.execPath, ["--experimental-strip-types", crash, legacy], {
				stdio: "pipe",
				windowsHide: true,
				timeout: 45000,
			}),
		).toThrow();
		const redirect = new DatabaseSync(legacy, { readOnly: true });
		try {
			expect(redirect.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
		} finally {
			redirect.close();
		}
		const recovered = open(legacy);
		expect(recovered.load(initial.state.mission_id)).toEqual({ ...initial.state, owner_pid: 2147483647 });
		expect(recovered.records(initial.state.mission_id)).toEqual(retained);
	}, 60000);
	it("rejects a live foreign owner without rewriting the original mission history", () => {
		const f = fixture();
		const first = open(f.path);
		const initial = compile("read a.txt", f.cwd, "private", "USER");
		first.commit(0, initial.state, initial.records);
		const legacy = join(f.directory, "legacy.sqlite");
		copyFileSync(first.databasePath, legacy);
		const db = new DatabaseSync(legacy);
		const state = { ...initial.state, owner_pid: process.ppid };
		try {
			db.prepare("UPDATE missions SET state=? WHERE id=?").run(JSON.stringify(state), state.mission_id);
		} finally {
			db.close();
		}
		expect(() => new MissionStore(legacy)).toThrow("live owner");
		const unchanged = new DatabaseSync(legacy, { readOnly: true });
		try {
			expect(unchanged.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
			expect(JSON.parse(String(unchanged.prepare("SELECT state FROM missions").get()?.state))).toEqual(state);
		} finally {
			unchanged.close();
		}
	});
	it("missing adopted history never initializes a fresh account", () => {
		const f = fixture();
		const store = new MissionStore(f.path);
		const physical = store.databasePath;
		store.close();
		renameSync(physical, `${physical}.retained`);
		expect(() => new MissionStore(f.path)).toThrow("history is missing");
		expect(existsSync(physical)).toBe(false);
		expect(existsSync(`${physical}.retained`)).toBe(true);
	});
	it("a redirect copied from another store cannot replace the existing history", () => {
		const f = fixture();
		const one = new MissionStore(f.path);
		const otherPath = join(f.directory, "other.sqlite");
		const two = new MissionStore(otherPath);
		one.close();
		two.close();
		copyFileSync(otherPath, f.path);
		expect(() => new MissionStore(f.path)).toThrow("another history");
	});
	it("an empty adopted physical file cannot erase the recorded account", () => {
		const f = fixture();
		const store = new MissionStore(f.path);
		const physical = store.databasePath;
		store.close();
		writeFileSync(physical, "");
		expect(() => new MissionStore(f.path)).toThrow("incompatible or empty");
		expect(readFileSync(physical).length).toBe(0);
	});
	it("a compatible physical database from another account cannot inherit its redirect", () => {
		const f = fixture();
		const one = new MissionStore(f.path);
		const other = new MissionStore(join(f.directory, "other.sqlite"));
		const physical = one.databasePath;
		const foreign = other.databasePath;
		one.close();
		other.close();
		copyFileSync(foreign, physical);
		expect(() => new MissionStore(f.path)).toThrow("another history");
	});
});
