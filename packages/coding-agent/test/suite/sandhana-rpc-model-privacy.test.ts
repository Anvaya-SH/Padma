import { fauxAssistantMessage } from "@anvaya.sh/padma-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import type { RpcResponse } from "../../src/modes/rpc/rpc-types.ts";
import { createHarness } from "./harness.ts";

const io = vi.hoisted(() => ({ lines: [] as string[], onLine: undefined as ((line: string) => void) | undefined }));
vi.mock("../../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		io.lines.push(line);
	},
}));
vi.mock("../../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, handler: (line: string) => void) => {
		io.onLine = handler;
		return () => {
			io.onLine = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

describe("native RPC model metadata privacy", () => {
	it("projects credentials on every selection response while preserving actual provider configuration", async () => {
		const h = await createHarness({ models: [{ id: "private-first" }, { id: "private-second" }] });
		const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
		type Listener = Parameters<typeof process.on>[1];
		const stdinListeners = process.stdin.listeners("end") as Listener[];
		const signalListeners = new Map(signals.map((signal) => [signal, process.listeners(signal) as Listener[]]));
		const privateUrl = "https://opaque-user:opaque-password@example.invalid/api?api_key=opaque-query";
		const headers = { Authorization: "opaque-authorization", "X-Api-Key": "opaque-header-key" };
		const samplingParams = {
			temperature: 0.2,
			system: "PRIVATE_SAMPLING_SOURCE",
			nested: { secret: "opaque-sampling" },
		};
		const models = h.session.modelRuntime
			.getAvailableSnapshot()
			.filter((model) => model.provider === h.getModel().provider);
		expect(models).toHaveLength(2);
		for (const model of models) {
			model.baseUrl = privateUrl;
			model.headers = headers;
			model.samplingParams = samplingParams;
		}
		h.session.agent.state.model = models[0];
		h.session.setScopedModels(models.map((model) => ({ model })));
		const runtime = {
			session: h.session,
			setRebindSession: vi.fn(),
			dispose: vi.fn(async () => {}),
		} as unknown as AgentSessionRuntime;
		const privateMessage = fauxAssistantMessage(
			"Authorization: Bearer opaque-bearer-value; refresh_token=opaque-refresh-value",
		);
		h.session.agent.state.messages.push(privateMessage);
		h.sessionManager.appendMessage(privateMessage);
		h.sessionManager.appendCustomEntry("private-extension", {
			headers: { "X-Custom-Credential": "opaque-custom-header" },
			client_secret: "opaque-client-secret",
			nested: { password: "opaque-nested-password" },
		});
		try {
			void runRpcMode(runtime);
			await vi.waitFor(() => expect(io.onLine).toBeDefined());
			for (const [index, command] of [
				{ type: "get_state" },
				{ type: "get_available_models" },
				{ type: "set_model", provider: models[1].provider, modelId: models[1].id },
				{ type: "cycle_model" },
				{ type: "get_messages" },
				{ type: "get_entries" },
				{ type: "get_tree" },
				{ type: "get_last_assistant_text" },
			].entries()) {
				const id = `model-privacy-${index}`;
				io.onLine!(JSON.stringify({ id, ...command }));
				let response: RpcResponse | undefined;
				await vi.waitFor(() => {
					response = io.lines
						.map((line) => JSON.parse(line) as RpcResponse)
						.find((value) => value.type === "response" && value.id === id);
					expect(response).toBeDefined();
				});
				expect(response).toMatchObject({ success: true });
				const wire = JSON.stringify(response);
				for (const secret of [
					"opaque-user",
					"opaque-password",
					"opaque-query",
					"opaque-authorization",
					"opaque-header-key",
					"PRIVATE_SAMPLING_SOURCE",
					"opaque-sampling",
					"opaque-bearer-value",
					"opaque-refresh-value",
					"opaque-custom-header",
					"opaque-client-secret",
					"opaque-nested-password",
				])
					expect(wire, command.type).not.toContain(secret);
				if (["get_state", "get_available_models", "set_model", "cycle_model"].includes(command.type))
					expect(wire).toContain("private-");
			}
			expect(h.session.model?.headers).toEqual(headers);
			expect(h.session.model?.baseUrl).toBe(privateUrl);
			expect(h.session.model?.samplingParams).toEqual(samplingParams);
			expect(privateMessage.content).toEqual(
				fauxAssistantMessage("Authorization: Bearer opaque-bearer-value; refresh_token=opaque-refresh-value")
					.content,
			);
			expect(JSON.stringify(h.sessionManager.getEntries())).toContain("opaque-custom-header");
			expect(h.faux.state.callCount).toBe(0);
			expect(h.session.sandhana.state).toBeNull();
		} finally {
			h.cleanup();
			io.lines = [];
			io.onLine = undefined;
			for (const listener of process.stdin.listeners("end") as Listener[])
				if (!stdinListeners.includes(listener)) process.stdin.off("end", listener);
			for (const signal of signals)
				for (const listener of process.listeners(signal) as Listener[])
					if (!signalListeners.get(signal)!.includes(listener)) process.off(signal, listener);
		}
	});
});
