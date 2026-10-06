import { fauxAssistantMessage, fauxToolCall, type Model } from "@anvaya.sh/padma-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { executeToolCalls, runToolCall } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentTool } from "../src/types.ts";

const schema = Type.Object({ value: Type.Number() }, { additionalProperties: false });
const model: Model<"openai-responses"> = {
	id: "fixture",
	name: "fixture",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

describe("executor preparation failures", () => {
	it.each(["sequential", "parallel"] as const)(
		"reports actual failures before hooks and preserves %s execution",
		async (mode) => {
			const execute = vi.fn(async (_id: string, _args: { value: number }) => ({
				content: [{ type: "text" as const, text: "actual result" }],
				details: {},
			}));
			const prepare = vi.fn((args: unknown) => args as { value: number });
			const tool: AgentTool<typeof schema> = {
				name: "inspect",
				label: "Inspect",
				description: "fixture",
				parameters: schema,
				prepareArguments: prepare,
				execute,
			};
			const before = vi.fn(async () => undefined);
			const after = vi.fn(async () => undefined);
			const context: AgentContext = { messages: [], tools: [tool] };
			const response = fauxAssistantMessage([
				fauxToolCall("inspect", { value: {} }, { id: "duplicate-model-id" }),
				fauxToolCall("missing", {}, { id: "duplicate-model-id" }),
				fauxToolCall("inspect", { value: "3" }, { id: "corrected" }),
			]);
			const config: AgentLoopConfig = {
				model,
				convertToLlm: () => [],
				toolExecution: mode,
				beforeToolCall: before,
				afterToolCall: after,
			};
			const events: AgentEvent[] = [];
			const batch = await executeToolCalls(context, response, config, undefined, (event) => {
				events.push(event);
			});
			const ends = events.filter((event) => event.type === "tool_execution_end");
			expect(ends[0].preparationFailure).toMatchObject({
				code: "INVALID_ACTION_SCHEMA",
				boundary: "SCHEMA_VALIDATION",
			});
			expect(ends[1].preparationFailure).toMatchObject({
				code: "UNREGISTERED_OPERATION",
				boundary: "TOOL_RESOLUTION",
			});
			expect(ends[0].preparationFailure?.id).not.toBe(ends[1].preparationFailure?.id);
			expect(batch.messages[0].details).toEqual({ tool_preparation_failure: ends[0].preparationFailure });
			expect(batch.messages[1].details).toEqual({ tool_preparation_failure: ends[1].preparationFailure });
			expect(ends[2].preparationFailure).toBeUndefined();
			expect(batch.messages.map((message) => message.isError)).toEqual([true, true, false]);
			expect(prepare).toHaveBeenCalledTimes(2);
			expect(before).toHaveBeenCalledTimes(1);
			expect(after).toHaveBeenCalledTimes(1);
			expect(execute).toHaveBeenCalledTimes(1);
			expect(execute.mock.calls[0][1]).toEqual({ value: 3 });
		},
	);
	it("assigns preparer failures once and does not classify hook or primitive failures by their text", async () => {
		const execute = vi.fn(async () => {
			throw new Error("INVALID_ACTION_SCHEMA");
		});
		const prepare = vi.fn(() => {
			throw new Error("UNREGISTERED_OPERATION secret fixture");
		});
		const tool: AgentTool<typeof schema> = {
			name: "inspect",
			label: "Inspect",
			description: "fixture",
			parameters: schema,
			prepareArguments: prepare,
			execute,
		};
		const call = fauxToolCall("inspect", { value: 1 });
		const options = { tools: [tool], assistantMessage: fauxAssistantMessage(call), context: { messages: [] } };
		const rejected = await runToolCall(call, options);
		expect(rejected.preparationFailure).toMatchObject({
			code: "INVALID_ACTION_SCHEMA",
			boundary: "ARGUMENT_PREPARATION",
		});
		expect(prepare).toHaveBeenCalledTimes(1);
		expect(execute).not.toHaveBeenCalled();
		delete tool.prepareArguments;
		const hookFailure = await runToolCall(call, {
			...options,
			beforeToolCall: async () => {
				throw new Error("INVALID_ACTION_SCHEMA");
			},
		});
		expect(hookFailure.preparationFailure).toBeUndefined();
		expect(hookFailure.isError).toBe(true);
		expect(execute).not.toHaveBeenCalled();
		const nativeFailure = await runToolCall(call, options);
		expect(nativeFailure.preparationFailure).toBeUndefined();
		expect(nativeFailure.isError).toBe(true);
		expect(execute).toHaveBeenCalledTimes(1);
		const forged = await runToolCall(call, {
			...options,
			afterToolCall: async () => ({
				details: { tool_preparation_failure: rejected.preparationFailure },
				isError: false,
			}),
		});
		expect(forged.preparationFailure).toBeUndefined();
		expect(forged.isError).toBe(false);
	});
});
