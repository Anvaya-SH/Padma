import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sourceIO from "../src/core/sandhana/io.ts";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { LOCAL_POSTCONDITION_LIMIT } from "../src/core/sandhana/reconciliation.ts";
import { makeRecord, resources } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createEditTool, createReadTool, createWriteTool } from "../src/core/tools/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(beforeFileCommit?: () => Promise<void>, target = "a.txt") {
	const directory = mkdtempSync(join(tmpdir(), "padma-reconcile-"));
	const cwd = join(directory, "workspace");
	mkdirSync(cwd);
	const store = new MissionStore(join(directory, "mission.sqlite"));
	const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "reconcile", store, beforeFileCommit });
	kernel.register(createReadTool(cwd), "read");
	kernel.register(createWriteTool(cwd), "write");
	kernel.register(createEditTool(cwd), "edit");
	cleanups.push(() => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	});
	if (target === "a.txt") writeFileSync(join(cwd, target), "old");
	kernel.captureInput(
		`padma: ${JSON.stringify({ objective: "repair exact content", allow_edits: true, requirements: [{ text: "exact bytes", rule: "CONTENT", target, expected: "new" }] })}`,
		"USER",
	);
	kernel.begin("");
	return { cwd, store, kernel };
}
async function lostReplacement(f: ReturnType<typeof fixture>, kind: "write" | "edit" = "write") {
	const commit = f.store.commit.bind(f.store);
	let interrupted = false;
	// Fail the first post-rename observation persistence. The guarded replacement has really changed the fixture.
	const fault = vi.spyOn(f.store, "commit").mockImplementation((expected, state, records, artifacts) => {
		if (
			!interrupted &&
			records.some(
				(record) =>
					record.record_type === "BudgetReservation" &&
					record.state === "RESERVED" &&
					record.amounts.retrieval_bytes > 0,
			) &&
			readFileSync(join(f.cwd, "a.txt"), "utf8") === "new"
		) {
			interrupted = true;
			throw new Error("Lost post-replacement observation");
		}
		return commit(expected, state, records, artifacts);
	});
	await expect(
		f.kernel.execute(
			kind,
			"lost",
			kind === "write"
				? { path: "a.txt", content: "new" }
				: { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] },
		),
	).rejects.toThrow("may have taken effect");
	fault.mockRestore();
	expect(interrupted).toBe(true);
	expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("new");
	const operation = f.store.get(f.kernel.state!.mission_id, f.kernel.state!.operations[0], "OperationRecord");
	expect(operation.status).toBe("OUTCOME_UNKNOWN");
	return operation;
}
describe("governed local postcondition reconciliation", () => {
	for (const operation of ["write", "restore"] as const)
		it(`recovers an actual process death after ${operation} while retaining unmeasured started capacity`, async () => {
			const directory = mkdtempSync(join(tmpdir(), "padma-reconcile-crash-"));
			const cwd = join(directory, "workspace");
			mkdirSync(cwd);
			if (operation === "write") writeFileSync(join(cwd, "a.txt"), "old");
			const database = join(directory, "mission.sqlite");
			const script = join(directory, "crash.mjs");
			writeFileSync(
				script,
				`import { existsSync, readFileSync } from 'node:fs';
import { SandhanaKernel } from ${JSON.stringify(new URL("../src/core/sandhana/kernel.ts", import.meta.url).href)};
import { MissionStore } from ${JSON.stringify(new URL("../src/core/sandhana/store.ts", import.meta.url).href)};
import { createReadTool, createWriteTool } from ${JSON.stringify(new URL("../src/core/tools/index.ts", import.meta.url).href)};
const cwd = ${JSON.stringify(cwd)};
const store = new MissionStore(${JSON.stringify(database)});
const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => 'crash', store });
kernel.register(createReadTool(cwd), 'read'); kernel.register(createWriteTool(cwd), 'write');
kernel.captureInput('padma: ' + JSON.stringify({ objective: 'repair content', allow_edits: true, requirements: [{ text: 'bytes', rule: 'CONTENT', target: 'a.txt', expected: 'new' }] }), 'USER'); kernel.begin('');
const restoring = ${operation === "restore"};
let checkpoint; let generation;
if (restoring) {
 await kernel.execute('write', 'create', { path: 'a.txt', content: 'new' });
 checkpoint = store.get(kernel.state.mission_id, kernel.state.operations[0], 'OperationRecord').checkpoint_ref;
 generation = store.get(kernel.state.mission_id, kernel.state.requirements[0], 'Requirement').generation;
}
const target = new URL('./a.txt', ${JSON.stringify(pathToFileURL(`${cwd}/`).href)});
const commit = store.commit.bind(store);
store.commit = (expected, state, records, artifacts) => {
 if (restoring ? !existsSync(target) && records.some(record => record.record_type === 'EvidenceRecord' && record.stage === 'phala') : records.some(record => record.record_type === 'BudgetReservation' && record.state === 'RESERVED' && record.amounts.retrieval_bytes > 0) && readFileSync(target, 'utf8') === 'new') process.exit(73);
 return commit(expected, state, records, artifacts);
};
if (restoring) await kernel.restoreCheckpoint(checkpoint, generation);
else await kernel.execute('write', 'crash', { path: 'a.txt', content: 'new' });
process.exit(74);
`,
			);
			const child = spawnSync(process.execPath, ["--experimental-strip-types", script], {
				cwd,
				encoding: "utf8",
				timeout: 30000,
			});
			const store = new MissionStore(database);
			cleanups.push(() => {
				store.close();
				rmSync(directory, { recursive: true, force: true });
			});
			expect(child.error, child.stderr).toBeUndefined();
			expect(child.status, child.stderr).toBe(73);
			if (operation === "write") expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("new");
			else expect(existsSync(join(cwd, "a.txt"))).toBe(false);
			const before = store.list("crash")[0];
			const original = store.get(before.mission_id, before.operations.at(-1)!, "OperationRecord");
			expect(original.status).toBe("IN_PROGRESS");
			expect(before.owner_pid).toBe(child.pid);
			const held = store.get(before.mission_id, original.reservation_ref!, "BudgetReservation");
			expect(held.state).toBe("STARTED");
			expect(held.actual).toBeNull();
			const restored = new SandhanaKernel({ cwd: () => cwd, session: () => "crash", store });
			restored.register(createReadTool(cwd), "read");
			restored.register(createWriteTool(cwd), "write");
			restored.captureInput(`resume ${before.mission_id}`, "USER");
			restored.begin("");
			await restored.execute("read", "inspect", { path: "a.txt" });
			expect(restored.state!.used.execution).toBe(operation === "write" ? 2 : 3);
			const settled = restored
				.state!.operations.map((ref) => store.get(before.mission_id, ref, "OperationRecord"))
				.find((record) => record.operation_id === original.operation_id)!;
			expect(settled.operation_id).toBe(original.operation_id);
			expect(store.get(before.mission_id, settled.reservation_ref!, "BudgetReservation")).toEqual(held);
			const state = restored.state!;
			for (const status of ["RELEASED", "RECONCILED"] as const) {
				const fabricated = makeRecord(before.mission_id, state.revision + 1, "BudgetReservation", {
					...held,
					state: status,
					actual: resources(),
				});
				expect(() =>
					store.commit(
						state.revision,
						{
							...state,
							revision: state.revision + 1,
							reservations: state.reservations.map((ref) =>
								ref === held.record_id ? fabricated.record_id : ref,
							),
						},
						[fabricated],
					),
				).toThrow(status === "RELEASED" ? "cannot release capacity" : "unmeasured capacity stays reserved");
			}
			expect(restored.state).toEqual(state);
			if (operation === "write") {
				// The crashed writer must not leave a marker that prevents a new, separately authorized operation.
				await restored.execute("write", "after-reconciliation", { path: "a.txt", content: "new" });
				expect(restored.state!.used.execution).toBe(3);
				expect(store.get(before.mission_id, settled.reservation_ref!, "BudgetReservation")).toEqual(held);
				expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("new");
			}
			const finalStatus = operation === "write" ? "VERIFIED_COMPLETE" : "EXECUTION_FAILED";
			expect(restored.finalize().status).toBe(finalStatus);
			expect(
				store
					.records(before.mission_id)
					.filter((record) => record.record_type === "TerminalReport")
					.map((record) => record.status),
			).toEqual(["OUTCOME_UNKNOWN", finalStatus]);
			// The child retains its 30-second bound; this also covers reopen, inspection and fresh dispatch.
		}, 60000);
	it("does not inspect under a changed replacement contract", async () => {
		const f = fixture();
		await lostReplacement(f);
		const old = f.kernel.finalize();
		f.kernel.register(
			{
				...createWriteTool(f.cwd),
				parameters: Type.Object({
					path: Type.String(),
					content: Type.String(),
					changed_contract: Type.Optional(Type.Boolean()),
				}),
				execute: async () => {
					throw new Error("Changed-contract fixture must not dispatch");
				},
			},
			"write",
		);
		f.kernel.captureInput(`resume ${old.mission_id}`, "USER");
		expect(() => f.kernel.begin("")).toThrow("adapter version changed");
		expect(f.kernel.state!.used.execution).toBe(1);
		expect(f.kernel.terminal).toEqual(old);
	});
	it("retains uncertainty when the original budget cannot admit its inspection", async () => {
		const f = fixture();
		await lostReplacement(f);
		const old = f.kernel.finalize();
		f.kernel.captureInput(
			`resume ${old.mission_id} budget: {"version":1,"ceilings":{"execution":1},"verification_reserve":0}`,
			"USER",
		);
		f.kernel.begin("");
		await expect(f.kernel.execute("read", "inspect", { path: "a.txt" })).rejects.toThrow(
			"no authorized unprotected capacity",
		);
		expect(f.kernel.state!.used.execution).toBe(1);
		expect(f.kernel.state!.operations).toHaveLength(1);
		expect(f.kernel.finalize().status).toBe("OUTCOME_UNKNOWN");
		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("new");
	});
	it("does not mistake a directory for an absent target", async () => {
		const f = fixture();
		await lostReplacement(f);
		const old = f.kernel.finalize();
		rmSync(join(f.cwd, "a.txt"));
		mkdirSync(join(f.cwd, "a.txt"));
		f.kernel.captureInput(`resume ${old.mission_id}`, "USER");
		f.kernel.begin("");
		await expect(f.kernel.execute("read", "inspect", { path: "a.txt" })).rejects.toThrow("inspection is unavailable");
		expect(
			f.store.records(old.mission_id).filter((record) => record.record_type === "ReconciliationRecord"),
		).toHaveLength(0);
		expect(f.kernel.finalize().status).toBe("OUTCOME_UNKNOWN");
	});
	it("retains the actual capture generation and refuses delivery when a file changes during inspection", async () => {
		const f = fixture();
		await lostReplacement(f);
		const old = f.kernel.finalize();
		f.kernel.captureInput(`resume ${old.mission_id}`, "USER");
		f.kernel.begin("");
		const observe = sourceIO.observedFile;
		let changed = false;
		const fault = vi.spyOn(sourceIO, "observedFile").mockImplementation((path, meter) => {
			const bytes = observe(path, meter);
			const current = f.store.get(old.mission_id, f.kernel.state!.operations.at(-1)!, "OperationRecord");
			if (
				!changed &&
				path === join(f.cwd, "a.txt") &&
				current.status === "IN_PROGRESS" &&
				f.store.get(old.mission_id, current.prepared_ref, "PreparedAction").operation_class === "READ"
			) {
				changed = true;
				writeFileSync(path, "intervening edit");
			}
			return bytes;
		});
		await expect(f.kernel.execute("read", "inspect", { path: "a.txt" })).rejects.toThrow(
			"inspection is unavailable or changed",
		);
		fault.mockRestore();
		expect(changed).toBe(true);
		const inspection = f.store.get(old.mission_id, f.kernel.state!.operations.at(-1)!, "OperationRecord");
		const action = f.store.get(old.mission_id, inspection.prepared_ref, "PreparedAction");
		const observation = f.store.get(old.mission_id, inspection.result_refs[0], "EvidenceRecord");
		const facts = observation.payload as { target_unchanged: boolean; full_output_ref: string };
		const captured = f.store.get(old.mission_id, facts.full_output_ref, "Artifact");
		expect(facts.target_unchanged).toBe(false);
		expect(captured.generation).toBe(action.target_generation);
		expect(captured.generation).not.toBe(observation.target_generation);
		expect(captured.purpose).toBe("OUTPUT");
		expect(f.store.artifact(old.mission_id, captured.record_id).toString()).toBe("new");
		expect(f.kernel.finalize().status).toBe("OUTCOME_UNKNOWN");
		expect(f.kernel.terminal!.artifacts).toHaveLength(0);
		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("intervening edit");
	});
	for (const kind of ["write", "edit"] as const)
		it(`observes a real lost ${kind} without replay and retains the report, ledger and validated recovery bytes`, async () => {
			const f = fixture();
			const original = await lostReplacement(f, kind);
			const old = f.kernel.finalize();
			const previous = f.kernel.state!;
			const reservation = f.store.get(old.mission_id, original.reservation_ref!, "BudgetReservation");
			const restored = new SandhanaKernel({ cwd: () => f.cwd, session: () => "reconcile", store: f.store });
			restored.register(createReadTool(f.cwd), "read");
			restored.register(createWriteTool(f.cwd), "write");
			restored.register(createEditTool(f.cwd), "edit");
			restored.captureInput(`resume ${old.mission_id}`, "USER");
			const compiled = restored.begin("");
			expect(compiled.reconciliation).toEqual({ operation_id: original.operation_id, path: join(f.cwd, "a.txt") });
			expect(restored.state!.used.execution).toBe(1);
			await expect(restored.execute("write", "duplicate", { path: "a.txt", content: "new" })).rejects.toThrow(
				"no repeat",
			);
			await expect(restored.execute("read", "partial", { path: "a.txt", limit: 1 })).rejects.toThrow(
				"complete target inspection",
			);
			await restored.execute("read", "inspect", { path: compiled.reconciliation!.path });
			const final = restored.finalize();
			expect(final.status).toBe("VERIFIED_COMPLETE");
			expect(final.limitations).toContain(LOCAL_POSTCONDITION_LIMIT);
			expect(restored.state!.used.execution).toBe(2);
			expect(restored.state!.used.ticks).toBe(0);
			expect(restored.state!.started_at).toBe(previous.started_at);
			expect(restored.store.get(old.mission_id, old.record_id, "TerminalReport")).toEqual(old);
			const settled = restored.store.get(old.mission_id, restored.state!.operations[0], "OperationRecord");
			expect(settled).toMatchObject({
				operation_id: original.operation_id,
				prepared_ref: original.prepared_ref,
				decision_ref: original.decision_ref,
				started_at: original.started_at,
				status: "CONFIRMED_COMPLETE",
				reservation_ref: original.reservation_ref,
			});
			expect(settled.reconciliation_refs).toHaveLength(1);
			expect(restored.store.get(old.mission_id, settled.reservation_ref!, "BudgetReservation")).toEqual(reservation);
			expect(restored.state!.operations).toHaveLength(2);
			expect(restored.store.list("reconcile")).toHaveLength(1);
			expect(final.artifacts.some((ref) => restored.store.artifact(old.mission_id, ref).toString() === "new")).toBe(
				true,
			);
			const best = restored.store.get(old.mission_id, restored.state!.best[0], "CheckpointRecord");
			expect(best.level).toBe("MISSION_VERIFIED");
			expect(restored.store.artifact(old.mission_id, best.artifact_ref).toString()).toBe("new");
		});
	for (const current of ["old", "human edit", null])
		it(`keeps uncertainty and current bytes when the target is ${current ?? "absent"}`, async () => {
			const f = fixture();
			const original = await lostReplacement(f);
			const old = f.kernel.finalize();
			if (current === null) rmSync(join(f.cwd, "a.txt"));
			else writeFileSync(join(f.cwd, "a.txt"), current);
			f.kernel.captureInput(`resume ${old.mission_id}`, "USER");
			f.kernel.begin("");
			await expect(f.kernel.execute("read", "inspect", { path: "a.txt" })).rejects.toThrow(
				"differs from the prepared postcondition",
			);
			const record = f.store
				.records(old.mission_id)
				.findLast((value) => value.record_type === "ReconciliationRecord")!;
			expect(record.result).toBe("NOT_AT_POSTCONDITION");
			expect(f.kernel.state!.operations[0]).toBe(original.record_id);
			expect(f.kernel.state!.used.execution).toBe(2);
			expect(f.kernel.finalize().status).toBe("OUTCOME_UNKNOWN");
			if (current === null) expect(existsSync(join(f.cwd, "a.txt"))).toBe(false);
			else expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe(current);
		});
	it("cannot relabel differing current bytes as positive reconciliation or settle with an arbitrary nonempty reference", async () => {
		const f = fixture();
		const original = await lostReplacement(f);
		const old = f.kernel.finalize();
		writeFileSync(join(f.cwd, "a.txt"), "human edit");
		f.kernel.captureInput(`resume ${old.mission_id}`, "USER");
		f.kernel.begin("");
		await expect(f.kernel.execute("read", "inspect", { path: "a.txt" })).rejects.toThrow("differs");
		const state = f.kernel.state!;
		const negative = f.store
			.records(old.mission_id)
			.findLast((record) => record.record_type === "ReconciliationRecord")!;
		const fake = makeRecord(old.mission_id, state.revision + 1, "ReconciliationRecord", {
			...negative,
			result: "POSTCONDITION_OBSERVED",
		});
		const settled = makeRecord(old.mission_id, state.revision + 1, "OperationRecord", {
			...original,
			status: "CONFIRMED_COMPLETE",
			result_refs: [...original.result_refs, fake.observation_ref],
			reconciliation_refs: [fake.record_id],
		});
		const proposed = {
			...state,
			revision: state.revision + 1,
			operations: state.operations.map((ref) => (ref === original.record_id ? settled.record_id : ref)),
		};
		expect(() => f.store.commit(state.revision, proposed, [fake, settled])).toThrow("verdict differs");
		const unsupported = makeRecord(old.mission_id, state.revision + 1, "OperationRecord", {
			...original,
			status: "CONFIRMED_COMPLETE",
			reconciliation_refs: [original.result_refs[0]],
		});
		expect(() =>
			f.store.commit(
				state.revision,
				{
					...proposed,
					operations: state.operations.map((ref) => (ref === original.record_id ? unsupported.record_id : ref)),
				},
				[unsupported],
			),
		).toThrow("authoritative reconciliation");
		expect(f.kernel.state).toEqual(state);
	});
	it("does not restore revoked read authority while reconciling an actual replacement", async () => {
		const f = fixture();
		await lostReplacement(f);
		f.kernel.revoke();
		const old = f.kernel.finalize();
		f.kernel.captureInput(`resume ${old.mission_id}`, "USER");
		f.kernel.begin("");
		await expect(f.kernel.execute("read", "inspect", { path: "a.txt" })).rejects.toThrow();
		expect(f.kernel.state!.used.execution).toBe(1);
		expect(f.kernel.finalize().status).toBe("OUTCOME_UNKNOWN");
		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("new");
	});
	it("cannot inspect or steal a foreground replacement whose owner is still live", async () => {
		let entered!: () => void;
		let release!: () => void;
		const reached = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const f = fixture(async () => {
			entered();
			await wait;
		}, "dir/a.txt");
		const running = f.kernel.execute("write", "running", { path: "dir/a.txt", content: "new" });
		await reached;
		try {
			f.kernel.captureInput(`resume ${f.kernel.state!.mission_id}`, "USER");
			expect(() => f.kernel.begin("")).toThrow("live operation owner");
			expect(f.kernel.state!.used.execution).toBe(1);
			expect(f.kernel.state!.operations).toHaveLength(1);
		} finally {
			release();
			await running;
		}
		expect(readFileSync(join(f.cwd, "dir/a.txt"), "utf8")).toBe("new");
	});
});
