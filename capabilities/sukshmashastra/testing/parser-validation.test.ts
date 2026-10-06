// Regression coverage for real-parser syntax proof (S6-INV-005, S6-PIPE-001 Step 6).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { API } from "typescript/unstable/sync";
import { checkSyntax, validateStructuralDeclarations } from "../engine/syntax-validator.ts";

const invalidSources = [
	["empty function parameter", "function f(,) {}"],
	["missing parameter separator", "function f(a b) {}"],
	["missing initializer", "const value = ;"],
	["missing expression", "function f() { return 1 + ; }"],
	["invalid statement", "function f() { if () {} }"],
	["break outside loop", "break;"],
	["continue outside loop", "continue;"],
	["duplicate lexical declaration", "let value = 1; let value = 2;"],
	["crossed nested delimiters", "const value = ([)];"],
	["invalid object members", "const value = { a: 1 b: 2 };"],
	["unterminated template", "const value = `unterminated;"],
	["invalid template substitution", `const value = \`hello \${1 + }\`;`],
	["unterminated template substitution", "const value = `hello ${1;"],
	["unterminated comment", "const value = 1; /* unterminated"],
	["unterminated double-quoted string", 'const value = "unterminated;'],
	["unterminated single-quoted string", "const value = 'unterminated;"],
	["raw newline in string", 'const value = "first\nsecond";'],
	["unterminated regex", "const value = /[abc/;"],
	["invalid regex group", "const value = /(/;"],
] as const;

const validSources = [
	["comment operators", "// =; +; !; ([{}])\n/* *; >; */ const value = 1;"],
	["string operators", `const value = "=; +; *; ([{}])"; const other = '!; >;';`],
	["template punctuation", `const value = \`} ) ] =; \${1 + 2} \${\`nested \${3}\`}\`;`],
	["escaped template delimiter", "const value = `escaped \\` still template`;"],
	["regex brackets", "const value = /[{}()[\\]]+/g;"],
	["regex slash and comment-looking tokens", "const value = /https?:\\/\\/[^/]+/;"],
	["division versus regex", "const value = 8 / 2; const pattern = /[(){}]/;"],
	["increment operator", "let value = 1; value++;"],
] as const;

describe("Sūkṣmaśastra: pinned parser validation", () => {
	for (const [name, source] of invalidSources) {
		it(`rejects ${name} in each applicable grammar`, () => {
			for (const filename of [undefined, "input.ts", "input.tsx", "input.js", "input.jsx"]) {
				const result = checkSyntax(source, filename);
				assert.equal(result.valid, false, `${filename ?? "default"}: ${source}`);
				assert.ok(result.errors.length > 0);
				assert.deepEqual(
					result.diagnostics,
					result.errors.map((message) => ({ message })),
				);
			}
		});
	}

	for (const [name, source] of validSources) {
		it(`accepts ${name} without punctuation heuristics`, () => {
			for (const filename of [undefined, "input.ts", "input.tsx", "input.js", "input.jsx"]) {
				const result = checkSyntax(source, filename);
				assert.equal(result.valid, true, `${filename ?? "default"}: ${result.errors.join("; ")}`);
				assert.deepEqual(result.errors, []);
			}
		});
	}

	it("accepts TypeScript types, generics and declarations without type checking", () => {
		const source = [
			"export interface User { id: string; }",
			"export type Box<T> = { value: T };",
			"export function identity<T extends User>(value: T): Box<T> { return { value }; }",
			"const wrongType: number = 'syntax is not semantics';",
		].join("\n");
		for (const filename of [undefined, "input.ts", "input.tsx", "input.mts", "input.cts"]) {
			const result = checkSyntax(source, filename);
			assert.equal(result.valid, true, result.errors.join("; "));
			assert.ok(result.topLevelNames.includes("interface:User"));
			assert.ok(result.topLevelNames.includes("type:Box"));
			assert.ok(result.topLevelNames.includes("function:identity"));
		}
	});

	it("accepts JSX only with a JSX/TSX filename", () => {
		const source = 'export const View = () => <><main title="=;">{/[{}]/.test("}")}</main></>;';
		for (const filename of ["view.jsx", "view.tsx"]) {
			const result = checkSyntax(source, filename);
			assert.equal(result.valid, true, result.errors.join("; "));
		}
		for (const filename of [undefined, "view.ts", "view.js", "view.mjs", "view.cjs"]) {
			assert.equal(checkSyntax(source, filename).valid, false, filename ?? "default");
		}
	});

	it("accepts typed JSX only with a TSX filename", () => {
		const source = "export const View = (props: { name: string }) => <main>{props.name}</main>;";
		assert.equal(checkSyntax(source, "view.tsx").valid, true);
		for (const filename of ["view.ts", "view.js", "view.jsx"]) {
			assert.equal(checkSyntax(source, filename).valid, false, filename);
		}
	});

	it("does not silently enable TypeScript for JavaScript filenames", () => {
		for (const source of ["const value: number = 1;", "interface User { id: string; }", "type Id = string;"]) {
			assert.equal(checkSyntax(source, "input.ts").valid, true);
			for (const filename of ["input.js", "input.jsx", "input.mjs", "input.cjs"]) {
				assert.equal(checkSyntax(source, filename).valid, false, `${filename}: ${source}`);
			}
		}
	});

	it("keeps angle-bracket grammar explicit instead of retrying another parser mode", () => {
		const assertion = "const value = <number>input;";
		assert.equal(checkSyntax(assertion).valid, true);
		assert.equal(checkSyntax(assertion, "input.ts").valid, true);
		assert.equal(checkSyntax(assertion, "input.tsx").valid, false);
		const arrow = "const identity = <T>(value: T) => value;";
		assert.equal(checkSyntax(arrow, "input.ts").valid, true);
		assert.equal(checkSyntax(arrow, "input.tsx").valid, false);
		assert.equal(checkSyntax("const identity = <T,>(value: T) => value;", "input.tsx").valid, true);
	});

	it("enforces module TypeScript's ambiguous generic grammar", () => {
		assert.equal(checkSyntax("const identity = <T>(value: T) => value;", "input.mts").valid, false);
		assert.equal(checkSyntax("const identity = <T,>(value: T) => value;", "input.mts").valid, true);
	});

	it("rejects a top-level return in an ES-module filename", () => {
		assert.equal(checkSyntax("return 1;", "input.mjs").valid, false);
	});

	it("rejects malformed JSX and TS type grammar", () => {
		assert.equal(checkSyntax("const view = <main><span /></other>;", "input.tsx").valid, false);
		assert.equal(checkSyntax("type Box<T = > = T;", "input.ts").valid, false);
	});

	it("rejects unsupported or absent explicit filename extensions as inconclusive", () => {
		for (const filename of ["input.py", "input.json", "input", "", "directory.ts/input"]) {
			const result = checkSyntax("const value = 1;", filename);
			assert.equal(result.valid, false, filename);
			assert.match(result.errors[0], /inconclusive: unsupported filename/);
		}
	});

	it("rejects unproven declaration-file grammar instead of treating it as ordinary TS", () => {
		for (const filename of ["input.d.ts", "input.d.mts", "input.d.cts"]) {
			const result = checkSyntax("export function concrete() { return 1; }", filename);
			assert.equal(result.valid, false, filename);
			assert.match(result.errors[0], /inconclusive: declaration-file grammar is unsupported/);
		}
	});

	it("fails closed when native parser capability is unavailable", (context) => {
		context.mock.method(API.prototype, "updateSnapshot", () => {
			throw new Error("Parser capability unavailable for regression test");
		});
		const result = checkSyntax("const value = 1;", "input.ts");
		assert.equal(result.valid, false);
		assert.match(result.errors.join("; "), /inconclusive: Parser capability unavailable/);
	});

	it("does not promote parser warnings to passing proof", () => {
		const result = checkSyntax("const value = { duplicate: 1, duplicate: 2 };", "input.js");
		assert.equal(result.valid, false);
		assert.ok(result.errors.length > 0);
	});

	it("reports missing braces using a parser diagnostic", () => {
		const result = checkSyntax(
			'export function broken() {\n  if (true) {\n    console.log("missing closing brace");\n',
		);
		assert.equal(result.valid, false);
		assert.match(result.errors.join("; "), /Unexpected end of file/);
	});

	it("reports actual parser locations", () => {
		const result = checkSyntax("const ok = 1;\nfunction f(,) {}", "src/input.ts");
		assert.equal(result.valid, false);
		assert.match(result.errors[0], /src\/input\.ts:2:\d+/);
	});

	it("never executes source or resolves its imports", () => {
		const before = Object.getOwnPropertyDescriptor(globalThis, "__syntaxParserSideEffect");
		const source = [
			'import missing from "./nonexistent-parser-test-dependency.js";',
			'globalThis.__syntaxParserSideEffect = "executed";',
			'throw new Error("must remain source text");',
		].join("\n");
		const result = checkSyntax(source, "input.js");
		assert.equal(result.valid, true, result.errors.join("; "));
		assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, "__syntaxParserSideEffect"), before);
	});

	it("preserves declaration deletion detection independently of grammar proof", () => {
		const before = "export function keeper() { return 1; }\nexport function removed() { return 2; }";
		const after = "export function keeper() { return 1; }";
		assert.deepEqual(validateStructuralDeclarations(before, after), {
			valid: false,
			undeclaredDeletions: ["function:removed"],
		});
		assert.equal(validateStructuralDeclarations(before, after, new Set(["function:removed"])).valid, true);
	});
});
