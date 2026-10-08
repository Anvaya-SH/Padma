import type { AgentMessage } from "@anvaya.sh/padma-agent-core";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	Type,
} from "@anvaya.sh/padma-ai";
import { describe, expect, it } from "vitest";
import { assemblePacket } from "../src/core/sandhana/avartana/position.ts";
import { modelSafe } from "../src/core/sandhana/avartana/render.ts";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { redact } from "../src/core/sandhana/redaction.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";

describe("bounded native transcript replay", () => {
	it("compaction retains both source-read batches needed by a single decision", () => {
		const store = new MissionStore(":memory:");
		try {
			const kernel = new SandhanaKernel({ cwd: () => process.cwd(), session: () => "two-source-packet", store });
			kernel.captureInput("Compare implementation and tests", "USER");
			kernel.begin("");
			const implementationCall = fauxToolCall("read", { path: "implementation.cjs" }, { id: "implementation" });
			const testCall = fauxToolCall("read", { path: "implementation.test.cjs" }, { id: "tests" });
			const messages: AgentMessage[] = [
				{ role: "user", content: "Compare implementation and tests", timestamp: 0 },
				fauxAssistantMessage(implementationCall, { stopReason: "toolUse" }),
				{
					role: "toolResult",
					toolCallId: "implementation",
					toolName: "read",
					content: [{ type: "text", text: "Current implementation source" }],
					isError: false,
					timestamp: 1,
				},
				fauxAssistantMessage(testCall, { stopReason: "toolUse" }),
				{
					role: "toolResult",
					toolCallId: "tests",
					toolName: "read",
					content: [{ type: "text", text: "Current named test assertions" }],
					isError: false,
					timestamp: 2,
				},
			];
			const packet = assemblePacket(kernel.missionPosition(), messages, [], 30000, 1000, 1000, true);
			expect(packet.messages.filter((message) => message.role !== "system")).toEqual(messages);
			expect(packet.estimatedTokens).toBeLessThanOrEqual(28000);
			expect(packet.compaction).toBe(true);
		} finally {
			store.close();
		}
	});
	it("redacts structured credentials in model views while retaining valid JSON and raw evidence", () => {
		const raw = {
			token: "opaque-token",
			cookie: "opaque-cookie",
			proxy_authorization: "opaque-proxy",
			nested: { refresh_token: "opaque-refresh", private_key: "opaque-key", count: 7 },
			text: 'token="opaque-inline"',
			source: 'api_key=opaque-api\n{"password":"opaque-password"}\n',
			headers: { "X-Custom": "opaque-header" },
			numeric: { token: 123456 },
		};
		const rendered = modelSafe(raw);
		expect(JSON.parse(JSON.stringify(rendered))).toEqual({
			token: "[REDACTED]",
			cookie: "[REDACTED]",
			proxy_authorization: "[REDACTED]",
			nested: { refresh_token: "[REDACTED]", private_key: "[REDACTED]", count: 7 },
			text: 'token="[REDACTED]"',
			source: 'api_key=[REDACTED]\n{"password":"[REDACTED]"}\n',
			headers: "[REDACTED]",
			numeric: { token: "[REDACTED]" },
		});
		expect(JSON.parse(redact(JSON.stringify(rendered)))).toEqual(rendered);
		expect(redact("token=[REDACTED]opaque-suffix")).toBe("token=[REDACTED]");
		expect(raw.token).toBe("opaque-token");
		expect(raw.nested.private_key).toBe("opaque-key");
	});
	it("replays replaced tool declarations without losing instructions, sections or mission authority", () => {
		const store = new MissionStore(":memory:");
		try {
			const kernel = new SandhanaKernel({ cwd: () => process.cwd(), session: () => "packet", store });
			kernel.captureInput("Diagnose a failure; preserve existing behavior", "USER");
			kernel.begin("");
			const position = kernel.missionPosition();
			const original = {
				name: "inspect",
				description: "old declaration ".repeat(2000),
				parameters: Type.Object({}),
			};
			const current = { ...original, description: "Current bounded inspection" };
			const messages: AgentMessage[] = [
				{
					role: "system",
					content: "Read-only authority",
					sections: { scope: "old", retained: "Keep this" },
					toolsAdded: [original],
					timestamp: 0,
				},
				{
					role: "system",
					content: "Revalidate current evidence",
					sections: { scope: "current" },
					toolsAdded: [current],
					timestamp: 1,
				},
				{ role: "user", content: "Continue diagnosis", timestamp: 2 },
			];
			const packet = assemblePacket(position, messages, [], 24000, 1000, 1000, false);
			expect(packet.compaction).toBe(true);
			expect(packet.estimatedTokens).toBeLessThan(22000);
			expect(getCurrentTools(packet.messages)).toEqual(getCurrentTools(messages));
			expect(
				getCurrentSystemMessage(
					packet.messages.filter(
						(message) =>
							message.role !== "system" ||
							typeof message.content !== "string" ||
							!message.content.startsWith('{"controller":"sandhana"'),
					),
				),
			).toEqual(getCurrentSystemMessage(messages));
			expect(packet.position).toEqual(position);
			expect(packet.messages).toContainEqual(messages[2]);
			expect(messages[0]).toMatchObject({ toolsAdded: [original], sections: { scope: "old" } });
			const disabled = assemblePacket(
				position,
				[
					...messages,
					{
						role: "system",
						content: "Assessment only",
						toolsRemoved: [{ name: "inspect" }],
						timestamp: 3,
					},
				],
				[],
				24000,
				1000,
				1000,
				true,
			);
			expect(getCurrentTools(disabled.messages)).toEqual([]);
			expect(getCurrentSystemPrompt(disabled.messages)).toContain("Assessment only");
		} finally {
			store.close();
		}
	});
});
