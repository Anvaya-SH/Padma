import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { signalsForExact } from "../src/core/sandhana/code.ts";
import { compile } from "../src/core/sandhana/compiler.ts";
import { routeBudget } from "../src/core/sandhana/configuration.ts";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import {
	canonical,
	digest,
	type MissionRecord,
	makeRecord,
	type Route,
	type Signals,
} from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createBashTool, createReadTool } from "../src/core/tools/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(instruction = "read a.txt") {
	const cwd = mkdtempSync(join(tmpdir(), "padma-routing-proof-"));
	writeFileSync(join(cwd, "a.txt"), "actual bytes");
	writeFileSync(join(cwd, "first.cjs"), "console.log('refuted'); process.exitCode = 1;");
	writeFileSync(join(cwd, "second.cjs"), "console.log('refuted'); process.exitCode = 1;");
	const store = new MissionStore(":memory:");
	const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "routing", store });
	kernel.register(createReadTool(cwd), "read");
	kernel.register(createBashTool(cwd), "bash");
	cleanups.push(() => {
		store.close();
		rmSync(cwd, { recursive: true, force: true });
	});
	kernel.captureInput(instruction, "USER");
	kernel.begin("");
	return { cwd, store, kernel };
}
function commitRoute(f: ReturnType<typeof fixture>, signals: Signals, route: Route, extra: MissionRecord[] = []) {
	const previous = f.store.load(f.kernel.state!.mission_id);
	const prior = f.store.get(previous.mission_id, previous.contract, "MissionContract");
	const configuration = f.store.get(previous.mission_id, prior.configuration_ref!, "KernelConfiguration");
	const budget = routeBudget(configuration.value, route, configuration.resource_overrides);
	const contract = makeRecord(previous.mission_id, previous.revision + 1, "MissionContract", {
		...prior,
		signals,
		route,
		...budget,
	});
	f.store.commit(
		previous.revision,
		{
			...previous,
			revision: previous.revision + 1,
			contract: contract.record_id,
			route,
			...budget,
		},
		[...extra, contract],
	);
}
function historySignals(evidence: string[]): Signals {
	const signals = signalsForExact(false);
	signals.H = { severity: 2, provenance: "HISTORY", evidence };
	signals.A = { severity: 1, provenance: "HISTORY", evidence };
	return signals;
}
const diagnostic = `padma: ${JSON.stringify({
	objective: "diagnose the failure",
	shell_commands: ["node first.cjs", "node second.cjs"],
	requirements: [{ text: "repair behavior", rule: "SEMANTIC", target: "." }],
})}`;
async function refute(f: ReturnType<typeof fixture>, mechanism: "VALIDATE" | "NORMALIZE", command: string) {
	expect(
		f.kernel.proposeHypothesis({
			target: ".",
			cause: "INPUT_FORMAT",
			mechanism,
			failure_signature: "refuted",
			expected_result: "supported",
		}),
	).toBe(true);
	await f.kernel.execute("bash", mechanism, { command });
	const state = f.kernel.state!;
	const hypothesis = f.store.get(state.mission_id, state.hypotheses.at(-1)!, "Hypothesis");
	expect(hypothesis).toMatchObject({ status: "CONTRADICTED", attempts: 1 });
	return hypothesis.contradicting[0];
}

describe("store routing proof boundary", () => {
	it.each(["SAKSHAT", "GAMBHIRA"] as const)(
		"rejects %s contracts inconsistent with unknown routing signals",
		(route) => {
			const f = fixture();
			const before = f.kernel.state!;
			const history = f.store.records(before.mission_id);
			expect(() => commitRoute(f, signalsForExact(false), route)).toThrow(/routing|route/i);
			expect(f.store.load(before.mission_id)).toEqual(before);
			expect(f.store.records(before.mission_id)).toEqual(history);
		},
	);
	it("rejects an initial forged fast route, but preserves legitimate initial legacy exact observation tokens", () => {
		const f = fixture();
		const compiled = compile("Fix behavior", f.cwd, "routing");
		const configuration = compiled.records.find((record) => record.record_type === "KernelConfiguration")!;
		const budget = routeBudget(configuration.value, "SAKSHAT", configuration.resource_overrides);
		const records = compiled.records.map((record) =>
			record.record_type === "MissionContract" ? { ...record, route: "SAKSHAT" as const, ...budget } : record,
		);
		expect(() => f.store.commit(0, { ...compiled.state, route: "SAKSHAT", ...budget }, records)).toThrow(
			/routing|route/i,
		);
		expect(f.kernel.state!.route).toBe("SAKSHAT");
	});
	it("a fast route requires evidence for each structural-zero signal", () => {
		const f = fixture();
		const signals = signalsForExact(true);
		signals.S.evidence = [];
		const before = f.kernel.state!;
		expect(() => commitRoute(f, signals, "SAKSHAT")).toThrow(/routing|route/i);
		expect(f.store.load(before.mission_id)).toEqual(before);
	});
	it.each(["COMMAND", "STRUCTURAL", "PREFLIGHT"] as const)(
		"%s labels on ordinary observations cannot establish S2/D2",
		async (provenance) => {
			const f = fixture();
			await f.kernel.execute("read", "ordinary", { path: "a.txt" });
			const before = f.kernel.state!;
			const evidence = f.store.get(before.mission_id, before.operations[0], "OperationRecord").result_refs;
			const signals = signalsForExact(false);
			signals.S = { severity: 2, provenance, evidence };
			signals.D = { severity: 2, provenance, evidence };
			expect(() => f.kernel.escalate(signals)).toThrow(/routing|route/i);
			expect(f.store.load(before.mission_id)).toEqual(before);
		},
	);
	it.each(["invented", "other mission", "last event", "actual read"] as const)(
		"rejects S2/D2 HISTORY from %s rather than inferring broad complexity",
		async (variant) => {
			const f = fixture();
			await f.kernel.execute("read", "actual", { path: "a.txt" });
			const state = f.kernel.state!;
			let evidence = state.last_event!;
			if (variant === "invented") evidence = "invented-reference";
			if (variant === "other mission") evidence = fixture().kernel.state!.last_event!;
			if (variant === "actual read")
				evidence = f.store.get(state.mission_id, state.operations[0], "OperationRecord").result_refs[0];
			const signals = signalsForExact(false);
			signals.S = { severity: 2, provenance: "HISTORY", evidence: [evidence] };
			signals.D = { severity: 2, provenance: "HISTORY", evidence: [evidence] };
			const history = f.store.records(state.mission_id);
			expect(() => f.kernel.escalate(signals)).toThrow();
			expect(f.store.load(state.mission_id)).toEqual(state);
			expect(f.store.records(state.mission_id)).toEqual(history);
		},
	);
	it.each(["invented", "other mission", "model", "kernel control", "command record"] as const)(
		"rejects history escalation with %s proof",
		(variant) => {
			const f = fixture();
			const state = f.kernel.state!;
			const payload = { claimed: "two failed approaches" };
			const event = makeRecord(state.mission_id, state.revision + 1, "EvidenceRecord", {
				event_id: "unsupported-routing",
				stage: "phala",
				kind: variant === "kernel control" ? "CONTROL" : "OBSERVATION",
				provenance: variant === "model" ? "MODEL" : "KERNEL",
				target_generation: null,
				captured_at: Date.now(),
				operation_id: null,
				source: "unsupported",
				payload,
				artifact_ref: null,
				digest: digest(payload),
				sensitivity: "PRIVATE",
				sources: [],
				requirement_ids: [],
				correction_of: null,
				previous: state.last_event,
			});
			const second = makeRecord(state.mission_id, state.revision + 1, "EvidenceRecord", {
				...event,
				event_id: "second-unsupported",
			});
			const before = { ...state, revision: state.revision + 1, last_event: second.record_id };
			f.store.commit(state.revision, before, [event, second]);
			const evidence =
				variant === "invented"
					? "invented"
					: variant === "other mission"
						? fixture().kernel.state!.last_event!
						: variant === "command record"
							? state.command
							: event.record_id;
			const history = f.store.records(state.mission_id);
			expect(() => commitRoute(f, historySignals([evidence, second.record_id]), "GAMBHIRA")).toThrow();
			expect(f.store.load(state.mission_id)).toEqual(before);
			expect(f.store.records(state.mission_id)).toEqual(history);
		},
	);
	it("startup and explicit configuration migration retain historical routing claims without rewriting or re-proving them", () => {
		const f = fixture();
		const directory = mkdtempSync(join(tmpdir(), "padma-routing-history-"));
		const path = join(directory, "legacy.sqlite");
		const store = new MissionStore(path);
		cleanups.push(() => {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		});
		const compiled = compile("read a.txt", f.cwd, "historical-routing");
		const records = compiled.records
			.filter((record) => record.record_type !== "KernelConfiguration")
			.map((record) => {
				if (record.record_type !== "MissionContract") return record;
				const { configuration_ref: _configuration, ...legacy } = record;
				return legacy;
			});
		store.commit(0, compiled.state, records);
		const original = store.get(compiled.state.mission_id, compiled.state.contract, "MissionContract");
		// Seed old serialized history, not a newly admitted mutation. Old releases accepted inconsistent claims.
		const historical = { ...original, signals: signalsForExact(false) };
		const database = new DatabaseSync(store.databasePath);
		try {
			database
				.prepare("UPDATE records SET payload=?,digest=? WHERE mission=? AND id=?")
				.run(canonical(historical), digest(historical), original.mission_id, original.record_id);
		} finally {
			database.close();
		}
		const history = store.records(original.mission_id);
		const reopened = new MissionStore(path);
		try {
			expect(reopened.load(original.mission_id)).toEqual(compiled.state);
			expect(reopened.records(original.mission_id)).toEqual(history);
		} finally {
			reopened.close();
		}
		const migrated = store.migrateConfiguration(original.mission_id);
		expect(migrated.route).toBe(compiled.state.route);
		expect(migrated.used).toEqual(compiled.state.used);
		expect(store.get(original.mission_id, migrated.contract, "MissionContract").signals).toEqual(historical.signals);
		for (const record of history)
			expect(store.get(record.mission_id, record.record_id, record.record_type)).toEqual(record);
		const prior = store.get(original.mission_id, migrated.contract, "MissionContract");
		const changed = makeRecord(original.mission_id, migrated.revision + 1, "MissionContract", {
			...prior,
			signals: { ...prior.signals, S: { severity: 1, provenance: "ESTIMATE", evidence: [] } },
		});
		expect(() =>
			store.commit(
				migrated.revision,
				{ ...migrated, revision: migrated.revision + 1, contract: changed.record_id },
				[changed],
			),
		).toThrow(/routing|route/i);
	});
	it("one real refutation is insufficient for H2/A1", async () => {
		const f = fixture(diagnostic);
		const evidence = await refute(f, "VALIDATE", "node first.cjs");
		const before = f.kernel.state!;
		expect(() => f.kernel.escalate(historySignals([evidence]))).toThrow();
		expect(f.store.load(before.mission_id)).toEqual(before);
	});
	it("two different hypotheses cannot recycle one materially identical experiment", async () => {
		const f = fixture(diagnostic);
		const first = await refute(f, "VALIDATE", "node first.cjs");
		const second = await refute(f, "NORMALIZE", "node first.cjs");
		const before = f.kernel.state!;
		expect(() => f.kernel.escalate(historySignals([first, second]))).toThrow();
		expect(f.store.load(before.mission_id)).toEqual(before);
	});
	it("two materially different confirmed refuted approaches escalate without resetting spent resources or history", async () => {
		const f = fixture(diagnostic);
		const first = await refute(f, "VALIDATE", "node first.cjs");
		const second = await refute(f, "NORMALIZE", "node second.cjs");
		const before = f.kernel.state!;
		const history = f.store.records(before.mission_id);
		// A real proof does not excuse an unrelated retained event in its cited proof set.
		expect(() => f.kernel.escalate(historySignals([first, second, before.last_event!]))).toThrow();
		f.kernel.escalate(historySignals([first, second]));
		const after = f.kernel.state!;
		expect(after.route).toBe("GAMBHIRA");
		expect(after.used).toEqual(before.used);
		expect(after.used.execution).toBe(2);
		expect(after.started_at).toBe(before.started_at);
		expect(after.ceilings).toEqual(before.ceilings);
		expect(after.verification_reserve).toBe(before.verification_reserve);
		expect(after.hypotheses).toEqual(before.hypotheses);
		for (const record of history)
			expect(f.store.get(record.mission_id, record.record_id, record.record_type)).toEqual(record);
	});
});
