import assert from "node:assert/strict";
import test from "node:test";
import { AdapterRegistry, type ExtractContext, type FileInfo, type LanguageAdapter } from "../adapters/adapter.ts";
import { GenericFallbackAdapter } from "../adapters/generic/fallback.ts";
import { ToyLanguageAdapter } from "../adapters/toy/toy.ts";
import { runAdapterConformanceSuite } from "./adapter-conformance.ts";

test("J5-ADP-001 / J5-GEN-ADP-001: Conformance suite on ToyLanguageAdapter", () => {
	const toyAdapter = new ToyLanguageAdapter();
	const validFile: FileInfo = {
		path: "src/sample.toy",
		language: "toy",
		class: "source",
		sizeBytes: 100,
		contentDigest: "sha256:dummy",
		isBinary: false,
	};
	const validContent = `
import helper;
fn main {
call helper;
}
`;

	const errorFile: FileInfo = {
		path: "src/broken.toy",
		language: "toy",
		class: "source",
		sizeBytes: 50,
		contentDigest: "sha256:err",
		isBinary: false,
	};
	const errorContent = `
fn test {
SYNTAX_ERROR
}
`;

	runAdapterConformanceSuite({
		adapter: toyAdapter,
		validSample: {
			file: validFile,
			content: validContent,
			expectedDeclarationsCount: 1,
			expectedReferencesCount: 2,
		},
		errorSample: {
			file: errorFile,
			content: errorContent,
		},
	});
});

test("J5-ADP-001: Conformance suite on GenericFallbackAdapter", () => {
	const genericAdapter = new GenericFallbackAdapter();
	const file: FileInfo = {
		path: "README.md",
		language: "markdown",
		class: "docs",
		sizeBytes: 25,
		contentDigest: "sha256:doc",
		isBinary: false,
	};
	const content = "# Hello World\nSome docs.";

	runAdapterConformanceSuite({
		adapter: genericAdapter,
		validSample: {
			file,
			content,
			expectedDeclarationsCount: 0,
			expectedReferencesCount: 0,
		},
	});
});

test("J5-ADP-002: Adapter timeout enforcement and failure handling", () => {
	const registry = new AdapterRegistry();
	const toy = new ToyLanguageAdapter();
	registry.register(toy);

	// Slow adapter simulating timeout
	const slowAdapter: LanguageAdapter = {
		id: "slow_adapter",
		version: toy.version,
		languages: toy.languages,
		provenanceClasses: toy.provenanceClasses,
		blindSpotKinds: toy.blindSpotKinds,
		grammarVersions: () => toy.grammarVersions(),
		configFingerprintInputs: (repo: { repoRoot: string }) => toy.configFingerprintInputs(repo),
		supports: (file: FileInfo) => toy.supports(file),
		extract: () => {
			const start = Date.now();
			while (Date.now() - start < 150) {
				// busy wait 150ms
			}
			return toy.extract(
				{ repoView: { repoRoot: "/", repoIdentity: "x", files: [] } },
				{ path: "a.toy", language: "toy", class: "source", sizeBytes: 10, contentDigest: "sha", isBinary: false },
				new Uint8Array(),
			);
		},
	};
	registry.register(slowAdapter);

	const ctx: ExtractContext = {
		repoView: { repoRoot: "/", repoIdentity: "x", files: [] },
		timeoutMs: 50, // 50ms ceiling < 150ms execution
	};
	const file: FileInfo = {
		path: "src/slow.toy",
		language: "toy",
		class: "source",
		sizeBytes: 10,
		contentDigest: "sha256:s",
		isBinary: false,
	};

	const res = registry.safeExtract(slowAdapter, ctx, file, new Uint8Array());
	assert.equal(res.status, "FAILED");
	assert.equal(res.reasonCode, "PARSE_TIMEOUT");
	assert.ok(res.diagnostics.some((d) => d.code === "PARSE_TIMEOUT"));
});

test("J5-PROV-002: Registry validation of declared properties", () => {
	const registry = new AdapterRegistry();

	// Invalid adapter with missing provenanceClasses
	assert.throws(
		() => {
			registry.register({
				id: "bad_adapter",
				version: "1.0",
				languages: ["bad"],
				provenanceClasses: [], // Violated: must declare at least one
				grammarVersions: () => ({}),
				configFingerprintInputs: () => [],
				supports: () => true,
				extract: () => ({
					status: "OK",
					declarations: [],
					references: [],
					configKeys: [],
					testCases: [],
					contracts: [],
					blindSpots: {},
					diagnostics: [],
				}),
				blindSpotKinds: [],
			});
		},
		{
			message: /must declare at least one provenanceClass/,
		},
	);
});
