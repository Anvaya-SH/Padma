import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadProjectContextFiles } from "../src/core/resource-loader.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

it("loads chat style alongside project rules, with ancestor instructions before local ones", () => {
	const dir = mkdtempSync(join(tmpdir(), "padma-casual-context-"));
	const agentDir = join(dir, "agent");
	const cwd = join(dir, "project");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	const files = [
		[join(agentDir, "CASUAL.md"), "Global chat voice"],
		[join(dir, "AGENTS.md"), "Parent execution rules"],
		[join(cwd, "AGENTS.md"), "Local execution rules"],
		[join(cwd, "CASUAL.md"), "Friendly cowboy pirate chat only; tool execution stays neutral."],
	];
	for (const [file, content] of files) writeFileSync(file, content);
	try {
		const context = loadProjectContextFiles({ cwd, agentDir }).filter((file) => file.path.startsWith(dir));
		expect(context.map((file) => file.path)).toEqual(files.map(([file]) => file));
		const prompt = buildSystemPrompt({ cwd, contextFiles: context });
		expect(prompt).toContain("Friendly cowboy pirate chat only; tool execution stays neutral.");
		expect(prompt).toContain("Local execution rules");
	} finally {
		for (const [file] of files) rmSync(file);
		rmdirSync(cwd);
		rmdirSync(agentDir);
		rmdirSync(dir);
	}
});
