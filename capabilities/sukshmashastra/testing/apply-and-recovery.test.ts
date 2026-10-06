// Sūkṣmaśastra Kṣepaṇa Apply & Crash Recovery Test Suite (Part F2, S6-APP-001..005)

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { applyPlanToWorkspace } from "../ksepana/adapter.ts";
import { recoverCrashState } from "../ksepana/recovery.ts";
import type { Anchor } from "../model/anchors.ts";
import type { BoundRepoTarget, Transformation } from "../model/plan.ts";
import { SukshmashastraError } from "../model/reason-codes.ts";
import { buildAndValidatePlan } from "../pipeline/plan-builder.ts";
import { InMemoryArtifactStore } from "../ports/artifact-store.ts";

describe("Sūkṣmaśastra: Kṣepaṇa File-Edit Adapter & Crash Recovery (S6-APP-001..005)", () => {
	let tempDir: string;
	let store: InMemoryArtifactStore;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sukshma-apply-test-"));
		store = new InMemoryArtifactStore();
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	});

	const repoBinding: BoundRepoTarget = {
		canonical_path: "C:/test-repo",
		repository_identity: "repo:test",
	};

	it("applies multi-file plan atomically under lock with markers", async () => {
		// Setup two files on disk
		const fileA = "fileA.ts";
		const fileB = "fileB.ts";
		const contentA = "function funcA() { return 'A'; }\n";
		const contentB = "function funcB() { return 'B'; }\n";

		await fs.writeFile(path.join(tempDir, fileA), contentA, "utf8");
		await fs.writeFile(path.join(tempDir, fileB), contentB, "utf8");

		const anchorA: Anchor = {
			anchor_id: "fn:funcA",
			file_id: `file:${fileA}`,
			targetFile: fileA,
			structural_selector: "function:funcA",
			selector: "function:funcA",
			identifier: "funcA",
			source_range: [0, 31],
			range: { startByte: 0, endByte: 31 },
		};

		const anchorB: Anchor = {
			anchor_id: "fn:funcB",
			file_id: `file:${fileB}`,
			targetFile: fileB,
			structural_selector: "function:funcB",
			selector: "function:funcB",
			identifier: "funcB",
			source_range: [0, 31],
			range: { startByte: 0, endByte: 31 },
		};

		const txA: Transformation = {
			transformation_id: "tx_A",
			kind: "replace_node",
			target_file: fileA,
			anchor_id: "fn:funcA",
			replacement_text: "function funcA() { return 'A_MOD'; }",
			affected_nodes: ["fn:funcA"],
			deliberately_unchanged_nodes: [],
		};

		const txB: Transformation = {
			transformation_id: "tx_B",
			kind: "replace_node",
			target_file: fileB,
			anchor_id: "fn:funcB",
			replacement_text: "function funcB() { return 'B_MOD'; }",
			affected_nodes: ["fn:funcB"],
			deliberately_unchanged_nodes: [],
		};

		const filesMap = new Map<string, string>([
			[fileA, contentA],
			[fileB, contentB],
		]);

		const plan = await buildAndValidatePlan({
			repoBinding,
			activeBinding: repoBinding,
			baseCommit: "c1",
			activeBaseCommit: "c1",
			workspaceGeneration: "1",
			activeWorkspaceGeneration: "1",
			intent: "Update both functions",
			anchors: [anchorA, anchorB],
			transformations: [txA, txB],
			files: filesMap,
			artifactStore: store,
		});

		// Apply to disk
		const applyRes = await applyPlanToWorkspace(plan, {
			workspaceRoot: tempDir,
			artifactStore: store,
		});

		assert.equal(applyRes.status, "APPLIED");
		assert.equal(applyRes.appliedFiles.length, 2);

		// Verify on disk
		const diskA = await fs.readFile(path.join(tempDir, fileA), "utf8");
		const diskB = await fs.readFile(path.join(tempDir, fileB), "utf8");
		assert.ok(diskA.includes("A_MOD"));
		assert.ok(diskB.includes("B_MOD"));

		// Verify markers: complete exists, start does not
		const markerDir = path.join(tempDir, ".padma", "markers");
		await assert.doesNotReject(() => fs.access(path.join(markerDir, `${plan.plan_id}.complete`)));
		await assert.rejects(() => fs.access(path.join(markerDir, `${plan.plan_id}.start`)));
	});

	it("aborts apply with PREIMAGE_CHANGED when on-disk content changes under lock", async () => {
		const file = "single.ts";
		const content = "function test() { return 1; }\n";
		await fs.writeFile(path.join(tempDir, file), content, "utf8");

		const anchor: Anchor = {
			anchor_id: "fn:test",
			file_id: `file:${file}`,
			targetFile: file,
			structural_selector: "function:test",
			selector: "function:test",
			identifier: "test",
			source_range: [0, 29],
			range: { startByte: 0, endByte: 29 },
		};

		const tx: Transformation = {
			transformation_id: "tx_1",
			kind: "replace_node",
			target_file: file,
			anchor_id: "fn:test",
			replacement_text: "function test() { return 2; }",
			affected_nodes: ["fn:test"],
			deliberately_unchanged_nodes: [],
		};

		const plan = await buildAndValidatePlan({
			repoBinding,
			activeBinding: repoBinding,
			baseCommit: "c1",
			activeBaseCommit: "c1",
			workspaceGeneration: "1",
			activeWorkspaceGeneration: "1",
			intent: "Update test",
			anchors: [anchor],
			transformations: [tx],
			files: new Map([[file, content]]),
			artifactStore: store,
		});

		// Tamper with file on disk to trigger PREIMAGE_CHANGED
		await fs.writeFile(path.join(tempDir, file), "function test() { return 'tampered'; }\n", "utf8");

		await assert.rejects(
			() =>
				applyPlanToWorkspace(plan, {
					workspaceRoot: tempDir,
					artifactStore: store,
				}),
			(err: any) => err instanceof SukshmashastraError && err.reasonCode === "PREIMAGE_CHANGED",
		);
	});

	it("rolls back multi-file changes when a fault occurs mid-rename (APPLY_ROLLED_BACK)", async () => {
		const fileA = "fileA.ts";
		const fileB = "fileB.ts";
		const contentA = "function funcA() { return 'A'; }\n";
		const contentB = "function funcB() { return 'B'; }\n";

		await fs.writeFile(path.join(tempDir, fileA), contentA, "utf8");
		await fs.writeFile(path.join(tempDir, fileB), contentB, "utf8");

		const anchorA: Anchor = {
			anchor_id: "fn:funcA",
			file_id: `file:${fileA}`,
			targetFile: fileA,
			structural_selector: "function:funcA",
			selector: "function:funcA",
			identifier: "funcA",
			source_range: [0, 31],
			range: { startByte: 0, endByte: 31 },
		};

		const anchorB: Anchor = {
			anchor_id: "fn:funcB",
			file_id: `file:${fileB}`,
			targetFile: fileB,
			structural_selector: "function:funcB",
			selector: "function:funcB",
			identifier: "funcB",
			source_range: [0, 31],
			range: { startByte: 0, endByte: 31 },
		};

		const txA: Transformation = {
			transformation_id: "tx_A",
			kind: "replace_node",
			target_file: fileA,
			anchor_id: "fn:funcA",
			replacement_text: "function funcA() { return 'A_FAIL'; }",
			affected_nodes: ["fn:funcA"],
			deliberately_unchanged_nodes: [],
		};

		const txB: Transformation = {
			transformation_id: "tx_B",
			kind: "replace_node",
			target_file: fileB,
			anchor_id: "fn:funcB",
			replacement_text: "function funcB() { return 'B_FAIL'; }",
			affected_nodes: ["fn:funcB"],
			deliberately_unchanged_nodes: [],
		};

		const plan = await buildAndValidatePlan({
			repoBinding,
			activeBinding: repoBinding,
			baseCommit: "c1",
			activeBaseCommit: "c1",
			workspaceGeneration: "1",
			activeWorkspaceGeneration: "1",
			intent: "Fault test",
			anchors: [anchorA, anchorB],
			transformations: [txA, txB],
			files: new Map([
				[fileA, contentA],
				[fileB, contentB],
			]),
			artifactStore: store,
		});

		// Fault injected at rename index 1 (after index 0 has been renamed)
		await assert.rejects(
			() =>
				applyPlanToWorkspace(plan, {
					workspaceRoot: tempDir,
					artifactStore: store,
					simulatedFaultAtRenameIndex: 1,
				}),
			(err: any) => err instanceof SukshmashastraError && err.reasonCode === "APPLY_ROLLED_BACK",
		);

		// Assert fileA was restored back to original baseline!
		const diskA = await fs.readFile(path.join(tempDir, fileA), "utf8");
		const diskB = await fs.readFile(path.join(tempDir, fileB), "utf8");
		assert.equal(diskA, contentA);
		assert.equal(diskB, contentB);
	});

	it("recovers from crash via markers and rollback restoration", async () => {
		const planId = "plan_crash_123";
		const file = "crash_file.ts";
		const originalContent = "const x = 1;\n";
		const modifiedContent = "const x = 999;\n";

		// Target file was modified before crash
		await fs.writeFile(path.join(tempDir, file), modifiedContent, "utf8");

		// Put rollback artifact in store
		const rollbackBundle = {
			plan_id: planId,
			timestamp: new Date().toISOString(),
			files: [
				{
					path: file,
					originalDigest: "some_hash",
					originalContent,
				},
			],
		};
		const bundleRef = await store.put(JSON.stringify(rollbackBundle));

		// Write start marker simulating interrupted crash
		const markerDir = path.join(tempDir, ".padma", "markers");
		await fs.mkdir(markerDir, { recursive: true });
		await fs.writeFile(
			path.join(markerDir, `${planId}.start`),
			JSON.stringify({ plan_id: planId, rollback_ref: bundleRef.digest }),
			"utf8",
		);

		// Execute crash recovery
		const recoveryRes = await recoverCrashState(planId, tempDir, store);
		assert.equal(recoveryRes.status, "PARTIAL");

		// Verify on-disk file was restored to original content!
		const restoredText = await fs.readFile(path.join(tempDir, file), "utf8");
		assert.equal(restoredText, originalContent);
	});
});
