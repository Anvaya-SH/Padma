import { describe, expect, it } from "vitest";
import {
	BUILTIN_SLASH_COMMANDS,
	builtinAutocompleteEntries,
	normalizeBuiltinCommand,
} from "../src/core/slash-commands.ts";

describe("builtin slash command Sanskrit-only with English redirect", () => {
	it("lists every command under its Sanskrit name only", () => {
		const entries = builtinAutocompleteEntries();
		const names = new Set(entries.map((entry) => entry.name));
		for (const command of BUILTIN_SLASH_COMMANDS) {
			expect(names.has(command.name)).toBe(true);
			if (command.command !== command.name) expect(names.has(command.command)).toBe(false);
		}
		for (const alias of ["models", "clear", "exit"]) expect(names.has(alias)).toBe(false);
		for (const sanskrit of ["pratimana", "dhyana", "pravesa", "adhikara", "visvasa", "prasthana"]) {
			expect(names.has(sanskrit)).toBe(true);
		}
		expect(names.size).toBe(entries.length);
	});
	it("redirects English to Sanskrit through normalization", () => {
		for (const command of BUILTIN_SLASH_COMMANDS) {
			expect(normalizeBuiltinCommand(`/${command.name}`)).toBe(`/${command.name}`);
			expect(normalizeBuiltinCommand(`/${command.command}`)).toBe(`/${command.name}`);
		}
		expect(normalizeBuiltinCommand("/models")).toBe("/pratimana");
		expect(normalizeBuiltinCommand("/clear")).toBe("/nava");
		expect(normalizeBuiltinCommand("/exit")).toBe("/prasthana");
		expect(normalizeBuiltinCommand("/login")).toBe("/pravesa");
		expect(normalizeBuiltinCommand("/access full")).toBe("/adhikara full");
		expect(normalizeBuiltinCommand("/adhikara full")).toBe("/adhikara full");
	});
});
