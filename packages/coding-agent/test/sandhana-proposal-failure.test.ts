import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolPreparationFailure } from "@anvaya.sh/padma-agent-core";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { digest, makeRecord, ProposalFailureSchema } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";

describe("persisted proposal failure integrity", () => {
	it("rejects invented recovery counts, boundary identities, provenance and duplicate attempts atomically", () => {
		const cwd = mkdtempSync(join(tmpdir(), "padma-proposal-failure-"));
		const store = new MissionStore(":memory:");
		try {
			const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "proposal", store });
			kernel.captureInput("Inspect the parser behavior", "USER");
			kernel.begin("");
			const diagnostic: ToolPreparationFailure = {
				version: "TOOL_PREPARATION_FAILURE/1",
				id: "actual-attempt",
				code: "INVALID_ACTION_SCHEMA",
				boundary: "SCHEMA_VALIDATION",
			};
			kernel.rejectProposal("read", "model-id", diagnostic);
			const before = kernel.state!;
			const records = store.records(before.mission_id);
			const original = records.find(
				(record) => record.record_type === "EvidenceRecord" && record.stage === "proposal-failure",
			);
			if (original?.record_type !== "EvidenceRecord" || !Value.Check(ProposalFailureSchema, original.payload))
				throw new Error("Missing actual failure evidence");
			const payload = { ...original.payload, count: 2, diagnostic: { ...diagnostic, id: "new-attempt" } };
			const variants = [
				{ payload: { ...payload, count: 1 } },
				{ payload: { ...payload, limit: payload.limit + 1 } },
				{ payload: { ...payload, diagnostic } },
				{ payload: { ...payload, diagnostic: { ...payload.diagnostic, boundary: "TOOL_RESOLUTION" } } },
				{ payload: { ...payload, tick_ref: before.contract } },
				{ payload, provenance: "MODEL" as const },
				{ payload, target_generation: "invented" },
				{ payload, stage: "observation" },
			];
			for (const variant of variants) {
				const evidence = makeRecord(before.mission_id, before.revision + 1, "EvidenceRecord", {
					...original,
					...variant,
					digest: digest(variant.payload),
					previous: before.last_event,
				});
				expect(() =>
					store.commit(
						before.revision,
						{ ...before, revision: before.revision + 1, last_event: evidence.record_id },
						[evidence],
					),
				).toThrow();
				expect(kernel.state).toEqual(before);
				expect(store.records(before.mission_id)).toEqual(records);
			}
			const first = makeRecord(before.mission_id, before.revision + 1, "EvidenceRecord", {
				...original,
				payload,
				digest: digest(payload),
				previous: before.last_event,
			});
			const secondPayload = { ...payload, diagnostic: { ...diagnostic, id: "another-attempt" } };
			const second = makeRecord(before.mission_id, before.revision + 1, "EvidenceRecord", {
				...original,
				payload: secondPayload,
				digest: digest(secondPayload),
				previous: first.record_id,
			});
			expect(() =>
				store.commit(before.revision, { ...before, revision: before.revision + 1, last_event: second.record_id }, [
					first,
					second,
				]),
			).toThrow();
			expect(store.records(before.mission_id)).toEqual(records);
			expect(kernel.state).toEqual(before);
		} finally {
			store.close();
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
