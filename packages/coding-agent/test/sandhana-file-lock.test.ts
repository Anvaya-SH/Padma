import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, getFileLockDir } from "../src/config.ts";
import { bindTarget, guardedReplace } from "../src/core/sandhana/code.ts";
import { acquireFileLock, fileLockPath } from "../src/core/sandhana/file-lock.ts";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createWriteTool } from "../src/core/tools/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "padma-file-lock-"));
	const target = join(cwd, "a.txt");
	writeFileSync(target, "old");
	const binding = bindTarget(cwd, "a.txt", "lock-fixture", 1, "lock-session");
	const path = fileLockPath(target);
	cleanups.push(() => {
		// Only these fixture-specific databases are retired, after all owned connections/processes are closed.
		expect(dirname(path)).toBe(getFileLockDir());
		for (const owned of [path, `${path}-journal`]) rmSync(owned, { force: true });
		rmSync(cwd, { recursive: true, force: true });
	});
	return { cwd, target, binding, path };
}
function subprocess(f: ReturnType<typeof fixture>, body: string, environment = process.env) {
	const script = join(f.cwd, "writer.mjs");
	writeFileSync(
		script,
		`import { readFileSync } from 'node:fs';
import { bindTarget, guardedReplace } from ${JSON.stringify(new URL("../src/core/sandhana/code.ts", import.meta.url).href)};
const cwd = ${JSON.stringify(f.cwd)};
const binding = bindTarget(cwd, 'a.txt', 'child-mission', 1, 'child-session');
let starts = 0;
${body}
`,
	);
	return spawnSync(process.execPath, ["--experimental-strip-types", script], {
		cwd: f.cwd,
		env: environment,
		encoding: "utf8",
		timeout: 30000,
	});
}
describe("cooperating writer lock ownership and process-exit recovery", () => {
	it("releases unstarted invocation capacity on contention and uses a new preparation after release", async () => {
		const f = fixture();
		const store = new MissionStore(":memory:");
		cleanups.push(() => store.close());
		const kernel = new SandhanaKernel({ cwd: () => f.cwd, session: () => "accounting", store });
		kernel.register(createWriteTool(f.cwd), "write");
		kernel.captureInput(
			'padma: {"objective":"replace exact bytes","allow_edits":true,"requirements":[{"text":"content","rule":"CONTENT","target":"a.txt","expected":"new"}]}',
			"USER",
		);
		kernel.begin("");
		const release = acquireFileLock(f.binding, "competing-owner");
		try {
			await expect(kernel.execute("write", "blocked", { path: "a.txt", content: "new" })).rejects.toMatchObject({
				status: "BLOCKED",
			});
			expect(kernel.state!.used.execution).toBe(0);
			expect(kernel.state!.operations).toHaveLength(0);
			const operation = store
				.records(kernel.state!.mission_id)
				.findLast((record) => record.record_type === "OperationRecord")!;
			expect(operation).toMatchObject({ status: "NOT_STARTED", started_at: null });
			const reservation = kernel
				.state!.reservations.map((ref) => store.get(kernel.state!.mission_id, ref, "BudgetReservation"))
				.find((record) => record.owner_operation_id === operation.operation_id)!;
			expect(reservation).toMatchObject({ state: "RELEASED", actual: null });
			expect(
				store
					.records(kernel.state!.mission_id)
					.filter((record) => record.record_type === "BudgetReservation" && record.state === "STARTED"),
			).toHaveLength(0);
			expect(readFileSync(f.target, "utf8")).toBe("old");
		} finally {
			release();
		}
		await kernel.execute("write", "new-preparation", { path: "a.txt", content: "new" });
		expect(kernel.state!.used.execution).toBe(1);
		expect(kernel.finalize().status).toBe("VERIFIED_COMPLETE");
	});
	it("excludes another process even when it uses a different session/config directory, then permits its new write", () => {
		const f = fixture();
		const release = acquireFileLock(f.binding, "parent-operation");
		const body = `try {
 await guardedReplace(binding, Buffer.from('new'), () => { starts++; }, undefined, undefined, undefined, 'child-operation');
 console.log(JSON.stringify({ starts, bytes: readFileSync(binding.canonical_path, 'utf8') }));
} catch (error) { console.log(JSON.stringify({ starts, error: error.message })); process.exitCode = 2; }`;
		try {
			const child = subprocess(f, body, { ...process.env, [ENV_AGENT_DIR]: join(f.cwd, "other-config") });
			expect(child.error, child.stderr).toBeUndefined();
			expect(child.status, child.stderr).toBe(2);
			expect(JSON.parse(child.stdout)).toEqual({
				starts: 0,
				error: "FILE_LOCK_BUSY: another cooperating writer owns this target",
			});
			expect(readFileSync(f.target, "utf8")).toBe("old");
		} finally {
			release();
		}
		const child = subprocess(f, body);
		expect(child.error, child.stderr).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
		expect(JSON.parse(child.stdout)).toEqual({ starts: 2, bytes: "new" });
		expect(existsSync(`${f.target}.padma-lock`)).toBe(false);
	});
	it("recovers a process exit while holding the mutex before any target effect", async () => {
		const f = fixture();
		const child = subprocess(
			f,
			`await guardedReplace(binding, Buffer.from('uncommitted'), () => { starts++; }, undefined, async () => { process.exit(73); }, undefined, 'crashed-operation'); process.exit(74);`,
		);
		expect(child.error, child.stderr).toBeUndefined();
		expect(child.status, child.stderr).toBe(73);
		expect(readFileSync(f.target, "utf8")).toBe("old");
		let starts = 0;
		await guardedReplace(
			f.binding,
			Buffer.from("new"),
			() => starts++,
			undefined,
			undefined,
			undefined,
			"new-operation",
		);
		expect(starts).toBe(2);
		expect(readFileSync(f.target, "utf8")).toBe("new");
		expect(existsSync(`${f.target}.padma-lock`)).toBe(false);
	});
	it("releases only its owned connection and retains the stable database identity between acquisitions", () => {
		const f = fixture();
		const release = acquireFileLock(f.binding, "first-operation");
		release();
		const next = acquireFileLock(f.binding, "second-operation");
		try {
			release();
			const child = subprocess(f, `await guardedReplace(binding, Buffer.from('bad'), () => { starts++; });`);
			expect(child.status, child.stderr).toBe(1);
			expect(child.stderr).toContain("FILE_LOCK_BUSY");
		} finally {
			next();
		}
		const database = new DatabaseSync(f.path);
		try {
			expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
			expect(database.prepare("SELECT * FROM last_acquisition").get()).toMatchObject({
				mission: "lock-fixture",
				operation: "second-operation",
				session: "lock-session",
				pid: process.pid,
			});
		} finally {
			database.close();
		}
	});
	it("does not remove or infer ownership of an anonymous legacy marker", async () => {
		const f = fixture();
		const marker = `${f.target}.padma-lock`;
		writeFileSync(marker, "");
		let starts = 0;
		await expect(guardedReplace(f.binding, Buffer.from("bad"), () => starts++)).rejects.toThrow("LEGACY_FILE_LOCK");
		expect(starts).toBe(0);
		expect(readFileSync(f.target, "utf8")).toBe("old");
		expect(readFileSync(marker, "utf8")).toBe("");
	});
	it("keeps preimage conflicts and aborts effective while the recoverable mutex is held", async () => {
		const f = fixture();
		let starts = 0;
		await expect(
			guardedReplace(
				f.binding,
				Buffer.from("bad"),
				() => starts++,
				undefined,
				async () => {
					writeFileSync(f.target, "human edit");
				},
			),
		).rejects.toThrow("PREIMAGE_CONFLICT");
		expect(starts).toBe(0);
		expect(readFileSync(f.target, "utf8")).toBe("human edit");
		const binding = bindTarget(f.cwd, "a.txt", "lock-fixture", 1, "lock-session");
		const abort = new AbortController();
		abort.abort(new Error("stop before target effect"));
		await expect(guardedReplace(binding, Buffer.from("bad"), () => starts++, abort.signal)).rejects.toThrow(
			"stop before target effect",
		);
		expect(starts).toBe(0);
		await guardedReplace(binding, Buffer.from("new"), () => starts++);
		expect(readFileSync(f.target, "utf8")).toBe("new");
	});
	it("fails closed on an incompatible lock database without modifying the target or deleting metadata", () => {
		const f = fixture();
		acquireFileLock(f.binding, "initialize")();
		const database = new DatabaseSync(f.path);
		database.exec("PRAGMA user_version=2");
		database.close();
		expect(() => acquireFileLock(f.binding, "incompatible")).toThrow("incompatible lock protocol");
		expect(readFileSync(f.target, "utf8")).toBe("old");
		expect(existsSync(f.path)).toBe(true);
	});
	it.skipIf(process.platform !== "win32")("uses the same mutex for Windows case aliases", () => {
		const f = fixture();
		const release = acquireFileLock(f.binding, "original-case");
		try {
			expect(() => acquireFileLock({ ...f.binding, canonical_path: f.target.toUpperCase() }, "alias")).toThrow(
				"FILE_LOCK_BUSY",
			);
		} finally {
			release();
		}
	});
});
