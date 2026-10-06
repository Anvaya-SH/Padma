import assert from "node:assert/strict";
import test from "node:test";
import type { EdgeRecord } from "../model/edges.ts";
import type { NodeRecord } from "../model/nodes.ts";
import { evaluateShrinkGuard } from "../store/shrink-guard.ts";
import { JalacitraStore } from "../store/store.ts";

test("J5-STORE-001: Store initialization and integrity check", () => {
	const store = new JalacitraStore(":memory:", "repo_test_init");
	const check = store.runIntegrityCheck();
	assert.equal(check.ok, true, `Integrity check should be ok: ${JSON.stringify(check)}`);
	assert.equal(check.foreignKeyViolations, 0);

	store.setMeta("test_key", "test_val");
	assert.equal(store.getMeta("test_key"), "test_val");
	assert.equal(store.getMeta("repo_identity"), "repo_test_init");
	store.close();
});

test("J5-STORE-002: Schema CHECK constraints enforcement", () => {
	const store = new JalacitraStore(":memory:");
	const gen = store.mintGeneration(null, null, "commit1", false, "fp1", "Initial gen");

	const node1: NodeRecord = {
		id: "n1",
		kind: "symbol",
		canonical: "repo:file1.ts#fn",
		name: "fn",
		parent_id: null,
		valid_from: gen,
		valid_to: null,
		attrs: { symbol_kind: "function" },
	};
	const node2: NodeRecord = {
		id: "n2",
		kind: "symbol",
		canonical: "repo:file2.ts#caller",
		name: "caller",
		parent_id: null,
		valid_from: gen,
		valid_to: null,
		attrs: { symbol_kind: "function" },
	};
	store.insertNode(node1);
	store.insertNode(node2);

	// 1. RUNTIME_CONFIRMED requires evidence_ref
	assert.throws(
		() => {
			const invalidEdge: EdgeRecord = {
				id: "e_err1",
				kind: "calls",
				src: "n1",
				dst: "n2",
				class: "RUNTIME_CONFIRMED",
				method: "v8_profiler",
				evidence_ref: null, // Violated: must be NOT NULL
				ambiguity: "UNIQUE",
				weight: 1,
				valid_from: gen,
				valid_to: null,
			};
			store.insertEdge(invalidEdge);
		},
		{
			name: "Error",
		},
	);

	// 2. observed_at_runtime requires class = RUNTIME_CONFIRMED
	assert.throws(
		() => {
			const invalidEdge: EdgeRecord = {
				id: "e_err2",
				kind: "observed_at_runtime",
				src: "n1",
				dst: "n2",
				class: "PARSED", // Violated: must be RUNTIME_CONFIRMED
				method: "ast",
				ambiguity: "UNIQUE",
				weight: 1,
				valid_from: gen,
				valid_to: null,
			};
			store.insertEdge(invalidEdge);
		},
		{
			name: "Error",
		},
	);

	// 3. Invalid ambiguity value
	assert.throws(
		() => {
			store.rawDb
				.prepare(
					`INSERT INTO edges (id, kind, src, dst, class, method, ambiguity, valid_from)
					 VALUES ('e_bad_amb', 'calls', 'n1', 'n2', 'PARSED', 'ast', 'INVALID_AMB', ?)`,
				)
				.run(gen);
		},
		{
			name: "Error",
		},
	);

	// 4. Invalid JSON in attrs
	assert.throws(
		() => {
			store.rawDb
				.prepare(
					`INSERT INTO nodes (id, kind, canonical, valid_from, attrs)
					 VALUES ('n_bad_json', 'file', 'canonical:bad', ?, 'INVALID_JSON')`,
				)
				.run(gen);
		},
		{
			name: "Error",
		},
	);

	// 5. Valid RUNTIME_CONFIRMED edge succeeds
	const validRuntimeEdge: EdgeRecord = {
		id: "e_valid_rt",
		kind: "observed_at_runtime",
		src: "n1",
		dst: "n2",
		class: "RUNTIME_CONFIRMED",
		method: "v8_coverage",
		evidence_ref: "coverage/cov.json#12",
		ambiguity: "UNIQUE",
		weight: 1,
		valid_from: gen,
		valid_to: null,
	};
	store.insertEdge(validRuntimeEdge);
	const retrieved = store.getEdge("e_valid_rt");
	assert.notEqual(retrieved, null);
	assert.equal(retrieved?.evidence_ref, "coverage/cov.json#12");

	store.close();
});

test("J5-STORE-003: Generation minting and node/edge temporal validity", () => {
	const store = new JalacitraStore(":memory:");
	const gen1 = store.mintGeneration(null, null, "c1", false, "cfg1", "Gen 1");
	assert.equal(gen1, 1);

	const node: NodeRecord = {
		id: "node_active_in_gen1_only",
		kind: "file",
		canonical: "repo:file_a.ts",
		name: "file_a.ts",
		parent_id: null,
		valid_from: gen1,
		valid_to: null,
	};
	store.insertNode(node);

	assert.notEqual(store.getNode("node_active_in_gen1_only", 1), null);

	const gen2 = store.mintGeneration(null, null, "c2", false, "cfg1", "Gen 2");
	assert.equal(gen2, 2);

	// Close node in gen 2 (active in gen 1, deleted in gen 2)
	store.closeNodes(["node_active_in_gen1_only"], gen2);

	// In gen 1, the node was valid
	assert.notEqual(store.getNode("node_active_in_gen1_only", 1), null);
	// In gen 2 or current, the node is closed
	assert.equal(store.getNode("node_active_in_gen1_only", 2), null);
	assert.equal(store.getNode("node_active_in_gen1_only"), null);

	store.close();
});

test("J5-STORE-004: Build Journal and crash recovery", () => {
	const store = new JalacitraStore(":memory:");
	const journal = store.journal;

	// Start two builds
	journal.start("build-1", 10, "idem-1");
	journal.updateProgress("build-1", 5);
	journal.start("build-2", 20, "idem-2");

	// Commit build 1
	journal.commit("build-1");
	assert.equal(journal.find("build-1")?.state, "COMMITTED");

	// Build 2 remains in PLANNED
	assert.equal(journal.find("build-2")?.state, "PLANNED");

	// Simulate crash recovery
	const recovery = journal.recoverInterrupted();
	assert.equal(recovery.abortedCount, 1);
	assert.equal(journal.find("build-2")?.state, "ABORTED");
	assert.equal(journal.find("build-1")?.state, "COMMITTED");

	store.close();
});

test("J5-STORE-005: Shrink Guard evaluation", () => {
	// Normal drop within limits (<30% nodes, <40% edges)
	const evalNormal = evaluateShrinkGuard(100, 85, 100, 75, 10, 1);
	assert.equal(evalNormal.allowed, true);

	// Sudden catastrophic drop without file removals: 100 -> 50 nodes (50% drop > 30% limit)
	const evalDrop = evaluateShrinkGuard(100, 50, 100, 50, 10, 0);
	assert.equal(evalDrop.allowed, false);
	assert.match(evalDrop.reason ?? "", /Shrink guard refused/);

	// Catastrophic drop with corresponding file removals: 10 of 12 files removed
	const evalLegit = evaluateShrinkGuard(100, 50, 100, 50, 12, 10);
	assert.equal(evalLegit.allowed, true);

	// Catastrophic drop with explicit override reason
	const evalOverride = evaluateShrinkGuard(100, 10, 100, 10, 10, 0, undefined, "Refactoring entire repo");
	assert.equal(evalOverride.allowed, true);
});

test("J5-STORE-006: Prune historical generations", () => {
	const store = new JalacitraStore(":memory:");
	const gen1 = store.mintGeneration(null, null, "c1", false, "cfg1");
	const gen2 = store.mintGeneration(null, null, "c2", false, "cfg1");
	const gen3 = store.mintGeneration(null, null, "c3", false, "cfg1");

	// Node valid in gen 1 only
	store.insertNode({
		id: "n_old",
		kind: "file",
		canonical: "repo:old.ts",
		valid_from: gen1,
		valid_to: gen2,
	});

	// Node valid in gen 2 and gen 3
	store.insertNode({
		id: "n_mid",
		kind: "file",
		canonical: "repo:mid.ts",
		valid_from: gen2,
		valid_to: gen3,
	});

	// Node valid in gen 3 onwards
	store.insertNode({
		id: "n_curr",
		kind: "file",
		canonical: "repo:curr.ts",
		valid_from: gen3,
		valid_to: null,
	});

	// Prune keepLastGenerations = 1 (only gen 3 kept)
	const pruneResult = store.pruneGenerations(1);
	assert.equal(pruneResult.prunedGenerations.length, 2);
	assert.ok(pruneResult.deletedNodes >= 1);

	// Old node is gone completely
	assert.equal(store.getNode("n_old", gen1), null);
	// Current node is still present
	assert.notEqual(store.getNode("n_curr"), null);

	store.close();
});
