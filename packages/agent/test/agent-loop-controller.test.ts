import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@anvaya.sh/padma-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import type { AgentLoopController } from "../src/agent-loop.ts";
import type { AgentMessage, AgentTool, StreamFn } from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(message: AssistantMessage) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
		queueMicrotask(() =>
			this.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message }),
		);
	}
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

describe("Agent loop controller port", () => {
	it("replaces the stock loop while reusing provider streaming and validated tool dispatch", async () => {
		const schema = Type.Object({});
		let toolExecutions = 0;
		const tool: AgentTool<typeof schema> = {
			name: "inspect",
			label: "Inspect",
			description: "Return a harmless fixture result",
			parameters: schema,
			execute: async () => {
				toolExecutions++;
				return { content: [{ type: "text", text: "fixture result" }], details: {} };
			},
		};
		let modelRequests = 0;
		const streamFn: StreamFn = () => {
			modelRequests++;
			return new MockAssistantStream(
				modelRequests === 1
					? assistantMessage([{ type: "toolCall", id: "call-1", name: "inspect", arguments: {} }], "toolUse")
					: assistantMessage([{ type: "text", text: "done" }], "stop"),
			);
		};
		const controllerCalls: string[] = [];
		const controller: AgentLoopController = {
			async run(request, context, config, emit, signal, ports) {
				controllerCalls.push(request.type);
				const emittedMessages: AgentMessage[] = [];
				await emit({ type: "agent_start" });
				await emit({ type: "turn_start" });

				if (request.type === "prompt") {
					for (const message of ports.declareToolChanges(context, request.messages)) {
						context.messages.push(message);
						emittedMessages.push(message);
						await emit({ type: "message_start", message });
						await emit({ type: "message_end", message });
					}
				}

				while (true) {
					const response = await ports.requestAssistantResponse(context, config, signal, emit);
					emittedMessages.push(response);
					const toolCalls = response.content.filter((block) => block.type === "toolCall");
					if (toolCalls.length === 0) {
						await emit({ type: "turn_end", message: response, toolResults: [] });
						break;
					}

					const result = await ports.executeToolCalls(context, response, config, signal, emit);
					context.messages.push(...result.messages);
					emittedMessages.push(...result.messages);
					await emit({ type: "turn_end", message: response, toolResults: result.messages });
					if (result.terminate) break;
					await emit({ type: "turn_start" });
				}

				await emit({ type: "agent_end", messages: emittedMessages });
				return emittedMessages;
			},
		};
		const model: Model<"openai-responses"> = {
			id: "gpt-4o-mini",
			name: "gpt-4o-mini",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		};
		const agent = new Agent({
			initialState: { model, tools: [tool] },
			streamFn,
			loopController: controller,
		});
		const observedEvents: string[] = [];
		agent.subscribe((event) => {
			observedEvents.push(event.type);
		});

		await agent.prompt("inspect safely");

		expect(controllerCalls).toEqual(["prompt"]);
		expect(modelRequests).toBe(2);
		expect(toolExecutions).toBe(1);
		expect(agent.state.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(observedEvents).toContain("tool_execution_start");
		expect(observedEvents).toContain("tool_execution_end");
		expect(observedEvents.at(-1)).toBe("agent_end");
	});
});
