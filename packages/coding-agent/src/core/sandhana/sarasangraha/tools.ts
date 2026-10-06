import type { AgentTool } from "@anvaya.sh/padma-agent-core";
import { Type } from "typebox";
import type { SandhanaKernel } from "../kernel.ts";

/** Six Sarasangraha tools. Compaction never mutates authorization, contract or budget. */
export function createSarasangrahaTools(kernel: SandhanaKernel): AgentTool[] {
	const compact: AgentTool = {
		name: "sarasangraha_compact",
		label: "Sarasangraha compact",
		description:
			"Create a bounded context capsule from current durable mission state and dependencies. Preserves protected requirements, prohibitions, authorization, operations and budget. Use when context pressure is high or before suspension. Does not mutate the mission contract.",
		parameters: Type.Object({}, { additionalProperties: false }),
		execute: async () => {
			const result = kernel.sarasangraha.compact();
			return kernel.operationControlOutput(
				{
					content: [
						{
							type: "text",
							text: JSON.stringify({
								status: "CURRENT",
								...result,
								note: "Protected state copied from authority; capsule is a projection, not the mission database",
							}),
						},
					],
					details: { capsule_id: result.capsuleId },
				},
				true,
			);
		},
	};

	const restore: AgentTool = {
		name: "sarasangraha_restore",
		label: "Sarasangraha restore",
		description:
			"Reconstruct usable context for the existing mission from durable state, capsule and exact sources. Validates revision and workspace identity, restores protected state, marks stale derivations, and lists source ranges to rehydrate with Avartana.",
		parameters: Type.Object({}, { additionalProperties: false }),
		execute: async () => {
			const result = kernel.sarasangraha.restore();
			return kernel.operationControlOutput(
				{ content: [{ type: "text", text: JSON.stringify({ status: "CURRENT", ...result }) }], details: {} },
				true,
			);
		},
	};

	const pin: AgentTool = {
		name: "sarasangraha_pin",
		label: "Sarasangraha pin",
		description:
			"Pin a small critical exact reference or mission-local note against ordinary compaction. Use for acceptance criteria, API contracts, failing stack ranges or decision rationale. Bounded to 16 pins and 64 KiB per mission.",
		parameters: Type.Object(
			{
				kind: Type.Union([Type.Literal("exact_ref"), Type.Literal("derived_note")]),
				locator: Type.String({ minLength: 1, maxLength: 8192 }),
				reason: Type.String({ minLength: 1, maxLength: 500 }),
			},
			{ additionalProperties: false },
		),
		execute: async (_id, value) => {
			const args = value as { kind: "exact_ref" | "derived_note"; locator: string; reason: string };
			const pin = kernel.sarasangraha.pin(args.kind, args.locator, args.reason);
			return kernel.operationControlOutput(
				{
					content: [{ type: "text", text: JSON.stringify({ status: "CURRENT", pin }) }],
					details: { pin_id: pin.pinId },
				},
				true,
			);
		},
	};

	const unpin: AgentTool = {
		name: "sarasangraha_unpin",
		label: "Sarasangraha unpin",
		description: "Remove a pin when its reason no longer applies. Pins must not be used to defeat compaction.",
		parameters: Type.Object({ pinId: Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false }),
		execute: async (_id, value) => {
			const args = value as { pinId: string };
			const removed = kernel.sarasangraha.unpin(args.pinId);
			return kernel.operationControlOutput(
				{
					content: [
						{ type: "text", text: JSON.stringify({ status: removed ? "CURRENT" : "UNAVAILABLE", removed }) },
					],
					details: {},
				},
				true,
			);
		},
	};

	const status: AgentTool = {
		name: "sarasangraha_status",
		label: "Sarasangraha status",
		description:
			"Report context pressure, latest capsule, stale dependencies, protected-state health and recoverability without dumping full history.",
		parameters: Type.Object({}, { additionalProperties: false }),
		execute: async () => {
			const result = kernel.sarasangraha.status();
			return kernel.operationControlOutput(
				{ content: [{ type: "text", text: JSON.stringify({ status: "CURRENT", ...result }) }], details: {} },
				true,
			);
		},
	};

	const explain: AgentTool = {
		name: "sarasangraha_explain",
		label: "Sarasangraha explain",
		description:
			"Explain what was kept, externalized, summarized or discarded during the latest compaction, with source references where available.",
		parameters: Type.Object({}, { additionalProperties: false }),
		execute: async () => {
			const result = kernel.sarasangraha.explain();
			return kernel.operationControlOutput(
				{ content: [{ type: "text", text: JSON.stringify({ status: "CURRENT", ...result }) }], details: {} },
				true,
			);
		},
	};

	return [compact, restore, pin, unpin, status, explain];
}
