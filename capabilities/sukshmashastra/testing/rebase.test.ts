// Sūkṣmaśastra Rebase, Three-Way Analysis, and Merge Test Suite (Part G, S6-RBS-001..005)

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Anchor } from "../model/anchors.ts";
import type { BoundRepoTarget, Transformation } from "../model/plan.ts";
import { buildAndValidatePlan } from "../pipeline/plan-builder.ts";
import { InMemoryArtifactStore } from "../ports/artifact-store.ts";
import { mergeWorkerPlans } from "../rebase/merge.ts";
import { analyzeThreeWayConflict, rebasePlan } from "../rebase/rebase.ts";

describe("Sūkṣmaśastra: Conflicts, Three-Way Analysis & Rebase (S6-RBS-001..005)", () => {
	const defaultBinding: BoundRepoTarget = {
		canonical_path: "C:/project",
		repository_identity: "repo:test",
	};

	it("cleanly rebases when target node moved down due to preceding edits (S6-RBS-001, S6-RBS-004)", async () => {
		const store = new InMemoryArtifactStore();
		const filePath = "src/math.ts";
		const baseContent = "function calculate() { return 10; }\n";

		const anchor: Anchor = {
			anchor_id: "fn:calculate",
			file_id: `file:${filePath}`,
			targetFile: filePath,
			structural_selector: "function:calculate",
			selector: "function:calculate",
			identifier: "calculate",
			source_range: [0, 35],
			range: { startByte: 0, endByte: 35 },
		};

		const tx: Transformation = {
			transformation_id: "tx_1",
			kind: "replace_node",
			target_file: filePath,
			anchor_id: "fn:calculate",
			replacement_text: "function calculate() { return 20; }",
			affected_nodes: ["fn:calculate"],
			deliberately_unchanged_nodes: [],
		};

		const plan = await buildAndValidatePlan({
			repoBinding: defaultBinding,
			activeBinding: defaultBinding,
			baseCommit: "c1",
			activeBaseCommit: "c1",
			workspaceGeneration: "1",
			activeWorkspaceGeneration: "1",
			intent: "Update calculate",
			anchors: [anchor],
			transformations: [tx],
			files: new Map([[filePath, baseContent]]),
			artifactStore: store,
		});

		// Concurrently modified file: prepended a header comment that shifts calculate down
		const updatedContent = "// File header comment added concurrently\nfunction calculate() { return 10; }\n";
		const rebaseRes = await rebasePlan(plan, new Map([[filePath, updatedContent]]), {
			newBaseCommit: "c2",
			artifactStore: store,
		});

		assert.equal(rebaseRes.success, true);
		assert.ok(rebaseRes.newPlan);
		assert.equal(rebaseRes.newPlan.parent_plan_id, plan.plan_id);
		assert.equal(rebaseRes.newPlan.base_commit, "c2");
		assert.equal(rebaseRes.semanticRecheckRecommended, true);

		// Anchor was moved to new byte range
		const rebasedAnchor = rebaseRes.newPlan.anchors[0];
		assert.ok(rebasedAnchor.source_range![0] > 0);
	});

	it("detects three-way conflict when target range is concurrently modified (S6-RBS-002)", () => {
		const base = "function calc() { return 1; }";
		const theirs = "function calc() { return 999; }"; // modified concurrently
		const report = analyzeThreeWayConflict("src/calc.ts", base, theirs, [
			{ start: 0, end: base.length, newText: "function calc() { return 2; }" },
		]);

		assert.equal(report.clean, false);
		assert.equal(report.conflicts.length, 1);
		assert.equal(report.conflicts[0].reason, "CONFLICT");
	});

	it("merges two concurrent non-overlapping worker plans on same file (S6-RBS-003)", async () => {
		const store = new InMemoryArtifactStore();
		const filePath = "src/service.ts";
		const content = ["function first() { return 1; }", "function second() { return 2; }", ""].join("\n");

		const anchor1: Anchor = {
			anchor_id: "fn:first",
			file_id: `file:${filePath}`,
			targetFile: filePath,
			structural_selector: "function:first",
			selector: "function:first",
			identifier: "first",
			source_range: [0, 31],
			range: { startByte: 0, endByte: 31 },
		};

		const anchor2: Anchor = {
			anchor_id: "fn:second",
			file_id: `file:${filePath}`,
			targetFile: filePath,
			structural_selector: "function:second",
			selector: "function:second",
			identifier: "second",
			source_range: [32, 64],
			range: { startByte: 32, endByte: 64 },
		};

		const tx1: Transformation = {
			transformation_id: "tx_1",
			kind: "replace_node",
			target_file: filePath,
			anchor_id: "fn:first",
			replacement_text: "function first() { return 100; }",
			affected_nodes: ["fn:first"],
			deliberately_unchanged_nodes: [],
		};

		const tx2: Transformation = {
			transformation_id: "tx_2",
			kind: "replace_node",
			target_file: filePath,
			anchor_id: "fn:second",
			replacement_text: "function second() { return 200; }",
			affected_nodes: ["fn:second"],
			deliberately_unchanged_nodes: [],
		};

		const planA = await buildAndValidatePlan({
			repoBinding: defaultBinding,
			activeBinding: defaultBinding,
			baseCommit: "c1",
			activeBaseCommit: "c1",
			workspaceGeneration: "1",
			activeWorkspaceGeneration: "1",
			intent: "Worker A: update first()",
			anchors: [anchor1],
			transformations: [tx1],
			files: new Map([[filePath, content]]),
			artifactStore: store,
		});

		const planB = await buildAndValidatePlan({
			repoBinding: defaultBinding,
			activeBinding: defaultBinding,
			baseCommit: "c1",
			activeBaseCommit: "c1",
			workspaceGeneration: "1",
			activeWorkspaceGeneration: "1",
			intent: "Worker B: update second()",
			anchors: [anchor2],
			transformations: [tx2],
			files: new Map([[filePath, content]]),
			artifactStore: store,
		});

		const mergeRes = await mergeWorkerPlans(planA, planB, new Map([[filePath, content]]), store);
		assert.equal(mergeRes.success, true);
		assert.ok(mergeRes.mergedPlan);
		assert.equal(mergeRes.mergedPlan.transformations.length, 2);
		assert.equal(mergeRes.mergedPlan.anchors.length, 2);
	});

	it("rejects merge when worker plans touch overlapping ranges (S6-RBS-003)", async () => {
		const store = new InMemoryArtifactStore();
		const filePath = "src/service.ts";
		const content = "function first() { return 1; }\n";

		const anchor: Anchor = {
			anchor_id: "fn:first",
			file_id: `file:${filePath}`,
			targetFile: filePath,
			structural_selector: "function:first",
			selector: "function:first",
			identifier: "first",
			source_range: [0, 31],
			range: { startByte: 0, endByte: 31 },
		};

		const txA: Transformation = {
			transformation_id: "tx_A",
			kind: "replace_node",
			target_file: filePath,
			anchor_id: "fn:first",
			replacement_text: "function first() { return 'A'; }",
			affected_nodes: ["fn:first"],
			deliberately_unchanged_nodes: [],
		};

		const txB: Transformation = {
			transformation_id: "tx_B",
			kind: "replace_node",
			target_file: filePath,
			anchor_id: "fn:first",
			replacement_text: "function first() { return 'B'; }",
			affected_nodes: ["fn:first"],
			deliberately_unchanged_nodes: [],
		};

		const planA = await buildAndValidatePlan({
			repoBinding: defaultBinding,
			activeBinding: defaultBinding,
			baseCommit: "c1",
			activeBaseCommit: "c1",
			workspaceGeneration: "1",
			activeWorkspaceGeneration: "1",
			intent: "Worker A",
			anchors: [anchor],
			transformations: [txA],
			files: new Map([[filePath, content]]),
			artifactStore: store,
		});

		const planB = await buildAndValidatePlan({
			repoBinding: defaultBinding,
			activeBinding: defaultBinding,
			baseCommit: "c1",
			activeBaseCommit: "c1",
			workspaceGeneration: "1",
			activeWorkspaceGeneration: "1",
			intent: "Worker B",
			anchors: [anchor],
			transformations: [txB],
			files: new Map([[filePath, content]]),
			artifactStore: store,
		});

		const mergeRes = await mergeWorkerPlans(planA, planB, new Map([[filePath, content]]), store);
		assert.equal(mergeRes.success, false);
		assert.ok(mergeRes.conflictReason?.includes("overlapping"));
	});
});
