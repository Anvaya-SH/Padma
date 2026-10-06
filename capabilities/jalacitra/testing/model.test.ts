import assert from "node:assert/strict";
import test from "node:test";
import { EDGE_SEMANTICS, isDependentHop } from "../model/edge-semantics.ts";
import { validateEdgeAttrs } from "../model/edges.ts";
import { canonicalFileId, canonicalSymbolId, deriveId, deriveRepoIdentity, normalizeRepoPath } from "../model/ids.ts";
import { validateNodeAttrs } from "../model/nodes.ts";
import { compareProvenance, weakestProvenance } from "../model/provenance.ts";
import { assertReasonCode, isKnownReasonCode, REASON_CODES } from "../model/reason-codes.ts";

test("J5-ID-001 / J5-ID-003: Identity determinism across repeated invocations", () => {
	const repoId = "repo_test123";
	const fileA = canonicalFileId(repoId, "src/auth/login.ts");
	const fileB = canonicalFileId(repoId, "src/auth/login.ts");
	assert.equal(fileA, fileB);

	const idA = deriveId(fileA);
	const idB = deriveId(fileB);
	assert.equal(idA, idB);
	assert.equal(idA.length, 24);

	const symA = canonicalSymbolId(idA, "function", "verifySession");
	const symB = canonicalSymbolId(idA, "function", "verifySession");
	assert.equal(symA, symB);
	assert.equal(deriveId(symA), deriveId(symB));
});

test("J5-ID-002: Path normalization independent of separators", () => {
	assert.equal(normalizeRepoPath("src\\auth\\login.ts"), "src/auth/login.ts");
	assert.equal(normalizeRepoPath("/src/auth/login.ts"), "src/auth/login.ts");
	assert.equal(normalizeRepoPath("./src/auth/login.ts"), "src/auth/login.ts");
	assert.equal(normalizeRepoPath("src/../src/auth/login.ts"), "src/auth/login.ts");
});

test("J5-ID-004: Distinct repositories produce distinct IDs for same path", () => {
	const repo1 = deriveRepoIdentity("/root/app1", "commit1", "wt1");
	const repo2 = deriveRepoIdentity("/root/app2", "commit2", "wt2");
	assert.notEqual(repo1, repo2);

	const file1 = canonicalFileId(repo1, "index.ts");
	const file2 = canonicalFileId(repo2, "index.ts");
	assert.notEqual(file1, file2);
	assert.notEqual(deriveId(file1), deriveId(file2));
});

test("J5-OBS-005: Reason-code catalog completeness", () => {
	const appendixCodes = [
		"NO_REPOSITORY_BINDING",
		"INDEX_ABSENT",
		"SCHEMA_NEWER",
		"IGNORED_BY_RULE",
		"EXCLUDED_VCS_INTERNAL",
		"EXCLUDED_DEPENDENCY_DIR",
		"EXCLUDED_SECRET_PATTERN",
		"BUILD_OUTPUT_ARTIFACT_ONLY",
		"BINARY_FILE",
		"FILE_TOO_LARGE",
		"SYMLINK_OUTSIDE_ROOT",
		"PATH_OUTSIDE_ROOT",
		"CASE_COLLISION",
		"PARSE_TIMEOUT",
		"PARSE_FAILED",
		"PARSER_ERROR_RECOVERY",
		"UNSUPPORTED_LANGUAGE",
		"CONFIG_TRUNCATED",
		"CONFIG_EXECUTABLE_NOT_EVALUATED",
		"SECRET_CONTENT_DETECTED",
		"NO_SUCH_MODULE",
		"NO_SUCH_EXPORT",
		"AMBIGUOUS_STAR_EXPORT",
		"DEPTH_LIMIT",
		"CYCLE_DETECTED",
		"DYNAMIC_SPECIFIER",
		"EXTERNAL_NOT_INDEXED",
		"FAN_OUT_TRUNCATED",
		"HUB_NODE_NOT_EXPANDED",
		"MODULE_RESOLUTION_MODE_UNSUPPORTED",
		"CONFIG_ALIAS_CONFLICT",
		"HELPER_NAME_CONVENTION",
		"FRAMEWORK_CONVENTION",
		"DECLARATION_MERGE",
		"OBSERVATION_GENERATION_MISMATCH",
		"EVIDENCE_REQUIRED",
		"SCOPE_DENIED",
		"SEMANTIC_UNAVAILABLE",
		"SEMANTIC_DEFERRED",
		"VERIFY_CEILING",
		"SHRINK_GUARD",
		"SOURCE_CHANGED",
		"SOURCE_REMOVED",
		"CONFIG_CHANGED",
		"TOOL_CHANGED",
		"SCHEMA_CHANGED",
		"DEPENDENCY_CHANGED",
	];

	for (const code of appendixCodes) {
		assert.ok(isKnownReasonCode(code), `Missing code: ${code}`);
		const entry = REASON_CODES[code];
		assert.ok(entry, `Catalog entry for ${code} must exist`);
		assert.equal(entry.code, code);
		assert.ok(entry.description.length > 0);
		assert.ok(["SKIP", "PARTIAL", "UNRESOLVED", "DOWNGRADE", "DENIED", "ERROR"].includes(entry.category));
	}

	assert.throws(() => assertReasonCode("UNKNOWN_INVALID_CODE_123"), /not registered/);
});

test("J5-PROV-001: Provenance ranking and weakest calculation", () => {
	assert.ok(compareProvenance("RUNTIME_CONFIRMED", "PARSED") < 0);
	assert.ok(compareProvenance("INFERRED", "COMPILED") > 0);
	assert.equal(weakestProvenance(["PARSED", "COMPILED", "RUNTIME_CONFIRMED"]), "PARSED");
	assert.equal(weakestProvenance(["PARSED", "INFERRED"]), "INFERRED");
});

test("J5-ALG-002: Edge semantics and dependent hops", () => {
	// Calls: callers are dependents (backward traversal: dst -> src)
	assert.equal(EDGE_SEMANTICS.calls.impactDirection, "backward");
	assert.equal(isDependentHop("calls", "dst_to_src"), true);
	assert.equal(isDependentHop("calls", "src_to_dst"), false);

	// Exposes: contracts exposed are dependents (forward traversal: src -> dst)
	assert.equal(EDGE_SEMANTICS.exposes.impactDirection, "forward");
	assert.equal(isDependentHop("exposes", "src_to_dst"), true);
	assert.equal(isDependentHop("exposes", "dst_to_src"), false);

	// Renamed from: excluded from impact
	assert.equal(EDGE_SEMANTICS.renamed_from.impactDirection, "none");
	assert.equal(isDependentHop("renamed_from", "src_to_dst"), false);
	assert.equal(isDependentHop("renamed_from", "dst_to_src"), false);
});

test("J5-ATTR-001 / J5-ATTR-002: Attribute discipline and bounds", () => {
	const rawNodeAttrs = {
		path: "src/index.ts",
		language: "typescript",
		unknown_illegal_key: "should_be_dropped",
		long_str: "a".repeat(600),
		large_array: new Array(100).fill(1),
	};
	const cleaned = validateNodeAttrs("file", rawNodeAttrs);
	assert.equal(cleaned.path, "src/index.ts");
	assert.equal(cleaned.language, "typescript");
	assert.equal(cleaned.unknown_illegal_key, undefined);
	assert.equal(cleaned.long_str, undefined); // not in allowed keys for file

	const symbolAttrs = validateNodeAttrs("symbol", {
		symbol_kind: "function",
		qualified_name: "testFn",
		exported: true,
		signature_digest: "s".repeat(600),
	});
	assert.equal((symbolAttrs.signature_digest as string).length, 512);

	const edgeAttrs = validateEdgeAttrs({
		reason: "IMPORTS_AND_CALLS",
		unauthorized_key: "discard",
	});
	assert.equal(edgeAttrs.reason, "IMPORTS_AND_CALLS");
	assert.equal(edgeAttrs.unauthorized_key, undefined);
});
