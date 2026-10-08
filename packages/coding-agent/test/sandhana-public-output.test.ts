import { fauxAssistantMessage } from "@anvaya.sh/padma-ai";
import { describe, expect, it } from "vitest";
import { SandhanaError } from "../src/core/sandhana/errors.ts";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { publicAgentEvent, publicOutput } from "../src/core/sandhana/public-output.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { toJsonEvent } from "../src/modes/json-event.ts";

describe("ordinary public output privacy", () => {
	it("projects operation control stops without requiring optional failure details", () => {
		const event = {
			type: "tool_execution_end" as const,
			toolCallId: "operation-control",
			toolName: "sandhana_operation",
			result: {
				content: [
					{ type: "text" as const, text: "Operation a1cba27c-d364-4086-82d0-348fc4c66e63 may have taken effect" },
				],
				details: { sandhana_stop: "OUTCOME_UNKNOWN" },
			},
			isError: true,
		};
		const projected = publicAgentEvent(event);
		if (projected?.type !== "tool_execution_end") throw new Error("Missing operation event");
		expect(JSON.stringify(projected.result.content)).toContain("could not confirm");
		expect(JSON.stringify(projected.result.content)).not.toContain("a1cba27c");
		expect(projected.result.details).toEqual(event.result.details);
	});
	it("keeps machine proposals in the raw response while excluding them from displayed assistant text", () => {
		const message = fauxAssistantMessage('Useful result. <yukti>{"private":"control-proposal"}</yukti>');
		const projected = publicAgentEvent({ type: "message_end", message });
		expect(JSON.stringify(projected)).toContain("Useful result.");
		expect(JSON.stringify(projected)).not.toContain("control-proposal");
		expect(JSON.stringify(message)).toContain("control-proposal");
	});
	it.each(["yukti", "pramana_plan", "pramana"])(
		"hides an interrupted %s proposal while preserving the preceding answer and raw response",
		(tag) => {
			const message = fauxAssistantMessage(`Useful result. <${tag}>{"private":"unfinished-control`);
			const projected = publicAgentEvent({ type: "message_end", message });
			expect(projected).toMatchObject({ message: { content: [{ type: "text", text: "Useful result." }] } });
			expect(JSON.stringify(projected)).not.toContain("unfinished-control");
			expect(JSON.stringify(message)).toContain("unfinished-control");
		},
	);
	it("shows a plain uncertain tool outcome and preserves typed diagnostic details", () => {
		const operation = "a1cba27c-d364-4086-82d0-348fc4c66e63";
		const error = new SandhanaError("EFFECT_OUTCOME_UNKNOWN", `Operation ${operation} may have taken effect`, {
			operation_id: operation,
		});
		const event = {
			type: "tool_execution_end" as const,
			toolCallId: "actual-call",
			toolName: "bash",
			result: {
				content: [{ type: "text" as const, text: error.message }],
				details: { sandhana_stop: "OUTCOME_UNKNOWN", sandhana_failure: error.failure },
			},
			isError: true,
		};
		const projected = publicAgentEvent(event);
		if (projected?.type !== "tool_execution_end") throw new Error("Missing tool event");
		const text = JSON.stringify(projected.result.content);
		expect(text).toContain("could not confirm");
		expect(text).not.toContain(operation);
		expect(projected.result.details).toEqual(event.result.details);
		expect(event.result.content[0].text).toContain(operation);
	});
	it("redacts generic credential tokens and proxy/cookie text in public views", () => {
		const projected = publicOutput({
			token: "opaque-token",
			message: 'token="opaque-inline" proxy_authorization=opaque-proxy cookie=opaque-cookie',
			count: 12,
		});
		const wire = JSON.stringify(projected);
		for (const secret of ["opaque-token", "opaque-inline", "opaque-proxy", "opaque-cookie"])
			expect(wire).not.toContain(secret);
		expect(projected).toMatchObject({ token: "[REDACTED]", count: 12 });
	});
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
