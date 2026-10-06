// Runtime Ingestion & Coverage Import Unit Tests (Step 14, J5-RT-001 through J5-RT-005)

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultRuntimeIngestion, type StoredEvidenceRecord } from "../runtime/runtime-ingestion.ts";
import { JalacitraStore } from "../store/store.ts";

test("J5-RT-001: Runtime observation requires valid evidence record (EVIDENCE_REQUIRED)", () => {
	const fixtureDir = join(tmpdir(), `jalacitra-rt-ev-${Date.now()}`);
	mkdirSync(fixtureDir, { recursive: true });
	const dbPath = join(fixtureDir, "store.sqlite");
	const store = new JalacitraStore(dbPath, "repo:rt-ev");

	try {
		// 1. Missing evidence throws EVIDENCE_REQUIRED
		assert.throws(() => {
			defaultRuntimeIngestion.recordRuntimeObservation(store, {
				repoIdentity: "repo:rt-ev",
				sourceNodeId: "node:1",
				targetNodeId: "node:2",
				generation: 1,
				evidence: null as unknown as StoredEvidenceRecord,
			});
		}, /EVIDENCE_REQUIRED/);

		// 2. Repository mismatch throws EVIDENCE_REQUIRED
		const mismatchedEvidence: StoredEvidenceRecord = {
			evidenceId: "ev:123",
			origin: "runtime_trace",
			targetRepoIdentity: "repo:other",
			artifactDigest: "abc",
			generation: 1,
		};
		assert.throws(() => {
			defaultRuntimeIngestion.recordRuntimeObservation(store, {
				repoIdentity: "repo:rt-ev",
				sourceNodeId: "node:1",
				targetNodeId: "node:2",
				generation: 1,
				evidence: mismatchedEvidence,
			});
		}, /EVIDENCE_REQUIRED.*mismatch/);
	} finally {
		store.close();
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test("J5-RT-002: Target missing at observation generation yields OBSERVATION_GENERATION_MISMATCH", () => {
	const fixtureDir = join(tmpdir(), `jalacitra-rt-gen-${Date.now()}`);
	mkdirSync(fixtureDir, { recursive: true });
	const dbPath = join(fixtureDir, "store.sqlite");
	const store = new JalacitraStore(dbPath, "repo:rt-gen");

	try {
		// Mint generations 1, 2, 3
		store.mintGeneration("1", null, null, false, "cfg");
		store.mintGeneration("2", null, null, false, "cfg");
		store.mintGeneration("3", null, null, false, "cfg");

		const rawDb = store.rawDb;

		// Insert source file node and file entry
		rawDb
			.prepare("INSERT INTO nodes (id, kind, canonical, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)")
			.run("node:source", "file", "canonical:source", 1, null);
		rawDb
			.prepare("INSERT INTO files (node_id, path, class, size_bytes, content_digest) VALUES (?, ?, ?, ?, ?)")
			.run("node:source", "src/source.ts", "source", 100, "dig-source");

		// Insert target node valid ONLY from generation 3
		rawDb
			.prepare("INSERT INTO nodes (id, kind, canonical, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)")
			.run("node:target", "function", "canonical:target", 3, null);

		const validEvidence: StoredEvidenceRecord = {
			evidenceId: "ev:trace-001",
			origin: "runtime_trace",
			targetRepoIdentity: "repo:rt-gen",
			artifactDigest: "digest-ok",
			generation: 1,
		};

		// Observation occurred at generation 1, where target did not exist!
		const result = defaultRuntimeIngestion.recordRuntimeObservation(store, {
			repoIdentity: "repo:rt-gen",
			sourceNodeId: "node:source",
			targetNodeId: "node:target",
			generation: 1,
			evidence: validEvidence,
		});

		assert.equal(result.success, false);
		assert.equal(result.reasonCode, "OBSERVATION_GENERATION_MISMATCH");
		assert.ok(result.unresolvedRefId);

		// Verify unresolved reference node and edge recorded in DB (J5-RT-002)
		const unresNode = rawDb.prepare("SELECT * FROM nodes WHERE kind = 'unresolved_ref'").get() as
			| { id: string; name: string }
			| undefined;
		assert.ok(unresNode);
		assert.equal(unresNode.name, "node:target");

		const unresEdge = rawDb.prepare("SELECT * FROM edges WHERE kind = 'unresolved_to'").get() as
			| { ambiguity: string; candidate_reason: string }
			| undefined;
		assert.ok(unresEdge);
		assert.equal(unresEdge.ambiguity, "UNRESOLVED");
		assert.equal(unresEdge.candidate_reason, "OBSERVATION_GENERATION_MISMATCH");
	} finally {
		store.close();
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test("J5-RT-003: RUNTIME_CONFIRMED edge validity is bounded to observation generation", () => {
	const fixtureDir = join(tmpdir(), `jalacitra-rt-edge-${Date.now()}`);
	mkdirSync(fixtureDir, { recursive: true });
	const dbPath = join(fixtureDir, "store.sqlite");
	const store = new JalacitraStore(dbPath, "repo:rt-edge");

	try {
		// Mint generations 1 and 2
		store.mintGeneration("1", null, null, false, "cfg");
		store.mintGeneration("2", null, null, false, "cfg");

		const rawDb = store.rawDb;

		// Insert nodes valid at generation 1
		rawDb
			.prepare("INSERT INTO nodes (id, kind, canonical, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)")
			.run("node:caller", "function", "canonical:caller", 1, null);
		rawDb
			.prepare("INSERT INTO nodes (id, kind, canonical, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)")
			.run("node:callee", "function", "canonical:callee", 1, null);

		const validEvidence: StoredEvidenceRecord = {
			evidenceId: "ev:trace-002",
			origin: "runtime_trace",
			targetRepoIdentity: "repo:rt-edge",
			artifactDigest: "digest-123",
			generation: 1,
		};

		const result = defaultRuntimeIngestion.recordRuntimeObservation(store, {
			repoIdentity: "repo:rt-edge",
			sourceNodeId: "node:caller",
			targetNodeId: "node:callee",
			kind: "calls",
			generation: 1,
			evidence: validEvidence,
		});

		assert.equal(result.success, true);
		assert.ok(result.edgeId);

		// Verify edge row in DB
		const edge = rawDb.prepare("SELECT * FROM edges WHERE id = ?").get(result.edgeId) as
			| Record<string, unknown>
			| undefined;
		assert.ok(edge);
		assert.equal(edge.class, "RUNTIME_CONFIRMED");
		assert.equal(edge.valid_from, 1);
		assert.equal(edge.valid_to, 2); // strictly closed at next generation (never carried forward)
		assert.equal(edge.evidence_ref, "ev:trace-002");
	} finally {
		store.close();
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test("J5-RT-004: Ingest existing test coverage artifact (LCOV) without running tests", () => {
	const fixtureDir = join(tmpdir(), `jalacitra-rt-cov-${Date.now()}`);
	mkdirSync(fixtureDir, { recursive: true });
	const dbPath = join(fixtureDir, "store.sqlite");
	const store = new JalacitraStore(dbPath, "repo:rt-cov");

	// Mint generations 1 and 2
	store.mintGeneration("1", null, null, false, "cfg");
	store.mintGeneration("2", null, null, false, "cfg");

	const lcovContent = `
TN:testSuiteA
SF:src/auth.ts
DA:1,1
DA:2,1
DA:3,0
end_of_record
SF:src/db.ts
DA:10,2
DA:11,2
end_of_record
`.trim();

	const covPath = join(fixtureDir, "coverage.lcov");
	writeFileSync(covPath, lcovContent);

	try {
		const evidence: StoredEvidenceRecord = {
			evidenceId: "ev:lcov-001",
			origin: "tool_observation",
			targetRepoIdentity: "repo:rt-cov",
			artifactDigest: createHash("sha256").update(lcovContent).digest("hex"),
			generation: 1,
		};

		const result = defaultRuntimeIngestion.importCoverage(store, {
			coverageFilePath: covPath,
			repoRoot: fixtureDir,
			repoIdentity: "repo:rt-cov",
			generation: 1,
			evidence,
		});

		assert.equal(result.success, true);
		assert.equal(result.filesCovered, 2);
		assert.equal(result.linesCovered, 4);
		assert.equal(result.edgesCreated, 1); // 1 test attribution edge from TN:testSuiteA
	} finally {
		store.close();
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});
