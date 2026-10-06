import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@anvaya.sh/padma-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextError, type ContextRequest, DEFAULT_CONTEXT_LIMITS } from "../src/core/sandhana/avartana/contracts.ts";
import { assemblePacket, buildCapsule, validateCapsule } from "../src/core/sandhana/avartana/position.ts";
import { verifyCitation } from "../src/core/sandhana/avartana/sources.ts";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { digest, type KernelConfigurationInput, makeRecord } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createBashTool, createReadTool, createWriteTool } from "../src/core/tools/index.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const release of cleanup.splice(0).reverse()) release();
});
function fixture(
	instruction = "Inspect configuration and diagnose the failure",
	configuration?: KernelConfigurationInput,
) {
	const root = mkdtempSync(join(tmpdir(), "padma-avartana-"));
	const cwd = join(root, "workspace");
	mkdirSync(cwd);
	const store = new MissionStore(":memory:");
	const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "context", store, configuration });
	kernel.register(createReadTool(cwd), "read");
	kernel.register(createWriteTool(cwd), "write");
	kernel.captureInput(instruction, "USER");
	kernel.begin("");
	cleanup.push(() => {
		store.close();
		rmSync(root, { recursive: true, force: true });
	});
	return { cwd, store, kernel };
}
function request(
	kernel: SandhanaKernel,
	sources: ContextRequest["sources"],
	extra: Partial<ContextRequest> = {},
): ContextRequest {
	return {
		version: "AVARTANA_REQUEST/1",
		id: randomUUID(),
		missionId: kernel.state!.mission_id,
		missionRevision: kernel.state!.revision,
		targetBinding: null,
		intent: "diagnose",
		question: "What is the exact configuration?",
		sources,
		requiredEvidence: ["observation"],
		freshness: "current_generation",
		coverageMode: "targeted",
		limits: { ...DEFAULT_CONTEXT_LIMITS, contextTokens: 32000 },
		cancellationId: randomUUID(),
		...extra,
	};
}
describe("real guarded Avartana sources and deterministic reconstruction", () => {
	it("maps UTF-8 BOM, CRLF and multibyte inclusive lines to immutable exact bytes across external edits", async () => {
		const f = fixture();
		const bytes = Buffer.from("\ufefffirst\r\nआवर्तन\r\nlast\n");
		writeFileSync(join(f.cwd, "a.txt"), bytes);
		const answer = await f.kernel.avartana.retrieve(
			request(f.kernel, [
				{ family: "filesystem_text", locator: "a.txt", range: { kind: "lines_inclusive", first: 2, last: 20 } },
			]),
		);
		expect(answer.status).toBe("PARTIAL");
		expect(answer.snippets).toHaveLength(1);
		const snippet = answer.snippets[0];
		expect(snippet.text).toBe("आवर्तन\r\nlast\n");
		expect(snippet.truncated).toBe(true);
		expect(snippet.citation.rawRange.begin).toBe(Buffer.byteLength("\ufefffirst\r\n"));
		expect(
			verifyCitation(f.store, answer.snapshots[0].securityScope, snippet.source, snippet.citation, (source) =>
				f.kernel.assertContextVisibility(source),
			),
		).toEqual(bytes.subarray(snippet.citation.rawRange.begin));
		writeFileSync(join(f.cwd, "a.txt"), "changed\n");
		expect(f.kernel.contextCurrentDigest(snippet.source)).not.toBe(digest(bytes));
		expect(
			verifyCitation(f.store, f.kernel.state!.mission_id, snippet.source, snippet.citation, (source) =>
				f.kernel.assertContextVisibility(source),
			),
		).toEqual(bytes.subarray(snippet.citation.rawRange.begin));
		const current = await f.kernel.avartana.retrieve(
			request(f.kernel, [{ family: "filesystem_text", locator: "a.txt" }]),
		);
		expect(current.snippets[0].text).toBe("changed\n");
		expect(current.snippets[0].source.ref.observedVersion).not.toBe(snippet.source.ref.observedVersion);
		expect(f.kernel.state!.used.ticks).toBe(0);
		expect(f.kernel.state!.used.execution).toBe(2);
	});
	it("enforces namespace and revoked visibility even for retained citations", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "secret-free bytes");
		const answer = await f.kernel.avartana.retrieve(
			request(f.kernel, [{ family: "filesystem_text", locator: "a.txt" }]),
		);
		const snippet = answer.snippets[0];
		expect(() => verifyCitation(f.store, "another-mission", snippet.source, snippet.citation, () => {})).toThrow(
			"namespace",
		);
		f.kernel.revoke();
		expect(() =>
			verifyCitation(f.store, f.kernel.state!.mission_id, snippet.source, snippet.citation, (source) =>
				f.kernel.assertContextVisibility(source),
			),
		).toThrow("grant");
		expect(f.store.artifact(f.kernel.state!.mission_id, snippet.source.ref.artifact.id).toString()).toBe(
			"secret-free bytes",
		);
	});
	it("keeps lossy/redacted views distinct from exact quotes and rejects forged digest bounds", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), Buffer.from([0x61, 0xff, 0x0a]));
		const answer = await f.kernel.avartana.retrieve(
			request(f.kernel, [{ family: "filesystem_text", locator: "a.txt" }]),
		);
		const snippet = answer.snippets[0];
		expect(snippet.citation.lossy).toBe(true);
		expect(() =>
			verifyCitation(
				f.store,
				f.kernel.state!.mission_id,
				snippet.source,
				{ ...snippet.citation, excerptDigest: "invented" },
				(source) => f.kernel.assertContextVisibility(source),
			),
		).toThrow("mismatch");
	});
	it("returns truthful no-match partial scope, persists a manifest and completes only the declared textual corpus", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "prefix");
		writeFileSync(join(f.cwd, "z.txt"), "needle");
		const answer = await f.kernel.avartana.retrieve(
			request(f.kernel, [{ family: "filesystem_text", locator: "." }], {
				coverageMode: "complete_scope",
				literal: "needle",
				limits: { ...DEFAULT_CONTEXT_LIMITS, scanBytes: 6, contextTokens: 32000 },
			}),
		);
		expect(answer.status).toBe("NO_MATCH_IN_PARTIAL_SCOPE");
		expect(answer.coverage.complete).toBe(false);
		expect(answer.coverage.unexamined).toBe(1);
		expect(answer.coverage.manifest).not.toBeNull();
		const next = await f.kernel.avartana.retrieve(
			request(f.kernel, [{ family: "filesystem_text", locator: "." }], {
				coverageMode: "complete_scope",
				literal: "needle",
				continuation: answer.continuation!.id,
			}),
		);
		expect(next.snippets[0].text).toBe("needle");
		expect(next.coverage.completed).toBe(2);
		expect(next.coverage.complete).toBe(true);
		expect(next.coverage.semantics).toContain("no corpus-wide");
		expect(
			f.store
				.records(f.kernel.state!.mission_id)
				.filter((record) => record.record_type === "EvidenceRecord" && record.source === "AVARTANA_CAPTURE/1"),
		).toHaveLength(2);
		writeFileSync(join(f.cwd, "a.txt"), "changed");
		const stale = await f.kernel.avartana.retrieve(
			request(f.kernel, [{ family: "filesystem_text", locator: "." }], {
				coverageMode: "complete_scope",
				literal: "needle",
				continuation: answer.continuation!.id,
			}),
		);
		expect(stale.status).toBe("STALE");
		expect(stale.coverage.complete).toBe(false);
	});
	it("preserves every protected requirement and uncertain action without a narrative or a second execution", async () => {
		const f = fixture(
			'padma: {"objective":"repair","allow_edits":true,"requirements":[{"text":"main","rule":"SEMANTIC","target":"."},{"text":"timeout <= 20 ms must remain","rule":"SEMANTIC","target":"."}]}',
		);
		writeFileSync(join(f.cwd, "a.txt"), "old");
		const id = await f.kernel.prepareOperation("write", "proposed", { path: "a.txt", content: "new" });
		const before = f.kernel.missionPosition();
		const capsule = buildCapsule(f.store, f.kernel.state!);
		f.kernel.compactContext();
		const rebuilt = new SandhanaKernel({ cwd: () => f.cwd, session: () => "context", store: f.store });
		expect(rebuilt.missionPosition().requirements.map((req) => req.text)).toEqual(
			before.requirements.map((req) => req.text),
		);
		expect(rebuilt.missionPosition().operations[0].operation.operation_id).toBe(id);
		expect(rebuilt.missionPosition().budget.reservations.some((r) => r.state === "RESERVED")).toBe(true);
		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("old");
		expect(() => validateCapsule(f.store, f.kernel.state!, capsule)).toThrow("changed");
		const state = f.kernel.state!;
		const corrupt = {
			...buildCapsule(f.store, state),
			position: { ...f.kernel.missionPosition(), requirements: [] },
		};
		const record = makeRecord(state.mission_id, state.revision + 1, "EvidenceRecord", {
			event_id: randomUUID(),
			stage: "sarasangraha",
			kind: "CONTROL",
			provenance: "KERNEL",
			target_generation: null,
			captured_at: Date.now(),
			operation_id: null,
			source: "SARASANGRAHA_CAPSULE/1",
			payload: corrupt,
			artifact_ref: null,
			digest: digest(corrupt),
			sensitivity: "PRIVATE",
			sources: [],
			requirement_ids: [],
			correction_of: null,
			previous: state.last_event,
		});
		expect(() =>
			f.store.commit(state.revision, { ...state, revision: state.revision + 1, last_event: record.record_id }, [
				record,
			]),
		).toThrow("Protected");
		expect(f.kernel.state).toEqual(state);
	});
	it("rejects arbitrary operators, plan cycles and overdepth before acquiring sources", async () => {
		const f = fixture();
		const basis = f.kernel.state!;
		for (const nodes of [
			[{ id: "x", op: "shell", inputs: [], literal: "cat credentials" }],
			[{ id: "x", op: "return", inputs: ["x"] }],
			[
				{ id: "read", op: "read_range", source: { family: "filesystem_text", locator: "missing" }, inputs: [] },
				{ id: "a", op: "analyse", question: "First", inputs: ["read"] },
				{ id: "b", op: "analyse", question: "Second", inputs: ["a"] },
			],
		]) {
			const input = request(f.kernel, [{ family: "filesystem_text", locator: "missing" }]);
			await expect(
				f.kernel.avartana.retrieve({ ...input, plan: { version: "AVARTANA_PLAN/1", nodes } } as ContextRequest),
			).rejects.toThrow();
		}
		expect(f.kernel.state).toEqual(basis);
	});
	it("reconstructs an actual uncertain replacement after the result boundary is interrupted", async () => {
		const f = fixture("Fix the content in a.txt");
		writeFileSync(join(f.cwd, "a.txt"), "old");
		const commit = f.store.commit.bind(f.store);
		let failed = false;
		const fault = vi.spyOn(f.store, "commit").mockImplementation((expected, state, records, artifacts) => {
			if (
				!failed &&
				readFileSync(join(f.cwd, "a.txt"), "utf8") === "new" &&
				records.some((record) => record.record_type === "BudgetReservation" && record.state === "RESERVED")
			) {
				failed = true;
				throw new Error("Lost post-replacement capture");
			}
			return commit(expected, state, records, artifacts);
		});
		await expect(f.kernel.execute("write", "interrupted", { path: "a.txt", content: "new" })).rejects.toThrow(
			"reconcile",
		);
		fault.mockRestore();
		const rebuilt = new SandhanaKernel({ cwd: () => f.cwd, session: () => "context", store: f.store });
		expect(rebuilt.missionPosition().operations[0].operation.status).toBe("OUTCOME_UNKNOWN");
		expect(rebuilt.missionPosition().operations[0].reconciliationRequired).toBe(true);
		expect(rebuilt.missionPosition().budget.reservations.some((r) => ["STARTED", "RETAINED"].includes(r.state))).toBe(
			true,
		);
		expect(rebuilt.state!.used.execution).toBe(1);
		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("new");
	});
	it("deduplicates exact JSONL records, keeps malformed/missing inputs unknown and never calls a model for arithmetic", async () => {
		const f = fixture();
		writeFileSync(
			join(f.cwd, "data.jsonl"),
			'{"n":2,"label":"आ"}\n{"n":3}\n{"n":1,"nested":{"n":2}}\n{"n":2,"n":9}\n{"other":4}\nbad\n',
		);
		const source: ContextRequest["sources"][number] = { family: "structured_text", locator: "data.jsonl" };
		const answer = await f.kernel.avartana.retrieve(
			request(f.kernel, [source], {
				plan: {
					version: "AVARTANA_PLAN/1",
					nodes: [
						{ id: "read", op: "read_range", source, inputs: [] },
						{ id: "a", op: "map_extract", inputs: ["read"], key: "n" },
						{ id: "read-again", op: "read_range", source, inputs: [] },
						{ id: "b", op: "map_extract", inputs: ["read-again"], key: "n" },
						{ id: "sum", op: "aggregate", inputs: ["a", "b"], key: "sum" },
						{ id: "return", op: "return", inputs: ["sum"] },
					],
				},
			}),
		);
		const total = answer.values.find(
			(value) => value && typeof value === "object" && "node" in value && value.node === "sum",
		) as { value: number; unknown: unknown[]; exactForCoveredInputsOnly: boolean };
		expect(total.value).toBe(6);
		expect(total.unknown).toHaveLength(3);
		expect(total.exactForCoveredInputsOnly).toBe(false);
		expect(answer.status).toBe("PARTIAL");
		expect(f.kernel.state!.used.ticks).toBe(0);
		const parsed = answer.values.find(
			(value) => value && typeof value === "object" && "node" in value && value.node === "a",
		) as { records: { citation: (typeof answer.snippets)[0]["citation"] }[] };
		expect(
			verifyCitation(
				f.store,
				f.kernel.state!.mission_id,
				answer.snippets[0].source,
				parsed.records[0].citation,
				(source) => f.kernel.assertContextVisibility(source),
			).toString(),
		).toBe('{"n":2,"label":"आ"}');
	});
	it("keeps fractional and overflowing sums unknown rather than inventing exact totals", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "data.json"), '{"n":9007199254740991}\n{"n":1}\n{"n":1.5}\n');
		const source: ContextRequest["sources"][number] = { family: "structured_text", locator: "data.json" };
		const answer = await f.kernel.avartana.retrieve(
			request(f.kernel, [source], {
				plan: {
					version: "AVARTANA_PLAN/1",
					nodes: [
						{ id: "read", op: "read_range", source, inputs: [] },
						{ id: "map", op: "map_extract", inputs: ["read"], key: "n" },
						{ id: "sum", op: "aggregate", inputs: ["map"], key: "sum" },
						{ id: "return", op: "return", inputs: ["sum"] },
					],
				},
			}),
		);
		const total = answer.values.find(
			(value) => value && typeof value === "object" && "node" in value && value.node === "sum",
		) as { value: number; unknown: unknown[]; exactForCoveredInputsOnly: boolean };
		expect(total.value).toBe(Number.MAX_SAFE_INTEGER);
		expect(total.unknown).toHaveLength(2);
		expect(total.exactForCoveredInputsOnly).toBe(false);
		expect(answer.status).toBe("PARTIAL");
		expect(f.kernel.state!.used.ticks).toBe(0);
	});
	it("retains conflict references through compaction without claiming different environments are false", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.json"), '{"timeout":20}');
		writeFileSync(join(f.cwd, "b.json"), '{"timeout":30}');
		const sources: ContextRequest["sources"] = [
			{ family: "filesystem_text", locator: "a.json" },
			{ family: "filesystem_text", locator: "b.json" },
		];
		const answer = await f.kernel.avartana.retrieve(
			request(f.kernel, sources, {
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
		expect(answer.unresolved[0]).toContain("environment/generation");
		f.kernel.compactContext();
		expect(f.kernel.missionPosition().contextConflicts[0].ref).toEqual(answer.contradictions[0]);
		f.kernel.revoke();
		const denied = await f.kernel.avartana.retrieve(
			request(f.kernel, [{ family: "mission_evidence", locator: answer.contradictions[0].id }]),
		);
		expect(denied.status).toBe("DENIED");
		expect(JSON.stringify(denied)).not.toContain('"timeout":20');
		expect(denied.values).toEqual([]);
	});
	it("keeps a cancelled late leaf charged once and never publishes its claims into the current view", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "mode: strict\n");
		const abort = new AbortController();
		let calls = 0;
		f.kernel.avartana.mountLeaf(async () => {
			calls++;
			const ref = f.kernel.reserveModel(1000, 1024);
			abort.abort();
			f.kernel.reconcileModel(ref, { ...fauxAssistantMessage("charged").usage, input: 10, output: 7 }, 1);
			return {
				result: {
					claims: [{ text: "Must not publish", citations: [0], support: "MODEL_INTERPRETATION" }],
					unresolved: [],
					coverage: "one line",
				},
				usageRef: ref,
				model: "faux",
				finishReason: "stop",
			};
		});
		const source: ContextRequest["sources"][number] = { family: "filesystem_text", locator: "a.txt" };
		const answer = await f.kernel.avartana.retrieve(
			request(f.kernel, [source], {
				plan: {
					version: "AVARTANA_PLAN/1",
					nodes: [
						{ id: "read", op: "read_range", source, inputs: [] },
						{ id: "leaf", op: "analyse", inputs: ["read"], question: "Interpret mode" },
						{ id: "return", op: "return", inputs: ["leaf"] },
					],
				},
			}),
			abort.signal,
		);
		expect(calls).toBe(1);
		expect(answer.status).toBe("CANCELLED");
		expect(answer.values).toEqual([]);
		expect(answer.derivations).toEqual([]);
		expect(f.kernel.state!.used.ticks).toBe(1);
		expect(f.kernel.state!.used.output_tokens).toBeGreaterThan(0);
	});
	it("finds a middle error in actual native process output without re-executing the process", async () => {
		const f = fixture("run: node emit.cjs");
		writeFileSync(
			join(f.cwd, "emit.cjs"),
			'process.stdout.write("head\\n" + "padding\\n".repeat(10000) + "specific_middle_error\\n" + "padding\\n".repeat(10000) + "end\\n");',
		);
		f.kernel.register(createBashTool(f.cwd), "bash");
		const result = await f.kernel.execute("bash", "native-log", { command: "node emit.cjs" });
		const ids = result.details as { sandhana: { observation_id: string } };
		const event = f.store.get(f.kernel.state!.mission_id, ids.sandhana.observation_id, "EvidenceRecord");
		const answer = await f.kernel.avartana.retrieve(
			request(f.kernel, [{ family: "tool_artifact", locator: event.record_id }], {
				literal: "specific_middle_error",
				freshness: "historical_allowed",
			}),
		);
		expect(answer.snippets[0]?.text, JSON.stringify(answer.limitations)).toBe("specific_middle_error\n");
		expect(answer.snippets[0].citation.rawRange.begin).toBeGreaterThan(60000);
		expect(answer.snippets[0].source.capture.stream).toBe("combined_order_unavailable");
		expect(f.kernel.state!.used.execution).toBe(1);
		expect(
			verifyCitation(
				f.store,
				f.kernel.state!.mission_id,
				answer.snippets[0].source,
				answer.snippets[0].citation,
				(source) => f.kernel.assertContextVisibility(source),
			).toString(),
		).toBe("specific_middle_error\n");
	}, 60000);
	it("reopens actual checkpoint bytes after database restart without restoring over an external edit", async () => {
		const root = mkdtempSync(join(tmpdir(), "padma-context-restart-"));
		const path = join(root, "mission.db");
		const cwd = join(root, "workspace");
		mkdirSync(cwd);
		let store = new MissionStore(path);
		cleanup.push(() => {
			store.close();
			rmSync(root, { recursive: true, force: true });
		});
		const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "context", store });
		kernel.register(createWriteTool(cwd), "write");
		kernel.captureInput("Fix the content in a.txt", "USER");
		kernel.begin("");
		writeFileSync(join(cwd, "a.txt"), "old");
		await kernel.execute("write", "candidate", { path: "a.txt", content: "candidate" });
		const checkpoint = store
			.records(kernel.state!.mission_id)
			.find(
				(record) =>
					record.record_type === "CheckpointRecord" && record.preimage === digest(Buffer.from("candidate")),
			);
		if (!checkpoint || checkpoint.record_type !== "CheckpointRecord")
			throw new Error("No actual candidate checkpoint");
		kernel.compactContext();
		store.close();
		writeFileSync(join(cwd, "a.txt"), "external_user_edit");
		store = new MissionStore(path);
		const rebuilt = new SandhanaKernel({ cwd: () => cwd, session: () => "context", store });
		const answer = await rebuilt.avartana.retrieve(
			request(rebuilt, [{ family: "tool_artifact", locator: checkpoint.artifact_ref }], {
				freshness: "historical_allowed",
			}),
		);
		expect(answer.snippets[0]?.text, JSON.stringify(answer.limitations)).toBe("candidate");
		expect(answer.snippets[0].provenance).toBe("HISTORY");
		expect(answer.snippets[0].source.ref.observation).toBeNull();
		expect(answer.snippets[0].source.ref.authority?.id).toBe(checkpoint.record_id);
		expect(
			verifyCitation(
				store,
				rebuilt.state!.mission_id,
				answer.snippets[0].source,
				answer.snippets[0].citation,
				(source) => rebuilt.assertContextVisibility(source),
			).toString(),
		).toBe("candidate");
		expect(rebuilt.state!.used.execution).toBe(1);
		expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("external_user_edit");
	}, 60000);
	it("rejects expired retained bytes even when the caller supplies a prior verified buffer", async () => {
		const f = fixture(undefined, { version: "sandhana/1", artifact: { retention_ms: 60000 } });
		writeFileSync(join(f.cwd, "a.txt"), "retained");
		const answer = await f.kernel.avartana.retrieve(
			request(f.kernel, [{ family: "filesystem_text", locator: "a.txt" }]),
		);
		const snippet = answer.snippets[0];
		vi.spyOn(Date, "now").mockReturnValue(snippet.source.retention.expiresAt! + 1);
		const blob = vi.spyOn(f.store, "artifact");
		expect(() =>
			verifyCitation(
				f.store,
				f.kernel.state!.mission_id,
				snippet.source,
				snippet.citation,
				(source) => f.kernel.assertContextVisibility(source),
				Buffer.from("retained"),
			),
		).toThrow("expired");
		expect(blob).not.toHaveBeenCalled();
	});
	it("rejects unsupported source backends without fabricating an empty corpus", async () => {
		const f = fixture();
		for (const family of [
			"session_archive",
			"project_graph_future",
			"experience_future",
			"live_tool_stream",
		] as const) {
			const answer = await f.kernel.avartana.retrieve(request(f.kernel, [{ family, locator: "unmounted" }]));
			expect(answer.status).toBe("UNAVAILABLE");
			expect(answer.coverage.complete).toBe(false);
			expect(answer.coverage.eligible).toBeNull();
			expect(answer.limitations[0].code).toBe("UNSUPPORTED_ADAPTER");
		}
		expect(f.kernel.state!.used.execution).toBe(0);
		expect(f.kernel.state!.used.ticks).toBe(0);
	});
	it("makes capacity overflow a blocker rather than dropping authority", () => {
		const f = fixture();
		const position = f.kernel.missionPosition();
		expect(() => assemblePacket(position, [], [], 100, 20, 20, true)).toThrow(ContextError);
		expect(f.kernel.state!.requirements).toHaveLength(1);
	});
	it("resolves real immutable Git commits without rewriting earlier references when HEAD moves", async () => {
		const f = fixture();
		const git = (...args: string[]) => execFileSync("git", ["-C", f.cwd, ...args], { encoding: "utf8" });
		git("init");
		git("config", "user.name", "Context fixture");
		git("config", "user.email", "fixture@example.invalid");
		writeFileSync(join(f.cwd, "a.txt"), "revision A");
		git("add", "a.txt");
		git("commit", "-m", "fixture A");
		const first = await f.kernel.avartana.retrieve(
			request(f.kernel, [{ family: "git_object", locator: "HEAD:a.txt" }], { freshness: "historical_allowed" }),
		);
		expect(first.snippets[0]?.text, JSON.stringify(first.limitations)).toBe("revision A");
		writeFileSync(join(f.cwd, "a.txt"), "revision B");
		git("add", "a.txt");
		git("commit", "-m", "fixture B");
		const second = await f.kernel.avartana.retrieve(
			request(f.kernel, [{ family: "git_object", locator: "HEAD:a.txt" }], { freshness: "historical_allowed" }),
		);
		expect(second.snippets[0].text).toBe("revision B");
		expect(first.snapshots[0].locator).not.toBe(second.snapshots[0].locator);
		expect(
			verifyCitation(
				f.store,
				f.kernel.state!.mission_id,
				first.snippets[0].source,
				first.snippets[0].citation,
				(source) => f.kernel.assertContextVisibility(source),
			).toString(),
		).toBe("revision A");
	}, 60000);
});
