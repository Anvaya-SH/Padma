// Durable Builds Integration Unit Tests (Step 13, J5-LONG-001 through J5-LONG-005)

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	classifyBuild,
	computeBuildIdempotencyKey,
	DurableBuildCoordinator,
	type DurableBuildProgress,
} from "../durable/durable-builds.ts";
import { JalacitraStore } from "../store/store.ts";

test("J5-LONG-001: Build classification threshold (Synchronous vs Durable)", () => {
	assert.equal(classifyBuild(10, false), "SYNCHRONOUS");
	assert.equal(classifyBuild(199, false), "SYNCHRONOUS");
	assert.equal(classifyBuild(201, false), "DURABLE");
	assert.equal(classifyBuild(1, true), "DURABLE"); // full build is always durable
});

test("J5-LONG-002: Progress callbacks and cooperative cancellation at batch boundary", async () => {
	const fixtureDir = join(tmpdir(), `jalacitra-durable-${Date.now()}`);
	mkdirSync(join(fixtureDir, "src"), { recursive: true });
	const dbPath = join(fixtureDir, "store.sqlite");
	const store = new JalacitraStore(dbPath, "repo:durable");

	try {
		writeFileSync(join(fixtureDir, "src", "task.ts"), "export const task = 1;");

		const coordinator = new DurableBuildCoordinator();
		const progressEvents: DurableBuildProgress[] = [];

		// Create an already aborted controller to test cooperative cancellation
		const controller = new AbortController();
		controller.abort();

		const result = await coordinator.executeDurableBuild({
			store,
			repoRoot: fixtureDir,
			repoIdentity: "repo:durable",
			signal: controller.signal,
			onProgress: (p) => progressEvents.push({ ...p }),
		});

		assert.equal(result.status, "CANCELLED");
		assert.ok(progressEvents.some((p) => p.isCancelled));
	} finally {
		store.close();
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test("J5-LONG-003: Idempotency and reconciliation of completed vs interrupted builds", async () => {
	const fixtureDir = join(tmpdir(), `jalacitra-durable-reconcile-${Date.now()}`);
	mkdirSync(join(fixtureDir, "src"), { recursive: true });
	const dbPath = join(fixtureDir, "store.sqlite");
	const store = new JalacitraStore(dbPath, "repo:durable-reconcile");

	try {
		writeFileSync(join(fixtureDir, "src", "item.ts"), "export const item = true;");

		const coordinator = new DurableBuildCoordinator();
		const _key = computeBuildIdempotencyKey("repo:durable-reconcile", "hash1", "1.0.0", "cfg1");

		// 1. Run a successful durable build
		const runResult = await coordinator.executeDurableBuild({
			store,
			repoRoot: fixtureDir,
			repoIdentity: "repo:durable-reconcile",
			changeSetDigest: "hash1",
			configFingerprint: "cfg1",
		});

		assert.equal(runResult.status, "CONFIRMED_COMPLETE");

		// 2. Reconcile the committed build -> CONFIRMED_COMPLETE
		const reconStatus = coordinator.reconcile(store, runResult.buildId, runResult.idempotencyKey);
		assert.equal(reconStatus, "CONFIRMED_COMPLETE");

		// 3. Simulate an interrupted build in journal (status = PLANNED/RUNNING)
		const interruptedId = "repo:durable-reconcile:interrupted-999";
		store.journal.start(interruptedId, 0, "some_key");

		// Reconciling an interrupted build rolls it back to ABORTED and marks it SAFELY_REDISPATCHABLE
		const reconInterrupted = coordinator.reconcile(store, interruptedId, "some_key");
		assert.equal(reconInterrupted, "SAFELY_REDISPATCHABLE");
	} finally {
		store.close();
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});
