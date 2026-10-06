import assert from "node:assert/strict";
import test from "node:test";
import type { FileInfo } from "../adapters/adapter.ts";
import { TypeScriptAdapter } from "../adapters/typescript/ts-adapter.ts";
import { resolveGraph } from "../resolve/resolver.ts";

test("J5-TS-001 / J5-TS-002: TypeScript AST extraction of declarations, calls, and blind spots", () => {
	const adapter = new TypeScriptAdapter();
	const file: FileInfo = {
		path: "src/service.ts",
		language: "typescript",
		class: "source",
		sizeBytes: 400,
		contentDigest: "sha256:service_ts",
		isBinary: false,
	};

	const code = `
import { logger } from "./logger";
import defaultHelper from "./helper";

export interface Config {
  port: number;
}

export class Service {
  constructor(private readonly config: Config) {}

  public start(): void {
    logger.info("Starting service");
    const port = process.env.PORT || "8080";
    eval("console.log('danger')");
    const dynamicKey = "foo";
    const x = (this as any)[dynamicKey]();
  }
}

export function createService(cfg: Config): Service {
  return new Service(cfg);
}
`;

	const bytes = new TextEncoder().encode(code);
	const res = adapter.extract(
		{ repoView: { repoRoot: "/repo", repoIdentity: "repo_ts", files: ["src/service.ts"] } },
		file,
		bytes,
	);

	assert.equal(res.status, "OK");

	// Declarations check
	const declNames = res.declarations.map((d) => d.name);
	assert.ok(declNames.includes("Config"));
	assert.ok(declNames.includes("Service"));
	assert.ok(declNames.includes("constructor"));
	assert.ok(declNames.includes("config")); // parameter property
	assert.ok(declNames.includes("start"));
	assert.ok(declNames.includes("createService"));

	// References check
	const imports = res.references.filter((r) => r.referenceKind === "imports");
	assert.equal(imports.length, 2);
	assert.ok(imports.some((r) => r.targetSpecifier === "./logger"));
	assert.ok(imports.some((r) => r.targetSpecifier === "./helper"));

	// Config keys check
	assert.equal(res.configKeys.length, 1);
	assert.equal(res.configKeys[0].name, "PORT");
	assert.equal(res.configKeys[0].scope, "env_var");

	// Blind spots check
	assert.ok((res.blindSpots.EVAL_OR_EXEC ?? 0) >= 1);
	assert.ok((res.blindSpots.DYNAMIC_DISPATCH ?? 0) >= 1);
});

test("J5-RES-001 / J5-RES-002: Multi-file resolution and graph linking", () => {
	const adapter = new TypeScriptAdapter();

	// File A: math.ts
	const fileA: FileInfo = {
		path: "src/math.ts",
		language: "typescript",
		class: "source",
		sizeBytes: 150,
		contentDigest: "sha256:math_ts",
		isBinary: false,
	};
	const codeA = `
export function add(a: number, b: number): number {
  return a + b;
}
`;
	const resA = adapter.extract(
		{ repoView: { repoRoot: "/repo", repoIdentity: "repo_res", files: [] } },
		fileA,
		new TextEncoder().encode(codeA),
	);

	// File B: app.ts
	const fileB: FileInfo = {
		path: "src/app.ts",
		language: "typescript",
		class: "source",
		sizeBytes: 200,
		contentDigest: "sha256:app_ts",
		isBinary: false,
	};
	const codeB = `
import { add } from "./math";

export function main(): void {
  const sum = add(5, 10);
  const host = process.env.HOST;
}
`;
	const resB = adapter.extract(
		{ repoView: { repoRoot: "/repo", repoIdentity: "repo_res", files: [] } },
		fileB,
		new TextEncoder().encode(codeB),
	);

	// Resolve graph
	const resolved = resolveGraph("repo_res", 1, [
		{ file: fileA, result: resA },
		{ file: fileB, result: resB },
	]);

	// Assert nodes
	const nodeKinds = resolved.nodes.map((n) => n.kind);
	assert.ok(nodeKinds.includes("file"));
	assert.ok(nodeKinds.includes("symbol"));
	assert.ok(nodeKinds.includes("config_key"));

	// Assert edges
	const edgeKinds = resolved.edges.map((e) => e.kind);
	assert.ok(edgeKinds.includes("declares"));
	assert.ok(edgeKinds.includes("imports"));
	assert.ok(edgeKinds.includes("calls"));
	assert.ok(edgeKinds.includes("reads_config"));

	// Find the calls edge from app.ts to add symbol
	const callsEdge = resolved.edges.find((e) => e.kind === "calls");
	assert.notEqual(callsEdge, undefined);
	assert.equal(callsEdge?.ambiguity, "UNIQUE");
	assert.equal(callsEdge?.class, "PARSED");

	// Find the imports edge from app.ts to math.ts
	const importsEdge = resolved.edges.find((e) => e.kind === "imports");
	assert.notEqual(importsEdge, undefined);
	assert.equal(importsEdge?.class, "PARSED");
});

test("J5-AMB-001 / J5-AMB-002: Ambiguity multi-candidate grouping", () => {
	const adapter = new TypeScriptAdapter();

	// File A: util1.ts exports format
	const fileA: FileInfo = {
		path: "src/util1.ts",
		language: "typescript",
		class: "source",
		sizeBytes: 100,
		contentDigest: "sha256:u1",
		isBinary: false,
	};
	const codeA = `export function format(): string { return "1"; }`;
	const resA = adapter.extract(
		{ repoView: { repoRoot: "/repo", repoIdentity: "repo_amb", files: [] } },
		fileA,
		new TextEncoder().encode(codeA),
	);

	// File B: util2.ts exports format
	const fileB: FileInfo = {
		path: "src/util2.ts",
		language: "typescript",
		class: "source",
		sizeBytes: 100,
		contentDigest: "sha256:u2",
		isBinary: false,
	};
	const codeB = `export function format(): string { return "2"; }`;
	const resB = adapter.extract(
		{ repoView: { repoRoot: "/repo", repoIdentity: "repo_amb", files: [] } },
		fileB,
		new TextEncoder().encode(codeB),
	);

	// File C: consumer.ts imports both
	const fileC: FileInfo = {
		path: "src/consumer.ts",
		language: "typescript",
		class: "source",
		sizeBytes: 150,
		contentDigest: "sha256:c",
		isBinary: false,
	};
	const codeC = `
import { format } from "./util1";
import { format } from "./util2";

export function run(): void {
  format();
}
`;
	const resC = adapter.extract(
		{ repoView: { repoRoot: "/repo", repoIdentity: "repo_amb", files: [] } },
		fileC,
		new TextEncoder().encode(codeC),
	);

	const resolved = resolveGraph("repo_amb", 1, [
		{ file: fileA, result: resA },
		{ file: fileB, result: resB },
		{ file: fileC, result: resC },
	]);

	const multiEdges = resolved.edges.filter((e) => e.kind === "calls" && e.ambiguity === "MULTI");
	assert.equal(multiEdges.length, 2);
	assert.equal(multiEdges[0].candidate_group, multiEdges[1].candidate_group);
	assert.equal(multiEdges[0].candidate_reason, "EXPORTED_MATCH");
});

test("J5-RES-004: Unresolved module import creates unresolved_ref node", () => {
	const adapter = new TypeScriptAdapter();
	const file: FileInfo = {
		path: "src/broken.ts",
		language: "typescript",
		class: "source",
		sizeBytes: 80,
		contentDigest: "sha256:brk",
		isBinary: false,
	};
	const code = `import { nonexistent } from "./nonexistent";`;
	const res = adapter.extract(
		{ repoView: { repoRoot: "/repo", repoIdentity: "repo_unres", files: [] } },
		file,
		new TextEncoder().encode(code),
	);

	const resolved = resolveGraph("repo_unres", 1, [{ file, result: res }]);

	const unresNode = resolved.nodes.find((n) => n.kind === "unresolved_ref");
	assert.notEqual(unresNode, undefined);
	assert.equal(unresNode?.attrs?.reason_code, "NO_SUCH_MODULE");

	const unresEdge = resolved.edges.find((e) => e.kind === "unresolved_to");
	assert.notEqual(unresEdge, undefined);
	assert.equal(unresEdge?.ambiguity, "UNRESOLVED");
});
