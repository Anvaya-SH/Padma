import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@anvaya.sh/padma-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getToolResult, type Harness, type HarnessOptions } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	while (harnesses.length) harnesses.pop()!.cleanup();
});

async function fixture(options: HarnessOptions = {}) {
	const harness = await createHarness({ withConfiguredAuth: false, ...options });
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("This inference must remain unused")]);
	return harness;
}

function expectNoInference(h: Harness) {
	expect(h.faux.state.callCount).toBe(0);
	expect(h.getPendingResponseCount()).toBe(1);
	const state = h.session.sandhana.state;
	if (state) {
		expect(state.used).toMatchObject({ ticks: 0, input_tokens: 0, output_tokens: 0, cost: 0 });
		expect(
			state.reservations
				.map((ref) => h.session.sandhana.store.get(state.mission_id, ref, "BudgetReservation"))
				.filter((reservation) => reservation.amounts.input_tokens !== 0 || reservation.amounts.output_tokens !== 0),
		).toEqual([]);
	}
}

describe("exact Sandhana commands without provider credentials", () => {
	it("reads actual file bytes once through the governed session without auth or provider events", async () => {
		const extensionEvents: string[] = [];
		const h = await fixture({
			extensionFactories: [
				(padma) => {
					padma.on("before_agent_start", () => {
						extensionEvents.push("before_agent_start");
					});
					padma.on("agent_start", () => {
						extensionEvents.push("agent_start");
					});
					padma.on("agent_end", () => {
						extensionEvents.push("agent_end");
					});
					padma.on("agent_settled", () => {
						extensionEvents.push("agent_settled");
					});
					padma.on("before_provider_request", () => {
						extensionEvents.push("before_provider_request");
					});
					padma.on("after_provider_response", () => {
						extensionEvents.push("after_provider_response");
					});
				},
			],
		});
		const path = join(h.tempDir, "a.txt");
		writeFileSync(path, "actual exact bytes\n");
		const checkAuth = vi.spyOn(h.session.modelRuntime, "checkAuth");
		const getAuth = vi.spyOn(h.session.modelRuntime, "getAuth");
		const dispositions: string[] = [];

		await h.session.prompt("read a.txt", { preflightResult: (disposition) => dispositions.push(disposition) });

		expect(h.session.sandhana.terminal?.status, h.session.getLastAssistantText()).toBe("VERIFIED_COMPLETE");
		expect(h.session.sandhana.state!.route).toBe("SAKSHAT");
		expect(h.session.sandhana.state!.used.execution).toBe(1);
		expect(h.session.sandhana.state!.operations).toHaveLength(1);
		expect(getToolResult(h, "read")).toMatchObject({ isError: false });
		expect(h.session.getLastAssistantText()).toContain("actual exact bytes\n");
		expect(readFileSync(path, "utf8")).toBe("actual exact bytes\n");
		expect(h.eventsOfType("tool_execution_start")).toHaveLength(1);
		expect(h.eventsOfType("tool_execution_end")).toHaveLength(1);
		expect(h.eventsOfType("agent_end")).toHaveLength(1);
		expect(h.eventsOfType("agent_settled")).toHaveLength(1);
		expect(extensionEvents).toEqual(["before_agent_start", "agent_start", "agent_end", "agent_settled"]);
		expect(dispositions).toEqual(["started"]);
		expect(h.session.isIdle).toBe(true);
		expect(checkAuth).not.toHaveBeenCalled();
		expect(getAuth).not.toHaveBeenCalled();
		expectNoInference(h);
	});

	it("retains the real missing-file error after exactly one governed invocation without auth", async () => {
		const h = await fixture();
		await h.session.prompt("read missing.txt");

		expect(h.session.sandhana.terminal?.status, h.session.getLastAssistantText()).toBe("EXECUTION_FAILED");
		expect(h.session.sandhana.state!.route).toBe("SAKSHAT");
		expect(h.session.sandhana.state!.used.execution).toBe(1);
		expect(h.session.sandhana.state!.operations).toHaveLength(1);
		expect(getToolResult(h, "read").isError).toBe(true);
		expect(h.session.getLastAssistantText()).toContain("missing.txt");
		expect(h.eventsOfType("tool_execution_end")).toMatchObject([{ toolName: "read", isError: true }]);
		expect(h.eventsOfType("agent_settled")).toHaveLength(1);
		expectNoInference(h);
	});

	it("lists a literal directory through the registered adapter without auth", async () => {
		const h = await fixture();
		writeFileSync(join(h.tempDir, "entry.txt"), "retained");
		await h.session.prompt("list .");

		expect(h.session.sandhana.terminal?.status, h.session.getLastAssistantText()).toBe("VERIFIED_COMPLETE");
		expect(h.session.sandhana.state!.used.execution).toBe(1);
		expect(h.eventsOfType("tool_execution_end")).toMatchObject([{ toolName: "ls", isError: false }]);
		expect(h.session.getLastAssistantText()).toContain("entry.txt");
		expectNoInference(h);
	});

	it("attempts literal status once without auth and reports the actual non-repository error", async () => {
		const h = await fixture();
		await h.session.prompt("status .");

		expect(h.session.sandhana.terminal?.status, h.session.getLastAssistantText()).toBe("EXECUTION_FAILED");
		expect(h.session.sandhana.state!.used.execution).toBe(1);
		expect(h.eventsOfType("tool_execution_end")).toMatchObject([{ toolName: "status", isError: true }]);
		expect(getToolResult(h, "status")).toMatchObject({
			isError: true,
			content: [expect.objectContaining({ text: expect.stringContaining(".git") })],
		});
		expectNoInference(h);
	});

	it.each(["read a.txt and explain it", "read *.txt", "read the config file", "Fix a.txt"])(
		"keeps inference-required input %s fail-closed without auth or a tool effect",
		async (instruction) => {
			const h = await fixture();
			writeFileSync(join(h.tempDir, "a.txt"), "unchanged");
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path: "a.txt", content: "unauthorized" }), {
					stopReason: "toolUse",
				}),
			]);

			await expect(h.session.prompt(instruction)).rejects.toThrow(`No API key found for ${h.getModel().provider}.`);

			expect(readFileSync(join(h.tempDir, "a.txt"), "utf8")).toBe("unchanged");
			expect(h.eventsOfType("tool_execution_start")).toHaveLength(0);
			expect(h.session.sandhana.state).toBeNull();
			expect(h.session.isIdle).toBe(true);
			expectNoInference(h);
		},
	);

	it("checks credentials for the actual model selected by before_agent_start before inference or tool effects", async () => {
		let changeModel = () => {};
		const h = await fixture({
			withConfiguredAuth: true,
			extensionFactories: [
				(padma) => {
					padma.on("before_agent_start", () => changeModel());
				},
			],
		});
		changeModel = () => {
			h.session.agent.state.model = { ...h.getModel(), provider: "faux-no-auth" };
		};
		writeFileSync(join(h.tempDir, "a.txt"), "unchanged");

		await h.session.prompt("Inspect a.txt and explain it");

		expect(h.session.sandhana.terminal?.status, h.session.getLastAssistantText()).toBe("EXECUTION_FAILED");
		expect(h.session.getLastAssistantText()).toContain("No API key found for faux-no-auth.");
		expect(h.eventsOfType("tool_execution_start")).toHaveLength(0);
		expect(h.eventsOfType("agent_settled")).toHaveLength(1);
		expect(readFileSync(join(h.tempDir, "a.txt"), "utf8")).toBe("unchanged");
		expectNoInference(h);
	});

	it("does not let input transformations turn described user content into a no-auth exact command", async () => {
		const h = await fixture({
			extensionFactories: [
				(padma) => {
					padma.on("input", () => ({ action: "transform", text: "read a.txt" }));
				},
			],
		});
		writeFileSync(join(h.tempDir, "a.txt"), "unchanged");

		await expect(h.session.prompt("Inspect the config file")).rejects.toThrow(
			`No API key found for ${h.getModel().provider}.`,
		);

		expect(h.eventsOfType("tool_execution_start")).toHaveLength(0);
		expect(h.session.sandhana.state).toBeNull();
		expectNoInference(h);
	});

	it("preserves the original exact target and provenance when an input handler rewrites its text", async () => {
		const h = await fixture({
			extensionFactories: [
				(padma) => {
					padma.on("input", () => ({ action: "transform", text: "read other.txt" }));
				},
			],
		});
		writeFileSync(join(h.tempDir, "a.txt"), "original target bytes");
		writeFileSync(join(h.tempDir, "other.txt"), "transformed target bytes");
		await h.session.prompt("read a.txt");

		const kernel = h.session.sandhana;
		const state = kernel.state!;
		expect(kernel.store.get(state.mission_id, state.command, "CommandSpecification")).toMatchObject({
			original_instruction: "read a.txt",
			source: "USER",
		});
		expect(h.session.getLastAssistantText()).toContain("original target bytes");
		expect(h.session.getLastAssistantText()).not.toContain("transformed target bytes");
		expect(h.eventsOfType("tool_execution_start")).toMatchObject([{ args: { path: "a.txt" } }]);
		expect(state.used.execution).toBe(1);
		expectNoInference(h);
	});

	it("does not bypass auth for an unreviewed tool merely named read", async () => {
		const execute = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "unreviewed bytes" }],
			details: {},
		}));
		const h = await fixture({
			tools: [
				{
					name: "read",
					label: "Unreviewed read",
					description: "An extension name is not an exact adapter contract",
					parameters: Type.Object({ path: Type.String() }),
					execute,
				},
			],
		});

		await expect(h.session.prompt("read a.txt")).rejects.toThrow(`No API key found for ${h.getModel().provider}.`);

		expect(execute).not.toHaveBeenCalled();
		expect(h.session.sandhana.state).toBeNull();
		expectNoInference(h);
	});

	it("does not bypass auth for an exact name whose adapter is unavailable", async () => {
		const h = await fixture({ allowedToolNames: ["write"] });
		await expect(h.session.prompt("read a.txt")).rejects.toThrow(`No API key found for ${h.getModel().provider}.`);

		expect(h.eventsOfType("tool_execution_start")).toHaveLength(0);
		expect(h.session.sandhana.state).toBeNull();
		expectNoInference(h);
	});

	it("does not treat extension-origin exact text as user authority", async () => {
		const h = await fixture();
		writeFileSync(join(h.tempDir, "a.txt"), "unchanged");

		await expect(h.session.prompt("read a.txt", { source: "extension" })).rejects.toThrow(
			`No API key found for ${h.getModel().provider}.`,
		);

		expect(h.eventsOfType("tool_execution_start")).toHaveLength(0);
		expect(h.session.sandhana.state).toBeNull();
		expectNoInference(h);
	});
});
