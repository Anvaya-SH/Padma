import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { bindTarget } from "../src/core/sandhana/code.ts";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { makeRecord } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createBashTool, createReadTool, createWriteTool } from "../src/core/tools/index.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const release of cleanup.splice(0).reverse()) release();
});

function fixture(name: string) {
	const cwd = mkdtempSync(join(tmpdir(), `padma-phase2-${name}-`));
	const store = new MissionStore(":memory:");
	const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => name, store });
	kernel.register(createReadTool(cwd), "read");
	kernel.register(createWriteTool(cwd), "write");
	kernel.register(createBashTool(cwd), "bash");
	cleanup.push(() => {
		store.close();
		rmSync(cwd, { recursive: true, force: true });
	});
	return { cwd, store, kernel };
}

describe("Phase 2 permitted local trials", () => {
	it("compares the same native read with governed exact retrieval", async () => {
		const f = fixture("read-trial");
		writeFileSync(join(f.cwd, "target.txt"), "complete requested bytes\n");
		const nativeStart = performance.now();
		const native = await createReadTool(f.cwd).execute("native", { path: "target.txt" });
		const nativeMs = performance.now() - nativeStart;
		const governedStart = performance.now();
		f.kernel.captureInput("read target.txt", "USER");
		f.kernel.begin("");
		const governed = await f.kernel.execute("read", "governed", { path: "target.txt" });
		const terminal = f.kernel.finalize();
		const governedMs = performance.now() - governedStart;
		expect(governed.content).toEqual(native.content);
		expect(terminal.status).toBe("VERIFIED_COMPLETE");
		expect(f.kernel.state!.used.execution).toBe(1);
		expect(f.kernel.state!.used.ticks).toBe(0);
		console.info(
			JSON.stringify({
				trial: "exact-read",
				native_ms: nativeMs,
				governed_ms: governedMs,
				native_tool_calls: 1,
				governed_tool_calls: f.kernel.state!.used.execution,
				additional_model_calls: 0,
				usage: f.kernel.state!.used,
				status: terminal.status,
			}),
		);
	});
	it("preserves the native missing-file error with one governed dispatch and no model call", async () => {
		const f = fixture("missing-read-trial");
		const nativeStart = performance.now();
		let nativeError: unknown;
		try {
			await createReadTool(f.cwd).execute("native-missing", { path: "missing.txt" });
		} catch (error) {
			nativeError = error;
		}
		const nativeMs = performance.now() - nativeStart;
		expect(nativeError).toBeInstanceOf(Error);
		if (!(nativeError instanceof Error)) throw new Error("Native missing-file read must fail");
		const governedStart = performance.now();
		f.kernel.captureInput("read missing.txt", "USER");
		f.kernel.begin("");
		const governed = await f.kernel.execute("read", "governed-missing", { path: "missing.txt" });
		const terminal = f.kernel.finalize();
		const governedMs = performance.now() - governedStart;
		expect(governed.isError).toBe(true);
		expect(nativeError).toMatchObject({ code: "ENOENT", path: join(f.cwd, "missing.txt") });
		expect(governed.details).toMatchObject({ adapter_error_code: "ENOENT" });
		expect(governed.content).toEqual([{ type: "text", text: expect.stringContaining(join(f.cwd, "missing.txt")) }]);
		expect(terminal.status).toBe("EXECUTION_FAILED");
		expect(f.kernel.state!.used.execution).toBe(1);
		expect(f.kernel.state!.used.ticks).toBe(0);
		console.info(
			JSON.stringify({
				trial: "missing-read",
				native_ms: nativeMs,
				governed_ms: governedMs,
				native_tool_calls: 1,
				governed_tool_calls: 1,
				additional_model_calls: 0,
				usage: f.kernel.state!.used,
				status: terminal.status,
			}),
		);
	});
	it("reproduces zero TTL, repairs it, and restores validated bytes after a failed candidate", async () => {
		const f = fixture("ttl-trial");
		// Public contract: null means no expiry; zero expires immediately; positive TTL adds to now.
		const original = "module.exports = (now, ttl) => ttl ? now + ttl : null;\n";
		const fixed = "module.exports = (now, ttl) => ttl === null ? null : now + ttl;\n";
		const command = "node --test expiry.test.cjs";
		writeFileSync(join(f.cwd, "expiry.cjs"), original);
		writeFileSync(join(f.cwd, "human.txt"), "unrelated user content\n");
		execFileSync("git", ["init", f.cwd], { stdio: "pipe", windowsHide: true });
		execFileSync("git", ["-C", f.cwd, "add", "--", "expiry.cjs", "human.txt"], {
			stdio: "pipe",
			windowsHide: true,
		});
		writeFileSync(join(f.cwd, "human.txt"), "unrelated tracked user edit\n");
		writeFileSync(join(f.cwd, "untracked.txt"), "unrelated untracked user file\n");
		const unrelatedStatus = execFileSync(
			"git",
			["-C", f.cwd, "status", "--porcelain", "--", "human.txt", "untracked.txt"],
			{ encoding: "utf8", windowsHide: true },
		);
		expect(unrelatedStatus).toContain("AM human.txt");
		expect(unrelatedStatus).toContain("?? untracked.txt");
		writeFileSync(
			join(f.cwd, "expiry.test.cjs"),
			[
				"const test = require('node:test'); const assert = require('node:assert/strict');",
				"const expiresAt = require('./expiry.cjs');",
				"test('zero expires immediately', () => assert.equal(expiresAt(100, 0), 100));",
				"test('null never expires', () => assert.equal(expiresAt(100, null), null));",
				"test('positive TTL preserves duration', () => assert.equal(expiresAt(100, 20), 120));",
			].join("\n"),
		);
		const nativeStart = performance.now();
		const baseline = await createBashTool(f.cwd).execute("baseline", { command });
		expect(baseline.isError).toBe(true);
		expect(baseline.structuredContent).toMatchObject({ exit_code: 1, output_complete: true });
		await createWriteTool(f.cwd).execute("native-fix", { path: "expiry.cjs", content: fixed });
		const nativeCheck = await createBashTool(f.cwd).execute("native-check", { command });
		expect(nativeCheck.isError).not.toBe(true);
		const nativeMs = performance.now() - nativeStart;
		// Restore only this test-owned fixture, so both paths start from identical bytes and tests.
		writeFileSync(join(f.cwd, "expiry.cjs"), original);
		const governedStart = performance.now();
		f.kernel.captureInput(
			`padma: ${JSON.stringify({
				objective: "Repair zero TTL while preserving null and positive TTL semantics",
				allow_edits: true,
				shell_commands: [command],
				quality_checks: [command],
				requirements: [
					{ text: "requested implementation", rule: "CONTENT", target: "expiry.cjs", expected: fixed },
					{
						text: "zero, null, and positive behavior",
						rule: "PROCESS",
						target: ".",
						expected: command,
						dependencies: ["expiry.cjs", "expiry.test.cjs"],
					},
				],
			})}`,
			"USER",
		);
		f.kernel.begin("");
		const failed = await f.kernel.execute("bash", "governed-baseline", { command });
		expect(failed.isError).toBe(true);
		await f.kernel.execute("write", "governed-fix", { path: "expiry.cjs", content: fixed });
		await f.kernel.execute("bash", "governed-check", { command });
		expect(f.kernel.ready()).toBe(true);
		const governedMs = performance.now() - governedStart;
		const matchedUsage = structuredClone(f.kernel.state!.used);
		const best = f.kernel.state!.best[0];
		expect(best).toBeDefined();
		await f.kernel.execute("write", "failed-candidate", { path: "expiry.cjs", content: original });
		await f.kernel.execute("bash", "candidate-check", { command });
		expect(f.kernel.ready()).toBe(false);
		expect(f.kernel.state!.best[0]).toBe(best);
		const state = f.kernel.state!;
		// Historical proof keeps the existing recovery point; it cannot promote a
		// new checkpoint while the current candidate fails the same requirement.
		const forged = makeRecord(state.mission_id, state.revision + 1, "CheckpointRecord", {
			...f.store.get(state.mission_id, best, "CheckpointRecord"),
		});
		expect(() =>
			f.store.commit(
				state.revision,
				{
					...state,
					revision: state.revision + 1,
					checkpoints: [...state.checkpoints, forged.record_id],
					best: [forged.record_id],
				},
				[forged],
			),
		).toThrow("artifact-specific passing verification");
		expect(f.kernel.state).toEqual(state);
		const generation = bindTarget(f.cwd, "expiry.cjs", state.mission_id, state.revision + 1, "ttl-trial").generation;
		await f.kernel.restoreCheckpoint(best, generation);
		expect(readFileSync(join(f.cwd, "expiry.cjs"), "utf8")).toBe(fixed);
		await f.kernel.runAcceptanceChecks(new AbortController().signal);
		expect(f.kernel.finalize().status).toBe("VERIFIED_COMPLETE");
		expect(readFileSync(join(f.cwd, "human.txt"), "utf8")).toBe("unrelated tracked user edit\n");
		expect(readFileSync(join(f.cwd, "untracked.txt"), "utf8")).toBe("unrelated untracked user file\n");
		expect(
			execFileSync("git", ["-C", f.cwd, "status", "--porcelain", "--", "human.txt", "untracked.txt"], {
				encoding: "utf8",
				windowsHide: true,
			}),
		).toBe(unrelatedStatus);
		expect(matchedUsage.execution).toBe(3);
		expect(f.kernel.state!.used.ticks).toBe(0);
		console.info(
			JSON.stringify({
				trial: "zero-ttl-repair",
				native_ms: nativeMs,
				governed_ms: governedMs,
				native_tool_calls: 3,
				governed_tool_calls: matchedUsage.execution,
				additional_model_calls: 0,
				matched_usage: matchedUsage,
				recovery_usage: f.kernel.state!.used,
				status: f.kernel.terminal!.status,
			}),
		);
	}, 300000);
});
