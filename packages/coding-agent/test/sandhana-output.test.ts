import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { serializeOutput, toolOutputView } from "../src/core/sandhana/output.ts";
import { digest } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createBashTool, createReadTool } from "../src/core/tools/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "padma-output-capture-"));
	const store = new MissionStore(":memory:");
	const kernel = new SandhanaKernel({
		cwd: () => cwd,
		session: () => "output",
		store,
		configuration: { version: "sandhana/1", artifact: { max_bytes: 4096 } },
	});
	cleanups.push(() => {
		store.close();
		rmSync(cwd, { recursive: true, force: true });
	});
	kernel.register(createReadTool(cwd), "read");
	return {
		cwd,
		store,
		kernel,
		start: () => {
			kernel.captureInput("run: node effect.cjs", "USER");
			kernel.begin("");
		},
	};
}

describe("bounded raw tool output", () => {
	it("matches native JSON bytes and digest across escaped text, UTF-8 and split surrogate pairs", () => {
		const value = {
			text: `${"x".repeat(4095)}😀\n\u0000\ud800\udc00\ud800\udc00${"y".repeat(4100)}`,
			optional: undefined,
			values: [null, true, false, 1.5, -0, undefined],
		};
		const expected = Buffer.from(JSON.stringify(value));
		const capture = serializeOutput(value, expected.length);
		expect(capture.bytes).toEqual(expected);
		expect(capture.measured_bytes).toBe(expected.length);
		expect(capture.digest).toBe(digest(expected));
		expect(capture.limitation).toBeNull();
	});
	it("measures a large escaped result without retaining its oversized JSON string", () => {
		const value = { text: "\u0000".repeat(100000), payload: { after: "observed" } };
		const expected = Buffer.from(JSON.stringify(value));
		const capture = serializeOutput(value, 4096);
		expect(capture.bytes).toBeNull();
		expect(capture.measured_bytes).toBe(expected.length);
		expect(capture.observed_bytes).toBe(expected.length);
		expect(capture.digest).toBe(digest(expected));
		expect(capture.limitation).toContain("exceeds bounded artifact");
	});
	it("rejects accessors and toJSON without executing their code", () => {
		const getter = vi.fn(() => "untrusted mutation");
		const customJSON = vi.fn(() => ({ substituted: true }));
		const accessor = Object.defineProperty({}, "value", { enumerable: true, get: getter });
		for (const value of [accessor, { toJSON: customJSON }]) {
			const capture = serializeOutput(value, 4096);
			expect(capture.measured_bytes).toBeNull();
			expect(capture.digest).toBeNull();
			expect(capture.bytes).toBeNull();
		}
		expect(getter).not.toHaveBeenCalled();
		expect(customJSON).not.toHaveBeenCalled();
	});
	it("rejects proxies before invoking traps", () => {
		const trap = vi.fn(() => {
			throw new Error("proxy executed");
		});
		const proxy = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap });
		expect(serializeOutput(proxy, 4096).limitation).toContain("proxy");
		expect(trap).not.toHaveBeenCalled();
	});
	it("records unsupported cycles and depth as unknown measurements without stack overflow", () => {
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		let deep: unknown = "leaf";
		for (let index = 0; index < 10000; index++) deep = [deep];
		for (const value of [cycle, deep, { invalid: Infinity }, { invalid: 1n }]) {
			const capture = serializeOutput(value, 4096);
			expect(capture.measured_bytes).toBeNull();
			expect(capture.bytes).toBeNull();
			expect(capture.limitation).not.toBeNull();
		}
	});
	it("settles a valid oversized result once and retains an explicit accessible-evidence gap", async () => {
		const f = fixture();
		const result = {
			content: [{ type: "text" as const, text: "\u0000".repeat(100000) }],
			details: { actual: true },
			structuredContent: { exit_code: 0 },
		};
		f.kernel.register({ ...createBashTool(f.cwd), execute: async () => result }, "bash");
		f.start();
		await expect(f.kernel.execute("bash", "escaped-output", { command: "node effect.cjs" })).rejects.toThrow(
			"Complete output",
		);
		const state = f.kernel.state!;
		const op = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
		const observation = f.store.get(state.mission_id, op.result_refs[0], "EvidenceRecord");
		const expected = Buffer.from(JSON.stringify(result));
		expect(observation.artifact_ref).toBeNull();
		expect(observation.payload).toMatchObject({
			omitted: true,
			serialized_output_bytes: expected.length,
			serialized_output_digest: digest(expected),
		});
		expect(op.status).toBe("CONFIRMED_COMPLETE");
		expect(state.used.execution).toBe(1);
		expect(state.used.output_bytes).toBe(expected.length);
		expect(state.used.artifact_bytes).toBe(0);
		expect(f.kernel.finalize("BUDGET_EXHAUSTED").status).toBe("BUDGET_EXHAUSTED");
	});
	it("deadline expiry after dispatch retains the actual returned result and known usage", async () => {
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		const f = fixture();
		f.kernel.register(
			{
				...createBashTool(f.cwd),
				execute: async () => {
					clock.mockReturnValue(now + 30 * 60 * 1000 + 1);
					return {
						content: [{ type: "text", text: "actual response" }],
						details: {},
						structuredContent: { exit_code: 0 },
					};
				},
			},
			"bash",
		);
		f.start();
		await expect(f.kernel.execute("bash", "expired-result", { command: "node effect.cjs" })).rejects.toThrow(
			"ceiling",
		);
		const state = f.kernel.state!;
		const op = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
		const observation = f.store.get(state.mission_id, op.result_refs[0], "EvidenceRecord");
		const raw = JSON.parse(f.store.artifact(state.mission_id, observation.artifact_ref!).toString()) as {
			structuredContent: { exit_code: number };
		};
		expect(raw.structuredContent.exit_code).toBe(0);
		expect(op.status).toBe("CONFIRMED_COMPLETE");
		expect(f.store.get(state.mission_id, op.reservation_ref!, "BudgetReservation").state).toBe("RECONCILED");
		expect(f.kernel.finalize().status).toBe("BUDGET_EXHAUSTED");
	});
	it.each(["cycle", "getter", "proxy"])(
		"persists Phala and unknown capacity after an effect followed by %s output",
		async (kind) => {
			const f = fixture();
			const getter = vi.fn(() => {
				writeFileSync(join(f.cwd, "getter-effect.txt"), "forbidden");
				return "mutation";
			});
			let details: unknown;
			if (kind === "cycle") {
				const cycle: Record<string, unknown> = {};
				cycle.self = cycle;
				details = cycle;
			} else if (kind === "getter") details = Object.defineProperty({}, "unsafe", { enumerable: true, get: getter });
			else
				details = new Proxy(
					{},
					{
						get: getter,
						ownKeys: () => {
							getter();
							return [];
						},
					},
				);
			f.kernel.register(
				{
					...createBashTool(f.cwd),
					execute: async () => {
						writeFileSync(join(f.cwd, "effect.txt"), "performed");
						return { content: [{ type: "text", text: "actual returned prefix" }], details };
					},
				},
				"bash",
			);
			f.start();
			await expect(f.kernel.execute("bash", "invalid-output", { command: "node effect.cjs" })).rejects.toThrow(
				"may have taken effect",
			);
			expect(getter).not.toHaveBeenCalled();
			expect(readFileSync(join(f.cwd, "effect.txt"), "utf8")).toBe("performed");
			const state = f.kernel.state!;
			const op = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
			const prepared = f.store.get(state.mission_id, op.prepared_ref, "PreparedAction");
			const observation = f.store.get(state.mission_id, op.result_refs[0], "EvidenceRecord");
			const reservation = f.store.get(state.mission_id, op.reservation_ref!, "BudgetReservation");
			expect(op.status).toBe("OUTCOME_UNKNOWN");
			expect(observation.payload).toMatchObject({
				serialized_output_bytes: null,
				serialized_output_digest: null,
				unknown: true,
			});
			expect(reservation.state).toBe("RETAINED");
			expect(reservation.amounts.output_bytes + reservation.actual!.output_bytes).toBe(prepared.limits.output_bytes);
			expect(state.used.execution).toBe(1);
			await expect(f.kernel.execute("bash", "duplicate", { command: "node effect.cjs" })).rejects.toThrow(
				"no repeat",
			);
			expect(f.kernel.finalize().status).toBe("OUTCOME_UNKNOWN");
		},
	);
});

describe("bounded model payloads", () => {
	it("shares its text allowance across content and nested data and labels omissions", () => {
		const result = toolOutputView(
			{
				content: [
					{ type: "text", text: "first" },
					{ type: "text", text: "second" },
					{ type: "text", text: "not displayed" },
				],
				details: { long: "hidden" },
			},
			8,
		);
		expect(result.content[0]).toEqual({ type: "text", text: "first" });
		expect(result.content[1]).toMatchObject({ type: "text" });
		expect(JSON.stringify(result)).toContain("sec");
		expect(JSON.stringify(result)).not.toContain("hidden");
		expect(result.content).toHaveLength(2);
		expect(result.details).toMatchObject({ model_view_truncated: true });
		expect(JSON.stringify(result)).toContain("final capture is not yet established");
	});
	it("bounds wide/cyclic data without getters and never emits a partial image", () => {
		const getter = vi.fn(() => "unsafe");
		const details: Record<string, unknown> = { values: new Array(100000).fill(1) };
		details.self = details;
		Object.defineProperty(details, "unsafe", { enumerable: true, get: getter });
		const result = toolOutputView(
			{ content: [{ type: "image", mimeType: "image/png", data: "x".repeat(100000) }], details },
			20,
		);
		expect(result.content.every((part) => part.type === "text")).toBe(true);
		expect(JSON.stringify(result).length).toBeLessThan(2000);
		expect(getter).not.toHaveBeenCalled();
	});
	it("redacts nested credential values by key and crops before scanning large text", () => {
		const result = toolOutputView(
			{
				content: [{ type: "text", text: `api_key=private-value ${"x".repeat(100000)}` }],
				details: { api_key: "another-private-value" },
			},
			100,
		);
		expect(JSON.stringify(result)).not.toContain("private-value");
		expect(JSON.stringify(result)).toContain("REDACTED");
	});
});
