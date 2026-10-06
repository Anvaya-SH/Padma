import { describe, expect, it } from "vitest";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { publicOutput } from "../src/core/sandhana/public-output.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { toJsonEvent } from "../src/modes/json-event.ts";

describe("ordinary public output privacy", () => {
	it("charges delivered views and fences new work when a public payload cannot fit", () => {
		const store = new MissionStore(":memory:");
		try {
			const kernel = new SandhanaKernel({
				cwd: () => process.cwd(),
				session: () => "public-output",
				store,
				limits: { output_bytes: 1000 },
			});
			kernel.captureInput("Inspect parser behavior", "USER");
			kernel.begin("");
			const before = kernel.state!.used.output_bytes;
			const view = kernel.publicView({ type: "queue_update", text: "ordinary" });
			expect(view).not.toBeNull();
			expect(kernel.state!.used.output_bytes - before).toBe(Buffer.byteLength(JSON.stringify(view)));
			expect(kernel.publicView({ text: "large".repeat(1000) })).toBeNull();
			expect(() => kernel.reserveModel(10, 10)).toThrow("Public output capacity");
			expect(kernel.finalize().status).toBe("BUDGET_EXHAUSTED");
		} finally {
			store.close();
		}
	});
	it("bounds aggregate public strings and omits oversized strings without exposing credential fragments", () => {
		const projected = publicOutput({ first: "ordinary", second: "Bearer private-value".repeat(10000) }, 100);
		expect(JSON.stringify(projected)).toContain("byte limit");
		expect(JSON.stringify(projected)).not.toContain("private-value");
		expect(JSON.stringify(projected)).toContain("ordinary");
	});
	it("redacts native tool arguments, nested credentials and headers without altering the actual event", () => {
		const event = {
			type: "tool_execution_start" as const,
			toolCallId: "actual-call",
			toolName: "bash",
			args: {
				command: "Authorization: Bearer opaque-token",
				password: "opaque-password",
				metadata: { refresh_token: "opaque-refresh", headers: { "X-Custom": "opaque-header" } },
			},
		};
		const wire = JSON.stringify(toJsonEvent(event));
		for (const secret of ["opaque-token", "opaque-password", "opaque-refresh", "opaque-header"])
			expect(wire).not.toContain(secret);
		expect(wire).toContain("actual-call");
		expect(event.args.password).toBe("opaque-password");
	});
	it("does not execute accessors, proxies or toJSON during projection", () => {
		let invoked = 0;
		const raw = {
			get password() {
				invoked++;
				return "private";
			},
			get value() {
				invoked++;
				return "private";
			},
			toJSON() {
				invoked++;
				return { raw: "private" };
			},
		};
		const proxy = new Proxy(
			{},
			{
				get() {
					invoked++;
					return "private";
				},
			},
		);
		expect(JSON.stringify(publicOutput({ raw, proxy }))).not.toContain("private");
		expect(invoked).toBe(0);
	});
	it("retains ordinary result structure and marks runtime cycles explicitly", () => {
		const result = {
			content: [{ type: "text", text: "ordinary output" }],
			details: { exit_code: 0, output_complete: true },
		};
		expect(publicOutput(result)).toEqual(result);
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		expect(JSON.stringify(publicOutput(cyclic))).toContain("omitted");
	});
	it("admits extension UI and approval presentation views through publicView and fences on capacity exhaustion", () => {
		const store = new MissionStore(":memory:");
		try {
			const kernel = new SandhanaKernel({
				cwd: () => process.cwd(),
				session: () => "public-ext-approval",
				store,
				limits: { output_bytes: 800 },
			});
			kernel.captureInput("Inspect extension output bounds", "USER");
			kernel.begin("");
			const extRequest = {
				type: "extension_ui_request",
				id: "ext-1",
				method: "notify",
				message: "Authorization: Bearer secret-token-ext",
			};
			const view = kernel.publicView(extRequest);
			expect(view).not.toBeNull();
			const wire = JSON.stringify(view);
			expect(wire).not.toContain("secret-token-ext");
			expect(wire).toContain("notify");

			const approvalView = {
				version: "SANDHANA_AUTHORIZATION/1",
				mission_id: kernel.state!.mission_id,
				revision: 1,
				request: {
					tool: "write",
					token: "private-auth-token",
					args: "x".repeat(1000),
				},
			};
			expect(kernel.publicView(approvalView)).toBeNull();
			expect(kernel.finalize().status).toBe("BUDGET_EXHAUSTED");
		} finally {
			store.close();
		}
	});
});
