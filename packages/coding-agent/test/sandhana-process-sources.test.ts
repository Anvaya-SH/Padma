import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { repairedCheckProgress } from "../src/core/sandhana/check-progress.ts";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import {
	observedProcessStates,
	processSourceDigests,
	processSourceStates,
} from "../src/core/sandhana/process-sources.ts";
import { digest, type MissionRecord, type RecordOf } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createBashTool, createWriteTool } from "../src/core/tools/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(dependencies: string[], content = "process.exit(0);", quality = false) {
	const cwd = mkdtempSync(join(tmpdir(), "padma-process-source-kinds-"));
	const store = new MissionStore(":memory:");
	const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "kinds", store });
	cleanups.push(() => {
		store.close();
		rmSync(cwd, { recursive: true, force: true });
	});
	kernel.register(createBashTool(cwd), "bash");
	writeFileSync(join(cwd, "parser.cjs"), "module.exports = 'good';");
	writeFileSync(join(cwd, "check.cjs"), content);
	kernel.captureInput(
		`padma: ${JSON.stringify({
			objective: "inspect parser behavior",
			shell_commands: ["node check.cjs"],
			quality_checks: quality ? ["node check.cjs"] : [],
			requirements: [{ text: "behavior", rule: "SEMANTIC", target: "parser.cjs", dependencies }],
		})}`,
		"USER",
	);
	kernel.begin("");
	return { cwd, store, kernel };
}

describe("captured local process dependencies", () => {
	it.each(["QUALITY", "PROCESS"] as const)(
		"restoring an absent dependency repairs a previously passing %s check across reopen",
		async (kind) => {
			const directory = mkdtempSync(join(tmpdir(), "padma-process-sources-"));
			const cwd = join(directory, "workspace");
			mkdirSync(cwd);
			const path = join(directory, "mission.sqlite");
			let store = new MissionStore(path);
			cleanups.push(() => {
				store.close();
				rmSync(directory, { recursive: true, force: true });
			});
			let kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "sources", store });
			kernel.register(createBashTool(cwd), "bash");
			kernel.register(createWriteTool(cwd), "write");
			const command = "node check.cjs";
			const content = "module.exports = 'good';";
			writeFileSync(join(cwd, "parser.cjs"), content);
			writeFileSync(join(cwd, "check.cjs"), "if (require('./parser.cjs') !== 'good') process.exit(1);");
			kernel.captureInput(
				`padma: ${JSON.stringify({
					objective: "repair parser behavior",
					allow_edits: true,
					shell_commands: [command],
					quality_checks: kind === "QUALITY" ? [command] : [],
					requirements: [
						{ text: "behavior", rule: "SEMANTIC", target: "parser.cjs", dependencies: ["parser.cjs"] },
						...(kind === "PROCESS"
							? [
									{
										text: "check",
										rule: "PROCESS",
										target: ".",
										expected: command,
										dependencies: ["parser.cjs"],
									},
								]
							: []),
					],
				})}`,
				"USER",
			);
			kernel.begin("");
			const mission = kernel.state!.mission_id;
			for (let index = 0; index < 5; index++) {
				if (index) {
					kernel.captureInput(`resume ${mission}`, "USER");
					kernel.begin("");
				}
				const reservation = kernel.reserveModel(10, 10);
				kernel.beginCognitiveTick(reservation);
				kernel.reconcileModel(
					reservation,
					{ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					1,
				);
				if (index === 1 || index === 3) unlinkSync(join(cwd, "parser.cjs"));
				if (index === 2 || index === 4)
					await kernel.execute("write", `restore-dependency:${index}`, { path: "parser.cjs", content });
				await kernel.execute("bash", `check:${index}`, { command });
				if (kind === "QUALITY") kernel.assessCandidate();
				kernel.finishCognitiveTick();
				expect(kernel.state!.stagnation).toBe([0, 1, 0, 1, 2][index]);
				if (index === 2) {
					const tick = store.get(mission, kernel.state!.cognitive_tick!, "CognitiveTick");
					expect(tick.progress).toHaveLength(1);
					expect(
						tick.progress[0].evidence.map((ref) => store.get(mission, ref, "EvidenceRecord").payload),
					).toEqual([
						expect.objectContaining({ result: "FAILED" }),
						expect.objectContaining({ result: "PASSED" }),
					]);
				}
				if (index === 4)
					expect(store.get(mission, kernel.state!.cognitive_tick!, "CognitiveTick").progress).toEqual([]);
				kernel.finalize();
				expect(kernel.terminal!.status).not.toBe("VERIFIED_COMPLETE");
				if (index === 1) {
					store.close();
					store = new MissionStore(path);
					kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "sources", store });
					kernel.register(createBashTool(cwd), "bash");
					kernel.register(createWriteTool(cwd), "write");
				}
			}
			expect(kernel.state!.used.execution).toBe(7);
			expect(kernel.state!.used.ticks).toBe(5);
		},
		120000,
	);

	it("native absent and directory observations remain distinct and a directory cannot be relabeled absent", async () => {
		const f = fixture(["missing.cjs", "dependency"]);
		mkdirSync(join(f.cwd, "dependency"));
		await f.kernel.execute("bash", "source-kinds", { command: "node check.cjs" });
		const state = f.kernel.state!;
		const operation = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
		const observation = f.store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
		const snapshot = (observation.payload as { process_sources: { before: string[]; after: string[] } })
			.process_sources;
		const bindings = snapshot.before.map((ref) => f.store.get(state.mission_id, ref, "TargetBinding"));
		const missing = bindings.find((binding) => binding.canonical_path === join(f.cwd, "missing.cjs"))!;
		const directory = bindings.find((binding) => binding.canonical_path === join(f.cwd, "dependency"))!;
		const missingPath = process.platform === "win32" ? missing.canonical_path.toLowerCase() : missing.canonical_path;
		const directoryPath =
			process.platform === "win32" ? directory.canonical_path.toLowerCase() : directory.canonical_path;
		expect(missing.preimage_digest).toBeNull();
		expect(directory.preimage_digest).toBeNull();
		expect(f.store.get(state.mission_id, missing.establishment_evidence[0], "EvidenceRecord").payload).toMatchObject({
			target_kind: "ABSENT",
		});
		const directorySource = f.store.get(state.mission_id, directory.establishment_evidence[0], "EvidenceRecord");
		expect(directorySource.payload).toMatchObject({ target_kind: "DIRECTORY" });
		const states = observedProcessStates(f.store, observation)!;
		expect(states).not.toBeNull();
		expect(Object.hasOwn(states, missingPath)).toBe(true);
		expect(states[missingPath]).toBeNull();
		expect(Object.hasOwn(states, directoryPath)).toBe(false);
		const files = processSourceDigests(f.store, state.mission_id, snapshot.before, operation.operation_id)!;
		expect(Object.hasOwn(files, missingPath)).toBe(false);
		expect(observedProcessStates(f.store, { ...observation, provenance: "MODEL" })).toBeNull();
		expect(
			observedProcessStates(f.store, {
				...observation,
				payload: {
					...(observation.payload as Record<string, unknown>),
					process_sources: { ...snapshot, version: "LOCAL_PROCESS_SOURCES/1" },
				},
			}),
		).toBeNull();
		const original = f.store.get.bind(f.store);
		const altered = vi
			.spyOn(f.store, "get")
			.mockImplementation(
				<T extends MissionRecord["record_type"]>(mission: string, ref: string, type: T): RecordOf<T> => {
					const record = original(mission, ref, type);
					if (record.record_type === "EvidenceRecord" && ref === directorySource.record_id) {
						const payload = { ...(directorySource.payload as Record<string, unknown>), target_kind: "ABSENT" };
						return { ...record, payload, digest: digest(payload) } as RecordOf<T>;
					}
					return record;
				},
			);
		expect(processSourceStates(f.store, state.mission_id, snapshot.before, operation.operation_id)).toBeNull();
		altered.mockRestore();
		// Reading old durable file facts retains their digest keys and never upgrades an ambiguous null to absence.
		const legacy = vi
			.spyOn(f.store, "get")
			.mockImplementation(
				<T extends MissionRecord["record_type"]>(mission: string, ref: string, type: T): RecordOf<T> => {
					const record = original(mission, ref, type);
					const evidence: MissionRecord = record;
					if (evidence.record_type === "EvidenceRecord" && evidence.source === "local-process-source/2") {
						const { target_kind: _kind, ...payload } = evidence.payload as Record<string, unknown>;
						return {
							...record,
							source: "local-process-source/1",
							payload,
							digest: digest(payload),
						} as RecordOf<T>;
					}
					return record;
				},
			);
		expect(processSourceStates(f.store, state.mission_id, snapshot.before, operation.operation_id)).toEqual(files);
		legacy.mockRestore();
	}, 30000);

	it("unchanged absent paths cannot mint a different repair key when older process captures are read", async () => {
		const f = fixture(
			["parser.cjs", "missing.cjs"],
			"if (require('./parser.cjs') !== 'good') process.exit(1);",
			true,
		);
		writeFileSync(join(f.cwd, "parser.cjs"), "module.exports = 'bad';");
		await f.kernel.execute("bash", "failing-source", { command: "node check.cjs" });
		f.kernel.assessCandidate();
		const mission = f.kernel.state!.mission_id;
		f.kernel.finalize();
		f.kernel.captureInput(`resume ${mission}`, "USER");
		f.kernel.begin("");
		writeFileSync(join(f.cwd, "parser.cjs"), "module.exports = 'good';");
		await f.kernel.execute("bash", "passing-source", { command: "node check.cjs" });
		f.kernel.assessCandidate();
		const state = f.kernel.state!;
		const records = f.store.records(state.mission_id);
		const native = repairedCheckProgress(f.store, state, records);
		expect(native).toHaveLength(1);
		const original = f.store.get.bind(f.store);
		const legacy = vi
			.spyOn(f.store, "get")
			.mockImplementation(
				<T extends MissionRecord["record_type"]>(mission: string, ref: string, type: T): RecordOf<T> => {
					const record = original(mission, ref, type);
					const evidence: MissionRecord = record;
					if (evidence.record_type !== "EvidenceRecord") return record;
					const data = evidence.payload as Record<string, unknown>;
					if (evidence.source === "local-process-source/2") {
						const { target_kind: _kind, ...payload } = data;
						return {
							...record,
							source: "local-process-source/1",
							payload,
							digest: digest(payload),
						} as RecordOf<T>;
					}
					if (evidence.stage === "phala" && data.process_sources && typeof data.process_sources === "object") {
						const payload = {
							...data,
							process_sources: { ...data.process_sources, version: "LOCAL_PROCESS_SOURCES/1" },
						};
						return { ...record, payload, digest: digest(payload) } as RecordOf<T>;
					}
					return record;
				},
			);
		expect(repairedCheckProgress(f.store, state, records)).toEqual(native);
		legacy.mockRestore();
	}, 30000);

	it("a dependency created by the running check is retained but cannot prove stable source applicability", async () => {
		const f = fixture(["missing.cjs"], "require('node:fs').writeFileSync('missing.cjs', 'created during check');");
		await f.kernel.execute("bash", "unstable-source", { command: "node check.cjs" });
		const state = f.kernel.state!;
		const operation = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
		const observation = f.store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
		expect(operation.status).toBe("CONFIRMED_COMPLETE");
		expect(observation.payload).toMatchObject({ dependencies_unchanged: false, process_sources: { complete: true } });
		expect(observedProcessStates(f.store, observation)).toBeNull();
		expect(state.used.execution).toBe(1);
	}, 30000);

	it.each(["ABSENT", "DIRECTORY"] as const)(
		"denies an unauthorized %s dependency before process dispatch",
		async (kind) => {
			const f = fixture([".padma/private"]);
			if (kind === "DIRECTORY") mkdirSync(join(f.cwd, ".padma", "private"), { recursive: true });
			await expect(f.kernel.execute("bash", "denied-presence", { command: "node check.cjs" })).rejects.toThrow(
				"Source read violates",
			);
			expect(f.kernel.state!.used.execution).toBe(0);
			expect(f.kernel.state!.operations).toEqual([]);
			expect(
				f.store
					.records(f.kernel.state!.mission_id)
					.some((record) => record.record_type === "EvidenceRecord" && record.source === "local-process-source/2"),
			).toBe(false);
		},
	);
});
