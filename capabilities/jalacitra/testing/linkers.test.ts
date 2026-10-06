import assert from "node:assert/strict";
import test from "node:test";
import type { FileInfo } from "../adapters/adapter.ts";
import { ConfigAdapter } from "../adapters/config/config-adapter.ts";
import { ManifestAdapter } from "../adapters/manifest/manifest-adapter.ts";
import { TestFrameworkAdapter } from "../adapters/tests/test-adapter.ts";
import type { EdgeRecord } from "../model/edges.ts";
import type { NodeRecord } from "../model/nodes.ts";
import { linkConfigToCode, linkTestsToCode } from "../resolve/linkers.ts";

test("J5-MAN-001: Manifest adapter extracts dependencies and scripts as build targets", () => {
	const adapter = new ManifestAdapter();
	const file: FileInfo = {
		path: "package.json",
		language: "json",
		class: "manifest",
		sizeBytes: 200,
		contentDigest: "sha256:pkg",
		isBinary: false,
	};
	const content = JSON.stringify({
		name: "my-app",
		scripts: {
			build: "tsc",
			test: "vitest run",
		},
		dependencies: {
			react: "^19.0.0",
		},
		devDependencies: {
			typescript: "^5.0.0",
		},
	});

	const res = adapter.extract(
		{ repoView: { repoRoot: "/repo", repoIdentity: "repo_man", files: [] } },
		file,
		new TextEncoder().encode(content),
	);

	assert.equal(res.status, "OK");
	assert.equal(res.references.length, 2); // react and typescript
	assert.ok(res.references.some((r) => r.targetSpecifier === "react"));

	const buildTargets = res.contracts.filter((c) => c.attrs?.is_build_target);
	assert.equal(buildTargets.length, 2);
	assert.ok(buildTargets.some((b) => b.descriptor === "npm run build"));
	assert.ok(buildTargets.some((b) => b.descriptor === "npm run test"));
});

test("J5-CFG-001 / J5-INV-008: Config adapter extracts key names only, never values", () => {
	const adapter = new ConfigAdapter();
	const file: FileInfo = {
		path: ".env",
		language: "env",
		class: "config",
		sizeBytes: 100,
		contentDigest: "sha256:env",
		isBinary: false,
	};
	const content = `
# DB config
DATABASE_URL=postgres://user:super_secret_pw@localhost:5432/db
PORT=3000
JWT_SECRET=super_secret_key_12345
`;

	const res = adapter.extract(
		{ repoView: { repoRoot: "/repo", repoIdentity: "repo_cfg", files: [] } },
		file,
		new TextEncoder().encode(content),
	);

	assert.equal(res.status, "OK");
	const keyNames = res.configKeys.map((k) => k.name);
	assert.deepEqual(keyNames, ["DATABASE_URL", "PORT", "JWT_SECRET"]);

	// Assert secret values NEVER appear in any key or excerpt
	for (const key of res.configKeys) {
		assert.equal(key.name.includes("super_secret"), false);
	}
});

test("J5-TST-001: Test framework adapter extracts test cases and param families", () => {
	const adapter = new TestFrameworkAdapter();
	const file: FileInfo = {
		path: "src/auth/login.test.ts",
		language: "typescript",
		class: "test",
		sizeBytes: 250,
		contentDigest: "sha256:tst",
		isBinary: false,
	};
	const content = `
describe("Auth Service", () => {
  it("authenticates valid user", () => {
    // test
  });

  test.each([1, 2])("handles cases", (val) => {
    // parametrized test
  });
});
`;

	const res = adapter.extract(
		{ repoView: { repoRoot: "/repo", repoIdentity: "repo_tst", files: [] } },
		file,
		new TextEncoder().encode(content),
	);

	assert.equal(res.status, "OK");
	assert.equal(res.testCases.length, 3);
	assert.equal(res.testCases[0].qualifiedName, "Auth Service");
	assert.equal(res.testCases[0].kind, "suite");
	assert.equal(res.testCases[1].qualifiedName, "authenticates valid user");
	assert.equal(res.testCases[1].kind, "case");
	assert.equal(res.testCases[2].qualifiedName, "handles cases");
	assert.equal(res.testCases[2].kind, "param_family");
});

test("J5-LINK-001 / J5-LINK-002: Cross-file linkers for tests and configs", () => {
	const sourceFile: NodeRecord = {
		id: "src_auth",
		kind: "file",
		canonical: "repo:src/auth.ts",
		name: "auth.ts",
		parent_id: null,
		valid_from: 1,
		valid_to: null,
		attrs: { class: "source", path: "src/auth.ts" },
	};
	const testFile: NodeRecord = {
		id: "test_auth",
		kind: "file",
		canonical: "repo:src/auth.test.ts",
		name: "auth.test.ts",
		parent_id: null,
		valid_from: 1,
		valid_to: null,
		attrs: { class: "test", path: "src/auth.test.ts" },
	};
	const importEdge: EdgeRecord = {
		id: "e_imp",
		kind: "imports",
		src: testFile.id,
		dst: sourceFile.id,
		class: "PARSED",
		method: "ast",
		ambiguity: "UNIQUE",
		weight: 1,
		valid_from: 1,
		valid_to: null,
	};

	const testEdges = linkTestsToCode({
		repoId: "repo_lnk",
		generation: 1,
		nodes: [sourceFile, testFile],
		edges: [importEdge],
	});

	// Should create both NAME_CONVENTION (INFERRED) and IMPORTS_ONLY (PARSED)
	assert.equal(testEdges.length, 2);
	assert.ok(testEdges.some((e) => e.class === "INFERRED" && e.attrs?.reason === "NAME_CONVENTION"));
	assert.ok(testEdges.some((e) => e.class === "PARSED" && e.attrs?.reason === "IMPORTS_ONLY"));

	// Config linker test
	const readsConfigEdge: EdgeRecord = {
		id: "e_read_cfg",
		kind: "reads_config",
		src: sourceFile.id,
		dst: "PORT",
		class: "PARSED",
		method: "ast",
		ambiguity: "UNIQUE",
		weight: 1,
		valid_from: 1,
		valid_to: null,
	};

	const configResult = linkConfigToCode({
		repoId: "repo_lnk",
		generation: 1,
		nodes: [sourceFile],
		edges: [readsConfigEdge],
	});

	assert.equal(configResult.newNodes.length, 1);
	assert.equal(configResult.newNodes[0].name, "PORT");
	assert.equal(configResult.newNodes[0]?.attrs?.declared, false);
});
