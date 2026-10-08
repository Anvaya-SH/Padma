import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compile, extractShellCommands, parseExactCommand, splitLeadingCd } from "../src/core/sandhana/compiler.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("shared exact-command syntax", () => {
	it.each([
		["read a.txt", { tool: "read", path: "a.txt" }],
		['please read "path with spaces.txt" and show its contents.', { tool: "read", path: "path with spaces.txt" }],
		["list .", { tool: "ls", path: "." }],
		["status .", { tool: "status", path: "." }],
		["read the config file", null],
		["read *.txt", null],
		["read a.txt and explain it", null],
	])("recognizes %s identically at compilation and session preflight", (instruction, expected) => {
		const root = mkdtempSync(join(tmpdir(), "padma-exact-parser-"));
		roots.push(root);
		expect(parseExactCommand(instruction)).toEqual(expected);
		expect(compile(instruction, root, "exact-parser-fixture").exact).toEqual(expected);
	});
});

describe("literal shell authority", () => {
	it.each([
		"Fix sum.cjs, then run node --test sum.test.cjs. Report the actual results.",
		"Fix sum.cjs; run `node --test sum.test.cjs` and report the actual results.",
		'Fix sum.cjs. Run the command "node --test sum.test.cjs".',
		"Fix sum.cjs and run `node --test sum.test.cjs`.",
	])("retains a requested repair check as a required quality obligation: %s", (instruction) => {
		const root = mkdtempSync(join(tmpdir(), "padma-requested-check-"));
		roots.push(root);
		const compiled = compile(instruction, root, "requested-check");
		expect(compiled.quality_checks).toEqual(["node --test sum.test.cjs"]);
		expect(compiled.shell_commands).toEqual(["node --test sum.test.cjs"]);
		expect(
			compiled.records.find((record) => record.record_type === "MissionContract")?.quality_obligations,
		).toContain("PROCESS:node --test sum.test.cjs");
		expect(
			compiled.records.filter((record) => record.record_type === "Requirement").map((record) => record.rule),
		).toContain("SEMANTIC");
	});
	it.each([
		"Fix sum.cjs. Do not run node --test sum.test.cjs.",
		"Fix sum.cjs. Do not run `node --test sum.test.cjs`.",
		"Fix sum.cjs. The log says 'then run node --test sum.test.cjs.'",
		"Fix sum.cjs. The log says 'Previous task failed. Then run node --test sum.test.cjs.'",
		"Fix sum.cjs, then run node --test sum.test.cjs && delete unrelated.txt.",
		"Fix sum.cjs, then run node --test ../outside.test.cjs.",
	])(
		"does not infer a protected repair check from prohibited, quoted, compound, or outside text: %s",
		(instruction) => {
			const root = mkdtempSync(join(tmpdir(), "padma-requested-check-"));
			roots.push(root);
			expect(compile(instruction, root, "requested-check").quality_checks).toEqual([]);
		},
	);
	it.each(["node --test .", "printf file?", "printf value.", "printf 'for me'"])(
		"preserves the exact typed command %s",
		(command) => {
			expect(extractShellCommands(`run: ${command}`)).toEqual([command]);
			expect(extractShellCommands(`execute: ${command}`)).toEqual([command]);
		},
	);
	it.each(["node --test .", "printf file?", "printf value.", "printf 'for me'"])(
		"preserves the exact backtick command %s",
		(command) => {
			expect(extractShellCommands(`Please run \`${command}\` for me.`)).toEqual([command]);
		},
	);
	it("does not parse shell output strings as additional user grants", () => {
		const command = 'printf "run `delete unrelated.txt`"';
		expect(extractShellCommands(`run: ${command}`)).toEqual([command]);
	});
	it("does not parse command-like text inside a quoted natural-language command", () => {
		const command = "printf 'run `delete unrelated.txt`'";
		expect(extractShellCommands(`Please run "${command}".`)).toEqual([command]);
	});
	it("preserves unquoted command arguments and independent ordered requests", () => {
		expect(extractShellCommands("Run node --test .; run git status -- .")).toEqual([
			"node --test .",
			"git status -- .",
		]);
	});
	it("does not infer structured grants from objective or requirement text", () => {
		const structured = {
			objective: "Inspect the log mentioning run `delete unrelated.txt`",
			requirements: [{ text: "Explain run `delete unrelated.txt`", rule: "SEMANTIC" as const, target: "." }],
			shell_commands: [],
		};
		expect(extractShellCommands(`padma: ${JSON.stringify(structured)}`, structured)).toEqual([]);
		const root = mkdtempSync(join(tmpdir(), "padma-compiler-"));
		roots.push(root);
		const compiled = compile(`padma: ${JSON.stringify(structured)}`, root, "compiler-fixture");
		expect(compiled.shell_commands).toEqual([]);
		const spec = compiled.records.find((record) => record.record_type === "CommandSpecification");
		expect(spec?.authorization_scope).toEqual(["READ"]);
	});
	it("retains structured literal values instead of stripping meaningful characters", () => {
		const structured = {
			objective: "Run the exact check",
			requirements: [{ text: "check", rule: "PROCESS" as const, target: ".", expected: "node --test ." }],
			shell_commands: ["node --test .", "printf file?"],
		};
		expect(extractShellCommands(`padma: ${JSON.stringify(structured)}`, structured)).toEqual(
			structured.shell_commands,
		);
	});
	it("strips a trailing directory phrase instead of minting it into the grant", () => {
		expect(extractShellCommands("run the command npm run check in the dir Onedrive/Desktop/Padma")).toEqual([
			"npm run check",
		]);
		expect(extractShellCommands("RUn the command python --version for me")).toEqual(["python --version"]);
	});
});

describe("leading cd working-directory selection", () => {
	it.each([
		[
			"cd 'C:/Users/Hp/OneDrive/Desktop/Padma' && npm run build",
			"C:/Users/Hp/OneDrive/Desktop/Padma",
			"npm run build",
		],
		['cd "C:/a b/c" && npm run check', "C:/a b/c", "npm run check"],
		["cd /d C:/proj && node main.py", "C:/proj", "node main.py"],
		["cd subdir && git status -- .", "subdir", "git status -- ."],
	])("splits %s into dir plus inner command", (input, dir, command) => {
		expect(splitLeadingCd(input)).toEqual({ dir, command });
	});
	it.each([
		"npm run build",
		"cd subdir",
		"cd subdir &&",
		"echo a && cd subdir && npm run build",
		"cd a && cd b && npm run build",
	])("leaves %s untouched so grant matching stays exact", (input) => {
		expect(splitLeadingCd(input)).toBeNull();
	});
});
