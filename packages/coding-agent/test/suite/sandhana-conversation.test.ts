import { fauxAssistantMessage, fauxToolCall } from "@anvaya.sh/padma-ai";
import { afterEach, expect, test } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

test("an unclear conversational prompt keeps its clarification and persists the incomplete verification", async () => {
	const harness = await createHarness();
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("Could you clarify what you’d like me to do?")]);
	await harness.session.prompt("asdgasdfsdfdsf");
	expect(harness.session.getLastAssistantText()).toBe("Could you clarify what you’d like me to do?");
	expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
	const report = harness.session.sandhana.terminal!;
	expect(report.status).toBe("PARTIALLY_COMPLETE");
	expect(report.verified).toHaveLength(0);
	expect(report.remaining).toHaveLength(1);
	expect(harness.session.sandhana.store.get(report.mission_id, report.record_id, "TerminalReport")).toEqual(report);
});

test("ordinary questions retain the model answer without claiming verified completion", async () => {
	const harness = await createHarness();
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("Padma means lotus.")]);
	await harness.session.prompt("What does Padma mean?");
	expect(harness.session.getLastAssistantText()).toBe("Padma means lotus.");
	expect(harness.session.sandhana.terminal?.status).toBe("PARTIALLY_COMPLETE");
	expect(harness.session.sandhana.state?.used.execution).toBe(0);
});

test("a requested implementation still surfaces missing verification", async () => {
	const harness = await createHarness();
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("Done.")]);
	await harness.session.prompt("Implement a new parser");
	expect(harness.session.getLastAssistantText()).toContain("PARTIALLY_COMPLETE");
	expect(harness.session.sandhana.terminal?.verified).toHaveLength(0);
});

test("a rejected tool attempt is never treated as a conversational answer", async () => {
	const harness = await createHarness();
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "unauthorized" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Could you clarify?"),
	]);
	await harness.session.prompt("What is here?");
	expect(harness.session.getLastAssistantText()).not.toBe("Could you clarify?");
	expect(harness.session.sandhana.terminal?.verified).toHaveLength(0);
});
