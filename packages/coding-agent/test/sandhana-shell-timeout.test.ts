import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import type { KernelConfigurationInput } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createBashTool } from "../src/core/tools/bash.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(configuration?: KernelConfigurationInput) {
	const cwd = mkdtempSync(join(tmpdir(), "padma-shell-timeout-"));
	const store = new MissionStore(":memory:");
	const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "shell-timeout", store, configuration });
	kernel.register(createBashTool(cwd, { exposeSessionEnvironment: false }), "bash");
	kernel.captureInput("run: node controlled.cjs", "USER");
	kernel.begin("");
	cleanups.push(() => {
		kernel.closeKnowledge();
		store.close();
		rmSync(cwd, { recursive: true, force: true });
	});
	return { cwd, store, kernel };
}

describe("governed shell timeout admission", () => {
	it("preserves a requested twenty-minute timeout instead of silently reducing it to two minutes", async () => {
		const f = fixture();
		const id = await f.kernel.prepareOperation("bash", "long-command", {
			command: "node controlled.cjs",
			timeout: 1200,
		});
		const operation = f.store.get(f.kernel.state!.mission_id, f.kernel.state!.operations[0], "OperationRecord");
		const action = f.store.get(operation.mission_id, operation.prepared_ref, "PreparedAction");
		expect(operation.operation_id).toBe(id);
		expect(action.timeout_ms).toBe(1200000);
		expect(action.arguments).toMatchObject({ timeout: 1200 });
		expect(f.kernel.state!.used.execution).toBe(0);
	});
	it("retains an explicitly configured shorter shell ceiling", async () => {
		const f = fixture({ version: "sandhana/1", timeouts: { shell_ms: 120000 } });
		await f.kernel.prepareOperation("bash", "bounded-command", { command: "node controlled.cjs", timeout: 1200 });
		const operation = f.store.get(f.kernel.state!.mission_id, f.kernel.state!.operations[0], "OperationRecord");
		const action = f.store.get(operation.mission_id, operation.prepared_ref, "PreparedAction");
		expect(action.timeout_ms).toBe(120000);
		expect(action.arguments).toMatchObject({ timeout: 120 });
	});
	it("keeps zero shell capacity disabled even with an explicit tool timeout", async () => {
		const f = fixture({ version: "sandhana/1", timeouts: { shell_ms: 0 } });
		await expect(
			f.kernel.prepareOperation("bash", "disabled", { command: "node controlled.cjs", timeout: 1200 }),
		).rejects.toThrow("dispatch disabled");
		expect(f.kernel.state!.used.execution).toBe(0);
		expect(f.kernel.state!.operations).toEqual([]);
	});
	it("captures native completion after the former two-minute cutoff without replaying the command", async () => {
		const f = fixture();
		writeFileSync(
			join(f.cwd, "controlled.cjs"),
			"setTimeout(() => { require('node:fs').writeFileSync('completed.txt', 'once'); console.log('completed once'); }, 125000);",
		);
		const result = await f.kernel.execute("bash", "native-long-command", {
			command: "node controlled.cjs",
			timeout: 1200,
		});
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toMatchObject({ exit_code: 0, output_complete: true });
		expect(readFileSync(join(f.cwd, "completed.txt"), "utf8")).toBe("once");
		const operation = f.store.get(f.kernel.state!.mission_id, f.kernel.state!.operations[0], "OperationRecord");
		expect(operation.status).toBe("CONFIRMED_COMPLETE");
		expect(f.kernel.state!.used.execution).toBe(1);
		expect(f.kernel.finalize().status).toBe("VERIFIED_COMPLETE");
	}, 180000);
});
