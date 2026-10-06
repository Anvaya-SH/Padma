import { describe, expect, it } from "vitest";
import { shouldShowStartupScreen } from "../src/cli/startup-screen.ts";
import { BUILTIN_SLASH_COMMANDS, isBuiltinCommand, normalizeBuiltinCommand } from "../src/core/slash-commands.ts";
import { resolveThinkingLevel } from "../src/core/ui-language.ts";
import { getFormattedTagline, PADMA_TAGLINES } from "../src/modes/interactive/components/taglines.ts";

describe("Sanskrit commands", () => {
	it("accepts ASCII and accented spellings while preserving argument bytes", () => {
		for (const command of BUILTIN_SLASH_COMMANDS) {
			const args = '  "C:\\a folder\\file.jsonl" --literal=value';
			for (const spelling of [command.name, command.displayName, command.command]) {
				expect(normalizeBuiltinCommand(`/${spelling}${args}`)).toBe(`/${command.command}${args}`);
				expect(isBuiltinCommand(spelling)).toBe(true);
			}
		}
	});

	it("leaves prompts and extension commands intact", () => {
		for (const input of ["model my data", "/my-extension a/b", "/modeling", "!echo /niryata"]) {
			expect(normalizeBuiltinCommand(input)).toBe(input);
		}
		expect(normalizeBuiltinCommand("/models openai/test")).toBe("/model openai/test");
	});

	it("accepts Sanskrit reasoning levels without changing provider identifiers", () => {
		expect(resolveThinkingLevel("gambhira")).toBe("high");
		expect(resolveThinkingLevel("Atigambhīra")).toBe("xhigh");
		expect(resolveThinkingLevel("medium")).toBe("medium");
		expect(resolveThinkingLevel("unknown")).toBeUndefined();
	});
});

describe("welcome screen", () => {
	it("keeps machine output and piped input free of welcome text", () => {
		expect(shouldShowStartupScreen([], true, true)).toBe(true);
		expect(shouldShowStartupScreen(["--offline", "--no-session"], true, true)).toBe(true);
		for (const args of [["--help"], ["--version"], ["--mode", "rpc"], ["--print"], ["hello"]]) {
			expect(shouldShowStartupScreen(args, true, true)).toBe(false);
		}
		expect(shouldShowStartupScreen([], false, true)).toBe(false);
		expect(shouldShowStartupScreen([], true, false)).toBe(false);
	});

	it("has fifty unique jokes with bold beige styling and English glosses", () => {
		expect(PADMA_TAGLINES).toHaveLength(50);
		expect(new Set(PADMA_TAGLINES).size).toBe(50);
		for (const [index, tagline] of PADMA_TAGLINES.entries()) {
			expect(tagline).toMatch(/\[[^\]]+\]/);
			expect(getFormattedTagline(index)).toBe(`\x1b[1m\x1b[38;2;215;201;184m${tagline}\x1b[39m\x1b[22m`);
		}
	});
});
