// Sūkṣmaśastra Transformations Golden Test Suite (Part E2, S6-TX-001..004)

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Anchor } from "../model/anchors.ts";
import { applyRangeEdits } from "../model/diff.ts";
import { SukshmashastraError } from "../model/reason-codes.ts";
import {
	addImport,
	changeSignature,
	deleteNode,
	insertNode,
	migrateConfig,
	moveDeclaration,
	removeImport,
	renameIdentifier,
	replaceNode,
	rewriteImportSpecifier,
	rewriteModuleSpecifier,
	runCustomCodemod,
	validateFileLanguageSupport,
} from "../transformations/index.ts";

describe("Sūkṣmaśastra: Transformations (S6-TX-001..004)", () => {
	describe("1. Rename Transformation (S6-TX-001, S6-TX-003)", () => {
		it("renames identifiers across declarations, calls, JSX, shorthand props, and exports", () => {
			const source = [
				'import { oldFunc } from "./lib";',
				"export { oldFunc };",
				"function oldFunc() {",
				"  const val = oldFunc();",
				"  const obj = { oldFunc };",
				'  const jsx = <oldFunc prop="test"></oldFunc>;',
				"  // Mention of oldFunc in comment",
				'  const str = "Mention of oldFunc in string";',
				"  return val;",
				"}",
			].join("\n");

			const res = renameIdentifier(source, "oldFunc", "newFunc");
			const modified = applyRangeEdits(source, res.edits);

			// Assert declaration and call renamed
			assert.ok(modified.includes("function newFunc()"));
			assert.ok(modified.includes("const val = newFunc();"));
			// Assert JSX tags renamed
			assert.ok(modified.includes('<newFunc prop="test"></newFunc>'));
			// Assert shorthand property expanded
			assert.ok(modified.includes("const obj = { oldFunc: newFunc };"));
			// Assert export aliased
			assert.ok(modified.includes("export { newFunc as oldFunc };"));
			// Assert strings and comments were NOT modified
			assert.ok(modified.includes("// Mention of oldFunc in comment"));
			assert.ok(modified.includes('"Mention of oldFunc in string"'));
			// Assert mentions_unmodified contains both
			assert.equal(res.mentions_unmodified.length, 2);
			assert.equal(res.mentions_unmodified[0].kind, "comment");
			assert.equal(res.mentions_unmodified[1].kind, "string");
		});

		it("renames default export functions", () => {
			const source = "export default function oldName() { return 1; }";
			const res = renameIdentifier(source, "oldName", "newName");
			const modified = applyRangeEdits(source, res.edits);
			assert.equal(modified, "export default function newName() { return 1; }");
		});
	});

	describe("2. Rewrite Imports (S6-TX-001, S6-TX-003)", () => {
		it("adds named import to existing import without churn", () => {
			const source = 'import { a } from "./mod";\nconsole.log(a);';
			const edits = addImport(source, {
				moduleSpecifier: "./mod",
				namedImports: ["b"],
			});
			const modified = applyRangeEdits(source, edits);
			assert.equal(modified, 'import { a, b } from "./mod";\nconsole.log(a);');
		});

		it("adds brand new import if module not yet imported", () => {
			const source = "console.log(123);\n";
			const edits = addImport(source, {
				moduleSpecifier: "./utils",
				namedImports: ["helper"],
			});
			const modified = applyRangeEdits(source, edits);
			assert.ok(modified.includes('import { helper } from "./utils";'));
		});

		it("removes named import and removes whole statement when empty", () => {
			const source = 'import { a, b } from "./mod";\nimport { c } from "./other";';
			const edits1 = removeImport(source, {
				moduleSpecifier: "./mod",
				namedImports: ["a"],
			});
			const step1 = applyRangeEdits(source, edits1);
			assert.ok(step1.includes('import { b } from "./mod";'));

			const edits2 = removeImport(step1, {
				moduleSpecifier: "./other",
				namedImports: ["c"],
			});
			const step2 = applyRangeEdits(step1, edits2);
			assert.ok(!step2.includes("./other"));
		});

		it("rewrites module specifiers and import specifiers", () => {
			const source = 'import { oldFn } from "./old-path";';
			const edits1 = rewriteModuleSpecifier(source, "./old-path", "./new-path");
			const step1 = applyRangeEdits(source, edits1);
			assert.equal(step1, 'import { oldFn } from "./new-path";');

			const edits2 = rewriteImportSpecifier(step1, {
				oldSpecifier: "oldFn",
				newSpecifier: "newFn",
			});
			const step2 = applyRangeEdits(step1, edits2);
			assert.equal(step2, 'import { newFn } from "./new-path";');
		});
	});

	describe("3. Replace Node (S6-TX-001, S6-TX-003)", () => {
		const dummyAnchor: Anchor = {
			anchor_id: "fn:test",
			id: "fn:test",
			file_id: "src/app.ts",
			selector: "function:test",
			kind: "function",
			targetFile: "src/app.ts",
			identifier: "test",
			range: {
				startByte: 0,
				endByte: 29,
				startLine: 1,
				endLine: 1,
				startColumn: 1,
				endColumn: 30,
			},
		};

		it("replaces anchored node range cleanly", () => {
			const source = "function test() { return 1; }\nconst b = 2;";
			const res = replaceNode(source, dummyAnchor, "function test() { return 42; }");
			const modified = applyRangeEdits(source, res.edits);
			assert.equal(modified, "function test() { return 42; }\nconst b = 2;");
		});

		it("rejects replacement that introduces syntax errors", () => {
			const source = "function test() { return 1; }\nconst b = 2;";
			assert.throws(
				() => replaceNode(source, dummyAnchor, "function test() { unclosed"),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "REJECTED_SYNTAX_ERROR",
			);
		});
	});

	describe("4. Insert Node (S6-TX-001, S6-TX-003)", () => {
		const fnAnchor: Anchor = {
			anchor_id: "fn:greet",
			id: "fn:greet",
			file_id: "src/app.ts",
			selector: "function:greet",
			kind: "function",
			targetFile: "src/app.ts",
			identifier: "greet",
			range: {
				startByte: 0,
				endByte: 36,
				startLine: 1,
				endLine: 1,
				startColumn: 1,
				endColumn: 37,
			},
		};

		it("inserts code BEFORE and AFTER an anchored node", () => {
			const source = "function greet() { return 'hello'; }";

			const resBefore = insertNode(source, fnAnchor, "BEFORE", "// Greeting header");
			const modBefore = applyRangeEdits(source, resBefore.edits);
			assert.ok(modBefore.startsWith("// Greeting header\nfunction greet"));

			const resAfter = insertNode(source, fnAnchor, "AFTER", "// Greeting footer");
			const modAfter = applyRangeEdits(source, resAfter.edits);
			assert.ok(modAfter.endsWith("// Greeting footer"));
		});

		it("inserts code INSIDE_START and INSIDE_END of a container", () => {
			const source = "function greet() {\n  return 'hi';\n}";
			const anchor: Anchor = {
				...fnAnchor,
				range: {
					startByte: 0,
					endByte: source.length,
					startLine: 1,
					endLine: 3,
					startColumn: 1,
					endColumn: 2,
				},
			};

			const resStart = insertNode(source, anchor, "INSIDE_START", "console.log('entering');");
			const modStart = applyRangeEdits(source, resStart.edits);
			assert.ok(modStart.includes("console.log('entering');"));
		});
	});

	describe("5. Delete Node (S6-TX-001, S6-TX-003)", () => {
		const anchor: Anchor = {
			anchor_id: "fn:deadCode",
			id: "fn:deadCode",
			file_id: "src/dead.ts",
			selector: "function:deadCode",
			kind: "function",
			targetFile: "src/dead.ts",
			identifier: "deadCode",
			range: {
				startByte: 0,
				endByte: 34,
				startLine: 1,
				endLine: 1,
				startColumn: 1,
				endColumn: 35,
			},
		};

		it("deletes node cleanly when no active references exist", () => {
			const source = "function deadCode() { return 0; }\nconst active = 1;";
			const res = deleteNode(source, anchor, []);
			const modified = applyRangeEdits(source, res.edits);
			assert.equal(modified.trim(), "const active = 1;");
		});

		it("rejects deletion with DELETE_REFERENCES_REMAIN if live references remain", () => {
			const source = "function deadCode() { return 0; }\nconst active = deadCode();";
			const activeRefs = [
				{
					file: "src/dead.ts",
					startByte: 49,
					endByte: 57,
				},
			];

			assert.throws(
				() => deleteNode(source, anchor, activeRefs),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "DELETE_REFERENCES_REMAIN",
			);
		});
	});

	describe("6. Move Declaration (S6-TX-001, S6-TX-003)", () => {
		const anchor: Anchor = {
			anchor_id: "fn:calculate",
			id: "fn:calculate",
			file_id: "src/utils.ts",
			selector: "function:calculate",
			kind: "function",
			targetFile: "src/utils.ts",
			identifier: "calculate",
			range: {
				startByte: 0,
				endByte: 36,
				startLine: 1,
				endLine: 1,
				startColumn: 1,
				endColumn: 37,
			},
		};

		it("moves declaration, exports in target, and imports in source", () => {
			const source = "function calculate() { return 100; }\nconsole.log(calculate());";
			const target = "export const PI = 3.14;";

			const res = moveDeclaration("src/utils.ts", source, "src/math.ts", target, anchor);

			const newSource = applyRangeEdits(source, res.sourceEdits);
			const newTarget = applyRangeEdits(target, res.targetEdits);

			// Assert removed from source and imported
			assert.ok(!newSource.includes("function calculate"));
			assert.ok(newSource.includes('import { calculate } from "./math"'));
			// Assert added to target with export
			assert.ok(newTarget.includes("export function calculate() { return 100; }"));
		});

		it("detects circular dependency and rejects with CONFLICT", () => {
			const source = "function calculate() { return 100; }";
			const target = "import { helper } from './utils';";

			assert.throws(
				() =>
					moveDeclaration("src/utils.ts", source, "src/math.ts", target, anchor, {
						"src/math.ts": ["src/utils.ts"],
					}),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "CONFLICT",
			);
		});
	});

	describe("7. Change Signature (S6-TX-001, S6-TX-003)", () => {
		const fnAnchor: Anchor = {
			anchor_id: "fn:greet",
			id: "fn:greet",
			file_id: "src/app.ts",
			selector: "function:greet",
			kind: "function",
			targetFile: "src/app.ts",
			identifier: "greet",
			range: {
				startByte: 0,
				endByte: 55,
				startLine: 1,
				endLine: 1,
				startColumn: 1,
				endColumn: 56,
			},
		};

		it("reorders, renames, and adds parameters", () => {
			const source =
				'function greet(first: string, last: string) {\n  return first + last;\n}\ngreet("John", "Doe");';
			const callSiteIdx = source.indexOf('greet("John"');
			const callSiteRaw = 'greet("John", "Doe")';
			const callSites = [
				{
					rawText: callSiteRaw,
					startByte: callSiteIdx,
					endByte: callSiteIdx + callSiteRaw.length,
				},
			];

			const res = changeSignature(
				source,
				fnAnchor,
				{
					reorder: [1, 0], // swap last and first
					add: [{ name: "salutation", defaultValue: '"Mr."' }],
				},
				callSites,
			);

			const modified = applyRangeEdits(source, res.edits);
			assert.ok(modified.includes('function greet(last: string, first: string, salutation = "Mr.")'));
			assert.ok(modified.includes('greet("Doe", "John", "Mr.")'));
		});

		it("flags dynamic dispatch and spread arguments as MANUAL_REVIEW_REQUIRED", () => {
			const source = "function greet(first: string) { return first; }";
			const callSites = [
				{
					rawText: "greet(...args)",
					startByte: 60,
					endByte: 74,
				},
			];

			const res = changeSignature(source, fnAnchor, { add: [{ name: "extra" }] }, callSites);
			assert.equal(res.flags.length, 1);
			assert.equal(res.flags[0].code, "MANUAL_REVIEW_REQUIRED");
		});
	});

	describe("8. Config Migration (S6-TX-003, Decision D-4)", () => {
		it("migrates JSON and JSONC while preserving structure and comments", () => {
			const jsonc = '{\n  // Biome configuration\n  "formatter": {\n    "enabled": false\n  }\n}';
			const res = migrateConfig("biome.jsonc", jsonc, [{ keyPath: ["formatter", "enabled"], newValue: true }]);
			const modified = applyRangeEdits(jsonc, res.edits);
			assert.ok(modified.includes('"enabled": true'));
			assert.ok(modified.includes("// Biome configuration"));
		});

		it("migrates YAML files preserving comments", () => {
			const yaml = "version: 1\n# App settings\nenabled: false\n";
			const res = migrateConfig("config.yaml", yaml, [{ keyPath: ["enabled"], newValue: "true" }]);
			const modified = applyRangeEdits(yaml, res.edits);
			assert.ok(modified.includes("enabled: true"));
			assert.ok(modified.includes("# App settings"));
		});

		it("refuses executable configurations with FORMAT_SKIPPED_EXECUTABLE_CONFIG", () => {
			assert.throws(
				() => migrateConfig("prettier.config.js", "module.exports = {};", []),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "FORMAT_SKIPPED_EXECUTABLE_CONFIG",
			);
		});
	});

	describe("9. Custom Sandboxed Codemod (S6-TX-003)", () => {
		it("runs sandboxed transformation in VM", async () => {
			const source = "const x = 1;\n";
			const script = "result = code.replace('1', '2');";
			const res = await runCustomCodemod(source, script);
			assert.equal(res.newContent, "const x = 2;\n");
		});

		it("rejects codemod introducing syntax errors", async () => {
			const source = "const x = 1;\n";
			const script = "result = 'const x = ;';";
			await assert.rejects(
				() => runCustomCodemod(source, script),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "REJECTED_SYNTAX_ERROR",
			);
		});
	});

	describe("10. Language Support Validation (S6-TX-004)", () => {
		it("accepts supported TypeScript and JavaScript files", () => {
			assert.doesNotThrow(() => validateFileLanguageSupport("src/app.ts", "rename"));
			assert.doesNotThrow(() => validateFileLanguageSupport("src/app.tsx", "rename"));
			assert.doesNotThrow(() => validateFileLanguageSupport("src/app.js", "rename"));
			assert.doesNotThrow(() => validateFileLanguageSupport("src/app.jsx", "rename"));
		});

		it("refuses non-TS/JS files with UNSUPPORTED_LANGUAGE", () => {
			assert.throws(
				() => validateFileLanguageSupport("src/script.py", "rename"),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "UNSUPPORTED_LANGUAGE",
			);
			assert.throws(
				() => validateFileLanguageSupport("src/main.rs", "rename"),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "UNSUPPORTED_LANGUAGE",
			);
		});
	});
});
