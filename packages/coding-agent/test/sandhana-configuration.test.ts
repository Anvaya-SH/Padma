import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfiguration } from "../src/core/sandhana/configuration.ts";
import { type KernelOptions, SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { type KernelConfigurationInput, makeRecord } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createReadTool, createWriteTool } from "../src/core/tools/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(
	options: Pick<KernelOptions, "configuration" | "limits" | "beforeDispatch"> = {},
	instruction = "read a.txt",
) {
	const directory = mkdtempSync(join(tmpdir(), "padma-configuration-"));
	const cwd = join(directory, "workspace");
	mkdirSync(cwd);
	writeFileSync(join(cwd, "a.txt"), "actual complete file\n");
	const store = new MissionStore(join(directory, "mission.sqlite"));
	const kernel = new SandhanaKernel({ ...options, cwd: () => cwd, session: () => "configuration", store });
	kernel.register(createReadTool(cwd), "read");
	kernel.register(createWriteTool(cwd), "write");
	cleanups.push(() => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	});
	kernel.captureInput(instruction, "USER");
	kernel.begin("");
	return { cwd, store, kernel };
}

describe("versioned configuration and sourced resource adjustments", () => {
	it("rejects invalid versions, unknown authority fields, negative limits, overflow and inconsistent reserves", () => {
		for (const input of [
			{ version: "sandhana/2" },
			{ version: "sandhana/1", permissions: ["EDIT"] },
			{ version: "sandhana/1", resources: { execution: 10 } },
			{ version: "sandhana/1", resources: { preflight: 3 } },
			{ version: "sandhana/1", resources: { cost: -1 } },
			{ version: "sandhana/1", model: { response_tokens: null } },
			{ version: "sandhana/1", view: { tool_chars: Number.MAX_SAFE_INTEGER + 1 } },
			{ version: "sandhana/1", artifact: { retention_ms: Number.MAX_SAFE_INTEGER } },
			{ version: "sandhana/1", routes: { MADHYAMA: { execution: 5 } } },
			{ version: "sandhana/1", stagnation: { diagnose: 7, stop: 4 } },
			{ version: "sandhana/1", timeouts: { shell_ms: Infinity } },
		])
			expect(() => resolveConfiguration(input), JSON.stringify(input)).toThrow();
	});
	it("captures a copy and resumes the persisted configuration instead of replacing it with new application settings", async () => {
		const configuration: KernelConfigurationInput = {
			version: "sandhana/1",
			routes: { SAKSHAT: { execution: 4 } },
			view: { tool_chars: 2 },
		};
		const f = fixture({ configuration });
		configuration.view!.tool_chars = 10000;
		const result = await f.kernel.execute("read", "bounded-view", { path: "a.txt" });
		expect(result.content[0]).toEqual({
			type: "text",
			text: "ac\n[Model view truncated; complete bounded result retained in mission artifact]",
		});
		const ids = result.details as { sandhana: { observation_id: string; operation_id: string } };
		expect(ids.sandhana.observation_id.length).toBeGreaterThan(2);
		expect(f.store.get(f.kernel.state!.mission_id, ids.sandhana.observation_id, "EvidenceRecord").kind).toBe(
			"OBSERVATION",
		);
		const old = f.kernel.finalize();
		expect(old.status).toBe("VERIFIED_COMPLETE");
		expect(old.presentation).toContain("actual complete file\n");
		const restored = new SandhanaKernel({
			cwd: () => f.cwd,
			session: () => "configuration",
			store: f.store,
			configuration: { version: "sandhana/1", routes: { SAKSHAT: { execution: 50 } }, view: { tool_chars: 50 } },
		});
		restored.captureInput(`resume ${old.mission_id}`, "USER");
		restored.begin("");
		expect(restored.configuration.view.tool_chars).toBe(2);
		expect(restored.state!.ceilings.execution).toBe(4);
		expect(restored.state!.used.execution).toBe(1);
		expect(f.store.get(old.mission_id, old.record_id, "TerminalReport")).toEqual(old);
	});
	it("defines zero as disabled for dispatch, evidence windows, model calls and hypothesis branches", async () => {
		for (const configuration of [
			{ version: "sandhana/1", artifact: { max_bytes: 0 } },
			{ version: "sandhana/1", artifact: { retention_ms: 0 } },
			{ version: "sandhana/1", timeouts: { observation_ms: 0 } },
			{ version: "sandhana/1", routes: { SAKSHAT: { execution: 0 } } },
		] satisfies KernelConfigurationInput[]) {
			const f = fixture({ configuration });
			await expect(f.kernel.execute("read", "disabled", { path: "a.txt" })).rejects.toThrow();
			expect(f.kernel.state!.operations).toEqual([]);
			expect(f.kernel.state!.used.execution).toBe(0);
		}
		const f = fixture({
			configuration: {
				version: "sandhana/1",
				model: { response_tokens: 0 },
				view: { evidence_events: 0, recent_observations: 0, tool_chars: 0, position_chars: 0 },
				branches: { active: 0, depth: 0 },
			},
		});
		await f.kernel.execute("read", "read-without-model", { path: "a.txt" });
		const position = JSON.parse(f.kernel.position()) as { evidence_index: unknown[]; observations: unknown[] };
		expect(position.evidence_index).toEqual([]);
		expect(position.observations).toEqual([]);
		expect(() => f.kernel.reserveModel(1, 1)).toThrow("no provider call admitted");
		f.kernel.acceptDecisionText(
			'<yukti>{"target":"a.txt","cause":"INPUT_FORMAT","mechanism":"INVESTIGATE","failure_signature":"bad","expected_result":"actual"}</yukti>',
		);
		expect(f.kernel.state!.hypotheses).toEqual([]);
		expect(f.kernel.state!.used.ticks).toBe(0);
	});
	it("enforces model and per-artifact bounds before dispatch", async () => {
		const f = fixture({
			configuration: { version: "sandhana/1", model: { response_tokens: 12 }, artifact: { max_bytes: 8 } },
		});
		expect(() => f.kernel.reserveModel(1, 13)).toThrow("captured model allowance");
		await expect(f.kernel.execute("read", "oversized-source", { path: "a.txt" })).rejects.toThrow(
			"configured artifact bound",
		);
		expect(f.kernel.state!.operations).toEqual([]);
		expect(f.kernel.state!.used.execution).toBe(0);
		expect(f.kernel.state!.used.ticks).toBe(0);
		const writer = fixture({ configuration: { version: "sandhana/1", artifact: { max_bytes: 8 } } }, "Fix a.txt");
		writeFileSync(join(writer.cwd, "a.txt"), "old");
		await expect(
			writer.kernel.execute("write", "oversized-replacement", { path: "a.txt", content: "replacement exceeds cap" }),
		).rejects.toThrow();
		expect(readFileSync(join(writer.cwd, "a.txt"), "utf8")).toBe("old");
		expect(writer.kernel.state!.operations).toEqual([]);
		expect(writer.kernel.state!.used.execution).toBe(0);
	});
	it("expired bytes remain recorded but cannot establish current proof or be delivered as a verified artifact", async () => {
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		const f = fixture({ configuration: { version: "sandhana/1", artifact: { retention_ms: 100 } } });
		await f.kernel.execute("read", "expiring-read", { path: "a.txt" });
		const artifact = f.store.records(f.kernel.state!.mission_id).find((record) => record.record_type === "Artifact")!;
		expect(artifact.record_type).toBe("Artifact");
		expect(f.store.artifact(artifact.mission_id, artifact.record_id).length).toBeGreaterThan(0);
		expect(f.kernel.ready()).toBe(true);
		clock.mockReturnValue(now + 101);
		expect(() => f.store.artifact(artifact.mission_id, artifact.record_id)).toThrow("Artifact expired");
		expect(f.kernel.position()).toContain("Artifact unavailable or expired; digest is not proof");
		expect(f.kernel.ready()).toBe(false);
		const report = f.kernel.finalize();
		expect(report.status).toBe("PARTIALLY_COMPLETE");
		expect(report.verified).toEqual([]);
		expect(report.artifacts).toEqual([]);
		expect(f.kernel.state!.used.execution).toBe(1);
	});
	it("budget amendments preserve spending, deadline and read-only authority and reject malformed requests atomically", async () => {
		const f = fixture();
		await f.kernel.execute("read", "first", { path: "a.txt" });
		const before = f.kernel.state!;
		f.kernel.amend('budget: {"version":1,"ceilings":{"execution":10,"output_tokens":100000}}');
		const after = f.kernel.state!;
		expect(after.ceilings.execution).toBe(10);
		expect(after.used).toEqual(before.used);
		expect(after.started_at).toBe(before.started_at);
		expect(after.authorizations).toEqual(before.authorizations);
		expect(after.requirements).toEqual(before.requirements);
		for (const request of [
			'{"version":1,"ceilings":{"execution":-1}}',
			'{"version":1,"ceilings":{"cost":null}}',
			'{"version":1,"ceilings":{},"permissions":["EDIT"]}',
			'{"version":1,"ceilings":{"execution":1},"verification_reserve":2}',
		]) {
			expect(() => f.kernel.amend(`budget: ${request}`)).toThrow();
			expect(f.kernel.state).toEqual(after);
		}
		f.kernel.acceptDecisionText('<yukti>{"budget":{"execution":999},"permissions":["EDIT"]}</yukti>');
		expect(f.kernel.state!.ceilings.execution).toBe(10);
		await expect(
			f.kernel.execute("write", "forbidden", { path: "a.txt", content: "unauthorized" }),
		).rejects.toThrow();
		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("actual complete file\n");
		expect(f.kernel.state!.used.execution).toBe(1);
	});
	it("the store rejects unsourced capacity changes and a budget record that widens the contract", () => {
		const f = fixture();
		const state = f.kernel.state!;
		expect(() =>
			f.store.commit(
				state.revision,
				{ ...state, revision: state.revision + 1, ceilings: { ...state.ceilings, execution: 20 } },
				[],
			),
		).toThrow("Effective budget differs");
		const request = { version: 1 as const, ceilings: { execution: 20 } };
		const source = makeRecord(state.mission_id, state.revision + 1, "Amendment", {
			amendment_id: "budget-source",
			instruction: `budget: ${JSON.stringify(request)}`,
			source: "USER",
			captured_at: Date.now(),
			requirement_changes: [],
			revokes: false,
		});
		const change = makeRecord(state.mission_id, state.revision + 1, "BudgetChange", {
			source_ref: source.record_id,
			previous_ref: null,
			request,
			overrides: request.ceilings,
			verification_reserve: null,
		});
		const prior = f.store.get(state.mission_id, state.contract, "MissionContract");
		const contract = makeRecord(state.mission_id, state.revision + 1, "MissionContract", {
			...prior,
			allowed_classes: [...prior.allowed_classes, "EDIT"],
			budget_ref: change.record_id,
			ceilings: { ...state.ceilings, execution: 20 },
			amendment_refs: [source.record_id],
			recompile_source: source.record_id,
		});
		expect(() =>
			f.store.commit(
				state.revision,
				{
					...state,
					revision: state.revision + 1,
					contract: contract.record_id,
					ceilings: contract.ceilings,
					intent_epoch: (state.intent_epoch ?? 1) + 1,
				},
				[source, change, contract],
			),
		).toThrow("cannot change compiled scope");
		expect(f.kernel.state).toEqual(state);
	});
	it("a user resource amendment invalidates an already prepared action before its primitive starts", async () => {
		let amend = () => {};
		const f = fixture({ beforeDispatch: async () => amend() });
		amend = () => f.kernel.amend('budget: {"version":1,"ceilings":{"execution":4}}');
		await expect(f.kernel.execute("read", "queued", { path: "a.txt" })).rejects.toThrow();
		expect(f.kernel.state!.operations).toEqual([]);
		expect(f.kernel.state!.ceilings.execution).toBe(4);
		expect(f.kernel.state!.used.execution).toBe(0);
	});
	it("explicit resume can record a resource increase without replacing prior reports or resurrecting grants", async () => {
		const f = fixture({ limits: { execution: 1 } });
		await f.kernel.execute("read", "first", { path: "a.txt" });
		const old = f.kernel.finalize();
		const before = f.kernel.state!;
		f.kernel.captureInput(`resume ${old.mission_id} budget: {"version":1,"ceilings":{"execution":2}}`, "USER");
		f.kernel.begin("");
		expect(f.kernel.state!.ceilings.execution).toBe(2);
		expect(f.kernel.state!.used).toEqual(before.used);
		expect(f.kernel.state!.authorizations).toEqual(before.authorizations);
		await f.kernel.execute("read", "second", { path: "a.txt" });
		expect(f.kernel.finalize().status).toBe("VERIFIED_COMPLETE");
		expect(f.kernel.state!.used.execution).toBe(2);
		expect(f.store.get(old.mission_id, old.record_id, "TerminalReport")).toEqual(old);
		expect(f.store.records(old.mission_id).filter((record) => record.record_type === "BudgetChange")).toHaveLength(1);
	});
});
