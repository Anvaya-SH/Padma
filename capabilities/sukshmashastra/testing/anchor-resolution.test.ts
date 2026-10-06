import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeSha256, resolveAnchor } from "../anchors/resolver.ts";
import type { Anchor } from "../model/anchors.ts";

describe("Sūkṣmaśastra: Anchor Resolution (Part D, S6-ANC-001..004, S6-TEST-001 Layer 2)", () => {
	it("resolves unique anchor when file digest and range match exactly", () => {
		const code = `
export function verifySession(token: string): boolean {
  return token.length > 0;
}
`;
		const bytes = new TextEncoder().encode(code);
		const digest = computeSha256(bytes);
		const start = code.indexOf("export function verifySession");
		const end = code.indexOf("}") + 1;
		const nodeText = code.slice(start, end);
		const nodeDigest = computeSha256(nodeText);

		const anchor: Anchor = {
			anchor_id: "anc_1",
			file_id: "file:src/auth.ts",
			symbol_id: "sym:src/auth.ts#verifySession",
			node_kind: "function",
			structural_selector: "function:verifySession",
			expected_content_digest: digest,
			expected_node_digest: nodeDigest,
			source_range: [start, end],
		};

		const resolution = resolveAnchor(anchor, bytes);
		assert.equal(resolution.status, "RESOLVED_UNIQUE");
		if (resolution.status === "RESOLVED_UNIQUE") {
			assert.deepEqual(resolution.range, [start, end]);
			assert.equal(resolution.node_digest, nodeDigest);
		}
	});

	it("returns AMBIGUOUS for overloaded functions without silent pick (S6-ANC-002)", () => {
		const code = `
export function parse(input: string): string;
export function parse(input: number): number;
export function parse(input: any): any {
  return input;
}
`;
		const bytes = new TextEncoder().encode(code);

		const anchor: Anchor = {
			anchor_id: "anc_overload",
			file_id: "file:src/parser.ts",
			structural_selector: "function:parse",
			expected_content_digest: "stale_hash",
			source_range: [0, 10],
		};

		const resolution = resolveAnchor(anchor, bytes);
		assert.equal(resolution.status, "AMBIGUOUS");
		if (resolution.status === "AMBIGUOUS") {
			assert.equal(resolution.candidates.length, 3);
			assert.equal(resolution.reason, "AMBIGUOUS");
			for (const c of resolution.candidates) {
				assert.equal(c.kind, "function");
				assert.equal(c.name, "parse");
			}
		}
	});

	it("returns AMBIGUOUS for same-named members in different scopes when unanchored (S6-ANC-002)", () => {
		const code = `
class ServiceA {
  validate(): boolean { return true; }
}
class ServiceB {
  validate(): boolean { return false; }
}
`;
		const bytes = new TextEncoder().encode(code);

		const anchor: Anchor = {
			anchor_id: "anc_member_ambiguous",
			file_id: "file:src/services.ts",
			structural_selector: "method:validate",
			expected_content_digest: "different_hash",
			source_range: [0, 10],
		};

		const resolution = resolveAnchor(anchor, bytes);
		assert.equal(resolution.status, "AMBIGUOUS");
		if (resolution.status === "AMBIGUOUS") {
			assert.equal(resolution.candidates.length, 2);
		}
	});

	it("resolves uniquely when disambiguated by container hierarchy chain", () => {
		const code = `
class ServiceA {
  validate(): boolean { return true; }
}
class ServiceB {
  validate(): boolean { return false; }
}
`;
		const bytes = new TextEncoder().encode(code);

		const anchor: Anchor = {
			anchor_id: "anc_member_scoped",
			file_id: "file:src/services.ts",
			structural_selector: "class:ServiceB > method:validate",
			expected_content_digest: "different_hash",
			source_range: [0, 10],
		};

		const resolution = resolveAnchor(anchor, bytes);
		assert.ok(resolution.status === "RESOLVED_UNIQUE" || resolution.status === "MOVED");
		if (resolution.status === "MOVED" || resolution.status === "RESOLVED_UNIQUE") {
			const expectedStart = code.indexOf("validate(): boolean { return false; }");
			assert.equal(resolution.range[0], expectedStart);
		}
	});

	it("reports MOVED when file content changed and offsets shifted (S6-ANC-001)", () => {
		const originalCode = `function test() { return 1; }`;
		const modifiedCode = `// Preceding comment added\nconst x = 100;\nfunction test() { return 1; }`;

		const originalBytes = new TextEncoder().encode(originalCode);
		const modifiedBytes = new TextEncoder().encode(modifiedCode);

		const originalStart = originalCode.indexOf("function test");
		const originalEnd = originalCode.length;
		const nodeDigest = computeSha256(originalCode.slice(originalStart, originalEnd));

		const anchor: Anchor = {
			anchor_id: "anc_moved",
			file_id: "file:src/test.ts",
			structural_selector: "function:test",
			expected_content_digest: computeSha256(originalBytes),
			expected_node_digest: nodeDigest,
			source_range: [originalStart, originalEnd],
		};

		const resolution = resolveAnchor(anchor, modifiedBytes);
		assert.equal(resolution.status, "MOVED");
		if (resolution.status === "MOVED") {
			assert.equal(resolution.evidence, "SIGNATURE_MATCH");
			const expectedNewStart = modifiedCode.indexOf("function test");
			assert.equal(resolution.range[0], expectedNewStart);
		}
	});

	it("reports NOT_FOUND when selector does not match any element", () => {
		const code = `export const pi = 3.14;`;
		const bytes = new TextEncoder().encode(code);

		const anchor: Anchor = {
			anchor_id: "anc_not_found",
			file_id: "file:src/math.ts",
			structural_selector: "function:calculateArea",
			expected_content_digest: computeSha256(bytes),
			source_range: [0, 5],
		};

		const resolution = resolveAnchor(anchor, bytes);
		assert.equal(resolution.status, "NOT_FOUND");
	});

	it("resolves default exports cleanly (export:default)", () => {
		const code = `
export default function login() {
  return "ok";
}
`;
		const bytes = new TextEncoder().encode(code);
		const anchor: Anchor = {
			anchor_id: "anc_default",
			file_id: "file:src/login.ts",
			structural_selector: "export:default",
			expected_content_digest: "some_digest",
			source_range: [0, 10],
		};

		const resolution = resolveAnchor(anchor, bytes);
		assert.ok(resolution.status === "RESOLVED_UNIQUE" || resolution.status === "MOVED");
	});
});
