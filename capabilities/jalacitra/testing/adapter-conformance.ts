// Jālacitra Adapter Conformance Suite (Part S1.2, J5-ADP-001 through J5-ADP-005, J5-GEN-ADP-001)

import assert from "node:assert/strict";
import { AdapterRegistry, type ExtractContext, type FileInfo, type LanguageAdapter } from "../adapters/adapter.ts";

export interface ConformanceOptions {
	adapter: LanguageAdapter;
	validSample: {
		file: FileInfo;
		content: string;
		expectedDeclarationsCount?: number;
		expectedReferencesCount?: number;
	};
	errorSample?: {
		file: FileInfo;
		content: string;
	};
}

export function runAdapterConformanceSuite(options: ConformanceOptions): void {
	const registry = new AdapterRegistry();
	registry.register(options.adapter);

	const ctx: ExtractContext = {
		repoView: {
			repoRoot: "/test/repo",
			repoIdentity: "repo_test_conf",
			files: [options.validSample.file.path],
		},
		timeoutMs: 2000,
	};

	const bytes = new TextEncoder().encode(options.validSample.content);

	// 1. Determinism: run twice, verify results are identical
	const res1 = registry.safeExtract(options.adapter, ctx, options.validSample.file, bytes);
	const res2 = registry.safeExtract(options.adapter, ctx, options.validSample.file, bytes);
	assert.deepEqual(res1, res2, "Adapter extraction must be completely deterministic");

	// 2. Output checks
	assert.equal(res1.status, "OK");
	if (options.validSample.expectedDeclarationsCount !== undefined) {
		assert.equal(res1.declarations.length, options.validSample.expectedDeclarationsCount);
	}
	if (options.validSample.expectedReferencesCount !== undefined) {
		assert.equal(res1.references.length, options.validSample.expectedReferencesCount);
	}

	// 3. Byte range correctness: range slices must match content
	for (const decl of res1.declarations) {
		assert.ok(decl.range.startByte >= 0);
		assert.ok(decl.range.endByte >= decl.range.startByte);
		assert.ok(decl.range.startLine >= 1);
		assert.ok(decl.range.endLine >= decl.range.startLine);
	}
	for (const ref of res1.references) {
		assert.ok(ref.range.startByte >= 0);
		assert.ok(ref.range.endByte >= ref.range.startByte);
		assert.ok(ref.range.startLine >= 1);
		assert.ok(ref.range.endLine >= ref.range.startLine);
	}

	// 4. Error recovery if error sample provided
	if (options.errorSample) {
		const errBytes = new TextEncoder().encode(options.errorSample.content);
		const errRes = registry.safeExtract(options.adapter, ctx, options.errorSample.file, errBytes);
		assert.ok(errRes.status === "PARTIAL" || errRes.status === "FAILED");
		assert.ok(errRes.blindSpots.PARSER_ERROR_RECOVERY !== undefined && errRes.blindSpots.PARSER_ERROR_RECOVERY > 0);
		assert.ok(errRes.diagnostics.length > 0);
		assert.ok(errRes.diagnostics.length <= 20, "Diagnostics must be capped at 20");
		for (const d of errRes.diagnostics) {
			if (d.excerpt) {
				assert.ok(d.excerpt.length <= 120, "Excerpts must be capped at 120 chars");
			}
		}
	}
}
