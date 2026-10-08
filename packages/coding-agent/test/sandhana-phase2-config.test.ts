import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { signalsForExact } from "../src/core/sandhana/code.ts";
import { compile } from "../src/core/sandhana/compiler.ts";
import { resolveConfiguration, routeBudget } from "../src/core/sandhana/configuration.ts";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { type KernelConfiguration, makeRecord } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function command(instruction: string, configuration?: KernelConfiguration) {
	const root = mkdtempSync(join(tmpdir(), "padma-phase2-config-"));
	roots.push(root);
	return compile(instruction, root, "phase2-config", "USER", undefined, undefined, configuration);
}

describe("Phase 2 resource calibration", () => {
	it("rejects a persisted route calibration that would increase the captured allowance", () => {
		const compiled = command("Fix the parser");
		const configuration = compiled.records.find((record) => record.record_type === "KernelConfiguration")!;
		// A valid older configuration may contain distinct future-route quotas.
		// Its current route and historical record remain valid at reopen.
		configuration.value.routes.GAMBHIRA.execution = 1000;
		const store = new MissionStore(":memory:");
		try {
			store.commit(0, compiled.state, compiled.records);
			const kernel = new SandhanaKernel({ cwd: () => roots.at(-1)!, session: () => "phase2-config", store });
			const before = kernel.state!;
			const signals = signalsForExact(false);
			signals.H = { severity: 2, provenance: "HISTORY", evidence: ["untrusted-route-proof"] };
			signals.A = { severity: 1, provenance: "HISTORY", evidence: ["untrusted-route-proof"] };
			expect(() => kernel.escalate(signals)).toThrow("cannot change the captured outer allowance");
			expect(kernel.state).toEqual(before);
			const ceilings = { ...before.ceilings, execution: 1000 };
			const contract = makeRecord(before.mission_id, before.revision + 1, "MissionContract", {
				...store.get(before.mission_id, before.contract, "MissionContract"),
				route: "GAMBHIRA",
				signals,
				ceilings,
			});
			expect(() =>
				store.commit(
					before.revision,
					{
						...before,
						revision: before.revision + 1,
						route: "GAMBHIRA",
						ceilings,
						contract: contract.record_id,
					},
					[contract],
				),
			).toThrow("Route transition cannot change the captured outer allowance");
			expect(kernel.state).toEqual(before);
		} finally {
			store.close();
		}
	});
	it("uses one outer allowance across default routes and selects legacy quotas explicitly", () => {
		const standard = resolveConfiguration();
		expect(standard.calibration_profile).toBe("STANDARD/1");
		for (const route of ["SAKSHAT", "MADHYAMA", "GAMBHIRA"] as const)
			expect(routeBudget(standard, route)).toEqual(routeBudget(standard, "MADHYAMA"));
		expect(standard.routes.SAKSHAT.execution).not.toBe(3);
		expect(standard.routes.MADHYAMA.execution).not.toBe(40);
		expect(standard.routes.GAMBHIRA.execution).not.toBe(100);
		const legacy = resolveConfiguration({ version: "sandhana/1", calibration_profile: "LEGACY/1" });
		expect(Object.values(legacy.routes).map((route) => route.execution)).toEqual([3, 40, 100]);
		expect(() => resolveConfiguration({ version: "sandhana/1", calibration_profile: "invented" })).toThrow();
	});
	it("protects declared distinct checks rather than charging every repeated requirement as a new run", () => {
		const compiled = command(
			`padma: ${JSON.stringify({
				objective: "replace and check content",
				allow_edits: true,
				shell_commands: ["node check.cjs"],
				quality_checks: ["node check.cjs"],
				requirements: [
					{ text: "content", rule: "CONTENT", target: "a.txt", expected: "new" },
					{ text: "same content", rule: "CONTENT", target: "a.txt", expected: "new" },
					{ text: "check", rule: "PROCESS", target: ".", expected: "node check.cjs" },
				],
			})}`,
		);
		expect(compiled.state.verification_reserve).toBe(2);
		const configuration = compiled.records.find((record) => record.record_type === "KernelConfiguration")!;
		for (const route of ["SAKSHAT", "MADHYAMA", "GAMBHIRA"] as const) {
			const budget = routeBudget(configuration.value, route, configuration.resource_overrides);
			expect(budget.verification_reserve).toBe(2);
			expect(budget.ceilings).toEqual(compiled.state.ceilings);
		}
	});
	it("needs no separate verification invocation for exact retrieval or subjective acceptance", () => {
		expect(command("read absent.txt").state.verification_reserve).toBe(0);
		const subjective = command(
			`padma: ${JSON.stringify({
				objective: "draft for review",
				requirements: [{ text: "human review", rule: "SUBJECTIVE", target: "draft.txt" }],
			})}`,
		);
		expect(subjective.state.verification_reserve).toBe(0);
	});
	it("retains the caller's calibration and copies the derived coding verification allowance", () => {
		const configuration = resolveConfiguration();
		const compiled = command("Fix the parser and preserve valid inputs", configuration);
		expect(compiled.state.verification_reserve).toBe(3);
		expect(configuration.routes.MADHYAMA.verification_reserve).toBe(0);
		const captured = compiled.records.find((record) => record.record_type === "KernelConfiguration")!;
		expect(captured.value.routes.MADHYAMA.verification_reserve).toBe(3);
		const legacy = resolveConfiguration({ version: "sandhana/1", calibration_profile: "LEGACY/1" });
		expect(command("Fix the parser", legacy).state.verification_reserve).toBe(6);
	});
	it("freezes the initial outer allowance and protected capacity across custom and legacy route changes", () => {
		for (const configuration of [
			resolveConfiguration({ version: "sandhana/1", calibration_profile: "LEGACY/1" }),
			resolveConfiguration({
				version: "sandhana/1",
				routes: {
					MADHYAMA: { execution: 20, ticks: 8, verification_reserve: 4 },
					GAMBHIRA: { execution: 100, ticks: 40, verification_reserve: 15 },
				},
			}),
		]) {
			const compiled = command("Fix the parser", configuration);
			const captured = compiled.records.find((record) => record.record_type === "KernelConfiguration")!;
			for (const route of ["SAKSHAT", "MADHYAMA", "GAMBHIRA"] as const)
				expect(routeBudget(captured.value, route, captured.resource_overrides)).toEqual({
					ceilings: compiled.state.ceilings,
					verification_reserve: compiled.state.verification_reserve,
				});
			expect(configuration.routes.GAMBHIRA.execution).toBe(100);
		}
	});
});
