import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CoverageProposal, nodeTestCases } from "../src/core/sandhana/acceptance.ts";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { makeRecord, type RecordOf } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createBashTool, createReadTool, createWriteTool } from "../src/core/tools/index.ts";

const command = "node --test parser.test.cjs";
const fixed = "module.exports = (value) => { if (value === '') throw new Error('empty'); return value; };";
const emptyCase = "test('rejects empty', () => assert.throws(() => parse(''), /empty/));";
const validCase = "test('preserves valid', () => assert.equal(parse('valid'), 'valid'));";
const prefix =
	"const test = require('node:test'); const assert = require('node:assert/strict'); const parse = require('./parser.cjs');\n";
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function fixture(
	implementation = fixed,
	testSource = `${prefix}${emptyCase}\n${validCase}`,
	execution = 40,
	partialTestRead = false,
	runCheck = true,
	instruction = "Fix parser accepting an invalid empty value; preserve valid existing values",
) {
	const cwd = mkdtempSync(join(tmpdir(), "padma-acceptance-"));
	const store = new MissionStore(":memory:");
	const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "acceptance", store, limits: { execution } });
	kernel.register(createReadTool(cwd), "read");
	kernel.register(createWriteTool(cwd), "write");
	kernel.register(createBashTool(cwd), "bash");
	cleanups.push(() => {
		store.close();
		rmSync(cwd, { recursive: true, force: true });
	});
	writeFileSync(join(cwd, "parser.cjs"), "module.exports = (value) => value;");
	writeFileSync(join(cwd, "parser.test.cjs"), testSource);
	kernel.captureInput(instruction, "USER");
	kernel.begin("");
	const test = await kernel.execute("read", "test-source", {
		path: "parser.test.cjs",
		...(partialTestRead ? { limit: 1 } : {}),
	});
	await kernel.execute("write", "patch", { path: "parser.cjs", content: implementation });
	const source = await kernel.execute("read", "implementation-source", { path: "parser.cjs" });
	if (runCheck) await kernel.execute("bash", "current-cases", { command });
	const testObservation = (test.details as { sandhana: { observation_id: string } }).sandhana.observation_id;
	const implementationObservation = (source.details as { sandhana: { observation_id: string } }).sandhana
		.observation_id;
	const proposals: CoverageProposal[] = kernel.state!.requirements.map((ref, index) => ({
		requirement_id: store.get(kernel.state!.mission_id, ref, "Requirement").requirement_id,
		command,
		case_names: [index === 0 ? "rejects empty" : "preserves valid"],
		applicability: "SUPPORTED",
		explanation:
			index === 0
				? "The assertion calls the changed parser with an empty value and checks its rejection."
				: "The preservation assertion invokes the same parser with an existing valid value and checks its unchanged result.",
		citations: [
			{ observation_id: implementationObservation, role: "IMPLEMENTATION", quote: implementation },
			{
				observation_id: testObservation,
				role: "TEST_ASSERTION",
				case_name: index === 0 ? "rejects empty" : "preserves valid",
				quote: index === 0 ? emptyCase : validCase,
			},
		],
	}));
	return { cwd, kernel, store, proposals };
}

function assess(kernel: SandhanaKernel, proposals: CoverageProposal[]) {
	const model = kernel.reserveModel(16000, 4000);
	kernel.reconcileModel(model, { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, 1);
	kernel.acceptDecisionText(`<pramana>${JSON.stringify({ results: proposals })}</pramana>`, model);
}

describe("requirement-specific current behavioral acceptance", () => {
	it.each([
		{ inputs: "current", submitted: false },
		{ inputs: "stale", submitted: false },
		{ inputs: "partial", submitted: false },
		{ inputs: "current", submitted: true },
		{ inputs: "stale", submitted: true },
		{ inputs: "partial", submitted: true },
	])(
		"coverage question admission retains its bound after reopening (inputs: $inputs, submitted: $submitted)",
		async ({ inputs, submitted }) => {
			const execution = submitted ? 40 : 7;
			const f = await fixture(fixed, prefix + emptyCase, execution, inputs === "partial");
			expect(f.kernel.verificationDue()).toBe(!submitted);
			if (submitted) expect(f.kernel.beginCoverageAssessment()).toBe(false);
			if (inputs === "stale")
				writeFileSync(join(f.cwd, "parser.cjs"), "module.exports = () => 'changed outside the mission';");
			expect(f.kernel.beginCoverageAssessment(submitted)).toBe(inputs === "current");
			if (inputs === "current") {
				assess(f.kernel, f.proposals);
				expect(f.kernel.ready()).toBe(false);
				expect(f.kernel.beginCoverageAssessment(submitted)).toBe(false);
			}
			const reopened = new SandhanaKernel({
				cwd: () => f.cwd,
				session: () => "acceptance",
				store: f.store,
				limits: { execution },
			});
			reopened.register(createReadTool(f.cwd), "read");
			reopened.register(createWriteTool(f.cwd), "write");
			reopened.register(createBashTool(f.cwd), "bash");
			expect(reopened.beginCoverageAssessment(submitted)).toBe(false);
			expect(reopened.state!.used.execution).toBe(4);
			expect(reopened.state!.used.ticks).toBe(inputs === "current" ? 1 : 0);
			expect(
				f.store
					.records(reopened.state!.mission_id)
					.filter(
						(record) =>
							record.record_type === "EvidenceRecord" &&
							record.stage === "pramana" &&
							record.kind === "CONTROL" &&
							record.payload &&
							typeof record.payload === "object" &&
							"coverage_request_key" in record.payload,
					),
			).toHaveLength(inputs === "current" ? 1 : 0);
		},
	);
	it("an early submission without an actual check does not admit a planning-only assessment", async () => {
		const f = await fixture(fixed, `${prefix}${emptyCase}\n${validCase}`, 40, false, false);
		expect(f.kernel.verificationDue()).toBe(false);
		expect(f.kernel.beginCoverageAssessment(true)).toBe(false);
		expect(f.kernel.finalize().status).toBe("PARTIALLY_COMPLETE");
	});
	it.each(["before check", "after check", "admitted assessment"] as const)(
		"a rejected proposal only suppresses an already admitted assessment of actual checks: %s",
		async (rejection) => {
			const f = await fixture(fixed, `${prefix}${emptyCase}\n${validCase}`, 40, false, rejection !== "before check");
			if (rejection === "admitted assessment") expect(f.kernel.beginCoverageAssessment(true)).toBe(true);
			assess(
				f.kernel,
				f.proposals.map((proposal) => ({
					...proposal,
					applicability: "INCONCLUSIVE",
					citations: [proposal.citations[1], proposal.citations[1]],
				})),
			);
			expect(f.kernel.ready()).toBe(false);
			if (rejection === "before check") await f.kernel.execute("bash", "required-after-rejection", { command });
			expect(f.kernel.beginCoverageAssessment(true)).toBe(rejection !== "admitted assessment");
			const reopened = new SandhanaKernel({ cwd: () => f.cwd, session: () => "acceptance", store: f.store });
			expect(reopened.beginCoverageAssessment(true)).toBe(false);
			if (rejection !== "admitted assessment") {
				assess(f.kernel, f.proposals);
				expect(f.kernel.finalize().status).toBe("VERIFIED_COMPLETE");
			} else expect(f.kernel.finalize().status).toBe("PARTIALLY_COMPLETE");
			expect(f.kernel.state!.used.execution).toBe(4);
			expect(
				f.kernel.state!.operations.filter(
					(ref) =>
						f.store.get(
							f.kernel.state!.mission_id,
							f.store.get(f.kernel.state!.mission_id, ref, "OperationRecord").prepared_ref,
							"PreparedAction",
						).operation_class === `SHELL:${command}`,
				),
			).toHaveLength(1);
		},
	);
	it("a rejected planning-only proposal cannot start another planning assessment without actual results", async () => {
		const f = await fixture(fixed, `${prefix}${emptyCase}\n${validCase}`, 6, false, false);
		assess(
			f.kernel,
			f.proposals.map((proposal) => ({
				...proposal,
				applicability: "INCONCLUSIVE",
				citations: [proposal.citations[1], proposal.citations[1]],
			})),
		);
		expect(f.kernel.verificationDue()).toBe(true);
		expect(f.kernel.beginCoverageAssessment()).toBe(false);
		expect(f.kernel.finalize().status).toBe("PARTIALLY_COMPLETE");
	});
	it.each([false, true])("multi-file coverage commits recoverable checkpoints (grouped: %s)", async (grouped) => {
		const formatterSource = "module.exports = (value) => value.trim();";
		const formatterCase = "test('trims whitespace', () => assert.equal(formatter(' value '), 'value'));";
		const f = await fixture(
			fixed,
			`${prefix}const formatter = require('./formatter.cjs');\n${emptyCase}\n${validCase}\n${formatterCase}`,
			40,
			false,
			false,
			"Fix parser.cjs to reject empty input and formatter.cjs to trim whitespace while preserving valid inputs.",
		);
		writeFileSync(join(f.cwd, "formatter.cjs"), "module.exports = (value) => value;");
		await f.kernel.execute("write", "formatter-patch", { path: "formatter.cjs", content: formatterSource });
		const formatter = await f.kernel.execute("read", "formatter-source", { path: "formatter.cjs" });
		await f.kernel.execute("bash", "combined-cases", { command });
		const proposal = f.proposals[0];
		const preservation = {
			...proposal.citations[1],
			case_name: "preserves valid",
			quote: validCase,
		};
		const formatterImplementation = {
			observation_id: (formatter.details as { sandhana: { observation_id: string } }).sandhana.observation_id,
			role: "IMPLEMENTATION" as const,
			quote: formatterSource,
		};
		const formatterAssertion = {
			...proposal.citations[1],
			case_name: "trims whitespace",
			quote: formatterCase,
		};
		const proposals: CoverageProposal[] = grouped
			? [
					{
						...proposal,
						case_names: ["rejects empty", "preserves valid"],
						citations: [...proposal.citations, preservation],
					},
					{
						...proposal,
						case_names: ["trims whitespace"],
						citations: [formatterImplementation, proposal.citations[0], formatterAssertion],
					},
				]
			: [
					{
						...proposal,
						case_names: ["rejects empty", "preserves valid", "trims whitespace"],
						citations: [...proposal.citations, preservation, formatterImplementation, formatterAssertion],
					},
				];
		assess(f.kernel, proposals);
		expect(
			f.store
				.records(f.kernel.state!.mission_id)
				.filter(
					(record) =>
						record.record_type === "EvidenceRecord" &&
						record.payload &&
						typeof record.payload === "object" &&
						"rejected_coverage" in record.payload,
				),
		).toEqual([]);
		expect(f.kernel.finalize().status).toBe("VERIFIED_COMPLETE");
		const reopened = new SandhanaKernel({ cwd: () => f.cwd, session: () => "acceptance", store: f.store });
		expect(reopened.terminal?.status).toBe("VERIFIED_COMPLETE");
		expect(reopened.state!.used.execution).toBe(6);
		const points = reopened.state!.best.map((ref) =>
			f.store.get(reopened.state!.mission_id, ref, "CheckpointRecord"),
		);
		expect(new Set(points.map((point) => point.target))).toEqual(
			new Set([join(f.cwd, "parser.cjs"), join(f.cwd, "formatter.cjs")]),
		);
		expect(points.every((point) => point.level === "MISSION_VERIFIED")).toBe(true);
		const records = new Set(f.store.records(reopened.state!.mission_id).map((record) => record.record_id));
		expect(points.every((point) => point.verification_refs.every((ref) => records.has(ref)))).toBe(true);
	});
	it("links both natural obligations to actual cases and a recoverable patch, with model interpretation separate from proof", async () => {
		const f = await fixture();
		assess(f.kernel, f.proposals);
		expect(f.kernel.ready()).toBe(true);
		const state = f.kernel.state!;
		const records = f.store.records(state.mission_id);
		expect(
			records.filter(
				(record) =>
					record.record_type === "EvidenceRecord" &&
					record.kind === "INTERPRETATION" &&
					record.provenance === "MODEL",
			),
		).toHaveLength(2);
		const proof = records.filter(
			(record): record is RecordOf<"EvidenceRecord"> =>
				record.record_type === "EvidenceRecord" && record.kind === "VERIFICATION",
		);
		expect(proof).toHaveLength(2);
		expect(proof.every((record) => record.provenance === "KERNEL" && record.sources.length === 3)).toBe(true);
		expect(f.store.get(state.mission_id, state.best[0], "CheckpointRecord").coverage).toHaveLength(2);
		const forged = makeRecord(state.mission_id, state.revision + 1, "EvidenceRecord", {
			...proof[0],
			provenance: "MODEL",
		});
		expect(() => f.store.commit(state.revision, { ...state, revision: state.revision + 1 }, [forged])).toThrow(
			"registered behavior rule",
		);
		const report = f.kernel.finalize();
		expect(report.status).toBe("VERIFIED_COMPLETE");
		expect(report.verified).toHaveLength(2);
		expect(f.kernel.state!.used.execution).toBe(4);
		expect(f.kernel.state!.used.ticks).toBe(1);
	});
	it("a green empty-value test cannot fill the missing preservation case", async () => {
		const f = await fixture(fixed, prefix + emptyCase);
		assess(f.kernel, f.proposals);
		const report = f.kernel.finalize();
		expect(report.status).toBe("PARTIALLY_COMPLETE");
		expect(report.verified).toHaveLength(1);
		expect(report.remaining).toHaveLength(1);
	});
	it("the real failing preservation case defeats a successful write and an optimistic coverage assessment", async () => {
		const f = await fixture(
			"module.exports = (value) => { if (value === '') throw new Error('empty'); return value.toUpperCase(); };",
		);
		assess(f.kernel, f.proposals);
		const report = f.kernel.finalize();
		expect(report.status).toBe("EXECUTION_FAILED");
		const verdict = f.store.get(report.mission_id, report.verification_report_ref!, "VerificationReport");
		expect(verdict.results[1].result).toBe("FAILED");
	});
	it("a concrete semantic failure uses protected capacity for its exact repair and recheck in the same mission", async () => {
		const f = await fixture(
			"module.exports = (value) => { if (value === '') throw new Error('empty'); return value.toUpperCase(); };",
			`${prefix}${emptyCase}\n${validCase}`,
			7,
		);
		assess(f.kernel, f.proposals);
		const before = f.kernel.state!;
		const failure = f.kernel.assessCandidate();
		expect(failure.completion_status).toBe("FAILED");
		expect(f.kernel.continueRepair(failure)).toBe(true);
		writeFileSync(join(f.cwd, "unrelated.cjs"), "module.exports = 'unrelated';");
		await expect(f.kernel.execute("read", "unrelated-discovery", { path: "unrelated.cjs" })).rejects.toThrow(
			"unprotected capacity",
		);
		await expect(
			f.kernel.execute("write", "unrelated-edit", { path: "unrelated.cjs", content: "module.exports = 'changed';" }),
		).rejects.toThrow("unprotected capacity");
		await f.kernel.execute("write", "repair", { path: "parser.cjs", content: fixed });
		const source = await f.kernel.execute("read", "repaired-source", { path: "parser.cjs" });
		await f.kernel.execute("bash", "repaired-cases", { command });
		for (const proposal of f.proposals) {
			proposal.citations[0].quote = fixed;
			proposal.citations[0].observation_id = (
				source.details as { sandhana: { observation_id: string } }
			).sandhana.observation_id;
		}
		assess(f.kernel, f.proposals);
		expect(f.kernel.finalize().status).toBe("VERIFIED_COMPLETE");
		expect(f.kernel.state!.mission_id).toBe(before.mission_id);
		expect(f.kernel.state!.used.execution).toBe(7);
		expect(f.kernel.state!.used.ticks).toBe(2);
		const reservations = f.kernel
			.state!.reservations.map((id) => f.store.get(before.mission_id, id, "BudgetReservation"))
			.filter((item) =>
				f.kernel.state!.operations.some(
					(ref) => f.store.get(before.mission_id, ref, "OperationRecord").operation_id === item.owner_operation_id,
				),
			);
		expect(reservations.map((item) => item.protected_for_verification)).toEqual([
			false,
			false,
			false,
			false,
			true,
			true,
			true,
		]);
	});
	it("fabricated quotes and stale generations cannot establish behavioral proof", async () => {
		const f = await fixture();
		const fabricated = structuredClone(f.proposals);
		for (const proposal of fabricated)
			proposal.citations[0].quote = "module.exports = () => 'invented implementation';";
		assess(f.kernel, fabricated);
		expect(f.kernel.ready()).toBe(false);
		writeFileSync(join(f.cwd, "parser.cjs"), "module.exports = (value) => value;");
		assess(f.kernel, f.proposals);
		expect(f.kernel.finalize().status).toBe("PARTIALLY_COMPLETE");
	});
	it("an unrelated tautology cannot verify a behavior even when the test file imports the parser", async () => {
		const tautology = "test('rejects empty', () => assert.equal(1, 1));";
		const f = await fixture(fixed, `${prefix}${tautology}\n${validCase}`);
		f.proposals[0].citations[1].quote = tautology;
		assess(f.kernel, f.proposals);
		expect(f.kernel.finalize().verified).toHaveLength(1);
	});
	it("a later check requires a new coverage comparison and a source change invalidates the earlier proof", async () => {
		const f = await fixture();
		assess(f.kernel, f.proposals);
		expect(f.kernel.ready()).toBe(true);
		await f.kernel.execute("bash", "later-check", { command });
		expect(f.kernel.ready()).toBe(false);
		assess(f.kernel, f.proposals);
		expect(f.kernel.ready()).toBe(true);
		writeFileSync(join(f.cwd, "parser.cjs"), "module.exports = () => 'broken';");
		expect(f.kernel.ready()).toBe(false);
	});
	it("missing, duplicate and skipped case results cannot be counted as all passing tests", () => {
		expect(() => nodeTestCases("TAP version 13\n1..0\n# tests 0\n# fail 0")).toThrow();
		expect(() =>
			nodeTestCases("TAP version 13\nok 1 - repeated\nok 2 - repeated\n1..2\n# tests 2\n# fail 0"),
		).toThrow();
		expect(nodeTestCases("TAP version 13\nok 1 - pending # SKIP\n1..1\n# tests 1\n# fail 0").get("pending")).toBe(
			"SKIPPED",
		);
	});
});
