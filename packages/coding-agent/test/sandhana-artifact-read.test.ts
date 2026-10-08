import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createReadTool } from "../src/core/tools/read.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

it("exact artifact reads recover retained output and explicit current freshness remains strict", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "padma-artifact-read-"));
	writeFileSync(join(cwd, "notes.txt"), "retained evidence\n");
	const store = new MissionStore(":memory:");
	const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "artifact-read", store });
	cleanups.push(() => {
		kernel.closeKnowledge();
		store.close();
		rmSync(cwd, { recursive: true, force: true });
	});
	kernel.register(createReadTool(cwd), "read");
	kernel.captureInput("Inspect notes.txt and explain its contents", "USER");
	kernel.begin("");
	const native = await kernel.execute("read", "native-read", { path: "notes.txt" });
	const details = native.details as { sandhana: { observation_id: string } };
	const tool = kernel.knowledgeTools().find((entry) => entry.name === "avartana_read")!;
	const args = { family: "tool_artifact", locator: details.sandhana.observation_id };
	const recovered = await tool.execute("retained", args);
	const payload = JSON.parse(recovered.content.map((part) => (part.type === "text" ? part.text : "")).join("")) as {
		snippets: { text: string; freshness: string }[];
	};
	expect(payload.snippets.some((snippet) => snippet.text.includes("retained evidence"))).toBe(true);
	expect(payload.snippets[0].freshness).toBe("satisfied");
	const expand = kernel.knowledgeTools().find((entry) => entry.name === "avartana_expand")!;
	const expanded = await expand.execute("expanded", { ...args, firstLine: 1, lastLine: 1 });
	expect(JSON.stringify(expanded.content)).toContain("retained evidence");
	const current = await tool.execute("current", { ...args, freshness: "current_generation" });
	const currentText = current.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	expect(JSON.parse(currentText)).toMatchObject({ status: "STALE", snippets: [] });
	expect(kernel.state!.used.execution).toBe(1);
});
