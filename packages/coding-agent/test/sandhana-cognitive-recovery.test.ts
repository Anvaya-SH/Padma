import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COGNITIVE_RECOVERY_VERSION } from "../src/core/sandhana/governor.ts";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { digest, type MissionState, makeRecord } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createReadTool } from "../src/core/tools/read.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "padma-cognitive-recovery-"));
	const cwd = join(directory, "workspace");
	mkdirSync(cwd);
	const path = join(directory, "mission.sqlite");
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	return { directory, cwd, path };
}
function crashedDecision(measured: boolean, prepared = false) {
	const f = fixture();
	const crash = join(f.directory, "crash.mjs");
	writeFileSync(
		crash,
		`
import { SandhanaKernel } from ${JSON.stringify(pathToFileURL(resolve("src/core/sandhana/kernel.ts")).href)};
import { MissionStore } from ${JSON.stringify(pathToFileURL(resolve("src/core/sandhana/store.ts")).href)};
import { createReadTool } from ${JSON.stringify(pathToFileURL(resolve("src/core/tools/read.ts")).href)};
const store = new MissionStore(process.argv[2]);
const kernel = new SandhanaKernel({ cwd: () => process.argv[3], session: () => 'recovery', store, limits: { elapsed_ms: 3600000 } });
kernel.captureInput('Inspect the parser behavior', 'USER');
kernel.begin('');
const ref = kernel.reserveModel(100, 100);
kernel.beginCognitiveTick(ref);
if (${measured}) kernel.reconcileModel(ref, { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, 5);
if (${prepared}) {
  kernel.register(createReadTool(process.argv[3]), 'read');
  await kernel.prepareOperation('read', 'never-dispatched', { path: 'parser.txt' });
}
process.kill(process.pid, 'SIGKILL');
`,
	);
	if (prepared) writeFileSync(join(f.cwd, "parser.txt"), "retained source");
	expect(() =>
		execFileSync(process.execPath, ["--experimental-strip-types", crash, f.path, f.cwd], {
			stdio: "pipe",
			windowsHide: true,
			timeout: 45000,
		}),
	).toThrow();
	const store = new MissionStore(f.path);
	cleanups.push(() => store.close());
	const before = store.list("recovery")[0];
	expect(before).toBeDefined();
	expect(before.terminal).toBeNull();
	expect(store.get(before.mission_id, before.cognitive_tick!, "CognitiveTick").status).toBe("OPEN");
	const kernel = new SandhanaKernel({ cwd: () => f.cwd, session: () => "recovery", store });
	return { ...f, store, kernel, before };
}

describe("recovery of an interrupted cognitive decision", () => {
	it.each([false, true])(
		"explicit resume preserves the dead decision's %s measurement state and settles its tick once",
		(measured) => {
			const f = crashedDecision(measured);
			const before = f.before;
			const reservations = before.reservations.map((ref) =>
				f.store.get(before.mission_id, ref, "BudgetReservation"),
			);
			f.kernel.captureInput(`resume ${before.mission_id}`, "USER");
			expect(() => f.kernel.begin("")).not.toThrow();
			const state = f.kernel.state!;
			expect(state.mission_id).toBe(before.mission_id);
			expect(state.owner_pid).toBe(process.pid);
			expect(state.started_at).toBe(before.started_at);
			expect(state.ceilings).toEqual(before.ceilings);
			expect(state.used.ticks).toBe(1);
			expect(state.used.input_tokens).toBe(before.used.input_tokens);
			expect(state.used.output_tokens).toBe(before.used.output_tokens);
			expect(state.used.cost).toBe(before.used.cost);
			expect(state.used.execution).toBe(0);
			for (const reservation of reservations)
				expect(
					state.reservations.map((ref) => f.store.get(state.mission_id, ref, "BudgetReservation")),
				).toContainEqual(reservation);
			expect(state.stagnation).toBe(1);
			expect(f.store.get(state.mission_id, state.cognitive_tick!, "CognitiveTick").status).toBe("SETTLED");
			const history = f.store.records(state.mission_id);
			expect(
				history.filter((record) => record.record_type === "CognitiveTick" && record.status === "SETTLED"),
			).toHaveLength(1);
			expect(history.filter((record) => record.record_type === "ResumeRecord")).toHaveLength(1);
			const recoveredReport = history.find((record) => record.record_type === "TerminalReport");
			expect(recoveredReport).toMatchObject({ status: "BLOCKED" });
			f.kernel.finishCognitiveTick();
			expect(f.kernel.state).toEqual(state);
		},
		60000,
	);
	it("malformed resume budget cannot claim or settle a dead owner's decision", () => {
		const f = crashedDecision(false);
		const records = f.store.records(f.before.mission_id);
		f.kernel.captureInput(`resume ${f.before.mission_id} budget: {`, "USER");
		expect(() => f.kernel.begin("")).toThrow();
		expect(f.kernel.state).toEqual(f.before);
		expect(f.store.records(f.before.mission_id)).toEqual(records);
	}, 60000);
	it("recovery evidence cannot alter the account, invent measurements or use an unrelated instruction", () => {
		const f = crashedDecision(false);
		const before = f.before;
		const tick = f.store.get(before.mission_id, before.cognitive_tick!, "CognitiveTick");
		const payload = {
			instruction: `resume ${before.mission_id}`,
			source_revision: before.revision,
			prior_owner_pid: before.owner_pid,
			contract_ref: before.contract,
			tick_ref: before.cognitive_tick,
			model_reservation_ref: tick.model_reservation_ref,
			model_usage_status: "UNKNOWN_RETAINED",
		};
		const variants: { payload?: Record<string, unknown>; state?: Partial<MissionState> }[] = [
			{ payload: { instruction: `resume ${before.mission_id}-other` } },
			{ payload: { model_usage_status: "SETTLED" } },
			{ payload: { model_reservation_ref: before.contract } },
			{ payload: { source_revision: before.revision - 1 } },
			{ state: { intent_epoch: (before.intent_epoch ?? 1) + 1 } },
			{ state: { verification_reserve: 0 } },
			{ state: { used: { ...before.used, ticks: 0 } } },
		];
		const records = f.store.records(before.mission_id);
		for (const variant of variants) {
			const facts = { ...payload, ...variant.payload };
			const evidence = makeRecord(before.mission_id, before.revision + 1, "EvidenceRecord", {
				event_id: "forged-recovery",
				stage: "niyantr",
				kind: "CONTROL",
				provenance: "KERNEL",
				target_generation: null,
				captured_at: Date.now(),
				operation_id: null,
				source: COGNITIVE_RECOVERY_VERSION,
				payload: facts,
				artifact_ref: null,
				digest: digest(facts),
				sensitivity: "PRIVATE",
				sources: [],
				requirement_ids: [],
				correction_of: null,
				previous: before.last_event,
			});
			expect(() =>
				f.store.commit(
					before.revision,
					{
						...before,
						revision: before.revision + 1,
						owner_pid: process.pid,
						last_event: evidence.record_id,
						...variant.state,
					},
					[evidence],
				),
			).toThrow();
			expect(f.kernel.state).toEqual(before);
			expect(f.store.records(before.mission_id)).toEqual(records);
		}
	}, 60000);
	it("a failed recovery settlement can be retried without another charge or recovery event", () => {
		const f = crashedDecision(false);
		const commit = f.store.commit.bind(f.store);
		const failure = vi.spyOn(f.store, "commit").mockImplementation((expected, state, records, artifacts) => {
			if (records.some((record) => record.record_type === "CognitiveTick" && record.status === "SETTLED"))
				throw new Error("interrupted recovery settlement");
			return commit(expected, state, records, artifacts);
		});
		f.kernel.captureInput(`resume ${f.before.mission_id}`, "USER");
		expect(() => f.kernel.begin("")).toThrow("interrupted recovery settlement");
		expect(f.kernel.state!.owner_pid).toBe(process.pid);
		expect(f.kernel.state!.terminal).toBeNull();
		failure.mockRestore();
		f.kernel.captureInput(`resume ${f.before.mission_id}`, "USER");
		f.kernel.begin("");
		const state = f.kernel.state!;
		expect(state.used.ticks).toBe(1);
		expect(state.stagnation).toBe(1);
		const records = f.store.records(state.mission_id);
		expect(
			records.filter(
				(record) => record.record_type === "EvidenceRecord" && record.source === COGNITIVE_RECOVERY_VERSION,
			),
		).toHaveLength(1);
		expect(records.filter((record) => record.record_type === "ResumeRecord")).toHaveLength(1);
		expect(
			records.filter((record) => record.record_type === "CognitiveTick" && record.status === "SETTLED"),
		).toHaveLength(1);
	}, 60000);
	it("an unstarted prepared action cannot leave the interrupted decision open on continuation", () => {
		const f = crashedDecision(true, true);
		f.kernel.register(createReadTool(f.cwd), "read");
		f.kernel.captureInput("continue", "USER");
		f.kernel.begin("");
		const state = f.kernel.state!;
		expect(state.mission_id).toBe(f.before.mission_id);
		expect(state.used.execution).toBe(0);
		expect(state.used.ticks).toBe(1);
		expect(state.stagnation).toBe(1);
		expect(f.store.get(state.mission_id, state.operations[0], "OperationRecord").status).toBe("NOT_STARTED");
		const next = f.kernel.reserveModel(100, 100);
		expect(() => f.kernel.beginCognitiveTick(next)).not.toThrow();
	}, 60000);
	it("an open decision owned by this live process is not a stopped run", () => {
		const store = new MissionStore(":memory:");
		cleanups.push(() => store.close());
		const kernel = new SandhanaKernel({ cwd: () => process.cwd(), session: () => "live", store });
		kernel.captureInput("Inspect the parser behavior", "USER");
		kernel.begin("");
		kernel.beginCognitiveTick(kernel.reserveModel(100, 100));
		const before = kernel.state!;
		const records = store.records(before.mission_id);
		kernel.captureInput(`resume ${before.mission_id}`, "USER");
		expect(() => kernel.begin("")).toThrow("stopped mission or a dead owner");
		kernel.captureInput(`resume ${before.mission_id}`, "EXTENSION");
		expect(() => kernel.begin("")).toThrow("Only current client input");
		expect(kernel.state).toEqual(before);
		expect(store.records(before.mission_id)).toEqual(records);
	});
	it("a stopped report with an open tick cannot prevent the next explicitly resumed decision", () => {
		const f = fixture();
		const store = new MissionStore(f.path);
		cleanups.push(() => store.close());
		const kernel = new SandhanaKernel({ cwd: () => f.cwd, session: () => "recovery", store });
		kernel.captureInput("Inspect the parser behavior", "USER");
		kernel.begin("");
		const ref = kernel.reserveModel(100, 100);
		kernel.beginCognitiveTick(ref);
		kernel.reconcileModel(ref, { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, 5);
		const report = kernel.finalize("BLOCKED", "Decision settlement was interrupted");
		const before = kernel.state!;
		kernel.captureInput(`resume ${before.mission_id}`, "USER");
		kernel.begin("");
		expect(kernel.state!.stagnation).toBe(1);
		expect(kernel.state!.used.ticks).toBe(1);
		expect(store.get(before.mission_id, report.record_id, "TerminalReport")).toEqual(report);
		const next = kernel.reserveModel(100, 100);
		expect(() => kernel.beginCognitiveTick(next)).not.toThrow();
		expect(kernel.state!.used.ticks).toBe(2);
	});
	it("a failed stopped-run settlement preserves the report and complete projection for retry", () => {
		const store = new MissionStore(":memory:");
		cleanups.push(() => store.close());
		const kernel = new SandhanaKernel({ cwd: () => process.cwd(), session: () => "stopped-retry", store });
		kernel.captureInput("Inspect the parser behavior", "USER");
		kernel.begin("");
		kernel.beginCognitiveTick(kernel.reserveModel(100, 100));
		const report = kernel.finalize("BLOCKED", "Interrupted settlement");
		const before = kernel.state!;
		const records = store.records(before.mission_id);
		const commit = store.commit.bind(store);
		const failure = vi.spyOn(store, "commit").mockImplementation((expected, state, additions, artifacts) => {
			if (additions.some((record) => record.record_type === "CognitiveTick" && record.status === "SETTLED"))
				throw new Error("resume settlement persistence failed");
			return commit(expected, state, additions, artifacts);
		});
		kernel.captureInput(`resume ${before.mission_id}`, "USER");
		expect(() => kernel.begin("")).toThrow("resume settlement persistence failed");
		expect(kernel.state).toEqual(before);
		expect(kernel.terminal).toEqual(report);
		expect(store.records(before.mission_id)).toEqual(records);
		failure.mockRestore();
		kernel.captureInput(`resume ${before.mission_id}`, "USER");
		kernel.begin("");
		expect(kernel.state!.stagnation).toBe(1);
		expect(kernel.state!.used.ticks).toBe(1);
		expect(store.records(before.mission_id).filter((record) => record.record_type === "ResumeRecord")).toHaveLength(
			1,
		);
	});
});
