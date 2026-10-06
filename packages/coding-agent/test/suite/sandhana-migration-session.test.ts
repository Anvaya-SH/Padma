import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@anvaya.sh/padma-ai";
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../../src/core/sandhana/compiler.ts";
import { digest, type MissionState, makeRecord } from "../../src/core/sandhana/records.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()!.cleanup();
});

describe("configuration migration through the actual session entry", () => {
	it("explicit resume migrates persisted legacy input, executes the exact read and preserves its prior report without inference", async () => {
		const h = await createHarness({ sandhanaConfiguration: { version: "sandhana/1", view: { tool_chars: 1 } } });
		harnesses.push(h);
		writeFileSync(join(h.tempDir, "a.txt"), "actual session bytes\n");
		const compiled = compile("read a.txt", h.tempDir, h.sessionManager.getSessionId(), "USER", { execution: 5 });
		const store = h.session.sandhana.store;
		const records = compiled.records
			.filter((record) => record.record_type !== "KernelConfiguration")
			.map((record) => {
				if (record.record_type !== "MissionContract") return record;
				const { configuration_ref: _configuration, ...legacy } = record;
				return legacy;
			});
		store.commit(0, compiled.state, records);
		const event = makeRecord(compiled.state.mission_id, 2, "EvidenceRecord", {
			event_id: "legacy-stop",
			stage: "niyantr",
			kind: "CONTROL",
			provenance: "KERNEL",
			target_generation: null,
			captured_at: Date.now(),
			operation_id: null,
			source: "Legacy fixture",
			payload: "Awaiting explicit resume",
			artifact_ref: null,
			digest: digest("Awaiting explicit resume"),
			sensitivity: "PRIVATE",
			sources: [],
			requirement_ids: [],
			correction_of: null,
			previous: null,
		});
		const old = makeRecord(compiled.state.mission_id, 2, "TerminalReport", {
			status: "BLOCKED",
			contract_ref: compiled.state.contract,
			verification_report_ref: null,
			artifacts: [],
			verified: [],
			remaining: [
				store.get(compiled.state.mission_id, compiled.state.requirements[0], "Requirement").requirement_id,
			],
			checks_run: [],
			checks_skipped: [],
			limitations: ["Awaiting explicit resume"],
			unknown_operation: null,
			next_action: "Resume",
			evidence: [event.record_id],
		});
		const stopped: MissionState = {
			...compiled.state,
			revision: 2,
			phase: "BLOCKED",
			terminal: old.record_id,
			last_event: event.record_id,
		};
		store.commit(1, stopped, [event, old]);
		h.setResponses([fauxAssistantMessage("This decision must remain unused")]);
		await h.session.prompt(`resume ${stopped.mission_id}`);
		const kernel = h.session.sandhana;
		expect(kernel.terminal?.status).toBe("VERIFIED_COMPLETE");
		expect(h.session.getLastAssistantText()).toContain("actual session bytes");
		expect(kernel.state!.mission_id).toBe(stopped.mission_id);
		expect(kernel.state!.ceilings.execution).toBe(5);
		expect(kernel.state!.used.execution).toBe(1);
		expect(kernel.state!.used.ticks).toBe(0);
		expect(kernel.state!.started_at).toBe(stopped.started_at);
		expect(kernel.state!.authorizations).toEqual(stopped.authorizations);
		expect(h.getPendingResponseCount()).toBe(1);
		expect(h.eventsOfType("tool_execution_end")).toHaveLength(1);
		expect(store.get(old.mission_id, old.record_id, "TerminalReport")).toEqual(old);
		expect(
			store.records(old.mission_id).filter((record) => record.record_type === "ConfigurationMigration"),
		).toHaveLength(1);
		expect(store.list(h.sessionManager.getSessionId())).toHaveLength(1);
	});
});
