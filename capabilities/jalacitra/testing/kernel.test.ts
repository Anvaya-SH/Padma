// Kernel Integration Unit Tests (Step 11, J5-KER-001 through J5-KER-007)

import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult } from "../api/context.ts";
import { type JalacitraKernelEvent, KernelEventEmitter } from "../ports/events.ts";
import { createHypothesisFromGraph } from "../ports/hypothesis.ts";
import { JalacitraKernelRegistration } from "../ports/kernel-registration.ts";
import { JalacitraBudgetManager, type KosaDebitRequest } from "../ports/kosa-budget.ts";
import { JalacitraEvidenceRecorder, type SaksyaObservation } from "../ports/saksya-evidence.ts";
import { JalacitraScopeGuard } from "../ports/scope-policy.ts";

test("J5-KER-001: Jalacitra capability and operations registration manifest", () => {
	const manifest = JalacitraKernelRegistration.getManifest();
	assert.equal(manifest.capabilityId, "jalacitra");
	assert.ok(manifest.operations.length >= 14);

	// Verify all operations have schemas, side-effect classes, risk tiers, and negative examples
	for (const op of manifest.operations) {
		assert.ok(op.operationName.startsWith("atlas."));
		assert.ok(["READ_ONLY", "LOCAL_STATE_MUTATION", "DESTRUCTIVE_LOCAL_MUTATION"].includes(op.sideEffectClass));
		assert.ok(["LOW", "MEDIUM", "HIGH"].includes(op.riskTier));
		assert.ok(op.inputSchema);
		assert.ok(op.outputSchema);
		assert.ok(op.negativeExamples.length > 0);
	}

	// Verify specific operations
	const discardOp = JalacitraKernelRegistration.getOperation("atlas.discard");
	assert.equal(discardOp?.sideEffectClass, "DESTRUCTIVE_LOCAL_MUTATION");
	assert.equal(discardOp?.riskTier, "HIGH");

	const locateOp = JalacitraKernelRegistration.getOperation("atlas.locate");
	assert.equal(locateOp?.sideEffectClass, "READ_ONLY");
	assert.equal(locateOp?.riskTier, "LOW");
});

test("J5-KER-002: ScopePolicy evaluation and SCOPE_DENIED reason code", () => {
	const guard = new JalacitraScopeGuard({
		productMode: "padma_code",
		policyVersion: "1.0",
		boundRepoRoot: "/repo",
		excludedPatterns: ["secrets/*", "internal/restricted.ts"],
	});

	// Permitted path
	const allowed = guard.evaluatePath("src/index.ts");
	assert.equal(allowed.allowed, true);

	// Denied by pattern
	const denied1 = guard.evaluatePath("secrets/keys.json");
	assert.equal(denied1.allowed, false);
	assert.equal(denied1.reasonCode, "SCOPE_DENIED");

	const denied2 = guard.evaluatePath("internal/restricted.ts");
	assert.equal(denied2.allowed, false);
	assert.equal(denied2.reasonCode, "SCOPE_DENIED");
});

test("J5-KER-003: Product mode switch (Code vs Cyber) and query-time exclusion filter", () => {
	// 1. In Code mode, standard paths are allowed
	const codeGuard = new JalacitraScopeGuard({
		productMode: "padma_code",
		policyVersion: "1.0",
		boundRepoRoot: "/repo",
		engagementScope: {
			excludedPaths: ["admin/auth"],
		},
	});
	assert.equal(codeGuard.evaluatePath("admin/auth/login.ts").allowed, true);

	// 2. In Cyber mode, engagement scope exclusions are enforced
	const cyberGuard = new JalacitraScopeGuard({
		productMode: "padma_cyber",
		policyVersion: "1.0",
		boundRepoRoot: "/repo",
		engagementScope: {
			excludedPaths: ["admin/auth"],
		},
	});
	const cyberEval = cyberGuard.evaluatePath("admin/auth/login.ts");
	assert.equal(cyberEval.allowed, false);
	assert.equal(cyberEval.reasonCode, "SCOPE_DENIED");

	// 3. Query-time filtering of existing nodes
	const nodes = [{ file_path: "src/utils.ts" }, { file_path: "admin/auth/tokens.ts" }, { file_path: "src/main.ts" }];
	const filtered = cyberGuard.filterQueryNodes(nodes);
	assert.equal(filtered.allowed.length, 2);
	assert.equal(filtered.deniedCount, 1);
	assert.equal(filtered.allowed[0].file_path, "src/utils.ts");
	assert.equal(filtered.allowed[1].file_path, "src/main.ts");
});

test("J5-KER-004: Koṣa budget accounting debit and usage reporting", async () => {
	let debitedRequest: KosaDebitRequest | undefined;

	const mockKosaPort = {
		debit: async (req: KosaDebitRequest) => {
			debitedRequest = req;
			return { debited: true, remainingBudget: 1000 };
		},
	};

	const budgetManager = new JalacitraBudgetManager({ kosaPort: mockKosaPort });

	await budgetManager.reportUsage(
		"atlas.resolve_symbol",
		{
			wall_ms: 15,
			files_read: 2,
			bytes_read: 2048,
			rows_scanned: 10,
			rows_returned: 2,
			output_bytes: 512,
		},
		"mission-xyz-123",
	);

	assert.ok(debitedRequest);
	assert.equal(debitedRequest.missionId, "mission-xyz-123");
	assert.equal(debitedRequest.operationName, "atlas.resolve_symbol");
	assert.equal(debitedRequest.usage.wall_ms, 15);
	assert.equal(debitedRequest.usage.files_read, 2);
});

test("J5-KER-005: Sākṣya evidence recording with item provenances and no laundering", async () => {
	let recordedObservation: SaksyaObservation | undefined;

	const mockSaksya = {
		append: async (obs: SaksyaObservation) => {
			recordedObservation = obs;
		},
	};

	const recorder = new JalacitraEvidenceRecorder({ evidencePort: mockSaksya });

	const mockQueryResult: QueryResult<any[]> = {
		schema_version: "jalacitra.result.v1",
		data: [
			{ id: "sym:1", canonical_name: "getUser", provenance: "PARSED" },
			{ id: "sym:2", canonical_name: "queryDb", provenance: "INFERRED", is_ambiguous: true },
		],
		snapshot: {
			snapshot_id: "snap_100",
			index_generation: 1,
			workspace_generation: "1",
			build_generation: null,
		},
		freshness: {
			requested: "current_generation",
			delivered: "current_generation",
			last_verified_at: new Date().toISOString(),
		},
		coverage: {
			scope: { repo_id: "repo", snapshot_id: "snap_100", generation: 1 },
			files_considered: 10,
			files_indexed: 10,
			files_skipped: [],
			languages: [],
			known_blind_spots: [],
			completeness: "EXACT_WITHIN_INDEX",
			limitations: [],
		},
		usage: {
			wall_ms: 10,
			files_read: 1,
			bytes_read: 100,
			rows_scanned: 5,
			rows_returned: 2,
			output_bytes: 200,
		},
		negative_evidence: [],
		truncation: { truncated: false },
	};

	await recorder.recordQueryEvidence("atlas.resolve_symbol", { name: "getUser" }, mockQueryResult, "mission-456");

	assert.ok(recordedObservation);
	assert.equal(recordedObservation.operation, "atlas.resolve_symbol");
	assert.equal(recordedObservation.snapshotId, "snap_100");
	assert.equal(recordedObservation.resultCount, 2);
	assert.equal(recordedObservation.origin, "deterministic_check");

	// Verify per-item provenance list prevents laundering INFERRED into stronger evidence
	assert.equal(recordedObservation.itemProvenances.length, 2);
	assert.equal(recordedObservation.itemProvenances[0].provenance, "PARSED");
	assert.equal(recordedObservation.itemProvenances[1].provenance, "INFERRED");
	assert.equal(recordedObservation.itemProvenances[1].isAmbiguous, true);
});

test("J5-KER-006 / J5-INV-013: Hypothesis boundary establishes weakest provenance", () => {
	// Mixed class edges: one COMPILED, one INFERRED
	const supportingEdges = [
		{
			kind: "calls",
			source: "func:handleAuth",
			target: "func:validateToken",
			provenance: "COMPILED" as const,
		},
		{
			kind: "calls",
			source: "func:validateToken",
			target: "func:verifySignature",
			provenance: "INFERRED" as const,
		},
	];

	const hypothesis = createHypothesisFromGraph("Token verification failure", supportingEdges);

	// Weakest among COMPILED and INFERRED is INFERRED!
	assert.equal(hypothesis.effectiveProvenance, "INFERRED");
	assert.equal(hypothesis.weakestSupportingEdge.target, "func:verifySignature");
	assert.equal(hypothesis.supportingEvidence.length, 2);
});

test("J5-KER-007: Kernel events emission without source text", () => {
	const emitter = new KernelEventEmitter();
	const received: JalacitraKernelEvent[] = [];

	emitter.on("jalacitra.index.committed", (evt) => {
		received.push(evt);
	});

	emitter.emit(
		"jalacitra.index.committed",
		"repo:sample",
		{
			generation: 2,
			nodesCount: 150,
			edgesCount: 300,
			filesIndexed: 15,
		},
		2,
	);

	assert.equal(received.length, 1);
	assert.equal(received[0].eventType, "jalacitra.index.committed");
	assert.equal(received[0].repoIdentity, "repo:sample");
	assert.equal(received[0].generation, 2);
	assert.equal((received[0].payload as any).nodesCount, 150);

	// Assert payload contains only structured metadata, never source code
	const payloadStr = JSON.stringify(received[0].payload);
	assert.equal(payloadStr.includes("function"), false);
	assert.equal(payloadStr.includes("import"), false);
});
