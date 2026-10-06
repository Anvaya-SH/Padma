import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compile } from "../src/core/sandhana/compiler.ts";
import { KernelStop, SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { configurationForMigration } from "../src/core/sandhana/migration.ts";
import {
	CONFIGURATION_MIGRATION_LIMITATION,
	canonical,
	digest,
	type MissionRecord,
	type MissionState,
	makeRecord,
} from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createReadTool, createWriteTool } from "../src/core/tools/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function workspace() {
	const directory = mkdtempSync(join(tmpdir(), "padma-migration-"));
	const cwd = join(directory, "workspace");
	mkdirSync(cwd);
	writeFileSync(join(cwd, "a.txt"), "actual data\n");
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	return { directory, cwd };
}
function openStore(path: string) {
	const store = new MissionStore(path);
	cleanups.push(() => store.close());
	return store;
}
function stoppedLegacy(
	options: {
		revoked?: boolean;
		expired?: boolean;
		incompatible?: boolean;
		unknownCeiling?: boolean;
		liveOwner?: boolean;
	} = {},
) {
	const f = workspace();
	const store = openStore(join(f.directory, "legacy.sqlite"));
	const compiled = compile("read a.txt", f.cwd, "migration", "USER", { execution: 4, elapsed_ms: 60 * 60 * 1000 });
	const records = compiled.records
		.filter((record) => record.record_type !== "KernelConfiguration")
		.map((record) => {
			if (record.record_type === "MissionContract") {
				const { configuration_ref: _configuration, ...legacy } = record;
				return {
					...legacy,
					policy_version: options.incompatible ? "unsupported/1" : legacy.policy_version,
					ceilings: {
						...legacy.ceilings,
						input_tokens: options.unknownCeiling ? null : legacy.ceilings.input_tokens,
					},
				};
			}
			if (record.record_type === "Authorization")
				return {
					...record,
					revoked: options.revoked ?? false,
					expires_at: options.expired ? 0 : record.expires_at,
				};
			return record;
		});
	const initial = {
		...compiled.state,
		owner_pid: options.liveOwner ? process.ppid : process.pid,
		ceilings: {
			...compiled.state.ceilings,
			input_tokens: options.unknownCeiling ? null : compiled.state.ceilings.input_tokens,
		},
		used: { ...compiled.state.used, execution: 1, ticks: 2, input_tokens: null, cost: null, output_bytes: 40 },
	};
	store.commit(0, initial, records);
	const event = makeRecord(initial.mission_id, 2, "EvidenceRecord", {
		event_id: "legacy-stop",
		stage: "niyantr",
		kind: "CONTROL",
		provenance: "KERNEL",
		target_generation: null,
		captured_at: Date.now(),
		operation_id: null,
		source: "Legacy stopped run",
		payload: "Awaiting explicit resume",
		artifact_ref: null,
		digest: digest("Awaiting explicit resume"),
		sensitivity: "PRIVATE",
		sources: [],
		requirement_ids: [],
		correction_of: null,
		previous: null,
	});
	const terminal = makeRecord(initial.mission_id, 2, "TerminalReport", {
		status: "BLOCKED",
		contract_ref: initial.contract,
		verification_report_ref: null,
		artifacts: [],
		verified: [],
		remaining: compiled.records
			.filter((record) => record.record_type === "Requirement")
			.map((req) => req.requirement_id),
		checks_run: [],
		checks_skipped: [],
		limitations: ["Awaiting explicit resume"],
		unknown_operation: null,
		next_action: "Resume the mission",
		evidence: [event.record_id],
	});
	const state: MissionState = {
		...initial,
		revision: 2,
		phase: "BLOCKED",
		terminal: terminal.record_id,
		last_event: event.record_id,
	};
	store.commit(1, state, [event, terminal]);
	return { ...f, store, state, terminal };
}
function migrationRecords(store: MissionStore, previous: MissionState) {
	const prior = store.get(previous.mission_id, previous.contract, "MissionContract");
	const revision = previous.revision + 1;
	const configuration = makeRecord(previous.mission_id, revision, "KernelConfiguration", {
		source: "MIGRATION",
		value: configurationForMigration(previous, prior),
		resource_overrides: {},
	});
	const contract = makeRecord(previous.mission_id, revision, "MissionContract", {
		...prior,
		configuration_ref: configuration.record_id,
	});
	const migration = makeRecord(previous.mission_id, revision, "ConfigurationMigration", {
		version: "CONFIGURATION_CAPTURE/1",
		previous_contract_ref: prior.record_id,
		contract_ref: contract.record_id,
		configuration_ref: configuration.record_id,
		limitation: CONFIGURATION_MIGRATION_LIMITATION,
	});
	return { configuration, contract, migration, state: { ...previous, revision, contract: contract.record_id } };
}

/** Export a fresh pre-configuration-format fixture, never rewrite the live store or its history. */
function legacySnapshot(path: string, source: MissionStore, state: MissionState) {
	const records: MissionRecord[] = source
		.records(state.mission_id)
		.filter((record) => record.record_type !== "KernelConfiguration")
		.map((record) => {
			if (record.record_type !== "MissionContract") return record;
			const { configuration_ref: _configuration, ...legacy } = record;
			return legacy;
		});
	const db = new DatabaseSync(path);
	try {
		db.exec(`BEGIN IMMEDIATE;
		CREATE TABLE missions (id TEXT PRIMARY KEY, session TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL);
		CREATE TABLE records (mission TEXT NOT NULL REFERENCES missions(id), id TEXT NOT NULL, revision INTEGER NOT NULL, type TEXT NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(mission,id));
		CREATE TABLE artifacts (mission TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(mission,id), FOREIGN KEY(mission,id) REFERENCES records(mission,id));
		PRAGMA user_version=1;`);
		db.prepare("INSERT INTO missions VALUES (?,?,?,?)").run(
			state.mission_id,
			state.session_id,
			state.revision,
			canonical(state),
		);
		for (const record of records) {
			db.prepare("INSERT INTO records VALUES (?,?,?,?,?,?)").run(
				record.mission_id,
				record.record_id,
				record.revision,
				record.record_type,
				digest(record),
				canonical(record),
			);
			if (record.record_type === "Artifact")
				db.prepare("INSERT INTO artifacts VALUES (?,?,?,?)").run(
					record.mission_id,
					record.record_id,
					record.digest,
					source.artifact(record.mission_id, record.record_id),
				);
		}
		db.exec("COMMIT");
	} finally {
		db.close();
	}
}

describe("versioned configuration capture migration", () => {
	it("startup appends one migration and preserves the stopped ledger, grants and immutable history across reopen", () => {
		const f = stoppedLegacy();
		const history = f.store.records(f.state.mission_id);
		const options = { cwd: () => f.cwd, session: () => "migration", store: f.store };
		const kernel = new SandhanaKernel({
			...options,
			configuration: { version: "sandhana/1", resources: { output_bytes: 0 }, view: { tool_chars: 1 } },
		});
		const after = kernel.state!;
		expect(after).toEqual({ ...f.state, revision: f.state.revision + 1, contract: after.contract });
		expect(kernel.configuration.view.tool_chars).toBe(50000);
		expect(kernel.configuration.routes.SAKSHAT.execution).toBe(4);
		expect(kernel.terminal).toEqual(f.terminal);
		for (const record of history)
			expect(f.store.get(record.mission_id, record.record_id, record.record_type)).toEqual(record);
		const migration = f.store
			.records(after.mission_id)
			.find((record) => record.record_type === "ConfigurationMigration")!;
		expect(migration).toMatchObject({
			version: "CONFIGURATION_CAPTURE/1",
			previous_contract_ref: f.state.contract,
			contract_ref: after.contract,
			limitation: CONFIGURATION_MIGRATION_LIMITATION,
		});
		const second = new SandhanaKernel({ ...options, store: openStore(join(f.directory, "legacy.sqlite")) });
		expect(second.state).toEqual(after);
		expect(f.store.records(after.mission_id)).toHaveLength(history.length + 4);
		expect(f.store.publicEvents(after.mission_id, f.state.revision).events).toMatchObject([
			{ revision: after.revision, payload: f.store.publicSnapshot(after.mission_id) },
		]);
	});
	it("explicit resume uses captured capacity and fresh evidence without granting edit authority", async () => {
		const f = stoppedLegacy();
		const kernel = new SandhanaKernel({
			cwd: () => f.cwd,
			session: () => "migration",
			store: f.store,
			limits: { execution: 500 },
		});
		kernel.register(createReadTool(f.cwd), "read");
		kernel.register(createWriteTool(f.cwd), "write");
		kernel.captureInput(`resume ${f.state.mission_id}`, "USER");
		kernel.begin("");
		expect(kernel.state!.used).toEqual(f.state.used);
		expect(kernel.state!.started_at).toBe(f.state.started_at);
		await kernel.execute("read", "migrated-read", { path: "a.txt" });
		expect(kernel.finalize().status).toBe("VERIFIED_COMPLETE");
		expect(kernel.state!.used.execution).toBe(2);
		expect(kernel.state!.ceilings.execution).toBe(4);
		expect(kernel.state!.authorizations).toEqual(f.state.authorizations);
		expect(f.store.get(f.state.mission_id, f.terminal.record_id, "TerminalReport")).toEqual(f.terminal);
	});
	it("expired and revoked grants stay unusable after migration and resume", async () => {
		for (const options of [{ revoked: true }, { expired: true }]) {
			const f = stoppedLegacy(options);
			const kernel = new SandhanaKernel({ cwd: () => f.cwd, session: () => "migration", store: f.store });
			kernel.register(createReadTool(f.cwd), "read");
			kernel.captureInput(`resume ${f.state.mission_id}`, "USER");
			try {
				kernel.begin("");
			} catch (error) {
				expect(error).toBeInstanceOf(KernelStop);
			}
			await expect(kernel.execute("read", "denied", { path: "a.txt" })).rejects.toThrow();
			expect(kernel.state!.used.execution).toBe(1);
			expect(kernel.state!.operations).toEqual([]);
			expect(kernel.state!.authorizations).toEqual(f.state.authorizations);
		}
	});
	it("incompatible policy leaves history queryable and prevents a replacement mission or dispatch", () => {
		const f = stoppedLegacy({ incompatible: true });
		const history = f.store.records(f.state.mission_id);
		const kernel = new SandhanaKernel({ cwd: () => f.cwd, session: () => "migration", store: f.store });
		expect(kernel.state).toEqual(f.state);
		expect(kernel.terminal).toEqual(f.terminal);
		expect(() => kernel.configuration).toThrow("Unsupported configuration-less mission");
		kernel.captureInput("read a.txt", "USER");
		expect(() => kernel.begin("")).toThrow("compatibility check failed");
		expect(f.store.list("migration")).toEqual([f.state]);
		expect(f.store.records(f.state.mission_id)).toEqual(history);
	});
	it("unknown hard ceilings cannot be replaced with defaults; failure appends nothing", () => {
		const f = stoppedLegacy({ unknownCeiling: true });
		const history = f.store.records(f.state.mission_id);
		expect(() => f.store.migrateConfiguration(f.state.mission_id)).toThrow("captured resource limits");
		expect(f.store.load(f.state.mission_id)).toEqual(f.state);
		expect(f.store.records(f.state.mission_id)).toEqual(history);
	});
	it("startup cannot revise a configuration-less mission still owned by another live process", () => {
		const f = stoppedLegacy({ liveOwner: true });
		const kernel = new SandhanaKernel({ cwd: () => f.cwd, session: () => "migration", store: f.store });
		expect(() => kernel.configuration).toThrow("live owner");
		expect(kernel.state).toEqual(f.state);
		expect(
			f.store.records(f.state.mission_id).filter((record) => record.record_type === "ConfigurationMigration"),
		).toEqual([]);
	});
	it("a repeated commit acknowledges the same migration while a raced proposal cannot replace it", () => {
		const f = stoppedLegacy();
		const first = migrationRecords(f.store, f.state);
		const raced = migrationRecords(f.store, f.state);
		const records = [first.configuration, first.contract, first.migration];
		f.store.commit(f.state.revision, first.state, records);
		f.store.commit(f.state.revision, first.state, records);
		expect(() =>
			f.store.commit(f.state.revision, raced.state, [raced.configuration, raced.contract, raced.migration]),
		).toThrow("Stale mission revision");
		expect(f.store.load(f.state.mission_id)).toEqual(first.state);
		expect(
			f.store.records(f.state.mission_id).filter((record) => record.record_type === "ConfigurationMigration"),
		).toHaveLength(1);
	});
	it("migration and resume retain the original expired deadline", () => {
		const f = stoppedLegacy();
		vi.spyOn(Date, "now").mockReturnValue(f.state.started_at + f.state.ceilings.elapsed_ms + 1);
		const kernel = new SandhanaKernel({ cwd: () => f.cwd, session: () => "migration", store: f.store });
		kernel.captureInput(`resume ${f.state.mission_id}`, "USER");
		kernel.begin("");
		expect(() => kernel.reserveModel(1, 1)).toThrow("Cumulative model/time ceiling");
		expect(kernel.state!.started_at).toBe(f.state.started_at);
		expect(kernel.state!.used).toEqual(f.state.used);
	});
	it("migration cannot alter authority, usage, deadline, terminal, scope, stored settings or capacity", () => {
		const f = stoppedLegacy();
		const original = f.store.records(f.state.mission_id);
		for (const field of [
			"used",
			"started_at",
			"phase",
			"terminal",
			"owner_pid",
			"ceilings",
			"authorizations",
		] as const) {
			const proposal = migrationRecords(f.store, f.state);
			const state: MissionState = { ...proposal.state };
			switch (field) {
				case "used":
					state.used = { ...state.used, execution: 0 };
					break;
				case "started_at":
					state.started_at += 1000;
					break;
				case "phase":
					state.phase = "EXECUTING";
					break;
				case "terminal":
					state.terminal = null;
					break;
				case "owner_pid":
					state.owner_pid += 1;
					break;
				case "ceilings":
					state.ceilings = { ...state.ceilings, execution: 500 };
					break;
				case "authorizations":
					state.authorizations = [];
					break;
			}
			expect(() =>
				f.store.commit(f.state.revision, state, [proposal.configuration, proposal.contract, proposal.migration]),
			).toThrow("cannot change captured state");
		}
		for (const change of ["scope", "settings", "overrides", "missing-record"] as const) {
			const proposal = migrationRecords(f.store, f.state);
			if (change === "scope") proposal.contract.allowed_classes.push("EDIT");
			if (change === "settings") proposal.configuration.value.view.tool_chars = 1;
			if (change === "overrides") proposal.configuration.resource_overrides = { execution: 500 };
			const additions = [proposal.configuration, proposal.contract, proposal.migration];
			if (change === "missing-record") additions.pop();
			expect(() => f.store.commit(f.state.revision, proposal.state, additions)).toThrow();
		}
		expect(f.store.load(f.state.mission_id)).toEqual(f.state);
		expect(f.store.records(f.state.mission_id)).toEqual(original);
	});
	it("an uncertain actual fixture mutation keeps its operation and retained capacity through migration; no repeat starts", async () => {
		const f = workspace();
		const source = openStore(join(f.directory, "current.sqlite"));
		const kernel = new SandhanaKernel({ cwd: () => f.cwd, session: () => "migration", store: source });
		let invocations = 0;
		kernel.register(
			{
				name: "bash",
				label: "Lost fixture response",
				description: "Fixture effect",
				parameters: Type.Object({ command: Type.String() }),
				execute: async () => {
					invocations++;
					writeFileSync(join(f.cwd, "a.txt"), "actual effect");
					throw new Error("Lost fixture response");
				},
			},
			"bash",
		);
		kernel.captureInput("run: node check.cjs", "USER");
		writeFileSync(join(f.cwd, "check.cjs"), "// fixture command identity\n");
		kernel.begin("");
		await expect(kernel.execute("bash", "lost", { command: "node check.cjs" })).rejects.toThrow();
		const terminal = kernel.finalize();
		expect(terminal.status).toBe("OUTCOME_UNKNOWN");
		const before = kernel.state!;
		const path = join(f.directory, "pre-configuration.sqlite");
		legacySnapshot(path, source, before);
		const store = openStore(path);
		const restored = new SandhanaKernel({ cwd: () => f.cwd, session: () => "migration", store });
		expect(restored.state).toEqual({ ...before, revision: before.revision + 1, contract: restored.state!.contract });
		expect(restored.state!.reservations.map((ref) => store.get(before.mission_id, ref, "BudgetReservation"))).toEqual(
			before.reservations.map((ref) => source.get(before.mission_id, ref, "BudgetReservation")),
		);
		restored.captureInput(`resume ${before.mission_id}`, "USER");
		expect(() => restored.begin("")).toThrow("authoritative reconciliation");
		expect(restored.terminal).toEqual(terminal);
		expect(restored.state!.used).toEqual(before.used);
		expect(invocations).toBe(1);
		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("actual effect");
	});
	it("retained verified bytes and real recoverable checkpoints survive migration without being recreated", async () => {
		const f = workspace();
		const source = openStore(join(f.directory, "candidate.sqlite"));
		const kernel = new SandhanaKernel({ cwd: () => f.cwd, session: () => "migration", store: source });
		kernel.register(createWriteTool(f.cwd), "write");
		kernel.captureInput(
			`padma: ${JSON.stringify({ objective: "replace exact bytes", allow_edits: true, requirements: [{ text: "bytes", rule: "CONTENT", target: "a.txt", expected: "new" }] })}`,
			"USER",
		);
		kernel.begin("");
		await kernel.execute("write", "candidate", { path: "a.txt", content: "new" });
		const terminal = kernel.finalize();
		expect(terminal.status).toBe("VERIFIED_COMPLETE");
		const before = kernel.state!;
		expect(before.best.length).toBeGreaterThan(0);
		const path = join(f.directory, "legacy-candidate.sqlite");
		legacySnapshot(path, source, before);
		const store = openStore(path);
		const restored = new SandhanaKernel({ cwd: () => f.cwd, session: () => "migration", store });
		expect(restored.state).toEqual({ ...before, revision: before.revision + 1, contract: restored.state!.contract });
		for (const ref of before.checkpoints) {
			const checkpoint = store.get(before.mission_id, ref, "CheckpointRecord");
			expect(checkpoint).toEqual(source.get(before.mission_id, ref, "CheckpointRecord"));
			expect(store.artifact(before.mission_id, checkpoint.artifact_ref)).toEqual(
				source.artifact(before.mission_id, checkpoint.artifact_ref),
			);
		}
		expect(restored.terminal).toEqual(terminal);
		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("new");
	});
});
