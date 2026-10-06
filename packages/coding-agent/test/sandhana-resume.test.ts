import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { makeRecord } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createReadTool, createWriteTool } from "../src/core/tools/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "padma-resume-"));
	const cwd = join(directory, "workspace");
	mkdirSync(cwd);
	const store = new MissionStore(join(directory, "mission.sqlite"));
	const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "resume", store });
	kernel.register(createReadTool(cwd), "read");
	kernel.register(createWriteTool(cwd), "write");
	cleanups.push(() => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	});
	writeFileSync(join(cwd, "a.txt"), "old");
	kernel.captureInput(
		`padma: ${JSON.stringify({ objective: "repair exact content", allow_edits: true, requirements: [{ text: "exact bytes", rule: "CONTENT", target: "a.txt", expected: "new" }] })}`,
		"USER",
	);
	kernel.begin("");
	return { cwd, store, kernel };
}
describe("explicit stopped-run resume", () => {
	it("explicit resume cannot replay an actual fixture mutation whose result was lost", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "parser.test.cjs"), "require('node:test')('fixture', () => {});");
		let invocations = 0;
		f.kernel.register(
			{
				name: "bash",
				label: "Uncertain fixture process",
				description: "Controlled effectful fixture",
				parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
				execute: async () => {
					invocations++;
					writeFileSync(join(f.cwd, "a.txt"), "actual effect");
					throw new Error("Lost response after fixture mutation");
				},
			},
			"bash",
		);
		await expect(f.kernel.execute("bash", "uncertain", { command: "node --test parser.test.cjs" })).rejects.toThrow(
			"may have taken effect",
		);
		const old = f.kernel.finalize();
		expect(old.status).toBe("OUTCOME_UNKNOWN");
		f.kernel.captureInput(`resume ${old.mission_id}`, "USER");
		await expect(async () => f.kernel.begin("")).rejects.toThrow("authoritative reconciliation");
		expect(invocations).toBe(1);
		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("actual effect");
		expect(f.kernel.state!.used.execution).toBe(1);
		expect(f.kernel.terminal).toEqual(old);
	});
	it("resume retains the original deadline and does not admit another decision after it expires", () => {
		const f = fixture();
		const old = f.kernel.finalize("BLOCKED", "Awaiting candidate");
		const previous = f.kernel.state!;
		vi.spyOn(Date, "now").mockReturnValue(previous.started_at + previous.ceilings.elapsed_ms + 1);
		f.kernel.captureInput(`resume ${old.mission_id}`, "USER");
		f.kernel.begin("");
		expect(() => f.kernel.reserveModel(1, 1)).toThrow("Cumulative model/time ceiling");
		expect(f.kernel.state!.started_at).toBe(previous.started_at);
		expect(f.kernel.state!.used.ticks).toBe(0);
	});
	it("reopens persisted known failure with one identity, original obligations, historical report and cumulative spending", async () => {
		const f = fixture();
		await f.kernel.execute("write", "bad-patch", { path: "a.txt", content: "bad" });
		const old = f.kernel.finalize();
		expect(old.status).toBe("EXECUTION_FAILED");
		const previous = f.kernel.state!;
		const restored = new SandhanaKernel({ cwd: () => f.cwd, session: () => "resume", store: f.store });
		restored.register(createReadTool(f.cwd), "read");
		restored.register(createWriteTool(f.cwd), "write");
		restored.captureInput(`resume ${old.mission_id}`, "USER");
		restored.begin("");
		expect(restored.state!.mission_id).toBe(old.mission_id);
		expect(restored.state!.command).toBe(previous.command);
		expect(restored.state!.requirements).toEqual(previous.requirements);
		expect(restored.state!.used).toEqual(previous.used);
		expect(restored.state!.started_at).toBe(previous.started_at);
		expect(restored.state!.contract).not.toBe(previous.contract);
		expect(f.store.get(old.mission_id, old.record_id, "TerminalReport")).toEqual(old);
		await restored.execute("write", "corrected", { path: "a.txt", content: "new" });
		const final = restored.finalize();
		expect(final.status).toBe("VERIFIED_COMPLETE");
		expect(restored.state!.used.execution).toBe(2);
		expect(f.store.list("resume")).toHaveLength(1);
		expect(f.store.records(old.mission_id).filter((record) => record.record_type === "TerminalReport")).toHaveLength(
			2,
		);
		expect(f.store.records(old.mission_id).filter((record) => record.record_type === "ResumeRecord")).toHaveLength(1);
		expect(final.contract_ref).toBe(restored.state!.contract);
	});
	it("rejects implicit reopening and an extension-authored resume without changing the stopped projection", () => {
		const f = fixture();
		const report = f.kernel.finalize("BLOCKED", "Awaiting a concrete candidate");
		const state = f.kernel.state!;
		expect(() =>
			f.store.commit(
				state.revision,
				{ ...state, revision: state.revision + 1, phase: "COMPILING", terminal: null },
				[],
			),
		).toThrow("Illegal mission transition");
		f.kernel.captureInput(`resume ${report.mission_id}`, "EXTENSION");
		expect(() => f.kernel.begin("")).toThrow("Only current client input");
		expect(f.kernel.state).toEqual(state);
	});
	it("does not restore revoked edit authority on resume", async () => {
		const f = fixture();
		f.kernel.revoke();
		const old = f.kernel.finalize("BLOCKED", "User revoked editing");
		f.kernel.captureInput(`resume ${old.mission_id}`, "USER");
		f.kernel.begin("");
		await expect(f.kernel.execute("write", "unauthorized", { path: "a.txt", content: "new" })).rejects.toThrow();
		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("old");
		expect(f.kernel.state!.used.execution).toBe(0);
	});
	it("a fabricated resume event cannot reopen a stopped run", () => {
		const f = fixture();
		const old = f.kernel.finalize("BLOCKED", "No candidate");
		const state = f.kernel.state!;
		const event = makeRecord(state.mission_id, state.revision + 1, "ResumeRecord", {
			source_ref: state.command,
			previous_terminal_ref: old.record_id,
			previous_contract_ref: state.contract,
			contract_ref: state.contract,
			resumed_at: Date.now(),
		});
		expect(() =>
			f.store.commit(
				state.revision,
				{ ...state, revision: state.revision + 1, phase: "COMPILING", terminal: null },
				[event],
			),
		).toThrow();
		expect(f.kernel.state).toEqual(state);
	});
	it("even an otherwise valid resume cannot mint a larger budget", () => {
		const f = fixture();
		const old = f.kernel.finalize("BLOCKED", "Awaiting candidate");
		const state = f.kernel.state!;
		const revision = state.revision + 1;
		const input = makeRecord(state.mission_id, revision, "Amendment", {
			amendment_id: "explicit-resume",
			instruction: `resume ${state.mission_id}`,
			source: "USER",
			captured_at: Date.now(),
			requirement_changes: [],
			revokes: false,
		});
		const prior = f.store.get(state.mission_id, state.contract, "MissionContract");
		const larger = { ...state.ceilings, execution: state.ceilings.execution + 20 };
		const contract = makeRecord(state.mission_id, revision, "MissionContract", {
			...prior,
			ceilings: larger,
			amendment_refs: [...(prior.amendment_refs ?? []), input.record_id],
			recompile_source: input.record_id,
		});
		const resume = makeRecord(state.mission_id, revision, "ResumeRecord", {
			source_ref: input.record_id,
			previous_terminal_ref: old.record_id,
			previous_contract_ref: prior.record_id,
			contract_ref: contract.record_id,
			resumed_at: Date.now(),
		});
		expect(() =>
			f.store.commit(
				state.revision,
				{
					...state,
					revision,
					phase: "COMPILING",
					terminal: null,
					intent_epoch: (state.intent_epoch ?? 1) + 1,
					contract: contract.record_id,
					ceilings: larger,
				},
				[input, contract, resume],
			),
		).toThrow("Resume cannot reset spending");
		expect(f.kernel.state).toEqual(state);
	});
});
