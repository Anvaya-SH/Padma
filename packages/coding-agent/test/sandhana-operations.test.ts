import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@anvaya.sh/padma-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { OperationManager } from "../src/core/sandhana/operations.ts";
import { digest, type KernelConfigurationInput, makeRecord, type Resources } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createBashTool, createReadTool, createWriteTool } from "../src/core/tools/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function until(predicate: () => boolean) {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Bounded observation deadline exceeded");
}
function fixture(
	options: {
		limits?: Partial<Resources>;
		configuration?: KernelConfigurationInput;
		beforeFileCommit?: () => Promise<void>;
		gates?: Map<string, ReturnType<typeof deferred>>;
		database?: string;
	} = {},
) {
	const cwd = mkdtempSync(join(tmpdir(), "padma-operations-"));
	const store = new MissionStore(options.database ?? ":memory:");
	const kernel = new SandhanaKernel({
		cwd: () => cwd,
		session: () => "operations",
		store,
		limits: options.limits,
		configuration: options.configuration,
		beforeFileCommit: options.beforeFileCommit,
	});
	const base = createReadTool(cwd);
	const entered: string[] = [];
	const read: AgentTool = {
		...base,
		execute: async (_id, args, _signal, update) => {
			const path = (args as { path: string }).path;
			entered.push(path);
			update?.({ content: [{ type: "text", text: `observed ${path}` }], details: {} });
			await options.gates?.get(path)?.promise;
			return { content: [{ type: "text", text: `observed ${path}` }], details: {} };
		},
	};
	kernel.register(read, "read");
	kernel.register(createWriteTool(cwd), "write");
	kernel.register(createBashTool(cwd, { exposeSessionEnvironment: false }), "bash");
	const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
		"base64",
	);
	writeFileSync(join(cwd, "a.png"), png);
	writeFileSync(join(cwd, "b.png"), png);
	writeFileSync(join(cwd, "c.png"), png);
	writeFileSync(join(cwd, "out.txt"), "old");
	const input =
		'padma: {"objective":"inspect and repair fixtures","allow_edits":true,"shell_commands":["node controlled.cjs","node fails.cjs"],"requirements":[{"text":"inspect fixtures","rule":"SEMANTIC","target":"."}]}';
	kernel.captureInput(input, "USER");
	kernel.begin(input);
	kernel.amend('operations: {"concurrency":2}');
	cleanups.push(() => {
		store.close();
		rmSync(cwd, { recursive: true, force: true });
	});
	return { cwd, store, kernel, manager: kernel.operations, entered, read };
}

describe("Durable subordinate operations", () => {
	it("a prerequisite changed after observation cannot authorize a dependent launch", async () => {
		const f = fixture();
		const first = await f.manager.prepare("read", { path: "a.png" });
		await f.manager.pump();
		await until(() => !f.manager.hasPending());
		const second = await f.manager.prepare("read", { path: "b.png" }, [
			{ operation_id: first.operation_id, condition: "EFFECT_CONFIRMED" },
		]);
		writeFileSync(join(f.cwd, "a.png"), "changed after the observed outcome");
		await f.manager.pump();
		await until(() => !f.manager.hasPending());
		expect(f.manager.inspect(second.operation_id).schedule.status).toBe("FAILED");
		expect(f.manager.inspect(second.operation_id).schedule.reason).toContain("Prerequisite");
		expect(f.entered).toEqual(["a.png"]);
		expect(f.kernel.state!.used.execution).toBe(1);
	});
	it("two scheduler instances share one account and claim the queued operation only once", async () => {
		const gate = deferred();
		const f = fixture({ gates: new Map([["a.png", gate]]) });
		const job = await f.manager.prepare("read", { path: "a.png" });
		const second = new OperationManager(f.kernel);
		await Promise.all([f.manager.pump(), second.pump()]);
		await until(() => f.entered.length === 1);
		expect(f.entered).toEqual(["a.png"]);
		expect(f.manager.reconnect(job.operation_id).attached).toBe(true);
		expect(second.reconnect(job.operation_id).attached).toBe(false);
		gate.resolve();
		await until(() => !f.manager.hasPending());
		expect(f.kernel.state!.used.execution).toBe(1);
		expect(second.inspect(job.operation_id).schedule.status).toBe("COMPLETED");
	});
	it("current target constraints stop affected queued work and allow unaffected observations", async () => {
		const f = fixture();
		const denied = await f.manager.prepare("read", { path: "a.png" });
		const allowed = await f.manager.prepare("read", { path: "b.png" });
		f.kernel.amend('operations: {"deny_targets":["a.png"]}');
		await f.manager.pump();
		await until(() => !f.manager.hasPending());
		expect(f.manager.inspect(denied.operation_id).schedule.status).toBe("CANCELLED");
		expect(f.manager.inspect(allowed.operation_id).schedule.status).toBe("COMPLETED");
		expect(f.entered).toEqual(["b.png"]);
		await expect(f.manager.prepare("read", { path: "a.png" })).rejects.toThrow("constraint");
		expect(f.kernel.state!.used.execution).toBe(1);
	});
	it("uncertain local replacement fences its retry but allows a genuinely separate observation", async () => {
		const f = fixture();
		const commit = f.store.commit.bind(f.store);
		let lost = false;
		vi.spyOn(f.store, "commit").mockImplementation((expected, state, records, artifacts) => {
			if (
				!lost &&
				readFileSync(join(f.cwd, "out.txt"), "utf8") === "changed" &&
				records.some(
					(record) =>
						record.record_type === "BudgetReservation" &&
						record.state === "RESERVED" &&
						record.amounts.retrieval_bytes > 0,
				)
			) {
				lost = true;
				throw new Error("Lost post-effect observation");
			}
			return commit(expected, state, records, artifacts);
		});
		const write = await f.manager.prepare("write", { path: "out.txt", content: "changed" });
		await f.manager.pump();
		await until(() => f.manager.inspect(write.operation_id).schedule.status === "UNCERTAIN");
		expect(lost).toBe(true);
		await expect(f.manager.prepare("write", { path: "out.txt", content: "changed" })).rejects.toThrow("no repeat");
		const read = await f.manager.prepare("read", { path: "b.png" });
		await f.manager.pump();
		await until(() => !f.manager.hasPending());
		expect(f.manager.inspect(read.operation_id).schedule.status).toBe("COMPLETED");
		expect(f.manager.inspect(write.operation_id).effect.status).toBe("OUTCOME_UNKNOWN");
		expect(f.kernel.finalize().status).toBe("OUTCOME_UNKNOWN");
	});
	it("a reduced parent deadline cancels a live process without resetting elapsed time or its account", async () => {
		const f = fixture();
		writeFileSync(
			join(f.cwd, "controlled.cjs"),
			"require('node:fs').writeFileSync('out.txt','changed'); setTimeout(() => {}, 30000);",
		);
		const job = await f.manager.prepare("bash", { command: "node controlled.cjs" });
		await f.manager.pump();
		await until(() => readFileSync(join(f.cwd, "out.txt"), "utf8") === "changed");
		const started = f.kernel.state!.started_at;
		f.kernel.amend(`budget: ${JSON.stringify({ version: 1, ceilings: { elapsed_ms: Date.now() - started + 150 } })}`);
		await until(() => f.manager.inspect(job.operation_id).schedule.status === "UNCERTAIN");
		expect(f.kernel.state!.started_at).toBe(started);
		expect(f.kernel.state!.used.execution).toBe(2);
		expect(f.manager.inspect(job.operation_id).effect.status).toBe("OUTCOME_UNKNOWN");
		expect(f.manager.inspect(job.operation_id).execution).toMatchObject([
			{ phase: "STARTED" },
			{ phase: "EXITED", cancellation_dispatched: true },
		]);
	});
	it("long shell timeouts are captured while the original mission deadline still controls cancellation", async () => {
		const f = fixture({ configuration: { version: "sandhana/1", timeouts: { shell_ms: 600000 } } });
		writeFileSync(join(f.cwd, "controlled.cjs"), "setTimeout(() => {}, 30000);");
		const job = await f.manager.prepare("bash", { command: "node controlled.cjs" });
		expect(f.store.get(job.mission_id, job.prepared_ref, "PreparedAction").timeout_ms).toBe(600000);
		f.manager.cancel(job.operation_id);
		expect(f.manager.inspect(job.operation_id).schedule.status).toBe("CANCELLED");
	});
	it("native completion before cancellation remains complete and is not signalled through an expired PID", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "controlled.cjs"), "console.log('complete');");
		const job = await f.manager.prepare("bash", { command: "node controlled.cjs" });
		const commit = f.store.commit.bind(f.store);
		let requested = false;
		vi.spyOn(f.store, "commit").mockImplementation((expected, state, records, artifacts) => {
			const result = commit(expected, state, records, artifacts);
			if (
				!requested &&
				records.some(
					(record) =>
						record.record_type === "EvidenceRecord" &&
						record.stage === "execution-handle" &&
						record.payload &&
						typeof record.payload === "object" &&
						"phase" in record.payload &&
						record.payload.phase === "EXITED",
				)
			) {
				requested = true;
				f.manager.cancel(job.operation_id);
			}
			return result;
		});
		await f.manager.pump();
		await until(() => !f.manager.hasPending());
		expect(requested).toBe(true);
		expect(f.manager.inspect(job.operation_id).schedule.status).toBe("COMPLETED");
		expect(f.manager.inspect(job.operation_id).effect.status).toBe("CONFIRMED_COMPLETE");
		expect(f.kernel.state!.used.execution).toBe(2);
		const history = f.store
			.records(f.kernel.state!.mission_id)
			.filter((record) => record.record_type === "OperationSchedule")
			.map((record) => record.status);
		expect(history).toContain("CANCEL_REQUESTED");
		expect(history.at(-1)).toBe("COMPLETED");
	});
	it("native cancellation confirms process exit without claiming prior effects were undone", async () => {
		const f = fixture();
		writeFileSync(
			join(f.cwd, "controlled.cjs"),
			"require('node:fs').writeFileSync('out.txt','changed'); console.log('effect observed'); setTimeout(() => {}, 30000);",
		);
		const job = await f.manager.prepare("bash", { command: "node controlled.cjs" });
		await f.manager.pump();
		await until(() => readFileSync(join(f.cwd, "out.txt"), "utf8") === "changed");
		f.manager.cancel(job.operation_id);
		await until(() => f.manager.inspect(job.operation_id).schedule.status === "UNCERTAIN");
		const current = f.manager.inspect(job.operation_id);
		expect(current.effect.status).toBe("OUTCOME_UNKNOWN");
		expect(readFileSync(join(f.cwd, "out.txt"), "utf8")).toBe("changed");
		const receipts = current.schedule.execution_refs!.map(
			(ref) => f.store.get(current.effect.mission_id, ref, "EvidenceRecord").payload,
		);
		expect(receipts).toMatchObject([{ phase: "STARTED" }, { phase: "EXITED", cancellation_requested: true }]);
		expect(await f.manager.reconcile(job.operation_id)).toMatchObject({ conclusion: "STILL_UNRESOLVED" });
		await expect(f.manager.prepare("bash", { command: "node controlled.cjs" })).rejects.toThrow("no repeat");
	});
	it("a failed prerequisite cancels dependent work and retains the actual failure", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "fails.cjs"), "process.exitCode = 1;");
		const failed = await f.manager.prepare("bash", { command: "node fails.cjs" });
		const dependent = await f.manager.prepare("read", { path: "b.png" }, [
			{ operation_id: failed.operation_id, condition: "PROCESS_SUCCEEDED" },
		]);
		await f.manager.pump();
		await until(() => !f.manager.hasPending());
		expect(f.manager.inspect(failed.operation_id).schedule.status).toBe("FAILED");
		expect(f.manager.inspect(dependent.operation_id).schedule.status).toBe("CANCELLED");
		expect(f.entered).toEqual([]);
	});
	it("cycles and terminal state rewrites are rejected by the durable transaction", async () => {
		const f = fixture();
		const id = await f.kernel.prepareOperation("read", "self", { path: "a.png" });
		expect(() => f.manager.submit(id, [{ operation_id: id, condition: "EFFECT_CONFIRMED" }])).toThrow("cycle");
		f.kernel.discardPrepared(id);
		const job = await f.manager.prepare("read", { path: "b.png" });
		await f.manager.pump();
		await until(() => !f.manager.hasPending());
		const state = f.kernel.state!;
		const schedule = f.manager.inspect(job.operation_id).schedule;
		const payload = { status: "QUEUED", reason: "forged replay", source_revision: state.revision };
		const control = makeRecord(state.mission_id, state.revision + 1, "EvidenceRecord", {
			event_id: "forged",
			stage: "dirghakriya",
			kind: "CONTROL",
			provenance: "KERNEL",
			operation_id: job.operation_id,
			target_generation: null,
			captured_at: Date.now(),
			source: "DIRGHAKRIYA/1",
			payload,
			artifact_ref: null,
			digest: digest(payload),
			sensitivity: "PRIVATE",
			sources: [],
			requirement_ids: [],
			correction_of: null,
			previous: state.last_event,
		});
		const forged = makeRecord(state.mission_id, state.revision + 1, "OperationSchedule", {
			...schedule,
			status: "QUEUED",
			source_revision: state.revision,
			reason: "forged replay",
			control_ref: control.record_id,
		});
		expect(() =>
			f.store.commit(
				state.revision,
				{ ...state, revision: state.revision + 1, schedules: [forged.record_id], last_event: control.record_id },
				[control, forged],
			),
		).toThrow("transition");
		expect(f.kernel.state).toEqual(state);
	});
	it("an actual result settles after a stopped report without rewriting that report or newer requirements", async () => {
		const gate = deferred();
		const f = fixture({ gates: new Map([["a.png", gate]]) });
		const job = await f.manager.prepare("read", { path: "a.png" });
		await f.manager.pump();
		await until(() => f.entered.length === 1);
		const report = f.kernel.finalize("BLOCKED", "Client stopped observing");
		expect(report.status).toBe("OUTCOME_UNKNOWN");
		gate.resolve();
		await until(() => f.manager.inspect(job.operation_id).schedule.status === "COMPLETED");
		expect(f.manager.inspect(job.operation_id).effect.result_refs).toHaveLength(1);
		expect(f.store.get(report.mission_id, report.record_id, "TerminalReport")).toEqual(report);
		const raw = f.manager.inspect(job.operation_id).effect.result_refs[0];
		expect(f.manager.readOutput(job.operation_id, raw, 0, 8).end).toBe(8);
	});
	it("restart from a possible effect snapshot retains identity, reservations and uncertainty without dispatch", async () => {
		const directory = mkdtempSync(join(tmpdir(), "padma-operation-db-"));
		const database = join(directory, "live.sqlite");
		const recoveryPath = join(directory, "recovery.sqlite");
		const gate = deferred();
		const f = fixture({ database, gates: new Map([["a.png", gate]]) });
		cleanups.unshift(() => rmSync(directory, { recursive: true, force: true }));
		const job = await f.manager.prepare("read", { path: "a.png" });
		await f.manager.pump();
		await until(() => f.entered.length === 1);
		copyFileSync(f.store.databasePath, recoveryPath); // deterministic crash window: durable start, no settled response
		const recoveredStore = new MissionStore(recoveryPath);
		const recovered = new SandhanaKernel({ cwd: () => f.cwd, session: () => "operations", store: recoveredStore });
		try {
			recovered.recoverUnknown();
			await recovered.operations.recover();
			const observed = recovered.operations.inspect(job.operation_id);
			expect(observed.schedule.status).toBe("UNCERTAIN");
			expect(observed.effect.status).toBe("OUTCOME_UNKNOWN");
			expect(observed.effect.operation_id).toBe(job.operation_id);
			expect(recovered.state!.used.execution).toBe(1);
			expect(recovered.operations.reconnect(job.operation_id).attached).toBe(false);
			expect(f.entered).toHaveLength(1);
		} finally {
			recoveredStore.close();
			gate.resolve();
			await until(() => !f.manager.hasPending());
		}
	});
	it("separate reviewed observations overlap, retain original identity, and reconnect without relaunch", async () => {
		const a = deferred(),
			b = deferred();
		const f = fixture({
			gates: new Map([
				["a.png", a],
				["b.png", b],
			]),
		});
		const one = await f.manager.prepare("read", { path: "a.png" });
		const two = await f.manager.prepare("read", { path: "b.png" });
		await f.manager.pump();
		await until(() => f.entered.length === 2);
		expect(f.manager.inspect(one.operation_id).schedule.status).toBe("RUNNING");
		expect(f.manager.inspect(two.operation_id).schedule.status).toBe("RUNNING");
		expect(f.manager.reconnect(one.operation_id).attached).toBe(true);
		await f.manager.recover();
		expect(f.entered).toEqual(["a.png", "b.png"]);
		a.resolve();
		b.resolve();
		await until(() => !f.manager.hasPending());
		expect(f.kernel.state!.used.execution).toBe(2);
		const usage = structuredClone(f.kernel.state!.used);
		f.manager.settle(one.operation_id);
		f.manager.settle(one.operation_id);
		await f.kernel.dispatchPrepared(one.operation_id);
		expect(f.kernel.state!.used).toEqual(usage);
		expect(f.manager.submit(one.operation_id).operation_id).toBe(one.operation_id);
	});
	it("conflicting writes stay ordered and stale second preimages never replace a newer write", async () => {
		const gate = deferred();
		let commits = 0;
		const f = fixture({
			beforeFileCommit: async () => {
				commits++;
				if (commits === 1) await gate.promise;
			},
		});
		const one = await f.manager.prepare("write", { path: "out.txt", content: "first" });
		const two = await f.manager.prepare("write", { path: "out.txt", content: "second" });
		await f.manager.pump();
		await until(() => commits === 1);
		expect(f.manager.inspect(two.operation_id).schedule.status).toBe("QUEUED");
		gate.resolve();
		await until(() => !f.manager.hasPending());
		expect(f.manager.inspect(one.operation_id).schedule.status).toBe("COMPLETED");
		expect(f.manager.inspect(two.operation_id).schedule.status).toBe("FAILED");
		expect(readFileSync(join(f.cwd, "out.txt"), "utf8")).toBe("first");
		expect(f.kernel.state!.used.execution).toBe(1);
	});
	it("dependency readiness requires the observed effect, not launch", async () => {
		const gate = deferred();
		const f = fixture({ gates: new Map([["a.png", gate]]) });
		const one = await f.manager.prepare("read", { path: "a.png" });
		const two = await f.manager.prepare("read", { path: "b.png" }, [
			{ operation_id: one.operation_id, condition: "EFFECT_CONFIRMED" },
		]);
		await f.manager.pump();
		await until(() => f.entered.length === 1);
		expect(f.manager.inspect(two.operation_id).schedule.status).toBe("QUEUED");
		gate.resolve();
		await until(() => !f.manager.hasPending());
		expect(f.entered).toEqual(["a.png", "b.png"]);
	});
	it("missing dependencies roll back admission; queued revocation never launches", async () => {
		const f = fixture();
		await expect(
			f.manager.prepare("read", { path: "a.png" }, [
				{ operation_id: "foreign-mission-id", condition: "EFFECT_CONFIRMED" },
			]),
		).rejects.toThrow("dependency");
		const queued = await f.manager.prepare("read", { path: "b.png" });
		f.kernel.amend("stop");
		await f.manager.pump();
		expect(f.manager.inspect(queued.operation_id).schedule.status).toBe("CANCELLED");
		expect(f.entered).toEqual([]);
		expect(f.kernel.state!.used.execution).toBe(0);
	});
	it("cancellation racing with returned completion retains actual completion", async () => {
		const gate = deferred();
		const f = fixture({ gates: new Map([["a.png", gate]]) });
		const job = await f.manager.prepare("read", { path: "a.png" });
		await f.manager.pump();
		await until(() => f.entered.length === 1);
		expect(f.manager.cancel(job.operation_id).status).toBe("CANCEL_REQUESTED");
		gate.resolve();
		await until(() => !f.manager.hasPending());
		expect(f.manager.inspect(job.operation_id).schedule.status).toBe("COMPLETED");
		expect(f.manager.inspect(job.operation_id).effect.status).toBe("CONFIRMED_COMPLETE");
	});
	it("unvalidated/reused runtime handles cannot receive cancellation", async () => {
		const gate = deferred();
		const f = fixture({ gates: new Map([["a.png", gate]]) });
		const job = await f.manager.prepare("read", { path: "a.png" });
		await f.manager.pump();
		await until(() => f.entered.length === 1);
		expect(() => f.manager.cancel(job.operation_id, "reused-token")).toThrow("validated");
		const foreignRuntime = new OperationManager(f.kernel);
		expect(foreignRuntime.reconnect(job.operation_id).attached).toBe(false);
		expect(() => foreignRuntime.cancel(job.operation_id)).toThrow("validated");
		await foreignRuntime.pump();
		expect(f.entered.length).toBe(1);
		gate.resolve();
		await until(() => !f.manager.hasPending());
	});
	it("late observations cannot verify a later steering requirement", async () => {
		const gate = deferred();
		const f = fixture({ gates: new Map([["a.png", gate]]) });
		const job = await f.manager.prepare("read", { path: "a.png" });
		await f.manager.pump();
		await until(() => f.entered.length === 1);
		f.kernel.amend("Now require a different target and independent proof");
		gate.resolve();
		await until(() => !f.manager.hasPending());
		expect(f.manager.inspect(job.operation_id).effect.status).toBe("CONFIRMED_COMPLETE");
		const requirements = f.kernel.state!.requirements.map((ref) =>
			f.store.get(f.kernel.state!.mission_id, ref, "Requirement"),
		);
		expect(requirements.at(-1)!.status).toBe("UNMET");
	});
	it("background admission cannot consume protected verification capacity", async () => {
		const f = fixture({ limits: { execution: 7 } });
		const one = await f.manager.prepare("read", { path: "a.png" });
		await expect(f.manager.prepare("read", { path: "b.png" })).rejects.toThrow();
		await f.manager.pump();
		await until(() => !f.manager.hasPending());
		expect(f.manager.inspect(one.operation_id).effect.status).toBe("CONFIRMED_COMPLETE");
		expect(f.kernel.state!.used.execution).toBe(1);
		expect(f.kernel.state!.verification_reserve).toBe(6);
	});
	it("progress is durable, bounded, associated and independently metered", async () => {
		const gate = deferred();
		const f = fixture({ gates: new Map([["a.png", gate]]) });
		const job = await f.manager.prepare("read", { path: "a.png" });
		await f.manager.pump();
		await until(() => f.entered.length === 1);
		const progress = f.manager.inspect(job.operation_id).schedule.progress_refs;
		expect(progress).toHaveLength(1);
		const before = f.kernel.state!.used.retrieval_bytes;
		const slice = f.manager.readOutput(job.operation_id, progress[0], 0, 16);
		expect(slice.end).toBe(16);
		expect(slice.omitted_after).toBe(true);
		expect(f.kernel.state!.used.retrieval_bytes).toBe(before + 16);
		expect(() => f.manager.readOutput(job.operation_id, "foreign-artifact")).toThrow("associated");
		gate.resolve();
		await until(() => !f.manager.hasPending());
	});
	it("reducing concurrency allows existing work to settle but blocks another launch", async () => {
		const a = deferred(),
			b = deferred();
		const f = fixture({
			gates: new Map([
				["a.png", a],
				["b.png", b],
			]),
		});
		await f.manager.prepare("read", { path: "a.png" });
		await f.manager.prepare("read", { path: "b.png" });
		const third = await f.manager.prepare("read", { path: "c.png" });
		await f.manager.pump();
		await until(() => f.entered.length === 2);
		f.kernel.amend('operations: {"concurrency":1}');
		a.resolve();
		await until(() => f.manager.list().some(({ schedule }) => schedule.status === "COMPLETED"));
		expect(f.manager.inspect(third.operation_id).schedule.status).toBe("QUEUED");
		b.resolve();
		await until(() => !f.manager.hasPending());
		expect(f.entered).toEqual(["a.png", "b.png", "c.png"]);
	});
});
