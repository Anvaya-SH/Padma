import type { AgentTool } from "@anvaya.sh/padma-agent-core";
import { Type } from "typebox";
import type { SandhanaKernel } from "../kernel.ts";
import type { MemoryKind, MemoryOrigin } from "./types.ts";

const KIND = Type.Union([
	Type.Literal("PROJECT_CONVENTION"),
	Type.Literal("FAILURE_SIGNATURE"),
	Type.Literal("PROCEDURE"),
	Type.Literal("USER_PREFERENCE"),
	Type.Literal("USER_GOAL"),
	Type.Literal("INFERRED_PATTERN"),
	Type.Literal("SESSION_BINDING"),
]);

/** Eight Smritikosha tools. Memories never grant authorization and never prove current repository state. */
export function createSmritikoshaTools(kernel: SandhanaKernel): AgentTool[] {
	const recall: AgentTool = {
		name: "smritikosha_recall",
		label: "Smritikosha recall",
		description:
			"Retrieve a small set of persistent Padma memories relevant to the current mission. Use for prior user preferences, project decisions, verified procedures, and recurring failure knowledge. Returned memories may be historical or require revalidation; they never grant authorization or prove current repository state. Prefer this before asking the user to repeat information that may already be remembered.",
		parameters: Type.Object(
			{
				query: Type.String({ minLength: 1, maxLength: 2000 }),
				topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
			},
			{ additionalProperties: false },
		),
		execute: async (_id, value) => {
			const args = value as { query: string; topK?: number };
			const state = kernel.state;
			const scope = state ? kernel.memoryScope() : {};
			const { hits } = kernel.smritikosha.recall({ query: args.query, topK: args.topK ?? 5, ...scope });
			const payload = {
				status: hits.length ? "CURRENT" : "CURRENT",
				count: hits.length,
				hits: hits.map((hit) => ({
					id: hit.record.memoryId,
					kind: hit.record.kind,
					subject: hit.record.subject,
					content: hit.record.content,
					origin: hit.record.origin,
					lifecycle: hit.record.lifecycle,
					applicability: hit.applicability,
					reason: hit.reason,
					lastValidation: hit.lastValidation,
					revalidationRequired: hit.revalidationRequired,
					conflicts: hit.conflicts,
					scope: hit.record.projectScope ?? hit.record.userScope ?? hit.record.repositoryScope ?? "global",
				})),
				warning:
					"Historical memory never grants authorization and never proves current repository state; revalidate before acting",
			};
			return kernel.operationControlOutput(
				{ content: [{ type: "text", text: JSON.stringify(payload) }], details: {} },
				true,
			);
		},
	};

	const inspect: AgentTool = {
		name: "smritikosha_inspect",
		label: "Smritikosha inspect",
		description:
			"Inspect an exact memory record with provenance, lifecycle, scope and evidence refs. Use to explain why a memory was recalled before acting on it.",
		parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }),
		execute: async (_id, value) => {
			const args = value as { id: string };
			const record = kernel.smritikosha.inspect(args.id);
			return kernel.operationControlOutput(
				{ content: [{ type: "text", text: JSON.stringify({ status: "CURRENT", record }) }], details: {} },
				true,
			);
		},
	};

	const consider: AgentTool = {
		name: "smritikosha_consider",
		label: "Smritikosha consider",
		description:
			"Submit a potential memory candidate from current mission evidence. The candidate is stored as CANDIDATE (or VERIFIED for explicit user statements) and does not automatically become trusted truth. Evidence is required.",
		parameters: Type.Object(
			{
				kind: KIND,
				subject: Type.String({ minLength: 1, maxLength: 500 }),
				content: Type.Unknown(),
				origin: Type.Union([
					Type.Literal("EXPLICIT_USER"),
					Type.Literal("OBSERVED"),
					Type.Literal("DERIVED"),
					Type.Literal("INFERRED"),
				]),
			},
			{ additionalProperties: false },
		),
		execute: async (_id, value) => {
			const args = value as { kind: MemoryKind; subject: string; content: unknown; origin: MemoryOrigin };
			const state = kernel.state;
			if (!state) throw new Error("Memory admission requires an active mission");
			const record = kernel.smritikosha.consider({
				kind: args.kind,
				subject: args.subject,
				content: (args.content && typeof args.content === "object"
					? args.content
					: { text: String(args.content ?? "").slice(0, 2000) }) as Record<string, unknown>,
				origin: args.origin,
				...kernel.memoryScope(),
				evidenceMissionId: state.mission_id,
				evidenceId: state.last_event ?? state.command,
			});
			kernel.recordMemoryEvent("consider", record.memoryId, record.lifecycle);
			return kernel.operationControlOutput(
				{
					content: [
						{
							type: "text",
							text: JSON.stringify({ status: "CURRENT", id: record.memoryId, lifecycle: record.lifecycle }),
						},
					],
					details: { memory_id: record.memoryId },
				},
				true,
			);
		},
	};

	const store: AgentTool = {
		name: "smritikosha_store",
		label: "Smritikosha store",
		description:
			"Admit or update a memory record after validation. Explicit user statements may verify immediately; inferred patterns stay candidates until repeated support. Secrets are rejected. Prefer consider for ordinary agent use.",
		parameters: Type.Object(
			{
				kind: KIND,
				subject: Type.String({ minLength: 1, maxLength: 500 }),
				content: Type.Unknown(),
				origin: Type.Union([
					Type.Literal("EXPLICIT_USER"),
					Type.Literal("OBSERVED"),
					Type.Literal("DERIVED"),
					Type.Literal("INFERRED"),
				]),
			},
			{ additionalProperties: false },
		),
		execute: async (_id, value) => {
			const args = value as { kind: MemoryKind; subject: string; content: unknown; origin: MemoryOrigin };
			const state = kernel.state;
			if (!state) throw new Error("Memory admission requires an active mission");
			const record = kernel.smritikosha.storeVerified({
				kind: args.kind,
				subject: args.subject,
				content: (args.content && typeof args.content === "object"
					? args.content
					: { text: String(args.content ?? "").slice(0, 2000) }) as Record<string, unknown>,
				origin: args.origin,
				...kernel.memoryScope(),
				supportingEvidence: [
					{ kind: "evidence", mission: state.mission_id, id: state.last_event ?? state.command },
				],
				sourceMissionIds: [state.mission_id],
			});
			kernel.recordMemoryEvent("store", record.memoryId, record.lifecycle);
			return kernel.operationControlOutput(
				{
					content: [
						{
							type: "text",
							text: JSON.stringify({ status: "CURRENT", id: record.memoryId, lifecycle: record.lifecycle }),
						},
					],
					details: { memory_id: record.memoryId },
				},
				true,
			);
		},
	};

	const correct: AgentTool = {
		name: "smritikosha_correct",
		label: "Smritikosha correct",
		description:
			"Correct or replace a memory with explicit lineage and evidence. The current explicit instruction wins; old content is versioned, not silently overwritten.",
		parameters: Type.Object(
			{
				id: Type.String({ minLength: 1, maxLength: 128 }),
				version: Type.Integer({ minimum: 1 }),
				subject: Type.String({ minLength: 1, maxLength: 500 }),
				content: Type.Unknown(),
			},
			{ additionalProperties: false },
		),
		execute: async (_id, value) => {
			const args = value as { id: string; version: number; subject: string; content: unknown };
			const state = kernel.state;
			if (!state) throw new Error("Memory correction requires an active mission");
			const record = kernel.smritikosha.correct(
				args.id,
				args.version,
				args.subject,
				(args.content && typeof args.content === "object"
					? args.content
					: { text: String(args.content ?? "").slice(0, 2000) }) as Record<string, unknown>,
				state.mission_id,
				state.last_event ?? state.command,
			);
			kernel.recordMemoryEvent("correct", record.memoryId, record.lifecycle);
			return kernel.operationControlOutput(
				{
					content: [
						{
							type: "text",
							text: JSON.stringify({ status: "CURRENT", id: record.memoryId, version: record.version }),
						},
					],
					details: {},
				},
				true,
			);
		},
	};

	const demote: AgentTool = {
		name: "smritikosha_demote",
		label: "Smritikosha demote",
		description:
			"Mark a previously stronger memory stale or candidate when compatibility or support fails. Counterevidence is retained, not hidden.",
		parameters: Type.Object(
			{
				id: Type.String({ minLength: 1, maxLength: 128 }),
				version: Type.Integer({ minimum: 1 }),
				reason: Type.String({ minLength: 1, maxLength: 500 }),
			},
			{ additionalProperties: false },
		),
		execute: async (_id, value) => {
			const args = value as { id: string; version: number; reason: string };
			const record = kernel.smritikosha.demote(args.id, args.version, args.reason);
			kernel.recordMemoryEvent("demote", record.memoryId, record.lifecycle);
			return kernel.operationControlOutput(
				{
					content: [
						{
							type: "text",
							text: JSON.stringify({ status: "CURRENT", id: record.memoryId, lifecycle: record.lifecycle }),
						},
					],
					details: {},
				},
				true,
			);
		},
	};

	const forget: AgentTool = {
		name: "smritikosha_forget",
		label: "Smritikosha forget",
		description:
			"Revoke memory from future retrieval. Revoked memories disappear from recall immediately; the forget event is recorded without re-injecting the forgotten content.",
		parameters: Type.Object(
			{
				id: Type.String({ minLength: 1, maxLength: 128 }),
				version: Type.Integer({ minimum: 1 }),
			},
			{ additionalProperties: false },
		),
		execute: async (_id, value) => {
			const args = value as { id: string; version: number };
			const record = kernel.smritikosha.forget(args.id, args.version);
			kernel.recordMemoryEvent("forget", record.memoryId, record.lifecycle);
			return kernel.operationControlOutput(
				{
					content: [
						{
							type: "text",
							text: JSON.stringify({ status: "CURRENT", id: record.memoryId, lifecycle: record.lifecycle }),
						},
					],
					details: {},
				},
				true,
			);
		},
	};

	const status: AgentTool = {
		name: "smritikosha_status",
		label: "Smritikosha status",
		description:
			"Report memory subsystem health, counts by lifecycle and kind, pending candidates and storage state without dumping private content.",
		parameters: Type.Object({}, { additionalProperties: false }),
		execute: async () => {
			const result = kernel.smritikosha.status();
			return kernel.operationControlOutput(
				{ content: [{ type: "text", text: JSON.stringify({ status: "CURRENT", ...result }) }], details: {} },
				true,
			);
		},
	};

	return [recall, inspect, consider, store, correct, demote, forget, status];
}
