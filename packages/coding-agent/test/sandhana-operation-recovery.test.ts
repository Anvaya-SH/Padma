import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createReadTool, createWriteTool } from "../src/core/tools/index.ts";

describe("Operation recovery after actual runtime death", () => {
	it("reconciles a started replacement after rename without replay, another account, or invented original usage", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "padma-operation-crash-workspace-"));
		const directory = mkdtempSync(join(tmpdir(), "padma-operation-crash-database-"));
		const database = join(directory, "mission.sqlite");
		writeFileSync(join(cwd, "out.txt"), "old");
		const child = spawnSync(
			process.execPath,
			[fileURLToPath(new URL("./fixtures/sandhana-operation-crash.ts", import.meta.url)), cwd, database],
			{ encoding: "utf8", timeout: 30000, windowsHide: true },
		);
		expect(child.status, child.stderr).toBe(91);
		const store = new MissionStore(database);
		try {
			const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "operation-crash", store });
			kernel.register(createReadTool(cwd), "read");
			kernel.register(createWriteTool(cwd), "write");
			const original = kernel.operations.list()[0];
			const originalReservation = store.get(
				original.effect.mission_id,
				original.effect.reservation_ref!,
				"BudgetReservation",
			);
			expect(original.schedule.status).toBe("RUNNING");
			expect(original.effect.status).toBe("IN_PROGRESS");
			expect(readFileSync(join(cwd, "out.txt"), "utf8")).toBe("new");
			const before = kernel.state!;
			const records = store.records(before.mission_id);
			const rejectedInputs = [
				{ source: "USER" as const, text: `resume ${before.mission_id} budget: {` },
				{
					source: "USER" as const,
					text: `resume ${before.mission_id} budget: {"version":1,"ceilings":{"execution":0}}`,
				},
				{ source: "USER" as const, text: `resume ${before.mission_id} unexpected suffix` },
				{ source: "USER" as const, text: `resume another-mission` },
				{ source: "EXTENSION" as const, text: `resume ${before.mission_id}` },
			];
			for (const input of rejectedInputs) {
				kernel.captureInput(input.text, input.source);
				expect(() => kernel.begin("")).toThrow();
				expect(kernel.state).toEqual(before);
				expect(store.records(before.mission_id)).toEqual(records);
				expect(kernel.operations.list()[0]).toEqual(original);
				expect(readFileSync(join(cwd, "out.txt"), "utf8")).toBe("new");
			}
			const foreignCwd = join(directory, "foreign-workspace");
			mkdirSync(foreignCwd);
			const foreign = new SandhanaKernel({ cwd: () => foreignCwd, session: () => "operation-crash", store });
			foreign.captureInput(`resume ${before.mission_id}`, "USER");
			expect(() => foreign.begin("")).toThrow("Resume workspace differs");
			expect(store.load(before.mission_id)).toEqual(before);
			expect(store.records(before.mission_id)).toEqual(records);
			kernel.captureInput(`resume ${original.effect.mission_id}`, "USER");
			const command = kernel.begin("");
			expect(command.reconciliation?.operation_id).toBe(original.effect.operation_id);
			expect(kernel.operations.inspect(original.effect.operation_id).schedule.status).toBe("UNCERTAIN");
			expect(kernel.operations.reconnect(original.effect.operation_id).attached).toBe(false);
			await expect(kernel.operations.prepare("write", { path: "out.txt", content: "new" })).rejects.toThrow(
				"no repeat",
			);
			await kernel.execute("read", "authoritative-inspection", { path: command.reconciliation!.path });
			const report = kernel.finalize();
			expect(report.status).toBe("VERIFIED_COMPLETE");
			expect(kernel.operations.inspect(original.effect.operation_id).schedule.status).toBe("COMPLETED");
			expect(kernel.operations.inspect(original.effect.operation_id).effect.prepared_ref).toBe(
				original.effect.prepared_ref,
			);
			expect(kernel.state!.used.execution).toBe(2);
			expect(kernel.state!.used.ticks).toBe(0);
			expect(kernel.state!.mission_id).toBe(original.effect.mission_id);
			expect(store.list("operation-crash")).toHaveLength(1);
			expect(store.get(original.effect.mission_id, originalReservation.record_id, "BudgetReservation")).toEqual(
				originalReservation,
			);
			expect(
				store
					.records(original.effect.mission_id)
					.filter((record) => record.record_type === "PreparedAction" && record.operation_class === "EDIT"),
			).toHaveLength(1);
		} finally {
			store.close();
			rmSync(cwd, { recursive: true, force: true });
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
