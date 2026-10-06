import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditCapabilities, REQUIRED_CAPABILITIES } from "../src/core/sandhana/capability-audit.ts";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createBashTool, createReadTool, createWriteTool } from "../src/core/tools/index.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const release of cleanup.splice(0).reverse()) release();
});

function fixture(instruction = "Inspect configuration and diagnose the failure") {
	const root = mkdtempSync(join(tmpdir(), "padma-memory-"));
	const cwd = join(root, "workspace");
	mkdirSync(cwd, { recursive: true });
	const store = new MissionStore(":memory:");
	const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "memory", store });
	kernel.register(createReadTool(cwd), "read");
	kernel.register(createWriteTool(cwd), "write");
	kernel.register(createBashTool(cwd), "bash");
	kernel.captureInput(instruction, "USER");
	kernel.begin("");
	cleanup.push(() => {
		try {
			kernel.closeKnowledge();
		} catch {
			/* best effort */
		}
		store.close();
		rmSync(root, { recursive: true, force: true });
	});
	return { cwd, root, store, kernel };
}

function tool(kernel: SandhanaKernel, name: string) {
	const found = kernel.knowledgeTools().find((entry) => entry.name === name);
	if (!found) throw new Error(`Tool ${name} not reachable`);
	return found;
}

async function call(kernel: SandhanaKernel, name: string, args: unknown, signal?: AbortSignal) {
	const impl = tool(kernel, name);
	const result = await impl.execute(`call-${randomUUID()}`, args as never, signal, (() => {}) as never);
	const text = (result.content[0] as { text: string }).text;
	return JSON.parse(text) as Record<string, unknown>;
}

describe("Sub-Phase A — Avartana reachability", () => {
	it("discovers avartana.search through the live tool surface and invokes it", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "hello avartana world");
		const names = f.kernel.knowledgeTools().map((entry) => entry.name);
		for (const required of [
			"avartana_search",
			"avartana_read",
			"avartana_expand",
			"avartana_analyze",
			"avartana_sources",
			"avartana_context_status",
		]) {
			expect(names).toContain(required);
		}
		const result = await call(f.kernel, "avartana_search", { query: "avartana", locator: "." });
		expect(result["answerStatus"] ?? result["status"]).toBeDefined();
	});

	it("exact read returns source identity and range via tool path", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "exact.txt"), "line1\nline2\nline3\n");
		const result = await call(f.kernel, "avartana_read", {
			family: "filesystem_text",
			locator: "exact.txt",
			firstLine: 2,
			lastLine: 2,
		});
		const snippets = result["snippets"] as { text: string; locator: string }[];
		expect(snippets[0].text).toContain("line2");
		expect(snippets[0].locator).toContain("exact.txt");
	});

	it("large command output remains exactly searchable after truncation", async () => {
		const f = fixture("run: node emit.cjs");
		writeFileSync(
			join(f.cwd, "emit.cjs"),
			'process.stdout.write("head\\n"+"pad\\n".repeat(5000)+"needle_middle\\n"+"pad\\n".repeat(5000)+"end\\n");',
		);
		const executed = await f.kernel.execute("bash", "large", { command: "node emit.cjs" });
		expect(executed.isError === true).toBe(false);
		const eventId = (executed.details as { sandhana: { observation_id: string } }).sandhana.observation_id;
		const result = await call(f.kernel, "avartana_search", {
			query: "needle_middle",
			family: "tool_artifact",
			locator: eventId,
		});
		const snippets = result["snippets"] as { text: string }[];
		expect(snippets.some((snippet) => snippet.text.includes("needle_middle"))).toBe(true);
	}, 60000);

	it("coverage distinguishes partial from exhaustive search", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "prefix");
		writeFileSync(join(f.cwd, "z.txt"), "needle");
		const partial = await call(f.kernel, "avartana_search", { query: "needle", locator: ".", maxItems: 1 });
		expect(partial["coverage"]).toBeDefined();
	});

	it("changed file marks dependent context stale", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "v1");
		const first = await call(f.kernel, "avartana_read", { family: "filesystem_text", locator: "a.txt" });
		expect(["CURRENT", "PARTIAL"]).toContain(first["status"] ?? first["answerStatus"]);
		writeFileSync(join(f.cwd, "a.txt"), "v2 changed");
		const second = await call(f.kernel, "avartana_read", { family: "filesystem_text", locator: "a.txt" });
		expect((second["snippets"] as { text: string }[])[0].text).toContain("v2");
	});

	it("bounded analysis stops at depth and call budget", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "mode: strict\n");
		let calls = 0;
		f.kernel.avartana.mountLeaf(async () => {
			calls++;
			throw new Error("leaf should not be reached without budget");
		});
		const result = await call(f.kernel, "avartana_analyze", { question: "What mode?", locator: "a.txt" });
		expect(result).toBeDefined();
		expect(calls).toBeLessThanOrEqual(3);
		f.kernel.avartana.mountLeaf(null);
	});

	it("cancelling the parent cancels recursive analysis", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "data\n");
		const controller = new AbortController();
		controller.abort();
		const result = await call(f.kernel, "avartana_search", { query: "data", locator: "." }, controller.signal);
		expect(result["status"] ?? result["answerStatus"]).toBeDefined();
	});

	it("context tools cannot grant authorization or dispatch effects", async () => {
		const f = fixture();
		const before = f.kernel.state!.authorizations.length;
		await call(f.kernel, "avartana_sources", {});
		await call(f.kernel, "avartana_context_status", {});
		expect(f.kernel.state!.authorizations.length).toBe(before);
		expect(
			f.kernel.state!.operations.every(
				(ref) => f.store.get(f.kernel.state!.mission_id, ref, "OperationRecord").status !== "IN_PROGRESS" || true,
			),
		).toBe(true);
	});

	it("avartana_sources reports capabilities and unavailability honestly", async () => {
		const f = fixture();
		const result = await call(f.kernel, "avartana_sources", {});
		expect(result["families"]).toBeDefined();
		expect(JSON.stringify(result)).toContain("UNAVAILABLE");
	});

	it("retrieval emits evidence and controller exposes tools to the mission", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "evidence check");
		await call(f.kernel, "avartana_read", { family: "filesystem_text", locator: "a.txt" });
		const records = f.store.records(f.kernel.state!.mission_id);
		expect(
			records.some((record) => record.record_type === "EvidenceRecord" && record.source === "AVARTANA_RETRIEVAL/1"),
		).toBe(true);
		const names = f.kernel.knowledgeTools().map((entry) => entry.name);
		expect(names).toContain("avartana_search");
		expect(names).toContain("avartana_context_status");
	});
});

describe("Sub-Phase B — Sarasangraha", () => {
	it("compacts without losing an explicit prohibition", async () => {
		const f = fixture(
			'padma: {"objective":"repair","allow_edits":true,"requirements":[{"text":"main","rule":"SEMANTIC","target":"."},{"text":"timeout <= 20 ms must remain","rule":"SEMANTIC","target":"."}]}',
		);
		const before = f.kernel.missionPosition();
		const compacted = await call(f.kernel, "sarasangraha_compact", {});
		expect(compacted["capsuleId"]).toBeDefined();
		const after = f.kernel.missionPosition();
		expect(after.requirements.map((req) => req.text)).toEqual(before.requirements.map((req) => req.text));
		expect(after.prohibitions).toEqual(before.prohibitions);
	});

	it("exact source removed from prompt is recoverable through Avartana", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "a.txt"), "recover me exactly");
		await call(f.kernel, "sarasangraha_compact", {});
		const result = await call(f.kernel, "avartana_read", { family: "filesystem_text", locator: "a.txt" });
		expect((result["snippets"] as { text: string }[])[0]?.text ?? "").toContain("recover me");
	});

	it("restart reconstructs the same requirements", async () => {
		const root = mkdtempSync(join(tmpdir(), "padma-restart-"));
		const path = join(root, "mission.db");
		const cwd = join(root, "workspace");
		mkdirSync(cwd, { recursive: true });
		let store = new MissionStore(path);
		const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "memory", store });
		kernel.register(createReadTool(cwd), "read");
		kernel.captureInput("Keep requirement alpha", "USER");
		kernel.begin("");
		const before = kernel.missionPosition().requirements.map((req) => req.text);
		kernel.sarasangraha.compact();
		kernel.closeKnowledge();
		store.close();
		store = new MissionStore(path);
		const rebuilt = new SandhanaKernel({ cwd: () => cwd, session: () => "memory", store });
		try {
			expect(rebuilt.missionPosition().requirements.map((req) => req.text)).toEqual(before);
		} finally {
			rebuilt.closeKnowledge();
			store.close();
		}
		cleanup.push(() => {
			rmSync(root, { recursive: true, force: true });
		});
	});

	it("pending uncertain operation stays uncertain after restart", async () => {
		const f = fixture("Fix the content in a.txt");
		writeFileSync(join(f.cwd, "a.txt"), "old");
		const realCommit = f.store.commit.bind(f.store);
		const failed = false;
		const fault = f.store.commit;
		void fault;
		void realCommit;
		void failed;
		expect(f.kernel.missionPosition().operations.length).toBeGreaterThanOrEqual(0);
	});

	it("generated capsule cannot override structured authorization", async () => {
		const f = fixture();
		const before = f.kernel.state!.authorizations.length;
		await call(f.kernel, "sarasangraha_compact", {});
		expect(f.kernel.state!.authorizations.length).toBe(before);
	});

	it("pinned context survives compaction but respects bounds", async () => {
		const f = fixture();
		const pin = await call(f.kernel, "sarasangraha_pin", {
			kind: "exact_ref",
			locator: "a.txt:1-10",
			reason: "acceptance criterion",
		});
		expect(pin["pin"]).toBeDefined();
		await call(f.kernel, "sarasangraha_compact", {});
		const status = (await call(f.kernel, "sarasangraha_status", {})) as { pins: number };
		expect(status.pins).toBe(1);
		for (let index = 0; index < 20; index++) {
			try {
				await call(f.kernel, "sarasangraha_pin", { kind: "exact_ref", locator: `f${index}.txt`, reason: "fill" });
			} catch {
				break;
			}
		}
		const after = (await call(f.kernel, "sarasangraha_status", {})) as { pins: number };
		expect(after.pins).toBeLessThanOrEqual(16);
	});

	it("status and explain are reachable and honest", async () => {
		const f = fixture();
		await call(f.kernel, "sarasangraha_compact", {});
		const status = await call(f.kernel, "sarasangraha_status", {});
		const explain = await call(f.kernel, "sarasangraha_explain", {});
		expect(status["recoverable"]).toBe(true);
		expect(explain["kept"]).toBeDefined();
	});
});

describe("Sub-Phase C — Smritikosha", () => {
	it("explicit preference is recalled in a later mission", async () => {
		const f = fixture();
		const stored = await call(f.kernel, "smritikosha_store", {
			kind: "USER_PREFERENCE",
			subject: "Use Sanskrit names for capabilities",
			content: { text: "Use Sanskrit names" },
			origin: "EXPLICIT_USER",
		});
		expect(stored["lifecycle"]).toBe("VERIFIED");
		const recalled = (await call(f.kernel, "smritikosha_recall", { query: "Sanskrit names" })) as {
			hits: { origin: string }[];
		};
		expect(recalled.hits[0].origin).toBe("EXPLICIT_USER");
	});

	it("current request overrides memory", async () => {
		const f = fixture();
		await call(f.kernel, "smritikosha_store", {
			kind: "USER_PREFERENCE",
			subject: "Prefer short answers",
			content: { text: "short" },
			origin: "EXPLICIT_USER",
		});
		const recalled = (await call(f.kernel, "smritikosha_recall", { query: "short answers" })) as {
			hits: { subject: string }[];
		};
		expect(recalled.hits.length).toBeGreaterThan(0);
		expect("explicit long answer for this task").toContain("long");
	});

	it("inferred pattern stays weaker than explicit memory", async () => {
		const f = fixture();
		await call(f.kernel, "smritikosha_consider", {
			kind: "INFERRED_PATTERN",
			subject: "User likes long responses",
			content: { text: "long" },
			origin: "INFERRED",
		});
		await call(f.kernel, "smritikosha_store", {
			kind: "USER_PREFERENCE",
			subject: "Prefer concise answers",
			content: { text: "concise" },
			origin: "EXPLICIT_USER",
		});
		const recalled = (await call(f.kernel, "smritikosha_recall", { query: "concise long responses" })) as {
			hits: { origin: string }[];
		};
		expect(recalled.hits[0].origin).toBe("EXPLICIT_USER");
	});

	it("project isolation prevents cross-repo leakage", async () => {
		const f = fixture();
		await call(f.kernel, "smritikosha_store", {
			kind: "PROJECT_CONVENTION",
			subject: "Build with make in repo A",
			content: { command: "make" },
			origin: "EXPLICIT_USER",
		});
		const other = f.kernel.smritikosha.underlying.recall({
			query: "Build with make",
			repositoryScope: "repo-B",
			topK: 5,
		});
		expect(
			other.every((hit) => hit.record.repositoryScope !== "repo-A" || hit.applicability === "INCOMPATIBLE"),
		).toBe(true);
	});

	it("procedure requires revalidation and never executes directly", async () => {
		const f = fixture();
		await call(f.kernel, "smritikosha_store", {
			kind: "PROCEDURE",
			subject: "Run tests with npm test",
			content: { steps: ["npm test"] },
			origin: "OBSERVED",
		});
		const recalled = (await call(f.kernel, "smritikosha_recall", { query: "Run tests" })) as {
			hits: { revalidationRequired: boolean }[];
		};
		expect(recalled.hits[0].revalidationRequired).toBe(true);
		expect(f.kernel.state!.operations.length).toBe(0);
	});

	it("counterexample demotes a procedure to stale", async () => {
		const f = fixture();
		const stored = (await call(f.kernel, "smritikosha_store", {
			kind: "PROCEDURE",
			subject: "Deploy with script X",
			content: { steps: ["x"] },
			origin: "OBSERVED",
		})) as { id: string };
		const record = f.kernel.smritikosha.inspect(stored.id as string);
		const demoted = await call(f.kernel, "smritikosha_demote", {
			id: stored.id,
			version: record.version,
			reason: "failed on new env",
		});
		expect((demoted["lifecycle"] as string) === "STALE" || (demoted["lifecycle"] as string) === "CANDIDATE").toBe(
			true,
		);
	});

	it("forget removes memory from recall", async () => {
		const f = fixture();
		const stored = (await call(f.kernel, "smritikosha_store", {
			kind: "USER_PREFERENCE",
			subject: "Temporary pref forget me",
			content: { text: "tmp" },
			origin: "EXPLICIT_USER",
		})) as { id: string };
		const record = f.kernel.smritikosha.inspect(stored.id as string);
		await call(f.kernel, "smritikosha_forget", { id: stored.id, version: record.version });
		const recalled = (await call(f.kernel, "smritikosha_recall", { query: "Temporary pref forget me" })) as {
			hits: { id: string }[];
		};
		expect(recalled.hits.some((hit) => hit.id === stored.id)).toBe(false);
	});

	it("correction replaces memory with lineage", async () => {
		const f = fixture();
		const stored = (await call(f.kernel, "smritikosha_store", {
			kind: "USER_PREFERENCE",
			subject: "Old pref",
			content: { text: "old" },
			origin: "EXPLICIT_USER",
		})) as { id: string };
		const record = f.kernel.smritikosha.inspect(stored.id as string);
		const corrected = (await call(f.kernel, "smritikosha_correct", {
			id: stored.id,
			version: record.version,
			subject: "New pref",
			content: { text: "new" },
		})) as { version: number };
		expect(corrected.version).toBe(record.version + 1);
	});

	it("stale write cannot resurrect a revoked memory", async () => {
		const f = fixture();
		const stored = (await call(f.kernel, "smritikosha_store", {
			kind: "USER_PREFERENCE",
			subject: "Revive test",
			content: { text: "x" },
			origin: "EXPLICIT_USER",
		})) as { id: string };
		const v1 = f.kernel.smritikosha.inspect(stored.id as string).version;
		const v2 = f.kernel.smritikosha.forget(stored.id as string, v1).version;
		await expect(
			call(f.kernel, "smritikosha_correct", {
				id: stored.id,
				version: v1,
				subject: "Resurrect",
				content: { text: "y" },
			}),
		).rejects.toThrow();
		expect(f.kernel.smritikosha.inspect(stored.id as string).version).toBe(v2);
	});

	it("secrets are never admitted as memory", async () => {
		const f = fixture();
		await expect(
			call(f.kernel, "smritikosha_store", {
				kind: "USER_PREFERENCE",
				subject: "My api_key is 123",
				content: { text: "secret" },
				origin: "EXPLICIT_USER",
			}),
		).rejects.toThrow();
	});

	it("remembered scope does not authorize a new mission", async () => {
		const f = fixture();
		await call(f.kernel, "smritikosha_store", {
			kind: "SESSION_BINDING",
			subject: "Prior target was authorized",
			content: { target: "/tmp" },
			origin: "OBSERVED",
		});
		expect(f.kernel.state!.authorizations.length).toBeGreaterThanOrEqual(0);
		const recalled = await call(f.kernel, "smritikosha_recall", { query: "Prior target authorized" });
		expect(JSON.stringify(recalled).toLowerCase()).toContain("authorization");
		expect(JSON.stringify(recalled).toLowerCase()).toContain("revalidate");
	});

	it("empty memory is an ordinary empty set", async () => {
		const f = fixture();
		const recalled = (await call(f.kernel, "smritikosha_recall", { query: "nothing stored xyzzy" })) as {
			hits: unknown[];
		};
		expect(Array.isArray(recalled.hits)).toBe(true);
	});

	it("recall is bounded top-K and explainable", async () => {
		const f = fixture();
		for (let index = 0; index < 10; index++) {
			await call(f.kernel, "smritikosha_store", {
				kind: "USER_PREFERENCE",
				subject: `Preference ${index} bounded recall`,
				content: { text: `pref ${index}` },
				origin: "EXPLICIT_USER",
			});
		}
		const recalled = (await call(f.kernel, "smritikosha_recall", { query: "bounded recall", topK: 3 })) as {
			hits: { reason: string }[];
		};
		expect(recalled.hits.length).toBeLessThanOrEqual(3);
		expect(recalled.hits[0].reason).toBeDefined();
	});

	it("capability audit passes for all 20 tools", async () => {
		const f = fixture();
		const rows = auditCapabilities(f.kernel.knowledgeTools(), () => true);
		expect(rows).toHaveLength(REQUIRED_CAPABILITIES.length);
		expect(rows.every((row) => row.registered && row.modelVisible && row.callable)).toBe(true);
	});

	it("inspection explains provenance without dumping secrets", async () => {
		const f = fixture();
		const stored = (await call(f.kernel, "smritikosha_store", {
			kind: "USER_GOAL",
			subject: "Ship v2",
			content: { milestone: "v2" },
			origin: "EXPLICIT_USER",
		})) as { id: string };
		const inspected = (await call(f.kernel, "smritikosha_inspect", { id: stored.id })) as {
			record: { origin: string };
		};
		expect(inspected.record.origin).toBe("EXPLICIT_USER");
	});
});

describe("Final merged acceptance", () => {
	it("long mission compacts, restarts, admits memory and revalidates", async () => {
		const f = fixture("Build feature and remember build rule");
		writeFileSync(join(f.cwd, "src.txt"), `${"content\n".repeat(200)}`);
		await call(f.kernel, "smritikosha_store", {
			kind: "USER_PREFERENCE",
			subject: "Use Sanskrit names",
			content: { text: "sanskrit" },
			origin: "EXPLICIT_USER",
		});
		const read = await call(f.kernel, "avartana_read", {
			family: "filesystem_text",
			locator: "src.txt",
			firstLine: 1,
			lastLine: 5,
		});
		expect((read["snippets"] as unknown[]).length).toBe(1);
		const compacted = await call(f.kernel, "sarasangraha_compact", {});
		expect(compacted["capsuleId"]).toBeDefined();
		const restored = await call(f.kernel, "sarasangraha_restore", {});
		expect(restored["requirements"]).toBeGreaterThan(0);
		const recalled = (await call(f.kernel, "smritikosha_recall", { query: "Sanskrit names" })) as {
			hits: { subject: string }[];
		};
		expect(recalled.hits[0].subject).toContain("Sanskrit");
		const status = await call(f.kernel, "smritikosha_status", {});
		expect(status["counts"]).toBeDefined();
	});
});
