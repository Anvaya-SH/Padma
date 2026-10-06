import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@anvaya.sh/padma-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	while (harnesses.length) harnesses.pop()!.cleanup();
});
async function fixture() {
	const harness = await createHarness();
	harnesses.push(harness);
	return harness;
}
function shellProbe() {
	return [
		fauxAssistantMessage([fauxToolCall("bash", { command: "printf probe" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("No further actions"),
	];
}
describe("Adhikara access modes", () => {
	it("auto blocks a shell command the instruction did not authorize", async () => {
		const h = await fixture();
		writeFileSync(join(h.tempDir, "a.txt"), "old");
		h.setResponses(shellProbe());
		expect(h.session.sandhana.getAccessMode()).toBe("auto");
		await h.session.prompt("Please inspect a.txt");
		expect(h.session.sandhana.state!.used.execution).toBe(0);
		expect(h.session.sandhana.terminal?.status).toBe("BLOCKED");
	});
	it("full access executes the same unauthorized shell command", async () => {
		const h = await fixture();
		writeFileSync(join(h.tempDir, "a.txt"), "old");
		h.setResponses(shellProbe());
		h.session.sandhana.setAccessMode("full");
		await h.session.prompt("Please inspect a.txt");
		const kernel = h.session.sandhana;
		expect(kernel.state!.used.execution).toBe(1);
		expect(kernel.terminal?.status).toBe("PARTIALLY_COMPLETE");
		const classes = kernel.state!.authorizations.flatMap(
			(ref) => kernel.store.get(kernel.state!.mission_id, ref, "Authorization").classes,
		);
		expect(classes).toContain("*");
	});
	it("switching back to auto removes full-access authority from later missions", async () => {
		const h = await fixture();
		writeFileSync(join(h.tempDir, "a.txt"), "old");
		h.setResponses(shellProbe());
		h.session.sandhana.setAccessMode("full");
		await h.session.prompt("Please inspect a.txt");
		expect(h.session.sandhana.terminal?.status).toBe("PARTIALLY_COMPLETE");
		h.session.sandhana.setAccessMode("auto");
		expect(h.session.sandhana.getAccessMode()).toBe("auto");
		h.setResponses(shellProbe());
		await h.session.prompt("Please inspect a.txt");
		expect(h.session.sandhana.state!.used.execution).toBe(0);
		expect(h.session.sandhana.terminal?.status).toBe("BLOCKED");
	});
});
