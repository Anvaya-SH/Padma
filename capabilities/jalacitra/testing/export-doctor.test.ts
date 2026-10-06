// Export, Doctor, and External Hint Import Unit Tests (Steps 18 & 19, J5-EXP-001..003, J5-OBS-003, J5-IMP-001..002)

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultExternalHintImporter } from "../adapters/external/graphify-import.ts";
import { createAtlas } from "../api/atlas.ts";
import { defaultAtlasDoctor } from "../doctor/doctor.ts";
import { defaultAtlasExporter } from "../export/export-contract.ts";

test("J5-EXP-001 / J5-EXP-002: Export contract produces redaction-safe JSON with untrusted: true", () => {
	const fixtureDir = join(tmpdir(), `jalacitra-exp-${Date.now()}`);
	mkdirSync(join(fixtureDir, "src"), { recursive: true });
	const dbPath = join(fixtureDir, "store.sqlite");

	const atlas = createAtlas({ dbPath, repoRoot: fixtureDir, repoIdentity: "repo:exp-test" });

	try {
		writeFileSync(join(fixtureDir, "src", "index.ts"), `export function mainFunction() { return 100; }\n`);

		atlas.ensureIndex();

		const status = atlas.status();
		const doc = defaultAtlasExporter.exportSnapshot(atlas.store, {
			coverage: status.coverage,
		});

		assert.equal(doc.schema_version, "1.0.0");
		assert.ok(doc.snapshot.indexGeneration >= 1);
		assert.ok(doc.nodes.length >= 1);
		assert.ok(doc.redaction_notice.includes("REDACTION_NOTICE"));

		// Verify every node and edge carries untrusted: true (J5-SEC-004, J5-EXP-001)
		for (const n of doc.nodes) {
			assert.equal(n.untrusted, true);
		}
		for (const e of doc.edges) {
			assert.equal(e.untrusted, true);
		}

		// Verify no machine or temporary directory paths appear in nodes
		const exportedStr = JSON.stringify(doc);
		assert.equal(exportedStr.includes(tmpdir()), false);
		assert.equal(exportedStr.includes("Users"), false);
	} finally {
		atlas.close();
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test("J5-OBS-003: Atlas Doctor runs integrity, foreign key, and orphan checks", () => {
	const fixtureDir = join(tmpdir(), `jalacitra-doc-${Date.now()}`);
	mkdirSync(join(fixtureDir, "src"), { recursive: true });
	const dbPath = join(fixtureDir, "store.sqlite");

	const atlas = createAtlas({ dbPath, repoRoot: fixtureDir, repoIdentity: "repo:doc-test" });

	try {
		writeFileSync(join(fixtureDir, "src", "file.ts"), "export const z = 99;");
		atlas.ensureIndex();

		const report = defaultAtlasDoctor.audit(atlas.store);

		assert.equal(report.healthy, true);
		assert.ok(report.totalChecks >= 4);
		assert.equal(report.recommendation, "NONE");

		const checkNames = report.findings.map((f) => f.check);
		assert.ok(checkNames.includes("sqlite_integrity"));
		assert.ok(checkNames.includes("foreign_keys"));
		assert.ok(checkNames.includes("orphan_nodes"));
		assert.ok(checkNames.includes("dependency_table"));
	} finally {
		atlas.close();
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test("J5-IMP-001 / J5-IMP-002: External hint import enforces INFERRED ceiling and non-promotion", () => {
	const fixtureDir = join(tmpdir(), `jalacitra-imp-${Date.now()}`);
	mkdirSync(fixtureDir, { recursive: true });
	const dbPath = join(fixtureDir, "store.sqlite");

	const atlas = createAtlas({ dbPath, repoRoot: fixtureDir, repoIdentity: "repo:imp-test" });

	const externalGraphPath = join(fixtureDir, "graph.json");
	writeFileSync(
		externalGraphPath,
		JSON.stringify({
			nodes: [
				{ id: "mod_a", label: "Module A" },
				{ id: "mod_b", label: "Module B" },
			],
			edges: [{ source: "mod_a", target: "mod_b", relation: "references", tool: "graphify", tool_version: "2.1" }],
		}),
	);

	try {
		atlas.ensureIndex();

		const result = defaultExternalHintImporter.importHints(atlas.store, {
			filePath: externalGraphPath,
			repoIdentity: "repo:imp-test",
		});

		assert.equal(result.success, true);
		assert.equal(result.nodesImported, 2);
		assert.equal(result.edgesImported, 1);
		// Provenance class is strictly INFERRED (non-promotion guarantee J5-IMP-001)
		assert.equal(result.provenanceClass, "INFERRED");

		// Verify edge in DB has class = INFERRED and method = external_import
		const edge = atlas.store.rawDb.prepare("SELECT * FROM edges WHERE method = 'external_import'").get() as
			| Record<string, unknown>
			| undefined;
		assert.ok(edge);
		assert.equal(edge.class, "INFERRED");
		assert.equal(edge.tool_name, "graphify");
	} finally {
		atlas.close();
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});
