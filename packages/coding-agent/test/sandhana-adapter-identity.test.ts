import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@anvaya.sh/padma-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createBashTool, createWriteTool } from "../src/core/tools/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(beforeDispatch?: () => Promise<void>, persistent = false) {
	const cwd = mkdtempSync(join(tmpdir(), "padma-adapter-identity-"));
	const store = new MissionStore(persistent ? join(cwd, "mission.sqlite") : ":memory:");
	const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "adapter-identity", store, beforeDispatch });
	cleanups.push(() => {
		store.close();
		rmSync(cwd, { recursive: true, force: true });
	});
	return { cwd, store, kernel };
}
describe("registered adapter identity at dispatch", () => {
	it("a replacement executor with the same schema cannot inherit a prepared write", async () => {
		const f = fixture();
		const original = createWriteTool(f.cwd);
		f.kernel.register(original, "write");
		writeFileSync(join(f.cwd, "target.txt"), "original");
		f.kernel.captureInput("Fix target.txt", "USER");
		f.kernel.begin("Fix target.txt");
		const operation = await f.kernel.prepareOperation("write", "candidate", {
			path: "target.txt",
			content: "replacement",
		});
		const before = f.kernel.state!;
		const action = f.store.get(
			before.mission_id,
			f.store.get(before.mission_id, before.operations[0], "OperationRecord").prepared_ref,
			"PreparedAction",
		);
		f.kernel.register(
			{
				...original,
				execute: async () => {
					throw new Error("different implementation");
				},
			},
			"write",
		);
		await expect(f.kernel.dispatchPrepared(operation)).rejects.toThrow("adapter");
		expect(readFileSync(join(f.cwd, "target.txt"), "utf8")).toBe("original");
		expect(f.kernel.state!.used.execution).toBe(0);
		expect(
			f.store
				.records(before.mission_id)
				.some(
					(record) =>
						record.record_type === "OperationRecord" &&
						record.operation_id === operation &&
						record.started_at !== null,
				),
		).toBe(false);
		expect(
			f.kernel
				.state!.reservations.map((ref) => f.store.get(before.mission_id, ref, "BudgetReservation"))
				.find((entry) => entry.owner_operation_id === operation)?.state,
		).toBe("RELEASED");
		await f.kernel.execute("write", "fresh-candidate", { path: "target.txt", content: "replacement" });
		const current = f.kernel.state!;
		const fresh = f.store.get(
			current.mission_id,
			f.store.get(current.mission_id, current.operations[0], "OperationRecord").prepared_ref,
			"PreparedAction",
		);
		// Both writes use the same kernel replacement implementation, but their live registrations cannot be exchanged.
		expect(fresh.schema_version_ref).toBe(action.schema_version_ref);
		expect(fresh.preconditions).not.toEqual(action.preconditions);
		expect(fresh.action_digest).not.toBe(action.action_digest);
		expect(readFileSync(join(f.cwd, "target.txt"), "utf8")).toBe("replacement");
		expect(current.used.execution).toBe(1);
	});
	it("same-source closures still require preparation against the current registration", async () => {
		const f = fixture();
		let invocations = 0;
		const factory = (effect: string): AgentTool => ({
			...createBashTool(f.cwd),
			execute: async () => {
				invocations++;
				writeFileSync(join(f.cwd, "effect.txt"), effect);
				return { content: [{ type: "text", text: effect }], details: {}, structuredContent: { exit_code: 0 } };
			},
		});
		const first = factory("first");
		const second = factory("second");
		expect(first.execute.toString()).toBe(second.execute.toString());
		f.kernel.register(first, "bash");
		f.kernel.captureInput("run: printf identity", "USER");
		f.kernel.begin("run: printf identity");
		const operation = await f.kernel.prepareOperation("bash", "candidate", { command: "printf identity" });
		f.kernel.register(second, "bash");
		await expect(f.kernel.dispatchPrepared(operation)).rejects.toThrow("adapter");
		expect(invocations).toBe(0);
		expect(f.kernel.state!.used.execution).toBe(0);
	});
	it("mutating the registered executor at the final guard cannot launch its replacement", async () => {
		let invocations = 0;
		let tool!: AgentTool;
		const f = fixture(async () => {
			tool.execute = async () => {
				invocations++;
				return { content: [{ type: "text", text: "unexpected execution" }], details: {} };
			};
		});
		tool = createBashTool(f.cwd);
		f.kernel.register(tool, "bash");
		f.kernel.captureInput("run: printf identity", "USER");
		f.kernel.begin("run: printf identity");
		await expect(f.kernel.execute("bash", "candidate", { command: "printf identity" })).rejects.toThrow("adapter");
		expect(invocations).toBe(0);
		expect(f.kernel.state!.used.execution).toBe(0);
	});
	it("a reopened runtime cannot dispatch a preparation against its new registration", async () => {
		const f = fixture(undefined, true);
		f.kernel.register(createWriteTool(f.cwd), "write");
		writeFileSync(join(f.cwd, "target.txt"), "original");
		f.kernel.captureInput("Fix target.txt", "USER");
		f.kernel.begin("Fix target.txt");
		const operation = await f.kernel.prepareOperation("write", "candidate", {
			path: "target.txt",
			content: "replacement",
		});
		const reopenedStore = new MissionStore(join(f.cwd, "mission.sqlite"));
		cleanups.push(() => reopenedStore.close());
		const reopened = new SandhanaKernel({
			cwd: () => f.cwd,
			session: () => "adapter-identity",
			store: reopenedStore,
		});
		reopened.register(createWriteTool(f.cwd), "write");
		await expect(reopened.dispatchPrepared(operation)).rejects.toThrow("adapter");
		expect(readFileSync(join(f.cwd, "target.txt"), "utf8")).toBe("original");
		expect(reopened.state!.used.execution).toBe(0);
		expect(
			reopenedStore
				.records(reopened.state!.mission_id)
				.some(
					(record) =>
						record.record_type === "OperationRecord" &&
						record.operation_id === operation &&
						record.started_at !== null,
				),
		).toBe(false);
	});
});
