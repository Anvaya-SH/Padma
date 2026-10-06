import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { progressFacts } from "../src/core/sandhana/governor.ts";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createReadTool, createWriteTool } from "../src/core/tools/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function openTick(kernel: SandhanaKernel) {
	const reservation = kernel.reserveModel(100, 100);
	kernel.beginCognitiveTick(reservation);
	kernel.reconcileModel(reservation, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, 1);
}
async function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "padma-recovery-progress-"));
	const cwd = join(directory, "workspace");
	mkdirSync(cwd);
	writeFileSync(join(cwd, "a.txt"), "old");
	const store = new MissionStore(join(directory, "mission.sqlite"));
	const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "progress", store });
	kernel.register(createReadTool(cwd), "read");
	kernel.register(createWriteTool(cwd), "write");
	cleanups.push(() => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	});
	kernel.captureInput(
		`padma: ${JSON.stringify({
			objective: "Repair parser behavior",
			allow_edits: true,
			requirements: [{ text: "Preserve parser behavior", rule: "SEMANTIC", target: "." }],
		})}`,
		"USER",
	);
	kernel.begin("");
	for (let index = 0; index < 3; index++) {
		openTick(kernel);
		kernel.finishCognitiveTick();
	}
	openTick(kernel);
	const commit = store.commit.bind(store);
	let interrupted = false;
	const fault = vi.spyOn(store, "commit").mockImplementation((expected, state, records, artifacts) => {
		if (
			!interrupted &&
			records.some(
				(record) =>
					record.record_type === "BudgetReservation" &&
					record.state === "RESERVED" &&
					record.amounts.retrieval_bytes > 0,
			) &&
			readFileSync(join(cwd, "a.txt"), "utf8") === "new"
		) {
			interrupted = true;
			throw new Error("Lost observation after actual replacement");
		}
		return commit(expected, state, records, artifacts);
	});
	await expect(kernel.execute("write", "lost", { path: "a.txt", content: "new" })).rejects.toThrow(
		"may have taken effect",
	);
	fault.mockRestore();
	expect(interrupted).toBe(true);
	expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("new");
	kernel.finishCognitiveTick();
	expect(kernel.state!.stagnation).toBe(4);
	const operation = store.get(kernel.state!.mission_id, kernel.state!.operations[0], "OperationRecord");
	expect(operation.status).toBe("OUTCOME_UNKNOWN");
	const report = kernel.finalize();
	expect(report.status).toBe("OUTCOME_UNKNOWN");
	kernel.captureInput(`resume ${report.mission_id}`, "USER");
	kernel.begin("");
	return { cwd, store, kernel, operation, report };
}
describe("evidence-derived progress from narrowed local uncertainty", () => {
	it.each(["settle", "resume"] as const)(
		"counts the supported postcondition once through %s and reopen without claiming semantic completion",
		async (settlement) => {
			const f = await fixture();
			openTick(f.kernel);
			await f.kernel.execute("read", "inspect", { path: "a.txt" });
			const state = f.kernel.state!;
			expect(state.requirements.map((ref) => f.store.get(state.mission_id, ref, "Requirement").status)).toEqual([
				"UNMET",
			]);
			expect(f.kernel.ready()).toBe(false);
			const reconciliation = f.store
				.records(state.mission_id)
				.findLast((record) => record.record_type === "ReconciliationRecord")!;
			expect(reconciliation.result).toBe("POSTCONDITION_OBSERVED");
			expect(progressFacts(f.store, state)).toHaveLength(1);
			if (settlement === "resume") {
				const stopped = f.kernel.finalize("BLOCKED", "Interrupted decision after actual inspection");
				f.kernel.captureInput(`resume ${state.mission_id}`, "USER");
				f.kernel.begin("");
				expect(f.store.get(state.mission_id, stopped.record_id, "TerminalReport")).toEqual(stopped);
			} else f.kernel.finishCognitiveTick();
			expect(f.kernel.state!.stagnation).toBe(0);
			const tick = f.store.get(state.mission_id, f.kernel.state!.cognitive_tick!, "CognitiveTick");
			expect(tick.progress[0].evidence).toEqual([reconciliation.observation_ref]);
			const reopened = new SandhanaKernel({ cwd: () => f.cwd, session: () => "progress", store: f.store });
			reopened.register(createReadTool(f.cwd), "read");
			openTick(reopened);
			await reopened.execute("read", "same-current-bytes", { path: "a.txt" });
			reopened.finishCognitiveTick();
			expect(reopened.state!.stagnation).toBe(1);
			expect(reopened.state!.used.ticks).toBe(6);
			expect(f.store.get(state.mission_id, f.report.record_id, "TerminalReport")).toEqual(f.report);
			expect(f.store.get(state.mission_id, f.operation.reservation_ref!, "BudgetReservation")).toEqual(
				f.store.get(
					state.mission_id,
					reopened
						.state!.operations.map((ref) => f.store.get(state.mission_id, ref, "OperationRecord"))
						.find((operation) => operation.operation_id === f.operation.operation_id)!.reservation_ref!,
					"BudgetReservation",
				),
			);
		},
		60000,
	);
	it("differing current bytes remain uncertain and cannot reset the governor", async () => {
		const f = await fixture();
		writeFileSync(join(f.cwd, "a.txt"), "human edit");
		openTick(f.kernel);
		await expect(f.kernel.execute("read", "inspect", { path: "a.txt" })).rejects.toThrow(
			"differs from the prepared postcondition",
		);
		expect(progressFacts(f.store, f.kernel.state!)).toEqual([]);
		f.kernel.finishCognitiveTick();
		expect(f.kernel.state!.stagnation).toBe(5);
		expect(f.kernel.finalize().status).toBe("OUTCOME_UNKNOWN");
		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("human edit");
	}, 60000);
	it("a reconciled label with unavailable inspection bytes cannot establish new progress", async () => {
		const f = await fixture();
		openTick(f.kernel);
		await f.kernel.execute("read", "inspect", { path: "a.txt" });
		const state = f.kernel.state!;
		const reconciliation = f.store
			.records(state.mission_id)
			.findLast((record) => record.record_type === "ReconciliationRecord")!;
		const observation = f.store.get(state.mission_id, reconciliation.observation_ref, "EvidenceRecord");
		const database = new DatabaseSync(f.store.databasePath);
		try {
			database
				.prepare("DELETE FROM artifacts WHERE mission=? AND id=?")
				.run(state.mission_id, observation.artifact_ref);
		} finally {
			database.close();
		}
		expect(progressFacts(f.store, f.kernel.state!)).toEqual([]);
		f.kernel.finishCognitiveTick();
		expect(f.kernel.state!.stagnation).toBe(5);
	}, 60000);
});
