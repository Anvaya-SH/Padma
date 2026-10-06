// Sūkṣmaśastra 8-Stage Validation Pipeline Test Suite (Part F1, S6-PIPE-001..002)

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Anchor } from "../model/anchors.ts";
import type { BoundRepoTarget, Transformation } from "../model/plan.ts";
import { SukshmashastraError } from "../model/reason-codes.ts";
import { buildAndValidatePlan, scanForSecrets, validateScopeAndPath } from "../pipeline/plan-builder.ts";
import { InMemoryArtifactStore } from "../ports/artifact-store.ts";

describe("Sūkṣmaśastra: Validation Pipeline & Plan Builder (S6-PIPE-001..002)", () => {
	const defaultBinding: BoundRepoTarget = {
		canonical_path: "C:/project",
		repository_identity: "repo:test",
	};

	const validAnchor: Anchor = {
		anchor_id: "fn:compute",
		id: "fn:compute",
		file_id: "src/calc.ts",
		selector: "function:compute",
		kind: "function",
		targetFile: "src/calc.ts",
		identifier: "compute",
		range: {
			startByte: 0,
			endByte: 37,
			startLine: 1,
			endLine: 1,
			startColumn: 1,
			endColumn: 38,
		},
	};

	const validTransformation: Transformation = {
		transformation_id: "tx_1",
		kind: "replace_node",
		target_file: "src/calc.ts",
		anchor_id: "fn:compute",
		replacement_text: "function compute() { return 999; }",
		affected_nodes: ["fn:compute"],
		deliberately_unchanged_nodes: [],
	};

	const files = new Map<string, string>([["src/calc.ts", "function compute() { return 100; }\nconst tax = 0.1;\n"]]);

	describe("Stage 1: Binding & Scope Check (S6-KER-001, S6-SEC-004, S6-SEC-005)", () => {
		it("rejects binding mismatch with BINDING_MISMATCH", async () => {
			await assert.rejects(
				() =>
					buildAndValidatePlan({
						repoBinding: { ...defaultBinding, repository_identity: "repo:other" },
						activeBinding: defaultBinding,
						baseCommit: "commit_a",
						activeBaseCommit: "commit_b",
						workspaceGeneration: "1",
						activeWorkspaceGeneration: "1",
						intent: "Update compute",
						anchors: [validAnchor],
						transformations: [validTransformation],
						files,
					}),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "BINDING_MISMATCH",
			);
		});

		it("rejects path traversal with PATH_OUTSIDE_ROOT", () => {
			assert.throws(
				() => validateScopeAndPath("../secret.txt"),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "PATH_OUTSIDE_ROOT",
			);
			assert.throws(
				() => validateScopeAndPath("src/../../outside.ts"),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "PATH_OUTSIDE_ROOT",
			);
		});

		it("rejects sensitive files with SCOPE_DENIED", () => {
			assert.throws(
				() => validateScopeAndPath(".env"),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "SCOPE_DENIED",
			);
			assert.throws(
				() => validateScopeAndPath(".git/config"),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "SCOPE_DENIED",
			);
			assert.throws(
				() => validateScopeAndPath(".padma/state.json"),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "SCOPE_DENIED",
			);
		});
	});

	describe("Stage 2: Anchor Resolution (S6-ANC-001..004)", () => {
		it("rejects missing anchor with NOT_FOUND", async () => {
			const missingAnchor: Anchor = {
				...validAnchor,
				selector: "function:nonExistent",
				identifier: "nonExistent",
			};
			await assert.rejects(
				() =>
					buildAndValidatePlan({
						repoBinding: defaultBinding,
						activeBinding: defaultBinding,
						baseCommit: "commit_a",
						activeBaseCommit: "commit_a",
						workspaceGeneration: "1",
						activeWorkspaceGeneration: "1",
						intent: "Missing anchor",
						anchors: [missingAnchor],
						transformations: [validTransformation],
						files,
					}),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "NOT_FOUND",
			);
		});
	});

	describe("Stage 3: Overlapping Edits Check (S6-TX-002)", () => {
		it("rejects overlapping edits with EDIT_OVERLAP", async () => {
			const tx1: Transformation = {
				transformation_id: "tx_1",
				kind: "replace_node",
				target_file: "src/calc.ts",
				anchor_id: "fn:compute",
				replacement_text: "function compute() { return 1; }",
				affected_nodes: ["fn:compute"],
				deliberately_unchanged_nodes: [],
			};
			const tx2: Transformation = {
				transformation_id: "tx_2",
				kind: "replace_node",
				target_file: "src/calc.ts",
				anchor_id: "fn:compute",
				replacement_text: "function compute() { return 2; }",
				affected_nodes: ["fn:compute"],
				deliberately_unchanged_nodes: [],
			};

			await assert.rejects(
				() =>
					buildAndValidatePlan({
						repoBinding: defaultBinding,
						activeBinding: defaultBinding,
						baseCommit: "commit_a",
						activeBaseCommit: "commit_a",
						workspaceGeneration: "1",
						activeWorkspaceGeneration: "1",
						intent: "Overlap test",
						anchors: [validAnchor],
						transformations: [tx1, tx2],
						files,
					}),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "EDIT_OVERLAP",
			);
		});
	});

	describe("Stage 4: Secret Scanning (S6-SEC-001)", () => {
		it("detects private keys and tokens in replacement text", () => {
			assert.throws(
				() => scanForSecrets("const key = '-----BEGIN RSA PRIVATE KEY----- abc';"),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "SECRET_IN_REPLACEMENT",
			);
			assert.throws(
				() => scanForSecrets("const token = 'ghp_123456789012345678901234567890123456';"),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "SECRET_IN_REPLACEMENT",
			);
		});
	});

	describe("Stage 6: Syntax & Invariant Checks (S6-INV-005)", () => {
		it("rejects transformation that introduces syntax error with REJECTED_SYNTAX_ERROR", async () => {
			const brokenTx: Transformation = {
				...validTransformation,
				replacement_text: "function compute() { return ;", // unclosed brace
			};

			await assert.rejects(
				() =>
					buildAndValidatePlan({
						repoBinding: defaultBinding,
						activeBinding: defaultBinding,
						baseCommit: "commit_a",
						activeBaseCommit: "commit_a",
						workspaceGeneration: "1",
						activeWorkspaceGeneration: "1",
						intent: "Syntax breaking",
						anchors: [validAnchor],
						transformations: [brokenTx],
						files,
					}),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "REJECTED_SYNTAX_ERROR",
			);
		});
	});

	describe("Stages 7 & 8: Complete Validated Plan & Rollback (S6-PIPE-001, S6-APP-003)", () => {
		it("successfully produces a VALIDATED StructuralEditPlan with artifacts", async () => {
			const store = new InMemoryArtifactStore();
			const plan = await buildAndValidatePlan({
				repoBinding: defaultBinding,
				activeBinding: defaultBinding,
				baseCommit: "commit_a",
				activeBaseCommit: "commit_a",
				workspaceGeneration: "1",
				activeWorkspaceGeneration: "1",
				intent: "Safely update compute logic",
				anchors: [validAnchor],
				transformations: [validTransformation],
				files,
				artifactStore: store,
			});

			assert.equal(plan.status, "VALIDATED");
			assert.ok(plan.plan_id.startsWith("plan_"));
			assert.ok(plan.expected_diff_ref.digest);
			assert.ok(plan.post_parse_report_ref.digest);
			assert.ok(plan.rollback_ref?.digest);
			assert.equal(plan.suggested_risk_tier, 1);

			// Verify artifacts are stored
			const diffContent = await store.get(plan.expected_diff_ref.digest);
			assert.ok(diffContent);
			assert.ok(diffContent.includes("compute"));

			const rollbackContent = await store.get(plan.rollback_ref!.digest);
			assert.ok(rollbackContent);
			const bundle = JSON.parse(rollbackContent);
			assert.equal(bundle.files.length, 1);
			assert.equal(bundle.files[0].path, "src/calc.ts");
		});
	});
});
