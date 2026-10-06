import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveMergedImpact, scanFileBlindSpots } from "../engine/impact-merger.ts";
import { checkSyntax, validateStructuralDeclarations } from "../engine/syntax-validator.ts";

describe("Sūkṣmaśastra: Syntax Validation & Impact Merger (S6-INV-005, S6-INV-007, S6-COV-001..004)", () => {
	describe("Syntax Validation (S6-INV-005)", () => {
		it("accepts syntactically clean TypeScript code", () => {
			const clean = `
export interface User {
  id: string;
  name: string;
}

export function getUser(id: string): User {
  return { id, name: "Alice" };
}
`;
			const res = checkSyntax(clean);
			assert.equal(res.valid, true);
			assert.equal(res.errors.length, 0);
			assert.ok(res.topLevelNames.includes("interface:User"));
			assert.ok(res.topLevelNames.includes("function:getUser"));
		});

		it("rejects code with unclosed braces or syntax errors", () => {
			const broken = `
export function broken() {
  if (true) {
    console.log("missing closing brace");
`;
			const res = checkSyntax(broken);
			assert.equal(res.valid, false);
			assert.ok(res.errors.some((e) => /Unexpected end of file/.test(e)));
			assert.ok(res.diagnostics.length > 0);
		});

		it("detects undeclared structural deletions", () => {
			const preEdit = `
export function keeper() { return 1; }
export function deletedByAccident() { return 2; }
`;
			const postEdit = `
export function keeper() { return 1; }
`;
			// Without keeper in expectedDeletedNames
			const checkFail = validateStructuralDeclarations(preEdit, postEdit, new Set());
			assert.equal(checkFail.valid, false);
			assert.ok(checkFail.undeclaredDeletions.includes("function:deletedByAccident"));

			// With keeper in expectedDeletedNames
			const checkPass = validateStructuralDeclarations(preEdit, postEdit, new Set(["function:deletedByAccident"]));
			assert.equal(checkPass.valid, true);
			assert.equal(checkPass.undeclaredDeletions.length, 0);
		});
	});

	describe("Impact Merger & Blind Spots (S6-INV-007, S6-COV-001..004)", () => {
		it("detects reflection, dynamic imports, and string mentions", () => {
			const source = `
// Documentation mention of verifySession
const fnName = "verifySession";
const result = Reflect.get(globalThis, fnName);
const mod = import("./dynamic/" + fnName);
`;
			const { uncovered, stringMentions } = scanFileBlindSpots("src/test.ts", source, ["verifySession"]);

			assert.ok(uncovered.has("STRING_OR_COMMENT_MENTION"));
			assert.ok(uncovered.has("REFLECTION"));
			assert.ok(uncovered.has("DYNAMIC_IMPORT"));
			assert.ok(stringMentions.length >= 1);
			assert.equal(stringMentions[0].kind, "mention");
		});

		it("produces honest EditCoverage report with LOWER_BOUND completeness and suggested checks", async () => {
			const files = new Map<string, string>([
				[
					"src/auth.ts",
					`
export function verifySession(token: string) { return Boolean(token); }
const test = verifySession("abc");
// verifySession in comment
`,
				],
			]);

			const mergeResult = await deriveMergedImpact({
				repoRoot: ".",
				targetSymbols: ["verifySession"],
				sourceFiles: files,
				isExportedFromRoot: true,
			});

			const cov = mergeResult.coverage;
			assert.equal(cov.atlas_completeness, "LOWER_BOUND");
			assert.ok(cov.uncovered_surface.some((u) => u.code === "EXTERNAL_API_CONSUMERS"));
			assert.ok(cov.uncovered_surface.some((u) => u.code === "STRING_OR_COMMENT_MENTION"));
			assert.ok(cov.external_contract_changes.length >= 1);
			assert.ok(cov.suggested_checks.includes("External API compatibility check"));
		});
	});
});
