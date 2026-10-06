import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getPackageDir } from "../src/config.ts";
import type { CoverageProposal } from "../src/core/sandhana/acceptance.ts";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { vitestCases } from "../src/core/sandhana/vitest-results.ts";
import { createBashTool, createReadTool, createWriteTool } from "../src/core/tools/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("current behavioral proof through the native Vitest JSON reporter", () => {
	it.each(["passing", "failing", "skipped"] as const)(
		"keeps %s named cases separate from mandatory obligations",
		async (outcome) => {
			const cwd = resolve(getPackageDir(), "../..");
			const directory = mkdtempSync(join(cwd, "sandhana-vitest-fixture-"));
			if (!directory.startsWith(cwd + (process.platform === "win32" ? "\\" : "/")))
				throw new Error("Fixture escaped workspace");
			const store = new MissionStore(":memory:");
			cleanups.push(() => {
				store.close();
				rmSync(directory, { recursive: true, force: true });
			});
			const implementationPath = relative(cwd, join(directory, "parser.mjs")).replaceAll("\\", "/");
			const testPath = relative(cwd, join(directory, "parser.test.mjs")).replaceAll("\\", "/");
			const command = `node node_modules/vitest/dist/cli.js --run ${testPath} --reporter=json --no-file-parallelism`;
			const implementation = `export default (value) => { if (value === '') throw new Error('empty'); return ${outcome === "failing" ? "value.toUpperCase()" : "value"}; };`;
			const empty = "test('rejects empty', () => expect(() => parse('')).toThrow('empty'));";
			const valid = `test${outcome === "skipped" ? ".skip" : ""}('preserves valid', () => expect(parse('valid')).toBe('valid'));`;
			writeFileSync(join(directory, "parser.mjs"), "export default (value) => value;");
			writeFileSync(
				join(directory, "parser.test.mjs"),
				`import { test, expect } from 'vitest'; import parse from './parser.mjs';\n${empty}\n${valid}`,
			);
			const kernel = new SandhanaKernel({
				cwd: () => cwd,
				session: () => "vitest-proof",
				store,
				limits: { execution: 40 },
			});
			kernel.register(createReadTool(cwd), "read");
			kernel.register(createWriteTool(cwd), "write");
			kernel.register(createBashTool(cwd), "bash");
			kernel.captureInput(
				`padma: ${JSON.stringify({
					objective: "Fix parser accepting empty values and preserve valid values",
					allow_edits: true,
					shell_commands: [command],
					requirements: [
						{
							text: "Reject invalid empty values",
							rule: "SEMANTIC",
							target: ".",
							dependencies: [implementationPath, testPath],
						},
						{
							text: "Preserve valid existing values",
							rule: "SEMANTIC",
							target: ".",
							dependencies: [implementationPath, testPath],
						},
					],
				})}`,
				"USER",
			);
			kernel.begin("");
			const testRead = await kernel.execute("read", "test-source", { path: testPath });
			await kernel.execute("write", "implementation-patch", { path: implementationPath, content: implementation });
			const sourceRead = await kernel.execute("read", "implementation-source", { path: implementationPath });
			await kernel.execute("bash", "real-vitest-cases", { command });
			const state = kernel.state!;
			const check = store.get(
				state.mission_id,
				store.get(state.mission_id, state.operations.at(-1)!, "OperationRecord").result_refs[0],
				"EvidenceRecord",
			);
			const facts = check.payload as { full_output_ref?: string };
			const raw = JSON.parse(store.artifact(state.mission_id, check.artifact_ref!).toString()) as {
				structuredContent: { output: string; truncated: boolean };
			};
			expect(raw.structuredContent.truncated).toBe(false);
			const output = facts.full_output_ref
				? store.artifact(state.mission_id, facts.full_output_ref).toString()
				: raw.structuredContent.output;
			expect(vitestCases(output, [resolve(cwd, testPath)]).get("preserves valid")).toBe(
				outcome === "passing" ? "PASSED" : outcome === "failing" ? "FAILED" : "SKIPPED",
			);
			const testObservation = (testRead.details as { sandhana: { observation_id: string } }).sandhana.observation_id;
			const sourceObservation = (sourceRead.details as { sandhana: { observation_id: string } }).sandhana
				.observation_id;
			const proposals: CoverageProposal[] = state.requirements.map((ref, index) => ({
				requirement_id: store.get(state.mission_id, ref, "Requirement").requirement_id,
				command,
				case_names: [index === 0 ? "rejects empty" : "preserves valid"],
				applicability: "SUPPORTED",
				explanation:
					"The actual named assertion calls the changed parser and checks the required rejection or preservation behavior.",
				citations: [
					{ observation_id: sourceObservation, role: "IMPLEMENTATION", quote: implementation },
					{
						observation_id: testObservation,
						role: "TEST_ASSERTION",
						case_name: index === 0 ? "rejects empty" : "preserves valid",
						quote: index === 0 ? empty : valid,
					},
				],
			}));
			const model = kernel.reserveModel(16000, 4000);
			kernel.reconcileModel(model, { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, 1);
			kernel.acceptDecisionText(`<pramana>${JSON.stringify({ results: proposals })}</pramana>`, model);
			const report = kernel.finalize();
			expect(report.status).toBe(
				outcome === "passing"
					? "VERIFIED_COMPLETE"
					: outcome === "failing"
						? "EXECUTION_FAILED"
						: "PARTIALLY_COMPLETE",
			);
			expect(report.verified).toHaveLength(outcome === "passing" ? 2 : outcome === "failing" ? 0 : 1);
			if (outcome === "passing") {
				const parsed = JSON.parse(output) as {
					numTotalTests: number;
					testResults: { name: string; assertionResults: { title: string }[] }[];
				};
				for (const corruption of ["count", "file", "duplicate", "empty"] as const) {
					const corrupt = structuredClone(parsed);
					if (corruption === "count") corrupt.numTotalTests++;
					if (corruption === "file") corrupt.testResults[0].name = join(directory, "unexecuted.test.mjs");
					if (corruption === "duplicate")
						corrupt.testResults[0].assertionResults[1].title = corrupt.testResults[0].assertionResults[0].title;
					if (corruption === "empty") corrupt.testResults[0].assertionResults = [];
					expect(() => vitestCases(JSON.stringify(corrupt), [resolve(cwd, testPath)]), corruption).toThrow();
				}
			}
		},
		60000,
	);
});
