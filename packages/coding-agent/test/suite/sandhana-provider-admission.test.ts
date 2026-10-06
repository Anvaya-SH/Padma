import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@anvaya.sh/padma-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextAnswer } from "../../src/core/sandhana/avartana/contracts.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	while (harnesses.length) harnesses.pop()!.cleanup();
});

describe("final provider transcript admission through the actual session", () => {
	it.each([
		["transform", "input_tokens"],
		["conversion", "input_tokens"],
		["transform", "cost"],
		["conversion", "cost"],
	] as const)(
		"rejects input added by %s against the %s ceiling before consuming a provider response",
		async (boundary, dimension) => {
			const h = await createHarness({
				sandhanaConfiguration: {
					version: "sandhana/1",
					resources: dimension === "input_tokens" ? { input_tokens: 60000 } : { cost: 3 },
				},
				models: [{ id: "priced-admission-fixture", cost: { input: 50, output: 0, cacheRead: 0, cacheWrite: 0 } }],
			});
			harnesses.push(h);
			const agent = h.session.agent;
			const added = { role: "user" as const, content: "x".repeat(80000), timestamp: 0 };
			if (boundary === "transform") agent.transformContext = async (messages) => [...messages, added];
			else {
				const convert = agent.convertToLlm;
				agent.convertToLlm = async (messages) => [...(await convert(messages)), added];
			}
			h.setResponses([fauxAssistantMessage("This response must remain unused")]);
			await h.session.prompt("Inspect the parser behavior");
			const kernel = h.session.sandhana;
			const state = kernel.state!;
			expect(kernel.terminal?.status, h.session.getLastAssistantText()).toBe("BUDGET_EXHAUSTED");
			expect(state.used).toMatchObject({ ticks: 0, input_tokens: 0, output_tokens: 0, cost: 0 });
			expect(
				state.reservations
					.map((ref) => kernel.store.get(state.mission_id, ref, "BudgetReservation"))
					.filter((record) => record.owner_operation_id.startsWith("model:")),
			).toHaveLength(0);
			expect(h.faux.state.callCount).toBe(0);
			expect(h.getPendingResponseCount()).toBe(1);
			expect(
				kernel.terminal!.failure_refs!.map(
					(ref) => kernel.store.get(state.mission_id, ref, "EvidenceRecord").failure?.code,
				),
			).toContain("BUDGET_REJECTED");
		},
	);
	it.each(["transform", "conversion"] as const)(
		"rejects %s input that exceeds the selected model context window",
		async (boundary) => {
			const h = await createHarness();
			harnesses.push(h);
			const agent = h.session.agent;
			const added = { role: "user" as const, content: "x".repeat(140000), timestamp: 0 };
			if (boundary === "transform") agent.transformContext = async (messages) => [...messages, added];
			else {
				const convert = agent.convertToLlm;
				agent.convertToLlm = async (messages) => [...(await convert(messages)), added];
			}
			h.setResponses([fauxAssistantMessage("This response must remain unused")]);
			await h.session.prompt("Inspect the parser behavior");
			expect(h.session.sandhana.terminal?.status, h.session.getLastAssistantText()).toBe("BUDGET_EXHAUSTED");
			expect(h.session.sandhana.state!.used.ticks).toBe(0);
			expect(h.getPendingResponseCount()).toBe(1);
		},
	);
	it("reserves the final normalized transcript and invokes preparation hooks once", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const agent = h.session.agent;
		const transform = agent.transformContext;
		const convert = agent.convertToLlm;
		const getApiKey = agent.getApiKey;
		let transforms = 0;
		let conversions = 0;
		let credentials = 0;
		agent.transformContext = async (messages, signal) => {
			transforms++;
			return transform ? transform(messages, signal) : messages;
		};
		agent.convertToLlm = async (messages) => {
			conversions++;
			return [...(await convert(messages)), { role: "user", content: "Final converted input", timestamp: 0 }];
		};
		agent.getApiKey = async (provider) => {
			credentials++;
			return getApiKey?.(provider);
		};
		let measured = 0;
		h.setResponses([
			(context, options) => {
				const kernel = h.session.sandhana;
				const state = kernel.state!;
				const reservation = state.reservations
					.map((ref) => kernel.store.get(state.mission_id, ref, "BudgetReservation"))
					.find((record) => record.owner_operation_id.startsWith("model:"));
				measured = Buffer.byteLength(JSON.stringify(context)) + kernel.configuration.model.input_overhead_bytes;
				expect(reservation?.amounts.input_tokens).toBe(measured);
				expect(reservation?.amounts.output_tokens).toBe(options?.maxTokens);
				expect(options?.apiKey).toBe("faux-key");
				return fauxAssistantMessage("Observed available input");
			},
		]);
		await h.session.prompt("Inspect the parser behavior");
		expect(h.session.sandhana.terminal?.status, h.session.getLastAssistantText()).toBe("PARTIALLY_COMPLETE");
		expect(measured).toBeGreaterThan(0);
		expect({ transforms, conversions, credentials }).toEqual({ transforms: 1, conversions: 1, credentials: 1 });
		expect(h.session.sandhana.state!.used).toMatchObject({ ticks: 1, cost: 0 });
		expect(h.session.sandhana.state!.used.input_tokens).toBeGreaterThan(0);
	});
	it("isolates the admitted transcript from later mutations to the converter result", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const agent = h.session.agent;
		const convert = agent.convertToLlm;
		let retained: Message[] = [];
		agent.convertToLlm = async (messages) => {
			retained = await convert(messages);
			return retained;
		};
		const kernel = h.session.sandhana;
		const begin = kernel.beginCognitiveTick.bind(kernel);
		vi.spyOn(kernel, "beginCognitiveTick").mockImplementation((ref) => {
			begin(ref);
			retained.push({ role: "user", content: `late_converter_mutation ${"x".repeat(80000)}`, timestamp: 0 });
		});
		h.setResponses([
			(context) => {
				expect(JSON.stringify(context)).not.toContain("late_converter_mutation");
				return fauxAssistantMessage("Original admitted input only");
			},
		]);
		await h.session.prompt("Inspect the parser behavior");
		expect(kernel.terminal?.status, h.session.getLastAssistantText()).toBe("PARTIALLY_COMPLETE");
		expect(h.faux.state.callCount).toBe(1);
	});
	it.each(["conversion failure", "cancellation"] as const)(
		"keeps source reads and main usage measurable after leaf %s before launch",
		async (boundary) => {
			const h = await createHarness();
			harnesses.push(h);
			writeFileSync(join(h.tempDir, "config.txt"), "mode: strict\n");
			const agent = h.session.agent;
			const convert = agent.convertToLlm;
			agent.convertToLlm = (messages) => {
				if (
					messages.some(
						(message) =>
							message.role === "system" &&
							typeof message.content === "string" &&
							message.content.startsWith("Read-only evidence analysis."),
					)
				) {
					if (boundary === "cancellation") agent.abort();
					throw new Error("Fixture leaf conversion failed");
				}
				return convert(messages);
			};
			const source = { family: "filesystem_text", locator: "config.txt" };
			h.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("avartana", {
							question: "Interpret the mode setting",
							sources: [source],
							limits: { contextTokens: 16000 },
							plan: {
								version: "AVARTANA_PLAN/1",
								nodes: [
									{ id: "read", op: "read_range", source, inputs: [] },
									{ id: "leaf", op: "analyse", inputs: ["read"], question: "Interpret the mode" },
									{ id: "return", op: "return", inputs: ["leaf"] },
								],
							},
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Available source, no leaf interpretation"),
			]);
			await h.session.prompt("Inspect config.txt");
			const kernel = h.session.sandhana;
			expect(kernel.terminal?.status, h.session.getLastAssistantText()).toBe(
				boundary === "cancellation" ? "BLOCKED" : "PARTIALLY_COMPLETE",
			);
			expect(kernel.state!.used).toMatchObject({
				ticks: boundary === "cancellation" ? 1 : 2,
				execution: 1,
				cost: 0,
			});
			expect(kernel.state!.used.input_tokens).toBeGreaterThan(0);
			expect(kernel.state!.used.output_tokens).toBeGreaterThan(0);
			expect(h.faux.state.callCount).toBe(boundary === "cancellation" ? 1 : 2);
			expect(h.getPendingResponseCount()).toBe(boundary === "cancellation" ? 1 : 0);
			const answer = JSON.parse(getMessageText(getToolResult(h, "avartana"))) as ContextAnswer;
			expect(answer.limitations).toContainEqual(
				expect.objectContaining({ code: boundary === "cancellation" ? "CANCELLED" : "PROVIDER_FAILURE" }),
			);
			if (boundary !== "cancellation")
				expect(answer.snippets.map((snippet) => snippet.text).join("\n")).toContain("mode: strict");
			expect(
				kernel.store
					.records(kernel.state!.mission_id)
					.filter(
						(record) => record.record_type === "EvidenceRecord" && record.source === "AVARTANA_DERIVATION/1",
					),
			).toHaveLength(0);
		},
	);
	it.each(["transform", "conversion", "credentials"] as const)(
		"retains a %s failure without inventing unknown provider usage",
		async (boundary) => {
			const h = await createHarness();
			harnesses.push(h);
			const agent = h.session.agent;
			const fail = () => {
				throw new Error(`Fixture ${boundary} preparation failed`);
			};
			if (boundary === "transform") agent.transformContext = async () => fail();
			else if (boundary === "conversion") agent.convertToLlm = fail;
			else agent.getApiKey = fail;
			h.setResponses([fauxAssistantMessage("This response must remain unused")]);
			await h.session.prompt("Inspect the parser behavior");
			const kernel = h.session.sandhana;
			const state = kernel.state!;
			expect(kernel.terminal?.status, h.session.getLastAssistantText()).toBe("EXECUTION_FAILED");
			expect(state.used).toMatchObject({ ticks: 0, input_tokens: 0, output_tokens: 0, cost: 0 });
			expect(
				kernel.terminal!.failure_refs!.map(
					(ref) => kernel.store.get(state.mission_id, ref, "EvidenceRecord").failure?.code,
				),
			).toContain("PROVIDER_FAILURE");
			expect(h.faux.state.callCount).toBe(0);
			expect(h.getPendingResponseCount()).toBe(1);
			expect(h.eventsOfType("agent_end")).toHaveLength(1);
		},
	);
	it("honors cancellation during preparation without reserving a model request", async () => {
		const h = await createHarness();
		harnesses.push(h);
		h.session.agent.getApiKey = () => {
			h.session.agent.abort();
			return "faux-key";
		};
		h.setResponses([fauxAssistantMessage("This response must remain unused")]);
		await h.session.prompt("Inspect the parser behavior");
		expect(h.session.sandhana.terminal?.status, h.session.getLastAssistantText()).toBe("BLOCKED");
		expect(h.session.sandhana.state!.used).toMatchObject({ ticks: 0, input_tokens: 0, output_tokens: 0, cost: 0 });
		expect(h.getPendingResponseCount()).toBe(1);
		expect(h.faux.state.callCount).toBe(0);
	});
	it.each(["input", "output", "identity", "hook failure"] as const)(
		"settles known zero inference after a late %s payload rejection",
		async (change) => {
			const h = await createHarness();
			harnesses.push(h);
			h.session.agent.onPayload = (payload) => {
				if (change === "hook failure") throw new Error("Fixture hook failed");
				const value = payload as Record<string, unknown>;
				if (change === "input") value.messages = "x".repeat(120000);
				if (change === "output") value.max_tokens = 90000;
				if (change === "identity") value.model = "unadmitted-model";
				return value;
			};
			let sent = false;
			h.setResponses([
				async (context, options, _state, model) => {
					await options?.onPayload?.(
						{ model: model.id, messages: context.messages, max_tokens: options?.maxTokens },
						model,
					);
					sent = true;
					return fauxAssistantMessage("must not be sent");
				},
			]);
			await h.session.prompt("Inspect the parser behavior");
			const kernel = h.session.sandhana;
			expect(sent).toBe(false);
			expect(kernel.terminal?.status).toBe(change === "hook failure" ? "EXECUTION_FAILED" : "BUDGET_EXHAUSTED");
			expect(kernel.state!.used).toMatchObject({
				ticks: 1,
				execution: 0,
				input_tokens: 0,
				output_tokens: 0,
				cost: 0,
			});
			expect(
				kernel
					.state!.reservations.map((ref) => kernel.store.get(kernel.state!.mission_id, ref, "BudgetReservation"))
					.filter((record) => record.owner_operation_id.startsWith("model:")),
			).toMatchObject([{ state: "RECONCILED", actual: { input_tokens: 0, output_tokens: 0, cost: 0 } }]);
		},
	);
	it("caps native thinking expansion and isolates an allowed payload hook", async () => {
		const h = await createHarness();
		harnesses.push(h);
		let retained: Record<string, unknown> | undefined;
		h.session.agent.onPayload = (payload) => {
			retained = payload as Record<string, unknown>;
			retained.temperature = 0.1;
			return retained;
		};
		h.setResponses([
			async (context, options, _state, model) => {
				const payload = await options?.onPayload?.(
					{
						model: model.id,
						messages: context.messages,
						max_tokens: 16000,
						thinking: { type: "enabled", budget_tokens: 12000 },
					},
					model,
				);
				expect(payload).toMatchObject({
					max_tokens: options?.maxTokens,
					temperature: 0.1,
					thinking: { budget_tokens: options!.maxTokens! - 1024 },
				});
				retained!.max_tokens = 90000;
				expect(payload).toMatchObject({ max_tokens: options?.maxTokens });
				return fauxAssistantMessage("bounded native request");
			},
		]);
		await h.session.prompt("Inspect the parser behavior");
		expect(h.session.sandhana.terminal?.status).toBe("PARTIALLY_COMPLETE");
		expect(h.faux.state.callCount).toBe(1);
	});
	it("rejects unadmitted model sampling overrides before reserving or requesting inference", async () => {
		const h = await createHarness();
		harnesses.push(h);
		h.session.agent.state.model = { ...h.session.model!, samplingParams: { max_tokens: 90000 } };
		h.setResponses([fauxAssistantMessage("must remain unused")]);
		await h.session.prompt("Inspect the parser behavior");
		expect(h.session.sandhana.terminal?.status).toBe("BUDGET_EXHAUSTED");
		expect(h.session.sandhana.state!.used.ticks).toBe(0);
		expect(h.faux.state.callCount).toBe(0);
		expect(h.getPendingResponseCount()).toBe(1);
	});
	it("isolates provider identity, pricing and sampling from preparation and payload hook mutations", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const selected = h.session.agent.state.model;
		const identity = selected.id;
		const convert = h.session.agent.convertToLlm;
		h.session.agent.convertToLlm = async (messages) => {
			const result = await convert(messages);
			selected.id = "late-unadmitted-model";
			selected.cost.input = 90000;
			selected.samplingParams = { max_tokens: 90000 };
			return result;
		};
		h.session.agent.onPayload = (payload, model) => {
			model.id = "hook-unadmitted-model";
			model.cost.output = 90000;
			return payload;
		};
		h.setResponses([
			async (context, options, _state, model) => {
				expect(model.id).toBe(identity);
				expect(model.samplingParams).toBeUndefined();
				expect(model.cost.input).toBe(0);
				await options?.onPayload?.(
					{ model: model.id, messages: context.messages, max_tokens: options.maxTokens },
					model,
				);
				expect(model.id).toBe(identity);
				expect(model.cost.output).toBe(0);
				return fauxAssistantMessage("captured provider configuration");
			},
		]);
		await h.session.prompt("Inspect the parser behavior");
		expect(h.session.sandhana.terminal?.status, h.session.getLastAssistantText()).toBe("PARTIALLY_COMPLETE");
		expect(h.faux.state.callCount).toBe(1);
		expect(h.session.sandhana.state!.used.cost).toBe(0);
	});
	it("settles known zero inference when cognitive admission fails before the provider port", async () => {
		const h = await createHarness();
		harnesses.push(h);
		vi.spyOn(h.session.sandhana, "beginCognitiveTick").mockImplementation(() => {
			throw new Error("Fixture pre-launch admission failed");
		});
		h.setResponses([fauxAssistantMessage("must remain unused")]);
		await h.session.prompt("Inspect the parser behavior");
		expect(h.session.sandhana.terminal?.status).toBe("EXECUTION_FAILED");
		expect(h.faux.state.callCount).toBe(0);
		expect(h.getPendingResponseCount()).toBe(1);
		expect(h.session.sandhana.state!.used).toMatchObject({ input_tokens: 0, output_tokens: 0, cost: 0 });
	});
});
