import { fauxAssistantMessage, fauxToolCall } from "@anvaya.sh/padma-ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

describe("ordinary native provider stream privacy", () => {
	it("does not expose credentials split across provider deltas and preserves actual governed arguments", async () => {
		const h = await createHarness();
		try {
			const content = "api_key=opaque-private-value; normal source content";
			h.setResponses([
				fauxAssistantMessage(
					[
						{ type: "text", text: "Authorization: Bearer opaque-stream-secret; normal explanation" },
						fauxToolCall("write", { path: "draft.txt", content }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Finished the requested draft"),
			]);
			await h.session.prompt("Create a draft in draft.txt with the supplied source content");
			const updates = h.eventsOfType("message_update");
			expect(updates).not.toHaveLength(0);
			expect(updates.some((event) => event.assistantMessageEvent.type === "text_end")).toBe(true);
			expect(
				updates.some((event) =>
					["text_delta", "thinking_delta", "toolcall_delta"].includes(event.assistantMessageEvent.type),
				),
			).toBe(false);
			const wire = JSON.stringify(h.events);
			expect(wire).not.toContain("opaque-stream-secret");
			expect(wire).not.toContain("opaque-private-value");
			expect(wire).toContain("normal explanation");
			const kernel = h.session.sandhana;
			const state = kernel.state!;
			const operation = state.operations
				.map((ref) => kernel.store.get(state.mission_id, ref, "OperationRecord"))
				.find(
					(op) => kernel.store.get(state.mission_id, op.prepared_ref, "PreparedAction").operation_class === "EDIT",
				)!;
			expect(operation.status).toBe("CONFIRMED_COMPLETE");
			expect(kernel.store.get(state.mission_id, operation.prepared_ref, "PreparedAction").arguments).toMatchObject({
				content,
			});
			expect(state.used.execution).toBe(1);
			expect(h.faux.state.callCount).toBe(2);
		} finally {
			h.cleanup();
		}
	});
});
