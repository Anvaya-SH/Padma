import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandhanaError } from "../src/core/sandhana/errors.ts";
import { type KernelOptions, SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import type { ActionApprovalInput } from "../src/core/sandhana/public-protocol.ts";
import { makeRecord } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createEditTool, createReadTool, createWriteTool } from "../src/core/tools/index.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const dispose of cleanup.splice(0).reverse()) dispose();
});

async function fixture(
	kind: "write" | "edit" = "write",
	existing = true,
	hooks: Pick<KernelOptions, "beforeDispatch"> = {},
) {
	const directory = mkdtempSync(join(tmpdir(), "padma-approval-"));
	const cwd = join(directory, "workspace");
	mkdirSync(cwd);
	const storePath = join(directory, "mission.sqlite");
	let store = new MissionStore(storePath);
	let kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "approval", store, ...hooks });
	const register = () => {
		kernel.register(createReadTool(cwd), "read");
		kernel.register(createWriteTool(cwd), "write");
		kernel.register(createEditTool(cwd), "edit");
	};
	register();
	cleanup.push(() => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	});
	const path = join(cwd, "a.txt");
	if (existing) writeFileSync(path, "old");
	kernel.captureInput("Inspect a.txt and explain its contents", "USER");
	kernel.begin("");
	const args =
		kind === "write"
			? { path: "a.txt", content: "new" }
			: { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] };
	try {
		await kernel.prepareOperation(kind, "denied-action", args);
		throw new Error("Expected authorization denial");
	} catch (error) {
		if (!(error instanceof SandhanaError)) throw error;
		expect(error.failure.code).toBe("AUTHORIZATION_REQUIRED");
		kernel.recordFailure(error);
		kernel.finalize("BLOCKED", error.message);
	}
	const response = (): ActionApprovalInput => {
		const view = store.publicAuthorization(kernel.state!.mission_id);
		if (!view.request) throw new Error("Missing approval request");
		return {
			version: "SANDHANA_APPROVAL/1",
			mission_id: view.mission_id,
			revision: view.revision,
			decision_ref: view.request.decision_ref,
			prepared_ref: view.request.prepared_ref,
			action_digest: view.request.action_digest,
		};
	};
	return {
		cwd,
		path,
		kind,
		args,
		response,
		get kernel() {
			return kernel;
		},
		get store() {
			return store;
		},
		reopen: () => {
			store.close();
			store = new MissionStore(storePath);
			kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "approval", store, ...hooks });
			register();
		},
	};
}

describe("trusted exact-action approval", () => {
	it.each([
		{ kind: "write", existing: true },
		{ kind: "write", existing: false },
		{ kind: "edit", existing: true },
	] as const)(
		"authorizes one fresh $kind existing=$existing without resetting the mission",
		async ({ kind, existing }) => {
			const f = await fixture(kind, existing);
			const previous = f.kernel.state!;
			const report = f.kernel.terminal!;
			f.kernel.captureInput(`authorize: ${JSON.stringify(f.response())}`, "USER");
			const command = f.kernel.begin("transformed input cannot replace the approval");
			expect(command.authorized_action).toEqual({ tool: kind, arguments: f.args });
			expect(f.kernel.state!.authorizations).toEqual(previous.authorizations);
			expect(f.kernel.state!.used).toEqual(previous.used);
			expect(f.kernel.state!.started_at).toBe(previous.started_at);
			await f.kernel.execute(kind, "approved-action", command.authorized_action!.arguments);
			const state = f.kernel.state!;
			expect(readFileSync(f.path, "utf8")).toBe("new");
			expect(state.used.execution).toBe(1);
			expect(state.operations).toHaveLength(1);
			expect(state.checkpoints).toHaveLength(2);
			const operation = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
			const action = f.store.get(state.mission_id, operation.prepared_ref, "PreparedAction");
			const recovery = f.store.get(state.mission_id, operation.checkpoint_ref!, "CheckpointRecord");
			expect(f.store.artifact(state.mission_id, recovery.artifact_ref).toString()).toBe(existing ? "old" : "");
			expect(recovery.preimage === "ABSENT").toBe(!existing);
			expect(
				state.checkpoints
					.map((ref) => f.store.get(state.mission_id, ref, "CheckpointRecord"))
					.some((point) => f.store.get(state.mission_id, point.artifact_ref, "Artifact").purpose === "DELIVERED"),
			).toBe(true);
			const grant = f.store.get(
				state.mission_id,
				f.store.get(state.mission_id, operation.decision_ref!, "ScopeDecision").authorization_ref!,
				"Authorization",
			);
			expect(operation.status).toBe("CONFIRMED_COMPLETE");
			expect(grant.prepared_ref).toBe(action.record_id);
			expect(grant.action_digest).toBe(action.action_digest);
			expect(grant.classes).toEqual(["EDIT"]);
			expect(f.store.get(state.mission_id, report.record_id, "TerminalReport")).toEqual(report);
			await expect(
				f.kernel.prepareOperation("write", "repeat-approval", { path: "a.txt", content: "new" }),
			).rejects.toMatchObject({ failure: { code: "AUTHORIZATION_REQUIRED" } });
			expect(f.kernel.state!.used.execution).toBe(1);
		},
	);
	it("rejects stale, foreign, altered and extension responses before changing durable state", async () => {
		const f = await fixture();
		const response = f.response();
		const before = f.kernel.state!;
		const records = f.store.records(before.mission_id);
		for (const request of [
			{ ...response, revision: response.revision - 1 },
			{ ...response, mission_id: "foreign" },
			{ ...response, decision_ref: "foreign" },
			{ ...response, prepared_ref: "foreign" },
			{ ...response, action_digest: "0".repeat(64) },
			{ ...response, arguments: { content: "changed" } },
		]) {
			f.kernel.captureInput(`authorize: ${JSON.stringify(request)}`, "USER");
			expect(() => f.kernel.begin("")).toThrow();
			expect(f.kernel.state).toEqual(before);
			expect(f.store.records(before.mission_id)).toEqual(records);
		}
		f.kernel.captureInput(`authorize: ${JSON.stringify(response)}`, "EXTENSION");
		expect(() => f.kernel.begin("")).toThrow("Only current client input");
		expect(f.kernel.state).toEqual(before);
		expect(readFileSync(f.path, "utf8")).toBe("old");
	});
	it.each(["target", "arguments", "environment", "expiry", "policy", "revocation", "adapter", "restart"] as const)(
		"fences an approved action after changed $0",
		async (change) => {
			const f = await fixture();
			f.kernel.captureInput(`authorize: ${JSON.stringify(f.response())}`, "USER");
			f.kernel.begin("");
			const before = f.kernel.state!;
			if (change === "target") writeFileSync(f.path, "intervening");
			if (change === "environment") vi.stubEnv("APPROVAL_FIXTURE", "changed");
			if (change === "expiry") {
				const approval = f.store.pendingApproval(before.mission_id, before.intent_epoch!)!;
				vi.spyOn(Date, "now").mockReturnValue(approval.expires_at + 1);
			}
			if (change === "policy") f.kernel.policy.version = "changed-policy";
			if (change === "revocation") f.kernel.amend("stop");
			if (change === "adapter") f.kernel.register(createWriteTool(f.cwd), "write");
			if (change === "restart") f.reopen();
			await expect(
				f.kernel.prepareOperation("write", "stale-approved", {
					...f.args,
					...(change === "arguments" ? { content: "different" } : {}),
				}),
			).rejects.toThrow();
			expect(f.kernel.state!.used.execution).toBe(0);
			expect(f.kernel.state!.checkpoints).toEqual([]);
			expect(f.kernel.state!.operations).toEqual([]);
			expect(readFileSync(f.path, "utf8")).toBe(change === "target" ? "intervening" : "old");
		},
	);
	it.each(["revocation", "expiry"] as const)("rechecks bound approval at dispatch after $0", async (change) => {
		let alter: (() => void) | undefined;
		const f = await fixture("write", true, { beforeDispatch: async () => alter?.() });
		f.kernel.captureInput(`authorize: ${JSON.stringify(f.response())}`, "USER");
		f.kernel.begin("");
		const id = await f.kernel.prepareOperation("write", "queued-approved", f.args);
		const before = f.kernel.state!;
		const operation = f.store.get(before.mission_id, before.operations[0], "OperationRecord");
		const action = f.store.get(before.mission_id, operation.prepared_ref, "PreparedAction");
		const approval = f.store.get(before.mission_id, action.approval_ref!, "ActionApproval");
		alter =
			change === "revocation"
				? () => f.kernel.amend("stop")
				: () => {
						vi.spyOn(Date, "now").mockReturnValue(approval.expires_at + 1);
					};
		await expect(f.kernel.dispatchPrepared(id)).rejects.toMatchObject({
			failure: {
				code: "AUTHORIZATION_REQUIRED",
				operation_id: id,
				target_binding_ref: action.binding_ref,
			},
		});
		expect(f.kernel.state!.used.execution).toBe(0);
		expect(readFileSync(f.path, "utf8")).toBe("old");
		expect(f.kernel.state!.operations).toEqual([]);
		expect(f.store.get(before.mission_id, operation.record_id, "OperationRecord").status).toBe("NOT_STARTED");
		expect(
			f.kernel
				.state!.reservations.map((ref) => f.store.get(before.mission_id, ref, "BudgetReservation"))
				.find((item) => item.owner_operation_id === id)?.state,
		).toBe("RELEASED");
	});
	it("does not replay a consumed approval after reopening", async () => {
		const f = await fixture();
		const response = f.response();
		f.kernel.captureInput(`authorize: ${JSON.stringify(response)}`, "USER");
		f.kernel.begin("");
		await f.kernel.execute("write", "approved", f.args);
		f.kernel.finalize("PARTIALLY_COMPLETE", "Original explanation remains unverified");
		const before = f.kernel.state!;
		f.reopen();
		expect(f.kernel.state).toEqual(before);
		f.kernel.captureInput(`authorize: ${JSON.stringify(response)}`, "USER");
		expect(() => f.kernel.begin("")).toThrow();
		expect(f.kernel.state).toEqual(before);
		expect(readFileSync(f.path, "utf8")).toBe("new");
	});
	it("rejects forged general authority and a second preparation using one sourced approval", async () => {
		const f = await fixture();
		f.kernel.captureInput(`authorize: ${JSON.stringify(f.response())}`, "USER");
		f.kernel.begin("");
		const approval = f.store.pendingApproval(f.kernel.state!.mission_id, f.kernel.state!.intent_epoch!)!;
		const before = f.kernel.state!;
		const forged = makeRecord(before.mission_id, before.revision + 1, "Authorization", {
			authorization_id: "forged",
			source_ref: approval.source_ref,
			classes: ["EDIT"],
			target: f.cwd,
			environment: `local:${f.cwd}`,
			policy_version: "padma_code/1",
			action_digest: null,
			expires_at: approval.expires_at,
			revoked: false,
		});
		expect(() =>
			f.store.commit(
				before.revision,
				{ ...before, revision: before.revision + 1, authorizations: [...before.authorizations, forged.record_id] },
				[forged],
			),
		).toThrow("general authority");
		expect(f.kernel.state).toEqual(before);
		const id = await f.kernel.prepareOperation("write", "first-preparation", f.args);
		const preparedState = f.kernel.state!;
		const operation = f.store.get(preparedState.mission_id, preparedState.operations[0], "OperationRecord");
		const action = f.store.get(preparedState.mission_id, operation.prepared_ref, "PreparedAction");
		const duplicate = makeRecord(preparedState.mission_id, preparedState.revision + 1, "PreparedAction", {
			...action,
			operation_id: "different-operation",
		});
		expect(() =>
			f.store.commit(preparedState.revision, { ...preparedState, revision: preparedState.revision + 1 }, [
				duplicate,
			]),
		).toThrow("only one");
		expect(f.kernel.state).toEqual(preparedState);
		expect(existsSync(f.path)).toBe(true);
		expect(readFileSync(f.path, "utf8")).toBe("old");
		expect(id).toBe(operation.operation_id);
	});
	it("runs an approved process once under its exact prepared authority", async () => {
		const f = await fixture();
		// Start a separate ordinary inspection so the process proposal is not instruction-authorized.
		f.kernel.captureInput("Inspect the fixture", "USER");
		f.kernel.begin("");
		let calls = 0;
		f.kernel.register(
			{
				name: "bash",
				label: "Fixture process",
				description: "Count a real fixture effect",
				parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
				execute: async () => {
					calls++;
					writeFileSync(join(f.cwd, "effect.txt"), "effect");
					return { content: [{ type: "text", text: "complete" }], details: { exitCode: 0 } };
				},
			},
			"bash",
		);
		await expect(
			f.kernel.prepareOperation("bash", "denied-process", { command: "node fixture.cjs" }),
		).rejects.toMatchObject({ failure: { code: "AUTHORIZATION_REQUIRED" } });
		f.kernel.finalize("BLOCKED", "Exact process authorization required");
		f.kernel.captureInput(`authorize: ${JSON.stringify(f.response())}`, "USER");
		const compiled = f.kernel.begin("");
		await f.kernel.execute("bash", "approved-process", compiled.authorized_action!.arguments);
		expect(calls).toBe(1);
		expect(readFileSync(join(f.cwd, "effect.txt"), "utf8")).toBe("effect");
		expect(f.kernel.state!.used.execution).toBe(1);
	});
	it("does not derive local-check authority from a grant bound to another prepared action", async () => {
		const f = await fixture();
		f.kernel.captureInput("Inspect the fixture", "USER");
		f.kernel.begin("");
		writeFileSync(join(f.cwd, "fixture.test.cjs"), "// retained test source\n");
		const args = { path: ".", content: "approved payload" };
		await expect(f.kernel.prepareOperation("write", "denied-root-action", args)).rejects.toMatchObject({
			failure: { code: "AUTHORIZATION_REQUIRED" },
		});
		f.kernel.finalize("BLOCKED", "Exact action authorization required");
		f.kernel.captureInput(`authorize: ${JSON.stringify(f.response())}`, "USER");
		f.kernel.begin("");
		const id = await f.kernel.prepareOperation("write", "approved-root-action", args);
		const state = f.kernel.state!;
		const operation = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
		const grant = state.authorizations
			.map((ref) => f.store.get(state.mission_id, ref, "Authorization"))
			.find((item) => item.classes.includes("EDIT"))!;
		expect(grant.target).toBe(f.cwd);
		expect(grant.prepared_ref).toBe(operation.prepared_ref);
		expect(id).toBe(operation.operation_id);
		let calls = 0;
		f.kernel.register(
			{
				name: "bash",
				label: "Fixture check",
				description: "Check with an actual fixture effect",
				parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
				execute: async () => {
					calls++;
					writeFileSync(join(f.cwd, "check-effect.txt"), "effect");
					return { content: [{ type: "text", text: "complete" }], details: { exitCode: 0 } };
				},
			},
			"bash",
		);
		await expect(
			f.kernel.execute("bash", "unapproved-local-check", { command: "node --test fixture.test.cjs" }),
		).rejects.toMatchObject({ failure: { code: "AUTHORIZATION_REQUIRED" } });
		expect(calls).toBe(0);
		expect(existsSync(join(f.cwd, "check-effect.txt"))).toBe(false);
		expect(f.kernel.state!.used.execution).toBe(0);
	});
});
