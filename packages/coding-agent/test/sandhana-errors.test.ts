import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandhanaError } from "../src/core/sandhana/errors.ts";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { requestProductMode, unavailablePort } from "../src/core/sandhana/ports.ts";
import { digest, makeRecord, type Resources } from "../src/core/sandhana/records.ts";
import { MissionStore, RevisionConflict } from "../src/core/sandhana/store.ts";
import { createReadTool, createWriteTool } from "../src/core/tools/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(limits?: Partial<Resources>, beforeDispatch?: () => Promise<void>) {
	const cwd = mkdtempSync(join(tmpdir(), "padma-errors-"));
	const store = new MissionStore(":memory:");
	const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "errors", store, limits, beforeDispatch });
	const read = kernel.register(createReadTool(cwd), "read");
	const write = kernel.register(createWriteTool(cwd), "write");
	cleanups.push(() => {
		store.close();
		rmSync(cwd, { recursive: true, force: true });
	});
	return {
		cwd,
		store,
		kernel,
		read,
		write,
		start: (instruction: string) => {
			kernel.captureInput(instruction, "USER");
			return kernel.begin(instruction);
		},
	};
}
describe("typed failures at actual Sandhana boundaries", () => {
	it("records an exact missing target with one launched read and no substitute", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "similarly-named.txt"), "must not be selected");
		f.start("read missing.txt");
		const result = await f.read.execute("missing", { path: "missing.txt" });
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({
			sandhana_failure: { code: "TARGET_MISSING", retry: { automatic: false } },
		});
		const state = f.kernel.state!;
		const operation = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
		const prepared = f.store.get(state.mission_id, operation.prepared_ref, "PreparedAction");
		const observation = f.store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
		expect(observation.failure).toMatchObject({
			operation_id: operation.operation_id,
			target_binding_ref: prepared.binding_ref,
			code: "TARGET_MISSING",
		});
		expect(f.store.get(state.mission_id, prepared.binding_ref, "TargetBinding").canonical_path).toBe(
			join(f.cwd, "missing.txt"),
		);
		const report = f.kernel.finalize();
		expect(report.status).toBe("EXECUTION_FAILED");
		expect(report.failure_refs).toContain(observation.record_id);
		expect(f.kernel.state!.used.execution).toBe(1);
	});
	it("rejects malformed arguments and unsupported operations before any launch", async () => {
		const f = fixture();
		f.start("Fix a.txt");
		const bad = await f.write.execute("bad", { path: "a.txt" });
		expect(bad.details).toMatchObject({ sandhana_failure: { code: "INVALID_ACTION_SCHEMA", operation_id: null } });
		expect(f.kernel.state!.used.execution).toBe(0);
		expect(f.kernel.state!.operations).toEqual([]);
		await expect(f.kernel.prepareOperation("unknown-tool", "unsupported", {})).rejects.toMatchObject({
			failure: { code: "UNREGISTERED_OPERATION" },
		});
		expect(f.kernel.state!.used.execution).toBe(0);
	});
	it("does not report an existing image missing when its decoder dependency is absent", async () => {
		const f = fixture();
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=",
			"base64",
		);
		writeFileSync(join(f.cwd, "image.png"), png);
		let calls = 0;
		const image = f.kernel.register(
			{
				name: "read",
				label: "image fixture",
				description: "decoder dependency failure",
				parameters: Type.Object({ path: Type.String() }),
				execute: async () => {
					calls++;
					const helper = readFileSync(join(f.cwd, "missing-decoder.txt"));
					return { content: [{ type: "text" as const, text: helper.toString() }], details: {} };
				},
			},
			"read",
		);
		f.start("read image.png");
		const result = await image.execute("image", { path: "image.png" });
		expect(result.details).toMatchObject({ sandhana_failure: { code: "TOOL_FAILURE_KNOWN" } });
		expect(readFileSync(join(f.cwd, "image.png"))).toEqual(png);
		expect(calls).toBe(1);
		expect(f.kernel.state!.used.execution).toBe(1);
	});
	it("distinguishes missing authority from denied scope without applying the proposed write", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "original");
		f.start("read a.txt");
		const denied = await f.write.execute("write", { path: "a.txt", content: "unauthorized" });
		const state = f.kernel.state!;
		const prepared = f.store.records(state.mission_id).findLast((record) => record.record_type === "PreparedAction");
		if (prepared?.record_type !== "PreparedAction") throw new Error("Denied preparation missing");
		expect(f.store.get(state.mission_id, prepared.binding_ref, "TargetBinding").canonical_path).toBe(
			join(f.cwd, "a.txt"),
		);
		expect(denied.details).toMatchObject({
			sandhana_failure: {
				code: "AUTHORIZATION_REQUIRED",
				operation_id: prepared.operation_id,
				target_binding_ref: prepared.binding_ref,
			},
		});
		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("original");
		await expect(f.kernel.prepareOperation("read", "outside", { path: "../outside.txt" })).rejects.toMatchObject({
			failure: { code: "SCOPE_DENIED" },
		});
		expect(f.kernel.state!.used.execution).toBe(0);
	});
	it("retains a conflicting user save and releases only the unstarted reservation", async () => {
		let target = "";
		const f = fixture(undefined, async () => {
			writeFileSync(target, "user save");
		});
		target = join(f.cwd, "a.txt");
		writeFileSync(target, "original");
		f.start("Fix a.txt");
		const result = await f.write.execute("conflict", { path: "a.txt", content: "candidate" });
		expect(result.details).toMatchObject({
			sandhana_stop: "BLOCKED",
			sandhana_failure: { code: "PREIMAGE_CONFLICT", retry: { automatic: false } },
		});
		expect(readFileSync(target, "utf8")).toBe("user save");
		const state = f.kernel.state!;
		const op = f.store.records(state.mission_id).find((record) => record.record_type === "OperationRecord")!;
		if (op.record_type !== "OperationRecord") throw new Error("fixture operation missing");
		expect(op.status).toBe("NOT_STARTED");
		expect(
			state.reservations
				.map((ref) => f.store.get(state.mission_id, ref, "BudgetReservation"))
				.find((reservation) => reservation.owner_operation_id === op.operation_id)?.state,
		).toBe("RELEASED");
		expect(state.used.execution).toBe(0);
		expect(f.kernel.finalize("BLOCKED").failure_refs?.length).toBeGreaterThan(0);
	});
	it("requires reconciliation after a real effect regardless of misleading error prose", async () => {
		const f = fixture();
		let calls = 0;
		const bash = f.kernel.register(
			{
				name: "bash",
				label: "fixture",
				description: "lost response",
				parameters: Type.Object({ command: Type.String() }),
				execute: async () => {
					calls++;
					writeFileSync(join(f.cwd, "effect.txt"), "actual effect");
					throw new Error("INVALID_ACTION_SCHEMA: sk-fixtureCredential123456789");
				},
			},
			"bash",
		);
		writeFileSync(join(f.cwd, "check.cjs"), "// fixture command");
		f.start("run: node check.cjs");
		const result = await bash.execute("lost", { command: "node check.cjs" });
		expect(result.details).toMatchObject({
			sandhana_stop: "OUTCOME_UNKNOWN",
			sandhana_failure: { code: "EFFECT_OUTCOME_UNKNOWN", retry: { automatic: false } },
		});
		expect(JSON.stringify(result.details)).not.toContain("sk-fixtureCredential");
		await bash.execute("replay", { command: "node check.cjs" });
		expect(calls).toBe(1);
		const report = f.kernel.finalize();
		expect(report.status).toBe("OUTCOME_UNKNOWN");
		expect(report.failure_refs?.length).toBeGreaterThan(0);
		expect(f.kernel.state!.used.execution).toBe(1);
	});
	it("rejects a launch without capacity and preserves a typed stale-revision failure", async () => {
		const f = fixture({ execution: 0 });
		writeFileSync(join(f.cwd, "a.txt"), "bytes");
		f.start("read a.txt");
		const result = await f.read.execute("zero", { path: "a.txt" });
		expect(result.details).toMatchObject({ sandhana_failure: { code: "BUDGET_REJECTED" } });
		expect(f.kernel.state!.used.execution).toBe(0);
		const state = f.kernel.state!;
		let error: unknown;
		try {
			f.store.commit(state.revision - 1, { ...state, revision: state.revision + 1 }, []);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(RevisionConflict);
		expect(error).toMatchObject({ failure: { code: "REVISION_CONFLICT", retry: { automatic: false } } });
		expect(f.kernel.state).toEqual(state);
	});
	it("rejects model failures, foreign operation identity and forged retry conditions", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "bytes");
		f.start("read a.txt");
		await f.read.execute("read", { path: "a.txt" });
		const state = f.kernel.state!;
		const op = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
		const action = f.store.get(state.mission_id, op.prepared_ref, "PreparedAction");
		const observation = f.store.get(state.mission_id, op.result_refs[0], "EvidenceRecord");
		const failure = new SandhanaError("TOOL_FAILURE_KNOWN", "forged", {
			operation_id: op.operation_id,
			target_binding_ref: action.binding_ref,
		}).failure;
		const forged = makeRecord(state.mission_id, state.revision + 1, "EvidenceRecord", {
			...observation,
			provenance: "MODEL",
			failure,
		});
		expect(() => f.store.commit(state.revision, { ...state, revision: state.revision + 1 }, [forged])).toThrow(
			"observed kernel/adapter boundary",
		);
		const wrong = makeRecord(state.mission_id, state.revision + 1, "EvidenceRecord", {
			...observation,
			failure: { ...failure, operation_id: "different-operation" },
		});
		expect(() => f.store.commit(state.revision, { ...state, revision: state.revision + 1 }, [wrong])).toThrow(
			"matching operation identity",
		);
		const retry = makeRecord(state.mission_id, state.revision + 1, "EvidenceRecord", {
			...observation,
			failure: { ...failure, retry: { automatic: false, conditions: ["Blindly replay the effect immediately"] } },
		});
		expect(() => f.store.commit(state.revision, { ...state, revision: state.revision + 1 }, [retry])).toThrow(
			"recovery conditions",
		);
		expect(f.kernel.state).toEqual(state);
		expect(f.kernel.finalize().status).toBe("VERIFIED_COMPLETE");
	});
	it("expired evidence and unavailable capabilities never become verification or effects", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "bytes");
		f.start("read a.txt");
		await f.read.execute("read", { path: "a.txt" });
		const state = f.kernel.state!;
		const artifact = f.store.records(state.mission_id).find((record) => record.record_type === "Artifact")!;
		expect(artifact.record_type).toBe("Artifact");
		if (artifact.record_type !== "Artifact") throw new Error("fixture artifact missing");
		const expired = makeRecord(state.mission_id, state.revision + 1, "Artifact", { ...artifact, expires_at: 1 });
		const bytes = f.store.artifact(state.mission_id, artifact.record_id);
		f.store.commit(
			state.revision,
			{ ...state, revision: state.revision + 1 },
			[expired],
			new Map([[expired.record_id, bytes]]),
		);
		expect(() => f.store.artifact(state.mission_id, expired.record_id)).toThrowError(SandhanaError);
		try {
			f.store.artifact(state.mission_id, expired.record_id);
		} catch (error) {
			expect(error).toMatchObject({ failure: { code: "ARTIFACT_UNAVAILABLE" } });
		}
		const before = f.kernel.state!;
		expect(await unavailablePort("structural_edit").request({}, before)).toMatchObject({
			status: "UNAVAILABLE",
			failure: { code: "UNAVAILABLE_CAPABILITY" },
		});
		expect(requestProductMode("padma_cyber", before)).toMatchObject({
			status: "UNAVAILABLE",
			failure: { code: "UNAVAILABLE_CAPABILITY" },
		});
		expect(f.kernel.state).toEqual(before);
		expect(digest(f.store.artifact(state.mission_id, artifact.record_id))).toBe(artifact.digest);
	});
});
