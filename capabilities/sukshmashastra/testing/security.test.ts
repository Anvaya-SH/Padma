// Sūkṣmaśastra Security Hardening & Kernel Integration Test Suite (Part I, S6-SEC-001..007, S6-KER-001..007)

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SukshmashastraError } from "../model/reason-codes.ts";
import { scanForSecrets, validateScopeAndPath } from "../pipeline/plan-builder.ts";
import { defaultEventEmitter } from "../ports/events.ts";
import { SUKSHMASHASTRA_MANIFEST } from "../ports/kernel-registration.ts";
import { SukshmashastraBudgetManager } from "../ports/kosa.ts";
import { SukshmashastraEvidenceRecorder } from "../ports/saksya.ts";
import { isExecutableConfig, migrateConfig } from "../transformations/config-migration.ts";

describe("Sūkṣmaśastra: Security Hardening & Kernel Integration (S6-SEC-001..007, S6-KER-001..007)", () => {
	describe("1. Secret Scanning in Replacement Artifacts (S6-SEC-001)", () => {
		it("detects and rejects private keys and API tokens in replacement text", () => {
			assert.throws(
				() => scanForSecrets("const key = '-----BEGIN RSA PRIVATE KEY----- secret';"),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "SECRET_IN_REPLACEMENT",
			);

			assert.throws(
				() => scanForSecrets("const aws = 'AKIA1234567890ABCDEF';"),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "SECRET_IN_REPLACEMENT",
			);

			assert.throws(
				() => scanForSecrets("const gh = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';"),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "SECRET_IN_REPLACEMENT",
			);

			assert.throws(
				() => scanForSecrets("const openai = 'sk-1234567890abcdefghijklmnopqrstuvwxyz1234';"),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "SECRET_IN_REPLACEMENT",
			);
		});

		it("allows clean non-secret code to pass", () => {
			assert.doesNotThrow(() => scanForSecrets("function compute() { return 42; }"));
			assert.doesNotThrow(() => scanForSecrets("const url = 'https://example.com/api/v1';"));
		});
	});

	describe("2. Executable Config Execution Guard (S6-SEC-002, Decision D-4)", () => {
		it("correctly identifies executable config formats", () => {
			assert.equal(isExecutableConfig("prettier.config.js"), true);
			assert.equal(isExecutableConfig("eslint.config.mjs"), true);
			assert.equal(isExecutableConfig("webpack.config.ts"), true);
			assert.equal(isExecutableConfig("tsconfig.json"), false);
			assert.equal(isExecutableConfig("biome.jsonc"), false);
		});

		it("refuses declarative migration on executable configs with FORMAT_SKIPPED_EXECUTABLE_CONFIG", () => {
			assert.throws(
				() => migrateConfig("prettier.config.js", "module.exports = {};", []),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "FORMAT_SKIPPED_EXECUTABLE_CONFIG",
			);
		});
	});

	describe("3. Path Confinement & ScopePolicy (S6-SEC-004, S6-SEC-005)", () => {
		it("confines operations within repository root and prevents traversal escapes", () => {
			assert.throws(
				() => validateScopeAndPath("../escape.ts"),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "PATH_OUTSIDE_ROOT",
			);

			assert.throws(
				() => validateScopeAndPath("sub/../../escape.ts"),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "PATH_OUTSIDE_ROOT",
			);
		});

		it("protects sensitive configuration, keys, and metadata paths", () => {
			assert.throws(
				() => validateScopeAndPath(".env"),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "SCOPE_DENIED",
			);
			assert.throws(
				() => validateScopeAndPath("config/.env.local"),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "SCOPE_DENIED",
			);
			assert.throws(
				() => validateScopeAndPath(".git/HEAD"),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "SCOPE_DENIED",
			);
			assert.throws(
				() => validateScopeAndPath(".ssh/id_rsa"),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "SCOPE_DENIED",
			);
			assert.throws(
				() => validateScopeAndPath(".padma/state.json"),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "SCOPE_DENIED",
			);
		});
	});

	describe("4. Kernel Capability Registration (S6-KER-001..003)", () => {
		it("publishes complete capability manifest with all 6 operations and negative examples", () => {
			assert.equal(SUKSHMASHASTRA_MANIFEST.capabilityId, "sukshmashastra");
			assert.equal(SUKSHMASHASTRA_MANIFEST.operations.length, 6);

			const opNames = SUKSHMASHASTRA_MANIFEST.operations.map((o) => o.operationName);
			assert.ok(opNames.includes("plan.create"));
			assert.ok(opNames.includes("plan.validate"));
			assert.ok(opNames.includes("plan.preview"));
			assert.ok(opNames.includes("plan.rebase"));
			assert.ok(opNames.includes("plan.explain"));
			assert.ok(opNames.includes("plan.apply"));

			// Check negative examples on plan.create
			const planCreate = SUKSHMASHASTRA_MANIFEST.operations.find((o) => o.operationName === "plan.create");
			assert.ok(planCreate);
			assert.ok(planCreate.negativeExamples.length >= 2);
			assert.equal(planCreate.negativeExamples[0].expectedErrorCode, "PATH_OUTSIDE_ROOT");
		});
	});

	describe("5. Koṣa Budget Tracking & Deferral (S6-KER-004)", () => {
		it("defers semantic compiler queries exceeding 10% budget ceiling with SEMANTIC_DEFERRED", async () => {
			const budgetManager = new SukshmashastraBudgetManager({
				debit: async () => {},
				getRemainingBudget: async () => 1000, // 1000ms remaining; 10% ceiling is 100ms
			});

			// 50ms is within 10% ceiling (<= 100ms)
			await assert.doesNotReject(() => budgetManager.checkSemanticBudgetCeiling(50));

			// 150ms exceeds 10% ceiling (> 100ms)
			await assert.rejects(
				() => budgetManager.checkSemanticBudgetCeiling(150),
				(err: any) => err instanceof SukshmashastraError && err.reasonCode === "SEMANTIC_DEFERRED",
			);
		});
	});

	describe("6. Sākṣya Evidence & Lifecycle Events (S6-KER-005, S6-KER-006)", () => {
		it("records plan evidence with deterministic provenance", async () => {
			const recorded: any[] = [];
			const recorder = new SukshmashastraEvidenceRecorder({
				append: async (rec) => {
					recorded.push(rec);
				},
			});

			const dummyPlan: any = {
				plan_id: "plan_test",
				base_commit: "c1",
				anchors: [1],
				transformations: [1],
				coverage: { atlas_completeness: "EXACT_WITHIN_INDEX" },
				expected_diff_ref: { digest: "diff_hash" },
			};

			const obs = await recorder.recordPlanValidation(dummyPlan);
			assert.equal(obs.operation, "plan.validate");
			assert.equal(obs.origin, "deterministic_check");
			assert.equal(recorded.length, 1);
		});

		it("emits kernel lifecycle events to subscribers", () => {
			const events: any[] = [];
			const unsubscribe = defaultEventEmitter.subscribe((e) => {
				events.push(e);
			});

			defaultEventEmitter.emit("plan_created", "plan_1");
			defaultEventEmitter.emit("plan_applied", "plan_1", { applied: true });

			unsubscribe();
			defaultEventEmitter.emit("plan_rolled_back", "plan_1"); // should not be captured

			assert.equal(events.length, 2);
			assert.equal(events[0].type, "plan_created");
			assert.equal(events[1].type, "plan_applied");
		});
	});
});
