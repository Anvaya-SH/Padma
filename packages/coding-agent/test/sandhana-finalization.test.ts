import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandhanaError } from "../src/core/sandhana/errors.ts";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import type { KernelConfigurationInput, RecordOf } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createBashTool, createReadTool, createWriteTool } from "../src/core/tools/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(configuration?: KernelConfigurationInput) {
	const cwd = mkdtempSync(join(tmpdir(), "padma-finalization-"));
	const store = new MissionStore(":memory:");
	const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "finalization", store, configuration });
	kernel.register(createReadTool(cwd), "read");
	kernel.register(createWriteTool(cwd), "write");
	kernel.register(createBashTool(cwd), "bash");
	cleanups.push(() => {
		store.close();
		rmSync(cwd, { recursive: true, force: true });
	});
	return {
		cwd,
		store,
		kernel,
		start: (command: object) => {
			kernel.captureInput(`padma: ${JSON.stringify(command)}`, "USER");
			kernel.begin("");
		},
	};
}

async function contentCandidate(configuration?: KernelConfigurationInput) {
	const f = fixture(configuration);
	writeFileSync(join(f.cwd, "candidate.txt"), "old");
	f.start({
		objective: "replace exact content",
		allow_edits: true,
		requirements: [{ text: "new bytes", rule: "CONTENT", target: "candidate.txt", expected: "new" }],
	});
	await f.kernel.execute("write", "candidate", { path: "candidate.txt", content: "new" });
	const assessment = f.kernel.assessCandidate();
	expect(assessment.completion_status).toBe("PASSED");
	expect(f.kernel.state!.phase).toBe("VERIFYING_QUALITY");
	return { ...f, assessment };
}

async function processCandidate(kind: "PROCESS" | "QUALITY", configuration?: KernelConfigurationInput) {
	const f = fixture(configuration);
	const command = "node check.cjs";
	writeFileSync(join(f.cwd, "candidate.txt"), "old");
	writeFileSync(join(f.cwd, "check.cjs"), "process.exit(0);");
	writeFileSync(join(f.cwd, "dependency.cjs"), "module.exports = 'original';");
	f.start({
		objective: "replace exact content and check current sources",
		allow_edits: true,
		shell_commands: [command],
		quality_checks: kind === "QUALITY" ? [command] : [],
		requirements: [
			{ text: "new bytes", rule: "CONTENT", target: "candidate.txt", expected: "new" },
			...(kind === "PROCESS"
				? [
						{
							text: "process check",
							rule: "PROCESS",
							target: ".",
							expected: command,
							dependencies: ["dependency.cjs", "missing.cjs"],
						},
					]
				: []),
		],
	});
	await f.kernel.execute("write", "candidate", { path: "candidate.txt", content: "new" });
	await f.kernel.execute("bash", "check", { command });
	const assessment = f.kernel.assessCandidate();
	expect(assessment.completion_status).toBe("PASSED");
	expect(assessment.quality).toBe(kind === "QUALITY" ? "PASSED" : "NOT_APPLICABLE");
	return { ...f, assessment };
}

function finalizeCurrent(
	f: ReturnType<typeof fixture> & { assessment: RecordOf<"VerificationReport"> },
	completionMessage?: string,
) {
	const before = f.kernel.state!;
	const terminal = f.kernel.finalize(undefined, undefined, completionMessage);
	const after = f.kernel.state!;
	const proof = f.store.get(after.mission_id, terminal.verification_report_ref!, "VerificationReport");
	expect(after.mission_id).toBe(before.mission_id);
	expect(after.contract).toBe(before.contract);
	expect(after.ceilings).toEqual(before.ceilings);
	expect(after.used.execution).toBe(before.used.execution);
	expect(after.used.ticks).toBe(before.used.ticks);
	expect(after.operations).toEqual(before.operations);
	return { before, after, terminal, proof };
}

describe("current evidence at finalization after candidate assessment", () => {
	it("admits a useful completion summary only after current evidence passes", async () => {
		const f = await contentCandidate();
		const { terminal } = finalizeCurrent(f, "Updated candidate.txt to the requested content.");
		expect(terminal.status).toBe("VERIFIED_COMPLETE");
		expect(terminal.presentation).toBe("Updated candidate.txt to the requested content.");
	});
	it("keeps unchanged CONTENT proof valid without dispatch, and charges live retrieval to the same ledger", async () => {
		const f = await contentCandidate();
		const { before, after, terminal, proof } = finalizeCurrent(f);
		expect(terminal.status).toBe("VERIFIED_COMPLETE");
		expect(proof.results).toEqual(f.assessment.results);
		expect(proof.candidate_refs).toEqual(f.assessment.candidate_refs);
		expect(after.used.retrieval_bytes).toBeGreaterThan(before.used.retrieval_bytes);
		expect(proof.record_id).not.toBe(f.assessment.record_id);
		expect(f.kernel.finalize()).toEqual(terminal);
		expect(f.kernel.state).toEqual(after);
	});

	it.each(["changed", "deleted"] as const)("rejects CONTENT target %s after a passing assessment", async (change) => {
		const f = await contentCandidate();
		if (change === "changed") writeFileSync(join(f.cwd, "candidate.txt"), "external edit");
		else unlinkSync(join(f.cwd, "candidate.txt"));
		const { terminal, proof } = finalizeCurrent(f, "Updated candidate.txt to the requested content.");
		expect(terminal.status).toBe("PARTIALLY_COMPLETE");
		expect(terminal.presentation).toBeUndefined();
		expect(proof.completion_status).toBe("INCONCLUSIVE");
		expect(proof.results[0].result).toBe("INCONCLUSIVE");
		expect(proof.candidate_refs).toEqual([]);
		expect(terminal.verified).toEqual([]);
		expect(terminal.remaining).toHaveLength(1);
	});

	it.each(["PROCESS", "QUALITY"] as const)(
		"keeps an unchanged passing %s check valid without rerunning it",
		async (kind) => {
			const f = await processCandidate(kind);
			const { before, after, terminal, proof } = finalizeCurrent(f);
			expect(terminal.status).toBe("VERIFIED_COMPLETE");
			expect(proof.completion_status).toBe("PASSED");
			expect(proof.quality).toBe(f.assessment.quality);
			expect(after.used.retrieval_bytes).toBeGreaterThan(before.used.retrieval_bytes);
		},
	);

	it.each(["changed", "deleted", "created"] as const)(
		"invalidates PROCESS proof when a dependency is %s after assessment",
		async (change) => {
			const f = await processCandidate("PROCESS");
			if (change === "changed") writeFileSync(join(f.cwd, "dependency.cjs"), "module.exports = 'external';");
			else if (change === "deleted") unlinkSync(join(f.cwd, "dependency.cjs"));
			else writeFileSync(join(f.cwd, "missing.cjs"), "module.exports = 'now present';");
			const { terminal, proof } = finalizeCurrent(f);
			expect(terminal.status).toBe("PARTIALLY_COMPLETE");
			expect(proof.results.map((result) => result.result)).toEqual(["PASSED", "INCONCLUSIVE"]);
			expect(terminal.verified).toHaveLength(1);
			expect(terminal.remaining).toHaveLength(1);
		},
	);

	it.each([
		["zero executed cases", "TAP version 13\n1..0\n# tests 0\n# fail 0"],
		["only skipped cases", "TAP version 13\nok 1 - pending # SKIP\n1..1\n# tests 1\n# fail 0"],
	] as const)("rejects a declared Node quality check with %s despite exit code zero", async (_label, output) => {
		const f = fixture();
		const command = "node --test quality.test.cjs";
		writeFileSync(join(f.cwd, "candidate.txt"), "old");
		writeFileSync(join(f.cwd, "quality.test.cjs"), "// retained test source");
		f.kernel.register(
			createBashTool(f.cwd, {
				operations: {
					exec: async (_command, _cwd, { onData }) => {
						onData(Buffer.from(output));
						return { exitCode: 0, outputComplete: true };
					},
				},
			}),
			"bash",
		);
		f.start({
			objective: "retain content and validate declared quality",
			allow_edits: true,
			shell_commands: [command],
			quality_checks: [command],
			requirements: [{ text: "new bytes", rule: "CONTENT", target: "candidate.txt", expected: "new" }],
		});
		await f.kernel.execute("write", "candidate", { path: "candidate.txt", content: "new" });
		await f.kernel.execute("bash", "quality", { command });
		const assessment = f.kernel.assessCandidate();
		expect(assessment.completion_status).toBe("PASSED");
		expect(assessment.quality).toBe("FAILED");
	});

	it("invalidates declared quality independently of unchanged passing CONTENT proof", async () => {
		const f = await processCandidate("QUALITY");
		writeFileSync(join(f.cwd, "check.cjs"), "process.exit(1);");
		const { terminal, proof } = finalizeCurrent(f);
		expect(terminal.status).toBe("PARTIALLY_COMPLETE");
		expect(proof.completion_status).toBe("PASSED");
		expect(proof.quality).toBe("INCONCLUSIVE");
		expect(proof.skipped).toContain("Quality check lacks current proof: node check.cjs");
	});

	it.each(["revoked grant", "changed policy", "exhausted retrieval"] as const)(
		"does not reuse passing proof under %s",
		async (change) => {
			const f = await contentCandidate();
			if (change === "revoked grant") f.kernel.revoke();
			else if (change === "changed policy") f.kernel.policy.version = "external-policy-change";
			else
				f.kernel.amend(
					`budget: ${JSON.stringify({ version: 1, ceilings: { retrieval_bytes: f.kernel.state!.used.retrieval_bytes } })}`,
				);
			const { terminal, proof } = finalizeCurrent(f);
			expect(terminal.status).toBe("PARTIALLY_COMPLETE");
			expect(proof.completion_status).toBe("INCONCLUSIVE");
			expect(proof.candidate_refs).toEqual([]);
		},
	);

	it("drops expired CONTENT observation and delivered artifacts instead of trusting cached metadata", async () => {
		const f = await contentCandidate({ version: "sandhana/1", artifact: { retention_ms: 60000 } });
		const artifacts = f.store
			.records(f.kernel.state!.mission_id)
			.filter((record) => record.record_type === "Artifact");
		const expires = Math.max(...artifacts.map((artifact) => artifact.expires_at!));
		vi.spyOn(Date, "now").mockReturnValue(expires + 1);
		const { terminal, proof } = finalizeCurrent(f);
		expect(terminal.status).toBe("PARTIALLY_COMPLETE");
		expect(proof.completion_status).toBe("INCONCLUSIVE");
		expect(proof.candidate_refs).toEqual([]);
	});

	it("records missing retained quality output as inconclusive without dispatch or throwing", async () => {
		const f = await processCandidate("QUALITY");
		const state = f.kernel.state!;
		const operation = f.store.get(state.mission_id, state.operations.at(-1)!, "OperationRecord");
		const observation = f.store.get(state.mission_id, operation.result_refs[0], "EvidenceRecord");
		const artifact = f.store.artifact.bind(f.store);
		vi.spyOn(f.store, "artifact").mockImplementation((mission, ref) => {
			if (ref === observation.artifact_ref) throw new SandhanaError("ARTIFACT_UNAVAILABLE", "Artifact unavailable");
			return artifact(mission, ref);
		});
		const { terminal, proof } = finalizeCurrent(f);
		expect(terminal.status).toBe("PARTIALLY_COMPLETE");
		expect(proof.completion_status).toBe("PASSED");
		expect(proof.quality).toBe("INCONCLUSIVE");
	});
});
