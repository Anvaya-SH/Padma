// Jālacitra Query Engine & Truthfulness/Freshness Test Suite (Part M, Part S1.5, Part S1.6)

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAtlas } from "../api/atlas.ts";

function createTestDir(name: string): string {
	const dir = join(tmpdir(), `jalacitra-query-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

test("J5-MISS-001: Missing index read returns INDEX_ABSENT without silent full build", () => {
	const root = createTestDir("missing-index");
	const dbPath = join(root, "non-existent.sqlite");
	const atlas = createAtlas({ dbPath, repoRoot: root, repoIdentity: "test-missing-repo" });

	try {
		const res = atlas.resolveSymbol({ name: "someFunction" });
		assert.equal(res.freshness.downgrade_reason, "INDEX_ABSENT");
		assert.equal(res.coverage.completeness, "UNKNOWN");
		assert.equal(res.data, null);
		assert.equal(res.negative_evidence.length, 1);
		assert.equal(res.negative_evidence[0].result, "INDEX_ABSENT");
	} finally {
		atlas.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("atlas.ensure_index and atlas.status full lifecycle", () => {
	const root = createTestDir("lifecycle");
	const dbPath = join(root, "store.sqlite");

	// Create sample project files
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify(
			{
				name: "demo-pkg",
				version: "1.0.0",
				scripts: { build: "tsc -b" },
				dependencies: { express: "^4.18.0" },
				devDependencies: { vitest: "^1.0.0" },
			},
			null,
			2,
		),
	);

	writeFileSync(
		join(root, "service.ts"),
		`
export function calculate(a: number, b: number): number {
	return a + b;
}

export class Calculator {
	add(x: number, y: number): number {
		return calculate(x, y);
	}
}
`,
	);

	writeFileSync(
		join(root, "service.test.ts"),
		`
import { calculate, Calculator } from "./service.ts";

test("calculates addition", () => {
	expect(calculate(2, 3)).toBe(5);
	const c = new Calculator();
	expect(c.add(1, 2)).toBe(3);
});
`,
	);

	writeFileSync(
		join(root, ".env"),
		`
PORT=3000
DATABASE_URL=postgres://localhost:5432/db
`,
	);

	const atlas = createAtlas({ dbPath, repoRoot: root, repoIdentity: "lifecycle-repo" });

	try {
		// Status before build
		const preStatus = atlas.status();
		assert.equal(preStatus.data.store_exists, false);

		// Ensure index
		const buildRes = atlas.ensureIndex();
		assert.equal(buildRes.data.status, "UPDATED");
		assert.equal(buildRes.data.generation, 1);
		assert(buildRes.data.nodes_count > 0);
		assert(buildRes.data.edges_count > 0);

		// Status after build
		const postStatus = atlas.status();
		assert.equal(postStatus.data.store_exists, true);
		assert.equal(postStatus.data.index_generation, 1);
		assert(postStatus.data.total_nodes > 0);
		assert(postStatus.data.total_edges > 0);
		assert(postStatus.data.languages.some((l) => l.language === "typescript"));
	} finally {
		atlas.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("atlas.resolve_symbol: exact matches, ambiguity policies, and negative evidence", () => {
	const root = createTestDir("resolve-symbol");
	const dbPath = join(root, "store.sqlite");

	writeFileSync(
		join(root, "math.ts"),
		`
export function compute(x: number): number { return x * 2; }
`,
	);
	writeFileSync(
		join(root, "worker.ts"),
		`
export function compute(msg: string): string { return msg.toUpperCase(); }
`,
	);

	const atlas = createAtlas({ dbPath, repoRoot: root, repoIdentity: "resolve-repo" });

	try {
		atlas.ensureIndex();

		// REPORT policy: returns both compute functions
		const reportRes = atlas.resolveSymbol({ name: "compute", ambiguity_policy: "REPORT" });
		assert.equal(reportRes.data.length, 2);
		assert.equal(reportRes.negative_evidence.length, 0);

		// STRICT policy: ambiguity detected, returns empty with negative evidence
		const strictRes = atlas.resolveSymbol({ name: "compute", ambiguity_policy: "STRICT" });
		assert.equal(strictRes.data.length, 0);
		assert.equal(strictRes.negative_evidence.length, 1);
		assert(strictRes.negative_evidence[0].result.includes("AMBIGUOUS_2_CANDIDATES"));

		// BEST_EFFORT policy: returns single highest ranked candidate
		const bestRes = atlas.resolveSymbol({ name: "compute", ambiguity_policy: "BEST_EFFORT" });
		assert.equal(bestRes.data.length, 1);

		// Non-existent symbol: returns empty with negative evidence
		const missingRes = atlas.resolveSymbol({ name: "doesNotExist" });
		assert.equal(missingRes.data.length, 0);
		assert.equal(missingRes.negative_evidence.length, 1);
		assert.equal(missingRes.negative_evidence[0].result, "NO_MATCH");
	} finally {
		atlas.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("atlas.locate and freshness verification (J5-INC-001, Part S1.6)", () => {
	const root = createTestDir("locate-freshness");
	const dbPath = join(root, "store.sqlite");
	const filePath = join(root, "util.ts");

	writeFileSync(filePath, `export function helper(): string { return "ok"; }`);

	const atlas = createAtlas({ dbPath, repoRoot: root, repoIdentity: "freshness-repo" });

	try {
		atlas.ensureIndex();

		// Locate with live verification when unmodified -> delivered: "live"
		const loc1 = atlas.locate({ file_path: "util.ts" }, { freshness: "live" });
		assert.equal(loc1.freshness.delivered, "live");
		assert.equal(loc1.data.verified_live, true);
		assert.notEqual(loc1.data.node, null);
		assert.notEqual(loc1.data.location, null);

		// Modify file on disk without re-indexing
		writeFileSync(filePath, `export function helper(): string { return "MODIFIED"; }`);

		// Locate with live verification after modification -> delivered: "STALE", downgrade: SOURCE_CHANGED
		const loc2 = atlas.locate({ file_path: "util.ts" }, { freshness: "live" });
		assert.equal(loc2.freshness.delivered, "STALE");
		assert.equal(loc2.freshness.downgrade_reason, "SOURCE_CHANGED");
		assert.equal(loc2.data.verified_live, false);

		// Locate with current_generation -> delivered: "FRESH", serves stored row
		const loc3 = atlas.locate({ file_path: "util.ts" }, { freshness: "current_generation" });
		assert.equal(loc3.freshness.delivered, "FRESH");

		// Delete file on disk
		rmSync(filePath);
		const loc4 = atlas.locate({ file_path: "util.ts" }, { freshness: "live" });
		assert.equal(loc4.freshness.delivered, "STALE");
		assert.equal(loc4.freshness.downgrade_reason, "SOURCE_REMOVED");
	} finally {
		atlas.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("atlas.neighbors: BFS, depth cap, and deterministic ordering", () => {
	const root = createTestDir("neighbors");
	const dbPath = join(root, "store.sqlite");

	writeFileSync(join(root, "a.ts"), `export function fnA() { return 1; }`);
	writeFileSync(join(root, "b.ts"), `import { fnA } from "./a.ts"; export function fnB() { return fnA(); }`);
	writeFileSync(join(root, "c.ts"), `import { fnB } from "./b.ts"; export function fnC() { return fnB(); }`);

	const atlas = createAtlas({ dbPath, repoRoot: root, repoIdentity: "neighbors-repo" });

	try {
		atlas.ensureIndex();

		const symB = atlas.resolveSymbol({ name: "fnB" }).data[0];
		assert(symB);

		// Depth 1 neighbors
		const n1 = atlas.neighbors({ node_id: symB.node.id, depth: 1 });
		assert(n1.data.nodes.length > 0);
		assert(n1.data.edges.length > 0);

		// Deterministic sort: nodes are ordered by kind, then canonical
		for (let i = 1; i < n1.data.nodes.length; i++) {
			const prev = n1.data.nodes[i - 1];
			const curr = n1.data.nodes[i];
			const cmp = prev.kind.localeCompare(curr.kind) || prev.canonical.localeCompare(curr.canonical);
			assert(cmp <= 0);
		}
	} finally {
		atlas.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("atlas.expand_impact: dependents traversal, hop grouping, and potential impact flag", () => {
	const root = createTestDir("impact");
	const dbPath = join(root, "store.sqlite");

	writeFileSync(join(root, "base.ts"), `export function core(): string { return "core"; }`);
	writeFileSync(join(root, "mid.ts"), `import { core } from "./base.ts"; export function middle() { return core(); }`);
	writeFileSync(join(root, "top.ts"), `import { middle } from "./mid.ts"; export function app() { return middle(); }`);

	const atlas = createAtlas({ dbPath, repoRoot: root, repoIdentity: "impact-repo" });

	try {
		atlas.ensureIndex();

		const coreSym = atlas.resolveSymbol({ name: "core" }).data[0];
		assert(coreSym);

		const impactRes = atlas.expandImpact({ symbol_id: coreSym.node.id, depth: 3 });

		// J5 requirement: impact_is_potential_not_proven MUST be true
		assert.equal(impactRes.data.impact_is_potential_not_proven, true);
		assert(impactRes.data.total_impacted_nodes >= 2);

		// Hop 1 should contain caller middle
		const hop1 = impactRes.data.items_by_hop[1] ?? [];
		assert(hop1.some((item) => item.node.canonical.includes("middle") || item.node.canonical.includes("mid.ts")));

		// Hop 2 should contain caller app
		const hop2 = impactRes.data.items_by_hop[2] ?? [];
		assert(hop2.some((item) => item.node.canonical.includes("app") || item.node.canonical.includes("top.ts")));
	} finally {
		atlas.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("atlas.find_relevant_tests: tests linking, ordering, and LOWER_BOUND completeness", () => {
	const root = createTestDir("find-tests");
	const dbPath = join(root, "store.sqlite");

	writeFileSync(join(root, "service.ts"), `export function processData(x: number) { return x * 10; }`);
	writeFileSync(
		join(root, "service.test.ts"),
		`
import { processData } from "./service.ts";
test("processes data", () => {
	expect(processData(5)).toBe(50);
});
`,
	);

	const atlas = createAtlas({ dbPath, repoRoot: root, repoIdentity: "tests-repo" });

	try {
		atlas.ensureIndex();

		const sym = atlas.resolveSymbol({ name: "processData" }).data[0];
		assert(sym);

		const testsRes = atlas.findRelevantTests({ changed_symbol_ids: [sym.node.id] });
		assert(testsRes.data.candidates.length >= 1);
		assert.equal(testsRes.data.candidates[0].class, "PARSED");
		assert(
			testsRes.data.candidates[0].reason.includes("IMPORTS_AND_CALLS") ||
				testsRes.data.candidates[0].reason.includes("TESTS"),
		);

		// Completeness must be LOWER_BOUND (never claims exact completeness)
		assert.equal(testsRes.coverage.completeness, "LOWER_BOUND");
		assert(testsRes.data.coverage_limitations.length > 0);
	} finally {
		atlas.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("atlas.path: shortest path tie breaking with provenance and canonical sort", () => {
	const root = createTestDir("path-search");
	const dbPath = join(root, "store.sqlite");

	writeFileSync(join(root, "x.ts"), `export function start() { return 1; }`);
	writeFileSync(join(root, "y.ts"), `import { start } from "./x.ts"; export function step() { return start(); }`);
	writeFileSync(join(root, "z.ts"), `import { step } from "./y.ts"; export function target() { return step(); }`);

	const atlas = createAtlas({ dbPath, repoRoot: root, repoIdentity: "path-repo" });

	try {
		atlas.ensureIndex();

		const startSym = atlas.resolveSymbol({ name: "start" }).data[0];
		const targetSym = atlas.resolveSymbol({ name: "target" }).data[0];
		assert(startSym && targetSym);

		// There is no forward edge from start to target (calls are backward: step calls start),
		// but step calls start and target calls step
		const pathRes = atlas.path({ from: targetSym.node.id, to: startSym.node.id, max_depth: 4 });
		assert.equal(pathRes.data.found, true);
		assert(pathRes.data.paths.length > 0);
		assert.equal(pathRes.data.paths[0].hops, 2);
	} finally {
		atlas.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("atlas.config_usage and atlas.dependencies", () => {
	const root = createTestDir("config-deps");
	const dbPath = join(root, "store.sqlite");

	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({
			name: "my-app",
			version: "2.0.0",
			dependencies: { lodash: "^4.17.21" },
		}),
	);

	writeFileSync(
		join(root, "server.ts"),
		`
const port = process.env.PORT || 8080;
console.log(port);
`,
	);

	writeFileSync(join(root, ".env"), `PORT=9000\nSECRET_KEY=123\n`);

	const atlas = createAtlas({ dbPath, repoRoot: root, repoIdentity: "config-deps-repo" });

	try {
		atlas.ensureIndex();

		// config_usage for PORT
		const cfgRes = atlas.configUsage({ key: "PORT" });
		assert.equal(cfgRes.data.key, "PORT");
		assert(cfgRes.data.declaring_files.length >= 1);
		assert(cfgRes.data.readers.length >= 1);
		assert.equal(cfgRes.data.read_but_not_declared, false);
		assert.equal(cfgRes.data.declared_but_not_read, false);

		// dependencies for package
		const depsRes = atlas.dependencies({ package_id: `pkg:config-deps-repo:npm:my-app` });
		assert(depsRes.data.dependencies.length >= 1);
		assert.equal(depsRes.data.dependencies[0].name, "lodash");
		assert.equal(depsRes.data.dependencies[0].resolved_version, null); // J5 requirement
	} finally {
		atlas.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("atlas.discard: requires explicit confirm=true and wipes cleanly", () => {
	const root = createTestDir("discard");
	const dbPath = join(root, "store.sqlite");

	writeFileSync(join(root, "index.ts"), `export const a = 1;`);

	const atlas = createAtlas({ dbPath, repoRoot: root, repoIdentity: "discard-repo" });

	try {
		atlas.ensureIndex();
		assert.equal(atlas.status().data.total_nodes > 0, true);

		// Discard without confirm -> refused
		const unconfirmed = atlas.discard({ scope: "all", confirm: false });
		assert.equal(unconfirmed.data.confirmed, false);
		assert.equal(unconfirmed.data.discarded, false);

		// Discard with confirm -> wiped
		const confirmed = atlas.discard({ scope: "all", confirm: true });
		assert.equal(confirmed.data.confirmed, true);
		assert.equal(confirmed.data.discarded, true);

		// Status after wipe
		assert.equal(atlas.status().data.total_nodes, 0);
	} finally {
		atlas.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("J5-TEST-TRUTHFULNESS: Blind spots cause LOWER_BOUND and never assert absence (Part S1.5)", () => {
	const root = createTestDir("truthfulness");
	const dbPath = join(root, "store.sqlite");

	// File with dynamic import, eval, dynamic dispatch, and computed property call
	writeFileSync(
		join(root, "dynamic.ts"),
		`
export class DynamicHandler {
	run(cmd: string, arg: unknown) {
		// 1. Dynamic dispatch on unannotated parameter
		(arg as any).execute();

		// 2. Eval
		eval("var x = 10;");

		// 3. String-based reference / computed call
		const targetName = "hiddenMethod";
		this[targetName]();

		// 4. Dynamic import
		import("./plugins/" + cmd);
	}

	hiddenMethod() {
		return "secret";
	}
}
`,
	);

	const atlas = createAtlas({ dbPath, repoRoot: root, repoIdentity: "truth-repo" });

	try {
		atlas.ensureIndex();

		const stat = atlas.status();
		const coverage = stat.coverage;

		// Must be LOWER_BOUND because of the dynamic blind spots
		assert.equal(coverage.completeness, "LOWER_BOUND");

		const blindSpots = coverage.known_blind_spots.map((b) => b.code);
		assert(blindSpots.includes("DYNAMIC_DISPATCH"), "Must record DYNAMIC_DISPATCH blind spot");
		assert(blindSpots.includes("EVAL_OR_EXEC"), "Must record EVAL_OR_EXEC blind spot");
		assert(blindSpots.includes("STRING_BASED_REFERENCE"), "Must record STRING_BASED_REFERENCE blind spot");
		assert(blindSpots.includes("DYNAMIC_IMPORT"), "Must record DYNAMIC_IMPORT blind spot");

		// Caller of hiddenMethod is invisible (called via this[targetName]())
		// Querying impact or callers of hiddenMethod:
		const hiddenSym = atlas.resolveSymbol({ name: "hiddenMethod" }).data[0];
		assert(hiddenSym);

		const impact = atlas.expandImpact({ symbol_id: hiddenSym.node.id });
		// Impact must be LOWER_BOUND because of blind spots in region
		assert.equal(impact.coverage.completeness, "LOWER_BOUND");
		assert(impact.data.blind_spots_in_region.STRING_BASED_REFERENCE > 0);
	} finally {
		atlas.close();
		rmSync(root, { recursive: true, force: true });
	}
});
