// Jālacitra Equivalence Test Harness (Part K2, J5-INC-005, J5-INV-011)

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IndexUpdatePipeline } from "../invalidate/update-pipeline.ts";
import { JalacitraStore } from "../store/store.ts";

test("J5-INC-005 / J5-INV-011: Incremental update equals clean full rebuild across edit sequences", () => {
	const fixtureDir = join(tmpdir(), `jalacitra_equiv_test_${Date.now()}`);
	mkdirSync(fixtureDir, { recursive: true });

	const pipeline = new IndexUpdatePipeline();
	const incStore = new JalacitraStore(":memory:", "repo_equiv");
	const fullStore = new JalacitraStore(":memory:", "repo_equiv");

	try {
		// Stage 1: Initial files
		mkdirSync(join(fixtureDir, "src"), { recursive: true });
		writeFileSync(
			join(fixtureDir, "src", "math.ts"),
			`export function add(a: number, b: number): number { return a + b; }`,
		);
		writeFileSync(join(fixtureDir, "src", "utils.ts"), `export function log(msg: string): void {}`);
		writeFileSync(
			join(fixtureDir, "src", "app.ts"),
			`import { add } from "./math";
import { log } from "./utils";
export function run(): void { add(1, 2); log("done"); }`,
		);
		writeFileSync(
			join(fixtureDir, "package.json"),
			JSON.stringify({ name: "test-app", scripts: { start: "node app.js" } }),
		);

		// Build Gen 1
		const b1 = pipeline.buildFullOrIncremental(incStore, {
			repoRoot: fixtureDir,
			repoIdentity: "repo_equiv",
		});
		if (!b1.success) console.error("b1 failed:", b1.abortedReason);
		assert.equal(b1.success, true);
		assert.equal(b1.generation, 1);

		// Stage 2: Edit math.ts (add function sub)
		writeFileSync(
			join(fixtureDir, "src", "math.ts"),
			`export function add(a: number, b: number): number { return a + b; }
export function sub(a: number, b: number): number { return a - b; }`,
		);
		const b2 = pipeline.buildFullOrIncremental(incStore, {
			repoRoot: fixtureDir,
			repoIdentity: "repo_equiv",
		});
		assert.equal(b2.success, true);
		assert.equal(b2.generation, 2);

		// Stage 3: Add new file service.ts
		writeFileSync(
			join(fixtureDir, "src", "service.ts"),
			`import { sub } from "./math";
export function execute(): void { sub(10, 5); }`,
		);
		const b3 = pipeline.buildFullOrIncremental(incStore, {
			repoRoot: fixtureDir,
			repoIdentity: "repo_equiv",
		});
		assert.equal(b3.success, true);
		assert.equal(b3.generation, 3);

		// Stage 4: Modify app.ts to call sub instead of add
		writeFileSync(
			join(fixtureDir, "src", "app.ts"),
			`import { sub } from "./math";
export function run(): void { sub(5, 2); }`,
		);
		const b4 = pipeline.buildFullOrIncremental(incStore, {
			repoRoot: fixtureDir,
			repoIdentity: "repo_equiv",
		});
		assert.equal(b4.success, true);
		assert.equal(b4.generation, 4);

		// Stage 5: Delete utils.ts
		rmSync(join(fixtureDir, "src", "utils.ts"), { force: true });
		const b5 = pipeline.buildFullOrIncremental(incStore, {
			repoRoot: fixtureDir,
			repoIdentity: "repo_equiv",
		});
		assert.equal(b5.success, true);
		assert.equal(b5.generation, 5);

		// Stage 6: Clean full rebuild from scratch in fullStore
		const bFull = pipeline.buildFullOrIncremental(fullStore, {
			repoRoot: fixtureDir,
			repoIdentity: "repo_equiv",
		});
		assert.equal(bFull.success, true);
		assert.equal(bFull.generation, 1);

		// 7. Verify Equivalence between incStore (Gen 5) and fullStore (Gen 1)
		// Compare Nodes:
		const incNodes = incStore.findNodesByKind("file", 5).concat(incStore.findNodesByKind("symbol", 5));
		const fullNodes = fullStore.findNodesByKind("file", 1).concat(fullStore.findNodesByKind("symbol", 1));

		const incCanonicalSet = new Set(incNodes.map((n) => `${n.kind}:${n.canonical}`));
		const fullCanonicalSet = new Set(fullNodes.map((n) => `${n.kind}:${n.canonical}`));

		assert.deepEqual(
			Array.from(incCanonicalSet).sort(),
			Array.from(fullCanonicalSet).sort(),
			"Current generation nodes in incremental graph must exactly match full rebuild graph",
		);

		// Compare Edges:
		const incEdgeTuples = incStore.rawDb
			.prepare(
				`SELECT e.kind, sn.canonical as src_canonical, dn.canonical as dst_canonical, e.class, e.ambiguity
				 FROM edges e
				 JOIN nodes sn ON e.src = sn.id
				 JOIN nodes dn ON e.dst = dn.id
				 WHERE e.valid_to IS NULL`,
			)
			.all() as Array<Record<string, unknown>>;

		const fullEdgeTuples = fullStore.rawDb
			.prepare(
				`SELECT e.kind, sn.canonical as src_canonical, dn.canonical as dst_canonical, e.class, e.ambiguity
				 FROM edges e
				 JOIN nodes sn ON e.src = sn.id
				 JOIN nodes dn ON e.dst = dn.id
				 WHERE e.valid_to IS NULL`,
			)
			.all() as Array<Record<string, unknown>>;

		const formatEdge = (r: Record<string, unknown>) =>
			`${r.kind}|${r.src_canonical}|${r.dst_canonical}|${r.class}|${r.ambiguity}`;

		const incEdgeStrings = incEdgeTuples.map(formatEdge).sort();
		const fullEdgeStrings = fullEdgeTuples.map(formatEdge).sort();

		assert.deepEqual(
			incEdgeStrings,
			fullEdgeStrings,
			"Current generation edges in incremental graph must exactly match full rebuild graph",
		);
	} finally {
		incStore.close();
		fullStore.close();
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});
