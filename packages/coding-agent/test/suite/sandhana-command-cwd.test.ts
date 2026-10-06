import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@anvaya.sh/padma-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

// User command/cwd pair must survive the actual session/faux-provider seam.
describe("session shell command/cwd authority", () => {
	it("executes exact command in a disposable child with actual native cwd and PROCESS proof", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const child = join(h.tempDir, "Onedrive", "Desktop", "Padma");
		mkdirSync(child, { recursive: true });
		const command = 'node -p "process.cwd()"';
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command, cwd: child })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Submit observed cwd"),
		]);
		await h.session.prompt(
			`run the command ${command} in the dir ${process.platform === "win32" ? "Onedrive\\Desktop\\Padma" : "Onedrive/Desktop/Padma"}`,
		);
		const kernel = h.session.sandhana;
		expect(kernel.terminal?.status).toBe("VERIFIED_COMPLETE");
		expect(kernel.state!.used.execution).toBe(1);
		const state = kernel.state!;
		const req = kernel.store.get(state.mission_id, state.requirements[0], "Requirement");
		expect(req).toMatchObject({
			rule: "PROCESS",
			expected: command,
			target: realpathSync(child),
			status: "VERIFIED",
		});
		const action = kernel.store.get(
			state.mission_id,
			kernel.store.get(state.mission_id, state.operations[0], "OperationRecord").prepared_ref,
			"PreparedAction",
		);
		expect(action.arguments).toMatchObject({ command, cwd: realpathSync(child) });
		const output = h.eventsOfType("tool_execution_end")[0].result;
		expect(output.content).toEqual(
			expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(child) })]),
		);
		expect(h.faux.state.callCount).toBeGreaterThan(0);
	});
	it("refuses a model-generated cd wrapper without executing any fixture project code", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const child = join(h.tempDir, "Onedrive", "Desktop", "Padma");
		mkdirSync(child, { recursive: true });
		writeFileSync(
			join(child, "package.json"),
			JSON.stringify({ scripts: { check: "node deliberately-not-created.cjs" } }),
		);
		h.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("bash", { command: "cd /c/Users/Hp/Onedrive/Desktop/Padma && npm run check", cwd: child })],
				{ stopReason: "toolUse" },
			),
		]);
		await h.session.prompt("run the command npm run check in the dir Onedrive/Desktop/Padma");
		expect(h.session.sandhana.state!.used.execution).toBe(0);
		expect(h.session.sandhana.terminal?.verified).toEqual([]);
		expect(h.eventsOfType("tool_execution_end")[0].isError).toBe(true);
	});
});
