import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ContextRequest, DEFAULT_CONTEXT_LIMITS } from "../src/core/sandhana/avartana/contracts.ts";
import { scanScope } from "../src/core/sandhana/avartana/scan.ts";
import { rankSnippets } from "../src/core/sandhana/avartana/selection.ts";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createReadTool } from "../src/core/tools/index.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const release of cleanup.splice(0).reverse()) release();
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "padma-context-policy-"));
	const store = new MissionStore(":memory:");
	const kernel = new SandhanaKernel({ cwd: () => root, session: () => "context-policy", store });
	kernel.register(createReadTool(root), "read");
	kernel.captureInput("Inspect configuration and diagnose the failure", "USER");
	kernel.begin("");
	cleanup.push(() => {
		store.close();
		rmSync(root, { recursive: true, force: true });
	});
	return { root, store, kernel };
}
function request(
	kernel: SandhanaKernel,
	sources: ContextRequest["sources"],
	extra: Partial<ContextRequest> = {},
): ContextRequest {
	const result: ContextRequest = {
		version: "AVARTANA_REQUEST/1",
		id: randomUUID(),
		missionId: kernel.state!.mission_id,
		missionRevision: kernel.state!.revision,
		targetBinding: null,
		intent: "diagnose",
		question: "needle",
		sources,
		requiredEvidence: ["observation"],
		freshness: "current_generation",
		coverageMode: "complete_scope",
		literal: "needle",
		limits: { ...DEFAULT_CONTEXT_LIMITS, contextTokens: 32000 },
		cancellationId: randomUUID(),
		...extra,
	};
	if (result.literal === undefined) delete result.literal;
	return result;
}

describe("request-wide context limits and finite expansion", () => {
	it("does not spend a fresh scan allowance per scope or record no-match traversal bytes as zero", async () => {
		const f = fixture();
		for (const name of ["one", "two"]) {
			mkdirSync(join(f.root, name));
			writeFileSync(join(f.root, name, "data.txt"), "x".repeat(1024));
		}
		const answer = await f.kernel.avartana.retrieve(
			request(
				f.kernel,
				[
					{ family: "filesystem_text", locator: "one" },
					{ family: "filesystem_text", locator: "two" },
				],
				{ limits: { ...DEFAULT_CONTEXT_LIMITS, scanBytes: 1024, contextTokens: 32000 } },
			),
		);
		expect(answer.coverage.complete).toBe(false);
		expect(answer.status).not.toBe("NOT_FOUND_IN_COMPLETE_SCOPE");
		expect(answer.limitations).toContainEqual(expect.objectContaining({ code: "BUDGET" }));
		expect(answer.coverage.unexamined).toBeNull();
		expect(f.kernel.state!.used.execution).toBe(1);
		const retained = f.store.get(f.kernel.state!.mission_id, answer.retained!.id, "EvidenceRecord");
		expect(retained.payload).toMatchObject({ scannedBytes: 1024, admittedHits: 0 });
		expect(f.kernel.state!.used.retrieval_bytes).toBeGreaterThanOrEqual(1024);
	});
	it("shares scan capacity across typed-plan source nodes", async () => {
		const f = fixture();
		writeFileSync(join(f.root, "a.txt"), "x".repeat(1024));
		writeFileSync(join(f.root, "b.txt"), "x".repeat(1024));
		const sources: ContextRequest["sources"] = [
			{ family: "filesystem_text", locator: "a.txt" },
			{ family: "filesystem_text", locator: "b.txt" },
		];
		const answer = await f.kernel.avartana.retrieve(
			request(f.kernel, sources, {
				literal: undefined,
				limits: { ...DEFAULT_CONTEXT_LIMITS, scanBytes: 1024, contextTokens: 32000 },
				plan: {
					version: "AVARTANA_PLAN/1",
					nodes: [
						{ id: "a", op: "enumerate_scope", source: sources[0], inputs: [] },
						{ id: "b", op: "enumerate_scope", source: sources[1], inputs: [] },
						{ id: "return", op: "return", inputs: ["a", "b"] },
					],
				},
			}),
		);
		expect(answer.coverage.complete).toBe(false);
		expect(f.kernel.state!.used.execution).toBe(1);
		expect(f.store.get(f.kernel.state!.mission_id, answer.retained!.id, "EvidenceRecord").payload).toMatchObject({
			scannedBytes: 1024,
		});
	});
	it("shares hit capacity across scopes while retaining known omissions and complete scan coverage", async () => {
		const f = fixture();
		writeFileSync(join(f.root, "a.txt"), "needle\n");
		writeFileSync(join(f.root, "b.txt"), "needle\n");
		const answer = await f.kernel.avartana.retrieve(
			request(
				f.kernel,
				[
					{ family: "filesystem_text", locator: "a.txt" },
					{ family: "filesystem_text", locator: "b.txt" },
				],
				{ limits: { ...DEFAULT_CONTEXT_LIMITS, scanBytes: 14, hits: 1, contextTokens: 32000 } },
			),
		);
		expect(answer.snippets).toHaveLength(1);
		expect(answer.coverage.complete).toBe(true);
		expect(answer.coverage.manifests).toHaveLength(2);
		expect(answer.coverage.omittedKnownHits).toBe(1);
		expect(answer.status).toBe("PARTIAL");
		expect(f.store.get(f.kernel.state!.mission_id, answer.retained!.id, "EvidenceRecord").payload).toMatchObject({
			scannedBytes: 14,
			admittedHits: 1,
		});
	});
	it("does not recharge a scanned capture for every matching snippet", async () => {
		const f = fixture();
		writeFileSync(join(f.root, "a.txt"), "needle\nneedle\nneedle\n");
		const answer = await f.kernel.avartana.retrieve(
			request(f.kernel, [{ family: "filesystem_text", locator: "a.txt" }], {
				limits: { ...DEFAULT_CONTEXT_LIMITS, scanBytes: 21, contextTokens: 32000 },
			}),
		);
		expect(answer.snippets).toHaveLength(3);
		expect(answer.limitations).toEqual([]);
		expect(f.store.get(f.kernel.state!.mission_id, answer.retained!.id, "EvidenceRecord").payload).toMatchObject({
			scannedBytes: 21,
		});
	});
	it("does not dispatch a scan when its byte allowance is zero", async () => {
		const f = fixture();
		writeFileSync(join(f.root, "a.txt"), "needle");
		const answer = await f.kernel.avartana.retrieve(
			request(f.kernel, [{ family: "filesystem_text", locator: "." }], {
				limits: { ...DEFAULT_CONTEXT_LIMITS, scanBytes: 0, contextTokens: 32000 },
			}),
		);
		expect(answer.coverage.complete).toBe(false);
		expect(f.kernel.state!.used.execution).toBe(0);
		expect(f.store.get(f.kernel.state!.mission_id, answer.retained!.id, "EvidenceRecord").payload).toMatchObject({
			scannedBytes: 0,
		});
	});
	it("keeps a lost traversal result measured as unknown while the parent retains actual work", async () => {
		const f = fixture();
		writeFileSync(join(f.root, "a.txt"), "x".repeat(1024));
		const execute = f.kernel.execute.bind(f.kernel);
		vi.spyOn(f.kernel, "execute").mockImplementation(async (...args) => {
			await execute(...args);
			throw new Error("Lost traversal result at context seam");
		});
		const answer = await f.kernel.avartana.retrieve(request(f.kernel, [{ family: "filesystem_text", locator: "." }]));
		expect(answer.coverage.complete).toBe(false);
		expect(f.kernel.state!.used.execution).toBe(1);
		expect(f.kernel.state!.used.retrieval_bytes).toBeGreaterThanOrEqual(1024);
		expect(f.store.get(f.kernel.state!.mission_id, answer.retained!.id, "EvidenceRecord").payload).toMatchObject({
			scannedBytes: null,
		});
	});
	it("does not grant another elapsed-time window to a later scope", async () => {
		const f = fixture();
		writeFileSync(join(f.root, "a.txt"), "x");
		writeFileSync(join(f.root, "b.txt"), "x");
		const now = performance.now.bind(performance);
		let elapsed = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now() + elapsed);
		const execute = f.kernel.execute.bind(f.kernel);
		vi.spyOn(f.kernel, "execute").mockImplementation(async (...args) => {
			const result = await execute(...args);
			elapsed += 10001;
			return result;
		});
		const answer = await f.kernel.avartana.retrieve(
			request(
				f.kernel,
				[
					{ family: "filesystem_text", locator: "a.txt" },
					{ family: "filesystem_text", locator: "b.txt" },
				],
				{ limits: { ...DEFAULT_CONTEXT_LIMITS, elapsedMs: 10000, contextTokens: 32000 } },
			),
		);
		expect(answer.status).toBe("CANCELLED");
		expect(f.kernel.state!.used.execution).toBe(1);
		expect(f.store.get(f.kernel.state!.mission_id, answer.retained!.id, "EvidenceRecord").payload).toMatchObject({
			scannedBytes: 1,
		});
	});
	it("checks the opened source size before reading when a file grows after enumeration", async () => {
		const f = fixture();
		const path = join(f.root, "a.txt");
		writeFileSync(path, "x");
		let reservations = 0;
		await expect(
			scanScope(
				f.root,
				"audit",
				"needle",
				1,
				1,
				10000,
				{
					authorize: () => writeFileSync(path, "xx"),
					reserve: () => {
						reservations++;
						return () => {};
					},
				},
				() => {
					throw new Error("No oversized capture may be retained");
				},
			),
		).rejects.toThrow("remaining traversal");
		expect(reservations).toBe(0);
	});
	it("expands only into declared containing scopes and retains reasons, work and historical negative evidence", async () => {
		const f = fixture();
		mkdirSync(join(f.root, "near"));
		writeFileSync(join(f.root, "near", "a.txt"), "x");
		writeFileSync(join(f.root, "z.txt"), "needle");
		const answer = await f.kernel.avartana.retrieve(
			request(
				f.kernel,
				[
					{ family: "filesystem_text", locator: "near" },
					{ family: "filesystem_text", locator: "." },
				],
				{
					expansion: {
						version: "AVARTANA_EXPANSION/1",
						minimumHits: 1,
						steps: [{ sourceIndex: 1, reason: "No hit in the named component" }],
					},
				},
			),
		);
		expect(answer.snippets[0]?.text).toBe("needle");
		expect(answer.values).toContainEqual(
			expect.objectContaining({
				version: "AVARTANA_EXPANSION_STEP/1",
				reason: "No hit in the named component",
				newlyCapturedSources: 1,
				previousNegativeEvidence: expect.stringContaining("HISTORICAL_CAPTURE_ONLY"),
				status: "EXAMINED",
				remaining: expect.objectContaining({ scanBytes: DEFAULT_CONTEXT_LIMITS.scanBytes - 8 }),
			}),
		);
		expect(f.kernel.state!.used.execution).toBe(2);
		expect(f.kernel.state!.used.ticks).toBe(0);
		expect(answer.coverage.eligible).toBe(2);
		expect(answer.coverage.manifests).toHaveLength(1);
	});
	it("stops expansion when the narrow search is sufficient", async () => {
		const f = fixture();
		mkdirSync(join(f.root, "near"));
		writeFileSync(join(f.root, "near", "a.txt"), "needle");
		writeFileSync(join(f.root, "z.txt"), "must not scan");
		const answer = await f.kernel.avartana.retrieve(
			request(
				f.kernel,
				[
					{ family: "filesystem_text", locator: "near" },
					{ family: "filesystem_text", locator: "." },
				],
				{
					expansion: {
						version: "AVARTANA_EXPANSION/1",
						minimumHits: 1,
						steps: [{ sourceIndex: 1, reason: "Only if insufficient" }],
					},
				},
			),
		);
		expect(answer.snippets[0]?.text).toBe("needle");
		expect(f.kernel.state!.used.execution).toBe(1);
		expect(answer.values).not.toContainEqual(expect.objectContaining({ version: "AVARTANA_EXPANSION_STEP/1" }));
	});
	it("rejects undeclared, sibling, repeated and out-of-workspace expansion before dispatch", async () => {
		const f = fixture();
		for (const locator of ["sibling", "near", ".."]) {
			const before = f.kernel.state;
			await expect(
				f.kernel.avartana.retrieve(
					request(
						f.kernel,
						[
							{ family: "filesystem_text", locator: "near" },
							{ family: "filesystem_text", locator },
						],
						{
							expansion: {
								version: "AVARTANA_EXPANSION/1",
								minimumHits: 1,
								steps: [{ sourceIndex: 1, reason: "Invalid" }],
							},
						},
					),
				),
			).rejects.toThrow("containing workspace scope");
			expect(f.kernel.state).toEqual(before);
		}
		await expect(
			f.kernel.avartana.retrieve(
				request(f.kernel, [{ family: "filesystem_text", locator: "near" }], {
					expansion: {
						version: "AVARTANA_EXPANSION/1",
						minimumHits: 1,
						steps: [{ sourceIndex: 1, reason: "Undeclared" }],
					},
				}),
			),
		).rejects.toThrow("declared same-family");
	});
	it("does not renew scan allowance when progressive expansion runs out of capacity", async () => {
		const f = fixture();
		mkdirSync(join(f.root, "near"));
		writeFileSync(join(f.root, "near", "a.txt"), "x".repeat(1024));
		writeFileSync(join(f.root, "z.txt"), "needle");
		const answer = await f.kernel.avartana.retrieve(
			request(
				f.kernel,
				[
					{ family: "filesystem_text", locator: "near" },
					{ family: "filesystem_text", locator: "." },
				],
				{
					limits: { ...DEFAULT_CONTEXT_LIMITS, scanBytes: 1024, contextTokens: 32000 },
					expansion: {
						version: "AVARTANA_EXPANSION/1",
						minimumHits: 1,
						steps: [{ sourceIndex: 1, reason: "Broaden" }],
					},
				},
			),
		);
		expect(answer.coverage.complete).toBe(false);
		expect(answer.values).toContainEqual(
			expect.objectContaining({
				version: "AVARTANA_EXPANSION_STEP/1",
				status: "BUDGET",
				remaining: expect.objectContaining({ scanBytes: 0 }),
			}),
		);
		expect(f.kernel.state!.used.execution).toBe(1);
	});
});

describe("deterministic evidence selection", () => {
	it("ranks exact query matches ahead of input order with inspectable selected and omitted features", async () => {
		const f = fixture();
		writeFileSync(join(f.root, "a.txt"), "unrelated");
		writeFileSync(join(f.root, "z.txt"), "needle");
		const answer = await f.kernel.avartana.retrieve(
			request(
				f.kernel,
				[
					{ family: "filesystem_text", locator: "a.txt" },
					{ family: "filesystem_text", locator: "z.txt" },
				],
				{
					literal: undefined,
					coverageMode: "targeted",
					limits: { ...DEFAULT_CONTEXT_LIMITS, ranges: 1, contextTokens: 32000 },
				},
			),
		);
		expect(answer.snippets).toHaveLength(1);
		expect(answer.snippets[0].text).toBe("needle");
		expect(answer.snippets[0].selection?.features.exactQuery).toBe(1);
		expect(answer.values).toContainEqual(
			expect.objectContaining({
				version: "AVARTANA_SELECTION/1",
				candidates: expect.arrayContaining([
					expect.objectContaining({
						selected: true,
						selection: expect.objectContaining({ features: expect.objectContaining({ exactQuery: 1 }) }),
					}),
					expect.objectContaining({
						selected: false,
						selection: expect.objectContaining({ features: expect.objectContaining({ exactQuery: 0 }) }),
					}),
				]),
			}),
		);
	});
	it("deduplicates ranges and uses stable tie-breaking rather than supplied order", async () => {
		const f = fixture();
		writeFileSync(join(f.root, "a.txt"), "needle");
		writeFileSync(join(f.root, "b.txt"), "needle");
		const input = request(f.kernel, [{ family: "filesystem_text", locator: "." }]);
		const answer = await f.kernel.avartana.retrieve(input);
		const position = f.kernel.missionPosition();
		const first = rankSnippets(answer.snippets, input, position, f.root, null, new Set());
		const reverse = rankSnippets([...answer.snippets].reverse(), input, position, f.root, null, new Set());
		expect(first.map((snippet) => snippet.citation)).toEqual(reverse.map((snippet) => snippet.citation));
		expect(
			rankSnippets([...answer.snippets, answer.snippets[0]], input, position, f.root, null, new Set()),
		).toHaveLength(2);
	});
	it("diversifies equally relevant sources and test roles before repeated lines", async () => {
		const f = fixture();
		writeFileSync(join(f.root, "a.txt"), "needle\nneedle\n");
		writeFileSync(join(f.root, "b.txt"), "needle\n");
		writeFileSync(join(f.root, "a.test.ts"), "needle\n");
		const answer = await f.kernel.avartana.retrieve(request(f.kernel, [{ family: "filesystem_text", locator: "." }]));
		expect(answer.snippets).toHaveLength(4);
		expect(new Set(answer.snippets.slice(0, 3).map((snippet) => snippet.source.ref.logicalId)).size).toBe(3);
		expect(answer.snippets.slice(0, 2).some((snippet) => snippet.source.locator.endsWith("a.test.ts"))).toBe(true);
		expect(answer.snippets[3].selection?.features.sourceDiversity).toBe(0);
	});
	it("keeps both sides of a known conflict reference-only when one-sided excerpts would fit", async () => {
		const f = fixture();
		writeFileSync(join(f.root, "a.json"), '{"timeout":20}');
		writeFileSync(join(f.root, "b.json"), '{"timeout":30}');
		const sources: ContextRequest["sources"] = [
			{ family: "filesystem_text", locator: "a.json" },
			{ family: "filesystem_text", locator: "b.json" },
		];
		const answer = await f.kernel.avartana.retrieve(
			request(f.kernel, sources, {
				literal: undefined,
				coverageMode: "targeted",
				limits: { ...DEFAULT_CONTEXT_LIMITS, ranges: 1, contextTokens: 32000 },
				plan: {
					version: "AVARTANA_PLAN/1",
					nodes: [
						{ id: "a", op: "read_range", source: sources[0], inputs: [] },
						{ id: "b", op: "read_range", source: sources[1], inputs: [] },
						{ id: "compare", op: "compare", inputs: ["a", "b"], key: "timeout" },
						{ id: "return", op: "return", inputs: ["compare"] },
					],
				},
			}),
		);
		expect(answer.contradictions).toHaveLength(1);
		expect(answer.snippets).toEqual([]);
		expect(answer.omitted).toHaveLength(2);
		expect(answer.omitted.every((reason) => reason.includes("opposing conflict"))).toBe(true);
		const plan: ContextRequest["plan"] = {
			version: "AVARTANA_PLAN/1",
			nodes: [
				{ id: "a", op: "read_range", source: sources[0], inputs: [] },
				{ id: "b", op: "read_range", source: sources[1], inputs: [] },
				{ id: "compare", op: "compare", inputs: ["a", "b"], key: "timeout" },
				{ id: "return", op: "return", inputs: ["compare"] },
			],
		};
		const full = await f.kernel.avartana.retrieve(
			request(f.kernel, sources, { literal: undefined, coverageMode: "targeted", plan }),
		);
		expect(full.snippets).toHaveLength(2);
		const ceiling =
			full.snippets.reduce((bytes, snippet) => bytes + Buffer.byteLength(JSON.stringify(snippet)), 0) + 128;
		const bounded = await f.kernel.avartana.retrieve(
			request(f.kernel, sources, {
				literal: undefined,
				coverageMode: "targeted",
				plan,
				limits: { ...DEFAULT_CONTEXT_LIMITS, ranges: 2, returnBytes: ceiling, contextTokens: ceiling },
			}),
		);
		expect(bounded.contradictions).toHaveLength(1);
		expect(bounded.snippets).toEqual([]);
		expect(bounded.status).toBe("PARTIAL");
	});
});
