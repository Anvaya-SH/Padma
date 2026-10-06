import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSelector, serializeSelector } from "../anchors/grammar.ts";
import { applyRangeEdits, computeFileDiff, validateNoOverlappingEdits } from "../model/diff.ts";
import { assertReasonCode, getReasonCode } from "../model/reason-codes.ts";

describe("Sūkṣmaśastra: Grammar, Diff & Reason Codes", () => {
	describe("Reason-Code Catalog (Appendix B, S6-TEST-001)", () => {
		it("all reason codes have valid categories, descriptions, and userActionable flags", () => {
			const expectedKeys = [
				"BINDING_MISMATCH",
				"AMBIGUOUS",
				"NOT_FOUND",
				"STALE_PREIMAGE",
				"MOVED",
				"GRAPH_PARSE_MISMATCH",
				"EDIT_OVERLAP",
				"UNDECLARED_STRUCTURAL_CHANGE",
				"GENERATED_FILE_SKIPPED",
				"MANUAL_REVIEW_REQUIRED",
				"STRING_OR_COMMENT_MENTION",
				"LARGE_CHANGE",
				"PREIMAGE_CHANGED",
				"APPLY_ROLLED_BACK",
				"APPLY_PARTIAL",
				"CONFLICT",
				"SEMANTIC_RECHECK_RECOMMENDED",
				"DIAGNOSTICS_DEFERRED",
				"SEMANTIC_DEFERRED",
				"FORMAT_SKIPPED_EXECUTABLE_CONFIG",
				"SECRET_IN_REPLACEMENT",
				"PATH_OUTSIDE_ROOT",
				"UNSUPPORTED_ENCODING",
				"UNSUPPORTED_LANGUAGE",
				"SCOPE_DENIED",
				"REJECTED_SYNTAX_ERROR",
				"DELETE_REFERENCES_REMAIN",
			];

			for (const key of expectedKeys) {
				const def = getReasonCode(key);
				assert.ok(def, `Missing reason code ${key}`);
				assert.equal(def.code, key);
				assert.ok(def.category.length > 0);
				assert.ok(def.description.length > 10);
				assert.equal(typeof def.userActionable, "boolean");
			}
		});

		it("assertReasonCode fails cleanly on uncatalogued codes", () => {
			assert.throws(() => assertReasonCode("NON_EXISTENT_CODE"), /Uncatalogued Sūkṣmaśastra reason code/);
		});
	});

	describe("Selector Grammar (S6-ANC-003)", () => {
		it("parses single-level selectors", () => {
			const sel = parseSelector("function:verifySession");
			assert.equal(sel.chain.length, 1);
			assert.equal(sel.target.kind, "function");
			assert.equal(sel.target.identifier, "verifySession");
			assert.equal(serializeSelector(sel), "function:verifySession");
		});

		it("parses multi-level hierarchy selectors", () => {
			const sel = parseSelector("class:AuthService > method:login");
			assert.equal(sel.chain.length, 2);
			assert.equal(sel.chain[0].kind, "class");
			assert.equal(sel.chain[0].identifier, "AuthService");
			assert.equal(sel.target.kind, "method");
			assert.equal(sel.target.identifier, "login");
			assert.equal(serializeSelector(sel), "class:AuthService > method:login");
		});

		it("parses import and export selectors with quotes", () => {
			const importSel = parseSelector('import:"./utils/session.ts"');
			assert.equal(importSel.target.kind, "import");
			assert.equal(importSel.target.identifier, "./utils/session.ts");

			const exportSel = parseSelector("export:default");
			assert.equal(exportSel.target.kind, "export");
			assert.equal(exportSel.target.identifier, "default");
		});

		it("rejects malformed and unsupported selectors", () => {
			assert.throws(() => parseSelector(""), /Empty structural selector/);
			assert.throws(() => parseSelector("unknownkind:foo"), /Unsupported selector kind/);
			assert.throws(() => parseSelector("function:"), /Missing identifier/);
			assert.throws(() => parseSelector("class:Auth >"), /Invalid empty selector segment/);
		});
	});

	describe("Range Replacement & Overlap Detection (Decision D-2, S6-TX-002)", () => {
		it("applies multiple non-overlapping edits in any input order", () => {
			const original = "const a = 1; const b = 2; const c = 3;";
			// Edit b (offset 23..24 -> '20'), edit a (offset 10..11 -> '10')
			const edits = [
				{ start: 23, end: 24, newText: "20" },
				{ start: 10, end: 11, newText: "10" },
			];
			const modified = applyRangeEdits(original, edits);
			assert.equal(modified, "const a = 10; const b = 20; const c = 3;");
		});

		it("detects and rejects overlapping edits with EDIT_OVERLAP", () => {
			const original = "function test() { return 42; }";
			const overlapping = [
				{ start: 0, end: 15, newText: "const test = () =>" },
				{ start: 10, end: 20, newText: "modified" },
			];
			assert.throws(() => validateNoOverlappingEdits(overlapping), /EDIT_OVERLAP/);
			assert.throws(() => applyRangeEdits(original, overlapping), /EDIT_OVERLAP/);
		});

		it("computes accurate unified diff previews", () => {
			const original = "line1\nline2\nline3\n";
			const modified = "line1\nline2_changed\nline3\nline4\n";
			const diff = computeFileDiff("src/test.ts", original, modified);
			assert.equal(diff.path, "src/test.ts");
			assert.ok(diff.patch.includes("line2_changed"));
			assert.ok(diff.addedLines >= 2);
			assert.ok(diff.removedLines >= 1);
		});
	});
});
