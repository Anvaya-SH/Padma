import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createBashTool } from "../src/core/tools/bash.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("Phase 2 process evidence", () => {
	it("retains separate native stdout and stderr, the command, exit and current sources", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "padma-streams-"));
		const store = new MissionStore(":memory:");
		cleanups.push(() => {
			store.close();
			rmSync(cwd, { recursive: true, force: true });
		});
		writeFileSync(
			join(cwd, "check.cjs"),
			"process.stdout.write('actual stdout'); process.stderr.write('actual stderr');",
		);
		const native = await createBashTool(cwd).execute("native-check", { command: "node check.cjs" });
		expect(native.structuredContent).toMatchObject({
			stdout: "actual stdout",
			stderr: "actual stderr",
			streams_truncated: false,
			exit_code: 0,
			output_complete: true,
		});
		const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "streams", store });
		kernel.register(createBashTool(cwd), "bash");
		kernel.captureInput("run: node check.cjs", "USER");
		kernel.begin("");
		await kernel.execute("bash", "governed-check", { command: "node check.cjs" });
		const state = kernel.state!;
		const operation = store.get(state.mission_id, state.operations[0], "OperationRecord");
		const action = store.get(state.mission_id, operation.prepared_ref, "PreparedAction");
		expect(action.arguments).toMatchObject({ command: "node check.cjs" });
		const observation = store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
		const retained: unknown = JSON.parse(store.artifact(state.mission_id, observation.artifact_ref!).toString());
		expect(retained).toMatchObject({
			structuredContent: {
				stdout: "actual stdout",
				stderr: "actual stderr",
				streams_truncated: false,
				exit_code: 0,
				output_complete: true,
			},
		});
		expect(observation.payload).toMatchObject({ dependencies_unchanged: true });
		expect(state.used.execution).toBe(1);
		expect(kernel.finalize().status).toBe("VERIFIED_COMPLETE");
	});
	it("keeps unidentified delegated output combined without inventing stream attribution", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "padma-delegated-stream-"));
		cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
		const tool = createBashTool(cwd, {
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("unattributed output"));
					return { exitCode: 1, outputComplete: true };
				},
			},
		});
		const result = await tool.execute("delegated", { command: "adapter-fixture" });
		expect(result.structuredContent).toMatchObject({ output: "unattributed output", exit_code: 1 });
		expect(result.structuredContent).not.toHaveProperty("stdout");
		expect(result.structuredContent).not.toHaveProperty("stderr");
		expect(result.isError).toBe(true);
	});
});
