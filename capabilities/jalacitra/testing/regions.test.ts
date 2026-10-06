// Regions & Community Detection Unit Tests (Step 16, J5-REG-001 through J5-REG-005)

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAtlas } from "../api/atlas.ts";
import { defaultRegionDetector, RegionDetector } from "../regions/community.ts";

test("J5-REG-002: Region detection determinism with fixed seed", () => {
	const fixtureDir = join(tmpdir(), `jalacitra-reg-det-${Date.now()}`);
	mkdirSync(join(fixtureDir, "src", "auth"), { recursive: true });
	mkdirSync(join(fixtureDir, "src", "db"), { recursive: true });
	const dbPath = join(fixtureDir, "store.sqlite");

	const atlas = createAtlas({ dbPath, repoRoot: fixtureDir, repoIdentity: "repo:regions-det" });

	try {
		writeFileSync(
			join(fixtureDir, "src", "auth", "login.ts"),
			`import { query } from "../db/client.ts";\nexport function login() { return query(); }\n`,
		);
		writeFileSync(
			join(fixtureDir, "src", "auth", "session.ts"),
			`import { login } from "./login.ts";\nexport function verify() { return login(); }\n`,
		);
		writeFileSync(join(fixtureDir, "src", "db", "client.ts"), `export function query() { return true; }\n`);

		atlas.ensureIndex();

		const detector = new RegionDetector();
		const run1 = detector.computeRegions(atlas.store, { seed: 42 });
		const run2 = detector.computeRegions(atlas.store, { seed: 42 });

		// Exactly identical regions and IDs across repeated runs
		assert.equal(run1.length, run2.length);
		for (let i = 0; i < run1.length; i++) {
			assert.equal(run1[i].regionId, run2[i].regionId);
			assert.equal(run1[i].label, run2[i].label);
			assert.equal(run1[i].cohesion, run2[i].cohesion);
			assert.deepEqual(run1[i].memberFiles, run2[i].memberFiles);
		}
	} finally {
		atlas.close();
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test("J5-REG-003 / J5-REG-004: Heuristic labeling, cohesion, bridges, and INFERRED provenance", () => {
	const fixtureDir = join(tmpdir(), `jalacitra-reg-label-${Date.now()}`);
	mkdirSync(join(fixtureDir, "src", "feature"), { recursive: true });
	const dbPath = join(fixtureDir, "store.sqlite");

	const atlas = createAtlas({ dbPath, repoRoot: fixtureDir, repoIdentity: "repo:regions-label" });

	try {
		writeFileSync(
			join(fixtureDir, "src", "feature", "one.ts"),
			`import { two } from "./two.ts";\nexport function one() { return two(); }\n`,
		);
		writeFileSync(join(fixtureDir, "src", "feature", "two.ts"), `export function two() { return 2; }\n`);

		atlas.ensureIndex();

		const regions = defaultRegionDetector.computeRegions(atlas.store, { seed: 100 });
		assert.ok(regions.length >= 1);

		const reg = regions.find((r) => r.memberFiles.some((f) => f.includes("feature"))) ?? regions[0];
		assert.equal(reg.label_is_heuristic, true);
		assert.equal(reg.provenance, "INFERRED");
		assert.ok(reg.label.includes("feature"));
		assert.ok(reg.cohesion >= 0 && reg.cohesion <= 1.0);
	} finally {
		atlas.close();
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test("J5-REG-005: DIRECTORY_FALLBACK triggers when file count exceeds complexity bound", () => {
	const fixtureDir = join(tmpdir(), `jalacitra-reg-fallback-${Date.now()}`);
	mkdirSync(join(fixtureDir, "src", "pkg"), { recursive: true });
	const dbPath = join(fixtureDir, "store.sqlite");

	const atlas = createAtlas({ dbPath, repoRoot: fixtureDir, repoIdentity: "repo:regions-fallback" });

	try {
		writeFileSync(join(fixtureDir, "src", "pkg", "mod1.ts"), "export const m1 = 1;");
		writeFileSync(join(fixtureDir, "src", "pkg", "mod2.ts"), "export const m2 = 2;");

		atlas.ensureIndex();

		const detector = new RegionDetector();
		// Force maxFilesForModularity = 1 so it falls back to directory grouping
		const regions = detector.computeRegions(atlas.store, { maxFilesForModularity: 1 });

		assert.ok(regions.length >= 1);
		assert.equal(regions[0].algorithm, "DIRECTORY_FALLBACK");
		assert.ok(regions[0].label.includes("directory fallback"));
	} finally {
		atlas.close();
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});
