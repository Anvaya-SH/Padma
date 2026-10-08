import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@anvaya.sh/padma-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()!.cleanup();
});
describe("Sandhana background work through the Pi session", () => {
	it("delivers completion that races with a wait decision and lets the model retrieve output before answering", async () => {
		const h = await createHarness();
		harnesses.push(h);
		writeFileSync(
			join(h.tempDir, "worker.cjs"),
			"console.log('started'); setTimeout(() => console.log('finished'), 100);",
		);
		const answer = "The worker printed started and finished, and exited with code 0.";
		h.setResponses([
			fauxAssistantMessage(
				fauxToolCall("sandhana_operation", {
					action: "submit",
					tool: "bash",
					arguments: { command: "node worker.cjs" },
				}),
				{ stopReason: "toolUse" },
			),
			async () => {
				const operations = h.session.sandhana.operations;
				while (operations.hasPending())
					await operations.wait(operations.eventSequence, new AbortController().signal);
				return fauxAssistantMessage("");
			},
			(context) => {
				const job = h.session.sandhana.operations.list()[0];
				expect(getCurrentSystemPrompt(context.messages)).toContain(job.effect.result_refs[0]);
				return fauxAssistantMessage(
					fauxToolCall("sandhana_operation", {
						action: "output",
						id: job.schedule.operation_id,
					}),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("finished");
				return fauxAssistantMessage(answer);
			},
		]);
		await h.session.prompt(
			'padma: {"objective":"run the worker in the background and report its output","shell_commands":["node worker.cjs"],"requirements":[{"text":"worker succeeds","rule":"PROCESS","target":".","expected":"node worker.cjs"}]}',
		);
		expect(h.session.sandhana.terminal?.status).toBe("VERIFIED_COMPLETE");
		expect(h.session.getLastAssistantText()).toBe(`${answer}\nCompleted and verified.`);
		expect(h.session.sandhana.operations.list()).toHaveLength(1);
		expect(h.session.sandhana.state!.used.execution).toBe(3);
		expect(h.faux.state.callCount).toBe(4);
		expect(h.getPendingResponseCount()).toBe(0);
	});
	it("launches governed shell work, waits on events, and reports actual completion without polling inference", async () => {
		const h = await createHarness({
			sandhanaConfiguration: { version: "sandhana/1", artifact: { max_bytes: 65536 } },
		});
		harnesses.push(h);
		writeFileSync(
			join(h.tempDir, "check.cjs"),
			"console.log('started'); setTimeout(() => console.log('finished'), 100);",
		);
		h.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("sandhana_operation", {
						action: "submit",
						tool: "bash",
						arguments: { command: "node check.cjs" },
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Wait for the actual check result"),
			fauxAssistantMessage("Submit the observed result"),
		]);
		await h.session.prompt(
			'padma: {"objective":"run the exact check","shell_commands":["node check.cjs"],"requirements":[{"text":"check succeeds","rule":"PROCESS","target":".","expected":"node check.cjs"}]}',
		);
		const kernel = h.session.sandhana;
		expect(
			kernel.operations.list(),
			JSON.stringify({
				terminal: kernel.terminal,
				results: h.session.messages.filter((message) => message.role === "toolResult"),
			}),
		).toHaveLength(1);
		const job = kernel.operations.list()[0];
		expect(job.schedule.status).toBe("COMPLETED");
		expect(job.effect.status).toBe("CONFIRMED_COMPLETE");
		expect(kernel.terminal?.status, JSON.stringify(kernel.terminal)).toBe("VERIFIED_COMPLETE");
		expect(kernel.state!.used.execution).toBe(2); // one control submission and one actual primitive
		expect(kernel.state!.used.ticks).toBeLessThanOrEqual(3);
		expect(kernel.store.list(h.sessionManager.getSessionId())).toHaveLength(1);
		expect(job.schedule.execution_refs).toHaveLength(2);
		const native = job.schedule.execution_refs!.map(
			(ref) => kernel.store.get(job.effect.mission_id, ref, "EvidenceRecord").payload,
		);
		expect(native).toMatchObject([
			{ phase: "STARTED", supervisor: "NODE_CHILD_PROCESS" },
			{ phase: "EXITED", exit_code: 0 },
		]);
		expect(
			h
				.eventsOfType("tool_execution_update")
				.some((event) => event.toolCallId === `operation:${job.schedule.operation_id}`),
		).toBe(true);
		const progress = h.eventsOfType("tool_execution_update").filter((event) => {
			const details: unknown = event.partialResult.details;
			return details && typeof details === "object" && "scheduling_state" in details;
		});
		expect(progress.length).toBeGreaterThan(0);
		for (const event of progress) {
			expect(JSON.stringify(event.partialResult.content)).not.toMatch(/RUNNING|DISPATCHED|DIRGHAKRIYA|Kshepana/);
			expect(JSON.stringify(event.partialResult.content)).not.toContain(job.schedule.operation_id);
		}
	});
});
