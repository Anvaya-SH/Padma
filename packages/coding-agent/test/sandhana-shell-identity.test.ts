import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createBashTool } from "../src/core/tools/bash.ts";
import { createPowerShellTool } from "../src/core/tools/powershell.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "padma-shell-identity-"));
	const store = new MissionStore(":memory:");
	const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "shell-identity", store });
	cleanups.push(() => {
		store.close();
		rmSync(cwd, { recursive: true, force: true });
	});
	const calls: string[] = [];
	const shell = kernel.register(
		createBashTool(cwd, {
			operations: {
				exec: async (command, _cwd, options) => {
					calls.push(command);
					options.onData(Buffer.from("observed literal command"));
					return { exitCode: 0, outputComplete: true };
				},
			},
		}),
		"bash",
	);
	return {
		cwd,
		store,
		kernel,
		calls,
		shell,
		start: (instruction: string) => {
			kernel.captureInput(instruction, "USER");
			return kernel.begin(instruction);
		},
	};
}

describe("exact governed shell semantics", () => {
	it.each([
		["printf '%s' '$HOME'", "printf '%s' \"$HOME\""],
		["printf '%s' 'two  spaces'", "printf '%s' 'two spaces'"],
	])("does not authorize changed literal semantics: %s", async (allowed, proposed) => {
		const f = fixture();
		f.start(`run: ${allowed}`);
		const result = await f.shell.execute("changed", { command: proposed });
		expect(result.isError).toBe(true);
		expect(f.calls).toEqual([]);
		expect(f.kernel.state!.used.execution).toBe(0);
		expect(
			f.kernel.store.records(f.kernel.state!.mission_id).filter((r) => r.record_type === "OperationRecord"),
		).toEqual([]);
	});
	it("executes the original literal once with its actual observation and ledger", async () => {
		const f = fixture();
		const command = "printf '%s' '$HOME'";
		f.start(`run: ${command}`);
		const result = await f.shell.execute("original", { command });
		expect(result.isError).not.toBe(true);
		expect(f.calls).toEqual([command]);
		expect(f.kernel.state!.used.execution).toBe(1);
		const state = f.kernel.state!;
		const operation = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
		expect(operation.status).toBe("CONFIRMED_COMPLETE");
		expect(operation.started_at).not.toBeNull();
	});
	it.each(["Do not execute any more shell commands", "Do not run any more commands"])(
		"respects current user prohibition: %s",
		async (prohibition) => {
			const f = fixture();
			const command = "printf authorized";
			f.start(`run: ${command}`);
			f.kernel.amend(prohibition);
			const result = await f.shell.execute("after-prohibition", { command });
			expect(result.isError).toBe(true);
			expect(f.calls).toEqual([]);
			expect(f.kernel.state!.used.execution).toBe(0);
		},
	);
	it.skipIf(process.platform !== "win32")("dispatches the reviewed native PowerShell transport once", async () => {
		const f = fixture();
		const command = "Set-Content -LiteralPath 'effect.txt' -Value 'native-effect'; Write-Output 'native-output'";
		const tool = f.kernel.register(createPowerShellTool(f.cwd), "powershell");
		f.start(`run: ${command}`);
		const result = await tool.execute("native-powershell", { command });
		expect(result.isError).not.toBe(true);
		expect(existsSync(join(f.cwd, "effect.txt"))).toBe(true);
		expect(readFileSync(join(f.cwd, "effect.txt"), "utf8").trim()).toBe("native-effect");
		expect(result.content).toEqual(
			expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("native-output") })]),
		);
		const state = f.kernel.state!;
		expect(state.used.execution).toBe(1);
		const operation = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
		expect(operation.status).toBe("CONFIRMED_COMPLETE");
		expect(operation.started_at).not.toBeNull();
		const starts = f.store
			.records(state.mission_id)
			.filter(
				(record) =>
					record.record_type === "EvidenceRecord" &&
					record.stage === "execution-handle" &&
					record.payload !== null &&
					typeof record.payload === "object" &&
					"phase" in record.payload &&
					record.payload.phase === "STARTED",
			);
		expect(starts).toHaveLength(1);
	});
});
