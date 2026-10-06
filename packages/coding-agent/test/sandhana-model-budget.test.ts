import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SandhanaError } from "../src/core/sandhana/errors.ts";
import { KernelStop, SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { MODEL_OVERRUN_SOURCE } from "../src/core/sandhana/model-usage.ts";
import { digest, makeRecord, resources } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "padma-model-budget-"));
	const store = new MissionStore(":memory:");
	const kernel = new SandhanaKernel({
		cwd: () => cwd,
		session: () => "model-budget",
		store,
		limits: { cost: 3, input_tokens: 300, output_tokens: 300 },
	});
	kernel.captureInput("Inspect the parser behavior", "USER");
	kernel.begin("");
	cleanups.push(() => {
		store.close();
		rmSync(cwd, { recursive: true, force: true });
	});
	return { cwd, store, kernel };
}
function rejected(launch: () => unknown): SandhanaError {
	let failure: unknown;
	try {
		launch();
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(SandhanaError);
	if (!(failure instanceof SandhanaError)) throw new Error("Expected typed budget rejection");
	expect(failure.failure).toMatchObject({
		code: "BUDGET_REJECTED",
		operation_id: null,
		target_binding_ref: null,
		retry: { automatic: false },
	});
	return failure;
}

describe("cumulative model reservation admission", () => {
	it.each(["negative input", "fractional output", "cache overflow", "invalid cost"] as const)(
		"retains malformed %s as unknown once and fences all new admission",
		(problem) => {
			const f = fixture();
			const ref = f.kernel.reserveModel(100, 100, 1);
			const usage = {
				input: problem === "negative input" ? -1 : problem === "cache overflow" ? Number.MAX_SAFE_INTEGER : 10,
				output: problem === "fractional output" ? 0.5 : 10,
				cacheRead: problem === "cache overflow" ? 1 : 0,
				cacheWrite: 0,
				cost: { total: problem === "invalid cost" ? Infinity : 0.1 },
			};
			const failure = f.kernel.reconcileModel(ref, usage, 1);
			expect(failure).toMatchObject({ status: "EXECUTION_FAILED", failure: { code: "PROVIDER_FAILURE" } });
			const state = f.kernel.state!;
			expect(state.used).toMatchObject({
				input_tokens: ["negative input", "cache overflow"].includes(problem) ? null : 10,
				output_tokens: problem === "fractional output" ? null : 10,
				cost: problem === "invalid cost" ? null : 0.1,
				ticks: 1,
			});
			expect(f.kernel.reconcileModel(ref, usage, 1)).toMatchObject({ failure: { code: "PROVIDER_FAILURE" } });
			expect(f.kernel.state).toEqual(state);
			rejected(() => f.kernel.reserveModel(0, 0, 0));
			const retrieval = makeRecord(state.mission_id, state.revision + 1, "BudgetReservation", {
				owner_operation_id: "retrieval:invalid-model-usage",
				amounts: resources(),
				protected_for_verification: false,
				state: "RESERVED",
				actual: null,
			});
			expect(() =>
				f.store.commit(
					state.revision,
					{ ...state, revision: state.revision + 1, reservations: [...state.reservations, retrieval.record_id] },
					[retrieval],
				),
			).toThrow(SandhanaError);
			expect(f.kernel.state).toEqual(state);
			expect(
				f.store
					.records(state.mission_id)
					.filter(
						(record) => record.record_type === "EvidenceRecord" && record.source === "invalid-model-usage/1",
					),
			).toHaveLength(1);
		},
	);
	it("retains an elapsed-time ceiling overrun and rejects further launch", () => {
		const f = fixture();
		const ref = f.kernel.reserveModel(100, 100, 1);
		const elapsed = f.kernel.state!.ceilings.elapsed_ms! + 1;
		expect(
			f.kernel.reconcileModel(
				ref,
				{ input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } },
				elapsed,
			),
		).toMatchObject({ failure: { code: "BUDGET_OVERRUN" } });
		const state = f.kernel.state!;
		expect(state.used.elapsed_ms).toBeGreaterThanOrEqual(elapsed);
		expect(
			f.store
				.records(state.mission_id)
				.filter((record) => record.record_type === "EvidenceRecord" && record.source === MODEL_OVERRUN_SOURCE),
		).toMatchObject([{ payload: { over_ceiling: ["elapsed_ms"] } }]);
		expect(() => f.kernel.reserveModel(0, 0, 0)).toThrow(SandhanaError);
		expect(f.kernel.state).toEqual(state);
	});
	it.each(["cost", "input_tokens", "output_tokens"] as const)(
		"retains a %s reservation overrun once even below the hard ceiling and blocks new admission",
		(dimension) => {
			const f = fixture();
			const ref = f.kernel.reserveModel(100, 100, 1);
			const usage = {
				input: dimension === "input_tokens" ? 101 : 20,
				output: dimension === "output_tokens" ? 101 : 20,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: dimension === "cost" ? 1.1 : 0.1 },
			};
			const failure = f.kernel.reconcileModel(ref, usage, 1);
			expect(failure).toBeInstanceOf(KernelStop);
			const state = f.kernel.state!;
			const settlement = f.store.get(state.mission_id, state.reservations[0], "BudgetReservation");
			const overruns = f.store
				.records(state.mission_id)
				.filter((record) => record.record_type === "EvidenceRecord" && record.source === MODEL_OVERRUN_SOURCE);
			expect(overruns).toHaveLength(1);
			expect(overruns[0]).toMatchObject({
				revision: settlement.revision,
				failure: { code: "BUDGET_OVERRUN", operation_id: null, target_binding_ref: null },
				payload: {
					reservation_ref: ref,
					settlement_ref: settlement.record_id,
					over_reservation: [dimension],
					over_ceiling: [],
				},
			});
			expect(settlement.state).toBe("RECONCILED");
			expect(state.used).toMatchObject({
				cost: usage.cost.total,
				input_tokens: usage.input,
				output_tokens: usage.output,
				ticks: 1,
			});
			expect(f.kernel.reconcileModel(ref, usage, 1)).toBeInstanceOf(KernelStop);
			expect(f.kernel.state).toEqual(state);
			expect(f.kernel.recordFailure(failure!)).toBe(overruns[0].record_id);
			expect(f.kernel.state).toEqual(state);
			let denied: unknown;
			try {
				f.kernel.reserveModel(1, 1, 0);
			} catch (error) {
				denied = error;
			}
			expect(denied).toMatchObject({ status: "BUDGET_EXHAUSTED", failure: { code: "BUDGET_OVERRUN" } });
			expect(f.kernel.state).toEqual(state);
		},
	);
	it("rejects a settlement missing its exact overrun evidence atomically", () => {
		const f = fixture();
		const ref = f.kernel.reserveModel(100, 100, 1);
		const before = f.kernel.state!;
		const reserved = f.store.get(before.mission_id, ref, "BudgetReservation");
		const actual = { ...resources(), input_tokens: 101, output_tokens: 20, cost: 0.1, ticks: 1, elapsed_ms: 1 };
		const settled = makeRecord(before.mission_id, before.revision + 1, "BudgetReservation", {
			...reserved,
			state: "RECONCILED",
			actual,
		});
		const state = {
			...before,
			revision: before.revision + 1,
			reservations: [settled.record_id],
			used: {
				...before.used,
				input_tokens: 101,
				output_tokens: 20,
				cost: 0.1,
				elapsed_ms: before.used.elapsed_ms + 1,
			},
		};
		expect(() => f.store.commit(before.revision, state, [settled])).toThrow("overrun");
		expect(f.kernel.state).toEqual(before);
	});
	it("settles already admitted peers after an overrun and retains cumulative ceiling evidence", () => {
		const f = fixture();
		const first = f.kernel.reserveModel(100, 100, 1);
		const second = f.kernel.reserveModel(100, 100, 1);
		const usage = { input: 310, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } };
		expect(f.kernel.reconcileModel(first, usage, 1)).toBeInstanceOf(KernelStop);
		const peer = new SandhanaKernel({ cwd: () => f.cwd, session: () => "model-budget", store: f.store });
		expect(peer.reconcileModel(second, { ...usage, input: 10 }, 2)).toBeInstanceOf(KernelStop);
		const state = f.kernel.state!;
		expect(state.used).toMatchObject({ input_tokens: 320, output_tokens: 40, cost: 0.2, ticks: 2 });
		expect(state.reservations.map((ref) => f.store.get(state.mission_id, ref, "BudgetReservation").state)).toEqual([
			"RECONCILED",
			"RECONCILED",
		]);
		const events = f.store
			.records(state.mission_id)
			.filter((record) => record.record_type === "EvidenceRecord" && record.source === MODEL_OVERRUN_SOURCE);
		expect(events.map((event) => (event.record_type === "EvidenceRecord" ? event.payload : null))).toEqual([
			expect.objectContaining({
				reservation_ref: first,
				over_reservation: ["input_tokens"],
				over_ceiling: ["input_tokens"],
			}),
			expect.objectContaining({ reservation_ref: second, over_reservation: [], over_ceiling: ["input_tokens"] }),
		]);
		const duplicate = f.kernel.reconcileModel(first, usage, 1)!;
		expect(f.kernel.recordFailure(duplicate)).toBe(events[0].record_id);
		expect(f.kernel.state).toEqual(state);
	});
	it("requires an explicit user resume to admit further work and preserves all earlier model spending", () => {
		const f = fixture();
		const ref = f.kernel.reserveModel(100, 100, 1);
		f.kernel.reconcileModel(ref, { input: 101, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } }, 1);
		const stopped = f.kernel.finalize("BUDGET_EXHAUSTED");
		const before = f.kernel.state!;
		expect(
			stopped.failure_refs!.map((id) => f.store.get(before.mission_id, id, "EvidenceRecord").failure?.code),
		).toContain("BUDGET_OVERRUN");
		f.kernel.captureInput(`resume ${before.mission_id}`, "EXTENSION");
		expect(() => f.kernel.begin("")).toThrow("Only current client input");
		expect(f.kernel.state).toEqual(before);
		f.kernel.captureInput(`resume ${before.mission_id}`, "USER");
		f.kernel.begin("");
		const resumed = f.kernel.state!;
		expect(resumed.intent_epoch).toBe(before.intent_epoch! + 1);
		expect(resumed.used).toMatchObject({ input_tokens: 101, output_tokens: 20, cost: 0.1, ticks: 1 });
		f.kernel.reserveModel(50, 50, 0.1);
		expect(f.kernel.state!.used.ticks).toBe(2);
	});
	it.each(["source", "reservation", "settlement", "dimensions", "spending", "duplicate"] as const)(
		"rejects forged overrun %s and rolls back the settlement",
		(field) => {
			const f = fixture();
			const ref = f.kernel.reserveModel(100, 100, 1);
			const before = f.kernel.state!;
			const reserved = f.store.get(before.mission_id, ref, "BudgetReservation");
			const actual = { ...resources(), input_tokens: 101, output_tokens: 20, cost: 0.1, ticks: 1, elapsed_ms: 1 };
			const settled = makeRecord(before.mission_id, before.revision + 1, "BudgetReservation", {
				...reserved,
				state: "RECONCILED",
				actual,
			});
			const payload = {
				version: "MODEL_USAGE_OVERRUN/1",
				intent_epoch: before.intent_epoch,
				contract_ref: before.contract,
				reservation_ref: field === "reservation" ? settled.record_id : ref,
				settlement_ref: field === "settlement" ? ref : settled.record_id,
				over_reservation: field === "dimensions" ? [] : ["input_tokens"],
				over_ceiling: [],
			};
			const evidence = makeRecord(before.mission_id, before.revision + 1, "EvidenceRecord", {
				event_id: "forged-overrun",
				stage: "kosa",
				kind: "CONTROL",
				provenance: "KERNEL",
				target_generation: null,
				captured_at: Date.now(),
				operation_id: null,
				source: field === "source" ? "other" : MODEL_OVERRUN_SOURCE,
				payload,
				artifact_ref: null,
				digest: digest(payload),
				sensitivity: "PRIVATE",
				sources: [],
				requirement_ids: [],
				correction_of: null,
				previous: before.last_event,
				failure: new SandhanaError("BUDGET_OVERRUN", "Fixture usage exceeded reservation").failure,
			});
			const state = {
				...before,
				revision: before.revision + 1,
				reservations: [settled.record_id],
				last_event: evidence.record_id,
				used: {
					...before.used,
					input_tokens: field === "spending" ? 1 : 101,
					output_tokens: 20,
					cost: 0.1,
					elapsed_ms: before.used.elapsed_ms + 1,
				},
			};
			const additions = [settled, evidence];
			if (field === "duplicate")
				additions.push(makeRecord(before.mission_id, state.revision, "EvidenceRecord", evidence));
			expect(() => f.store.commit(before.revision, state, additions)).toThrow();
			expect(f.kernel.state).toEqual(before);
			expect(f.store.records(before.mission_id).some((record) => record.record_id === settled.record_id)).toBe(
				false,
			);
		},
	);
	it.each(["cost", "input_tokens", "output_tokens"] as const)(
		"rejects competing %s without spending a tick and admits only remaining capacity after settlement",
		(dimension) => {
			const f = fixture();
			const first = f.kernel.reserveModel(200, 200, 2);
			const peer = new SandhanaKernel({ cwd: () => f.cwd, session: () => "model-budget", store: f.store });
			const before = f.kernel.state!;
			const records = f.store.records(before.mission_id);
			const request = [
				dimension === "input_tokens" ? 101 : 100,
				dimension === "output_tokens" ? 101 : 100,
				dimension === "cost" ? 1.1 : 1,
			] as const;
			expect(rejected(() => peer.reserveModel(...request))).toBeInstanceOf(KernelStop);
			expect(f.kernel.state).toEqual(before);
			expect(f.store.records(before.mission_id)).toEqual(records);
			f.kernel.reconcileModel(
				first,
				{ input: 20, output: 30, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } },
				1,
			);
			const next = peer.reserveModel(...request);
			const state = f.kernel.state!;
			expect(state.used).toMatchObject({ input_tokens: 20, output_tokens: 30, cost: 0.25, ticks: 2 });
			expect(f.store.get(state.mission_id, next, "BudgetReservation")).toMatchObject({ state: "RESERVED" });
			expect(state.reservations.map((ref) => f.store.get(state.mission_id, ref, "BudgetReservation").state)).toEqual(
				["RECONCILED", "RESERVED"],
			);
		},
	);
	it.each(["RESERVED", "STARTED", "RETAINED"] as const)(
		"the durable gate includes %s capacity and rolls back an overbooked append",
		(status) => {
			const f = fixture();
			const initial = f.kernel.state!;
			const held = makeRecord(initial.mission_id, initial.revision + 1, "BudgetReservation", {
				owner_operation_id: "held-resource",
				amounts: { ...resources(), cost: 2 },
				protected_for_verification: false,
				state: status,
				actual: status === "RETAINED" ? resources() : null,
			});
			f.store.commit(
				initial.revision,
				{ ...initial, revision: initial.revision + 1, reservations: [held.record_id] },
				[held],
			);
			const before = f.kernel.state!;
			const records = f.store.records(before.mission_id);
			const proposed = makeRecord(before.mission_id, before.revision + 1, "BudgetReservation", {
				owner_operation_id: "competing-resource",
				amounts: { ...resources(), cost: 2 },
				protected_for_verification: false,
				state: "RESERVED",
				actual: null,
			});
			rejected(() =>
				f.store.commit(
					before.revision,
					{ ...before, revision: before.revision + 1, reservations: [...before.reservations, proposed.record_id] },
					[proposed],
				),
			);
			expect(f.kernel.state).toEqual(before);
			expect(f.store.records(before.mission_id)).toEqual(records);
		},
	);
	it.each(["cost", "input_tokens", "output_tokens"] as const)(
		"an unknown reserved %s bound cannot be interpreted as free capacity",
		(dimension) => {
			const f = fixture();
			const before = f.kernel.state!;
			const proposed = makeRecord(before.mission_id, before.revision + 1, "BudgetReservation", {
				owner_operation_id: "unknown-resource",
				amounts: { ...resources(), [dimension]: null },
				protected_for_verification: false,
				state: "RESERVED",
				actual: null,
			});
			rejected(() =>
				f.store.commit(
					before.revision,
					{ ...before, revision: before.revision + 1, reservations: [proposed.record_id] },
					[proposed],
				),
			);
			expect(f.kernel.state).toEqual(before);
		},
	);
	it("rejects invalid estimates before recording usage and keeps failed measurement unknown even with a free model", () => {
		const f = fixture();
		const before = f.kernel.state!;
		for (const request of [
			[NaN, 1, 0],
			[-1, 1, 0],
			[0.5, 1, 0],
			[1, Infinity, 0],
			[1, 0.5, 0],
			[1, 1, NaN],
			[1, 1, -1],
			[1, 1, Infinity],
		] as const) {
			const [input, output, cost] = request;
			expect(rejected(() => f.kernel.reserveModel(input, output, cost))).toBeInstanceOf(KernelStop);
			expect(f.kernel.state).toEqual(before);
		}
		const reservation = f.kernel.reserveModel(100, 100, 0);
		f.kernel.reconcileModel(reservation, null, 1);
		const unknown = f.kernel.state!;
		expect(unknown.used).toMatchObject({ input_tokens: null, output_tokens: null, cost: null, ticks: 1 });
		rejected(() => f.kernel.reserveModel(0, 1, 0));
		expect(f.kernel.state).toEqual(unknown);
	});
});
