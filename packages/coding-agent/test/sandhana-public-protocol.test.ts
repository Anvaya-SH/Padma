import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SandhanaKernel } from "../src/core/sandhana/kernel.ts";
import { isPublicMissionSnapshot } from "../src/core/sandhana/public-protocol.ts";
import { digest, makeRecord } from "../src/core/sandhana/records.ts";
import { MissionStore } from "../src/core/sandhana/store.ts";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "../src/core/tools/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(
	instruction = `padma: ${JSON.stringify({
		objective: "PRIVATE_INSTRUCTION",
		requirements: [
			{
				text: "Read parser.txt",
				rule: "CONTENT",
				target: "parser.txt",
				expected: "PRIVATE_CONTENT api_key=private-secret",
			},
		],
	})}`,
) {
	const directory = mkdtempSync(join(tmpdir(), "padma-public-mission-"));
	const cwd = join(directory, "workspace");
	mkdirSync(cwd);
	const path = join(directory, "mission.sqlite");
	let store = new MissionStore(path);
	const kernel = new SandhanaKernel({ cwd: () => cwd, session: () => "public-mission", store });
	kernel.register(createReadTool(cwd), "read");
	cleanups.push(() => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	});
	kernel.captureInput(instruction, "USER");
	kernel.begin("");
	return {
		cwd,
		kernel,
		get store() {
			return store;
		},
		reopen: () => {
			store.close();
			store = new MissionStore(path);
		},
	};
}

describe("committed public mission projection", () => {
	it.each([
		{ kind: "write", existing: true },
		{ kind: "write", existing: false },
		{ kind: "edit", existing: true },
	] as const)(
		"retains a denied $kind request for an existing=$existing target without publishing a checkpoint",
		async ({ kind, existing }) => {
			const f = fixture("read parser.txt");
			const path = join(f.cwd, "parser.txt");
			if (existing) writeFileSync(path, "PRIVATE_PREIMAGE");
			const replacement = "PRIVATE_REPLACEMENT api_key=private-edit-secret";
			let invocations = 0;
			f.kernel.register(
				{
					...(kind === "write" ? createWriteTool(f.cwd) : createEditTool(f.cwd)),
					execute: async () => {
						invocations++;
						return { content: [{ type: "text" as const, text: "unexpected edit" }], details: {} };
					},
				},
				kind,
			);
			const before = f.kernel.state!;
			await expect(
				f.kernel.prepareOperation(
					kind,
					"denied-private-edit",
					kind === "write"
						? { path: "parser.txt", content: replacement }
						: { path: "parser.txt", edits: [{ oldText: "PRIVATE_PREIMAGE", newText: replacement }] },
				),
			).rejects.toMatchObject({ failure: { code: "AUTHORIZATION_REQUIRED" } });
			const state = f.kernel.state!;
			const view = f.store.publicAuthorization(state.mission_id);
			expect(view.request).toMatchObject({
				action: { tool_id: kind, kind: "EDIT" },
				effect: { kind: "FILE_REPLACEMENT", side_effect: true, postimage_digest: digest(Buffer.from(replacement)) },
				arguments_omitted: true,
				requires_repreparation: true,
			});
			expect(view.request!.target.binding_ref).toBe(
				f.store.get(state.mission_id, view.request!.prepared_ref, "PreparedAction").binding_ref,
			);
			const history = f.store.records(state.mission_id);
			expect(
				history.some(
					(record) =>
						record.record_type === "EvidenceRecord" &&
						record.kind === "PREDICTION" &&
						record.operation_id === view.request!.operation_id,
				),
			).toBe(true);
			expect(
				history.filter((record) => record.record_type === "Artifact" || record.record_type === "CheckpointRecord"),
			).toEqual([]);
			expect(state.authorizations).toEqual(before.authorizations);
			expect(state.checkpoints).toEqual([]);
			expect(state.operations).toEqual([]);
			expect(state.used.execution).toBe(0);
			expect(state.used.artifact_bytes).toBe(0);
			expect(state.used.retrieval_bytes).toBeGreaterThanOrEqual(before.used.retrieval_bytes);
			for (const privateText of [
				"PRIVATE_PREIMAGE",
				"PRIVATE_REPLACEMENT",
				"private-edit-secret",
				"parser.txt",
				f.cwd,
			])
				expect(JSON.stringify(view)).not.toContain(privateText);
			expect(invocations).toBe(0);
			expect(existsSync(path)).toBe(existing);
			if (existing) expect(readFileSync(path, "utf8")).toBe("PRIVATE_PREIMAGE");
			f.reopen();
			expect(f.store.publicAuthorization(state.mission_id)).toEqual(view);
			expect(f.store.load(state.mission_id)).toEqual(state);
			expect(f.store.records(state.mission_id)).toEqual(history);
		},
	);
	it("retains a safe authorization request when the denied preparation has no operation marker", async () => {
		const f = fixture("Read parser.txt");
		writeFileSync(join(f.cwd, "parser.txt"), "PRIVATE_SOURCE");
		let invocations = 0;
		f.kernel.register(
			{
				...createBashTool(f.cwd),
				execute: async () => {
					invocations++;
					return { content: [{ type: "text" as const, text: "unexpected launch" }], details: {} };
				},
			},
			"bash",
		);
		await expect(
			f.kernel.prepareOperation("bash", "private-denied-process", {
				command: "node unapproved.cjs api_key=private-approval-secret",
			}),
		).rejects.toMatchObject({ failure: { code: "AUTHORIZATION_REQUIRED" } });
		const state = f.kernel.state!;
		expect(state.operations).toEqual([]);
		const scope = f.store.records(state.mission_id).findLast((record) => record.record_type === "ScopeDecision");
		if (scope?.record_type !== "ScopeDecision") throw new Error("Native missing-authorization decision absent");
		const history = f.store.records(state.mission_id);
		const view = f.store.publicAuthorization(state.mission_id);
		expect(view).toMatchObject({
			version: "SANDHANA_AUTHORIZATION/1",
			mission_id: state.mission_id,
			revision: state.revision,
			request: {
				decision_ref: scope.record_id,
				operation_id: scope.operation_id,
				action_digest: scope.action_digest,
				action: { tool_id: "bash", kind: "PROCESS" },
				effect: { kind: "OPAQUE_PROCESS", side_effect: true },
				arguments_omitted: true,
				requires_repreparation: true,
				response: "EXACT_USER_INSTRUCTION",
			},
		});
		for (const privateText of ["PRIVATE_SOURCE", "private-approval-secret", "unapproved.cjs", f.cwd])
			expect(JSON.stringify(view)).not.toContain(privateText);
		expect(f.store.load(state.mission_id)).toEqual(state);
		expect(f.store.records(state.mission_id)).toEqual(history);
		expect(invocations).toBe(0);
		f.reopen();
		expect(f.store.publicAuthorization(state.mission_id)).toEqual(view);
	});
	it("does not offer an earlier authorization request after trusted intent changes", async () => {
		const f = fixture("Read parser.txt");
		f.kernel.register(createBashTool(f.cwd), "bash");
		await expect(f.kernel.prepareOperation("bash", "old-request", { command: "node old.cjs" })).rejects.toMatchObject(
			{ failure: { code: "AUTHORIZATION_REQUIRED" } },
		);
		const before = f.kernel.state!;
		expect(f.store.publicAuthorization(before.mission_id).request).not.toBeNull();
		f.kernel.amend("Use the new parser behavior instead");
		const current = f.kernel.state!;
		expect(f.store.publicAuthorization(current.mission_id)).toMatchObject({
			revision: current.revision,
			request: null,
		});
		expect(
			f.store
				.records(current.mission_id)
				.filter(
					(record) => record.record_type === "ScopeDecision" && record.outcome === "NEEDS_CURRENT_AUTHORIZATION",
				),
		).toHaveLength(1);
		expect(current.used.execution).toBe(0);
	});
	it("does not turn a request preview or generic approval text into authority", async () => {
		const f = fixture("Read parser.txt");
		f.kernel.register(createBashTool(f.cwd), "bash");
		const arguments_ = { command: "node unapproved.cjs" };
		await expect(f.kernel.prepareOperation("bash", "original-request", arguments_)).rejects.toMatchObject({
			failure: { code: "AUTHORIZATION_REQUIRED" },
		});
		const before = f.kernel.state!;
		const view = f.store.publicAuthorization(before.mission_id);
		f.kernel.amend(`approve: ${JSON.stringify(view.request)}`);
		expect(f.kernel.state!.authorizations).toEqual(before.authorizations);
		await expect(f.kernel.prepareOperation("bash", "same-display-text", arguments_)).rejects.toMatchObject({
			failure: { code: "AUTHORIZATION_REQUIRED" },
		});
		expect(f.kernel.state!.used.execution).toBe(0);
		expect(f.kernel.state!.operations).toEqual([]);
	});
	it("does not offer policy denial as an authorization request", async () => {
		const f = fixture("Read parser.txt");
		f.kernel.policy.version = "different-current-policy";
		await expect(f.kernel.prepareOperation("read", "policy-denied", { path: "parser.txt" })).rejects.toMatchObject({
			failure: { code: "SCOPE_DENIED" },
		});
		expect(f.store.publicAuthorization(f.kernel.state!.mission_id).request).toBeNull();
		expect(f.kernel.state!.used.execution).toBe(0);
	});
	it("retains a policy-denied creation without offering authorization or publishing recovery bytes", async () => {
		const f = fixture("read parser.txt");
		f.kernel.register(createWriteTool(f.cwd), "write");
		f.kernel.amend('operations: {"deny_targets":["parser.txt"]}');
		await expect(
			f.kernel.prepareOperation("write", "policy-denied-creation", {
				path: "parser.txt",
				content: "PRIVATE_REPLACEMENT",
			}),
		).rejects.toMatchObject({ failure: { code: "SCOPE_DENIED" } });
		const state = f.kernel.state!;
		const records = f.store.records(state.mission_id);
		expect(records.some((record) => record.record_type === "PreparedAction" && record.tool_id === "write")).toBe(
			true,
		);
		expect(records.some((record) => record.record_type === "ScopeDecision" && record.outcome === "DENY")).toBe(true);
		expect(
			records.filter((record) => record.record_type === "Artifact" || record.record_type === "CheckpointRecord"),
		).toEqual([]);
		expect(f.store.publicAuthorization(state.mission_id).request).toBeNull();
		expect(state.operations).toEqual([]);
		expect(state.used.execution).toBe(0);
		expect(state.used.artifact_bytes).toBe(0);
		expect(existsSync(join(f.cwd, "parser.txt"))).toBe(false);
	});
	it("permits an authorized replacement under an unrelated target constraint", async () => {
		const f = fixture("Fix parser.txt");
		writeFileSync(join(f.cwd, "parser.txt"), "original");
		writeFileSync(join(f.cwd, "protected.txt"), "untouched");
		f.kernel.register(createWriteTool(f.cwd), "write");
		f.kernel.amend('operations: {"deny_targets":["protected.txt"]}');
		await f.kernel.execute("write", "allowed-constrained-replacement", {
			path: "parser.txt",
			content: "replacement",
		});
		const state = f.kernel.state!;
		expect(f.store.get(state.mission_id, state.operations[0], "OperationRecord").status).toBe("CONFIRMED_COMPLETE");
		expect(state.used.execution).toBe(1);
		expect(state.checkpoints).not.toEqual([]);
		expect(readFileSync(join(f.cwd, "parser.txt"), "utf8")).toBe("replacement");
		expect(readFileSync(join(f.cwd, "protected.txt"), "utf8")).toBe("untouched");
		expect(f.store.publicAuthorization(state.mission_id).request).toBeNull();
	});
	it.each(["decision", "prepared"] as const)(
		"rejects %s identity corruption in a retained authorization request",
		async (kind) => {
			const f = fixture("Read parser.txt");
			f.kernel.register(createBashTool(f.cwd), "bash");
			await expect(
				f.kernel.prepareOperation("bash", "integrity-request", { command: "node denied.cjs" }),
			).rejects.toMatchObject({ failure: { code: "AUTHORIZATION_REQUIRED" } });
			const state = f.kernel.state!;
			const view = f.store.publicAuthorization(state.mission_id);
			const request = view.request!;
			const target =
				kind === "decision"
					? f.store.get(state.mission_id, request.decision_ref, "ScopeDecision")
					: f.store.get(state.mission_id, request.prepared_ref, "PreparedAction");
			const changed = { ...target, action_digest: "fabricated" };
			const db = new DatabaseSync(f.store.databasePath);
			try {
				db.prepare("UPDATE records SET payload=?,digest=? WHERE mission=? AND id=?").run(
					JSON.stringify(changed),
					digest(changed),
					state.mission_id,
					target.record_id,
				);
			} finally {
				db.close();
			}
			expect(() => f.store.publicAuthorization(state.mission_id)).toThrow("Authorization request differs");
			expect(f.store.load(state.mission_id)).toEqual(state);
			expect(state.used.execution).toBe(0);
		},
	);
	it.each(["row-id", "row-revision", "duplicate-revision", "lookahead"] as const)(
		"rejects %s corruption rather than returning ambiguous replay history",
		(corruption) => {
			const f = fixture();
			for (let index = 0; index < 3; index++) {
				const current = f.kernel.state!;
				f.store.commit(current.revision, { ...current, revision: current.revision + 1 }, []);
			}
			const state = f.kernel.state!;
			const cursor = state.revision - 3;
			const page = f.store.publicEvents(state.mission_id, cursor, 3);
			const target = page.events[corruption === "lookahead" ? 1 : 0];
			const db = new DatabaseSync(f.store.databasePath);
			try {
				if (corruption === "row-id")
					db.prepare("UPDATE records SET id=? WHERE mission=? AND id=?").run(
						`${target.record_id}-changed`,
						state.mission_id,
						target.record_id,
					);
				else if (corruption === "row-revision")
					db.prepare("UPDATE records SET revision=? WHERE mission=? AND id=?").run(
						target.revision + 1,
						state.mission_id,
						target.record_id,
					);
				else if (corruption === "lookahead")
					db.prepare("UPDATE records SET digest=? WHERE mission=? AND id=?").run(
						"invalid",
						state.mission_id,
						target.record_id,
					);
				else {
					const duplicate = { ...target, record_id: `${target.record_id}-duplicate` };
					db.prepare("INSERT INTO records(mission,id,revision,type,digest,payload) VALUES(?,?,?,?,?,?)").run(
						state.mission_id,
						duplicate.record_id,
						duplicate.revision,
						duplicate.record_type,
						digest(duplicate),
						JSON.stringify(duplicate),
					);
				}
			} finally {
				db.close();
			}
			const history = f.store.records(state.mission_id);
			expect(() => f.store.publicEvents(state.mission_id, cursor, 1)).toThrow(
				"Committed public event identity or payload differs",
			);
			expect(f.store.load(state.mission_id)).toEqual(state);
			expect(f.store.records(state.mission_id)).toEqual(history);
			f.reopen();
			expect(() => f.store.publicEvents(state.mission_id, cursor, 1)).toThrow(
				"Committed public event identity or payload differs",
			);
		},
	);
	it.each(["interior", "tail"] as const)(
		"reports missing %s history without inventing events or repeating effects",
		(gap) => {
			const f = fixture();
			for (let index = 0; index < 4; index++) {
				const current = f.kernel.state!;
				f.store.commit(current.revision, { ...current, revision: current.revision + 1 }, []);
			}
			const state = f.kernel.state!;
			const cursor = state.revision - 3;
			const missing = gap === "interior" ? cursor + 1 : state.revision;
			const db = new DatabaseSync(f.store.databasePath);
			try {
				db.prepare("DELETE FROM records WHERE mission=? AND type='PublicMissionEvent' AND revision=?").run(
					state.mission_id,
					missing,
				);
			} finally {
				db.close();
			}
			const history = f.store.records(state.mission_id);
			const page = f.store.publicEvents(state.mission_id, cursor, gap === "interior" ? 1 : 4);
			expect(page.history_gap).toBe(true);
			expect(page.events.some((event) => event.revision === missing)).toBe(false);
			expect(page.next_revision).toBe(gap === "interior" ? cursor + 2 : state.revision);
			expect(page.has_more).toBe(gap === "interior");
			const caughtUp = f.store.publicEvents(state.mission_id, page.next_revision, 4);
			expect(caughtUp).toMatchObject({ next_revision: state.revision, has_more: false, history_gap: false });
			expect(f.store.load(state.mission_id)).toEqual(state);
			expect(f.store.records(state.mission_id)).toEqual(history);
			f.reopen();
			expect(f.store.publicEvents(state.mission_id, cursor, gap === "interior" ? 1 : 4)).toEqual(page);
		},
	);
	it("terminal progress reflects the current verifier when a previously verified source changes", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "parser.txt"), "PRIVATE_CONTENT api_key=private-secret");
		await f.kernel.execute("read", "initial-current-proof", { path: "parser.txt" });
		const before = f.kernel.state!;
		expect(f.store.publicSnapshot(before.mission_id).progress.verified).toBe(1);
		writeFileSync(join(f.cwd, "parser.txt"), "Changed outside the mission");
		const terminal = f.kernel.finalize();
		expect(terminal.status).toBe("PARTIALLY_COMPLETE");
		expect(terminal.verified).toEqual([]);
		expect(terminal.remaining).toHaveLength(1);
		expect(f.store.get(before.mission_id, before.requirements[0], "Requirement").status).toBe("VERIFIED");
		const snapshot = f.store.publicSnapshot(before.mission_id);
		expect(isPublicMissionSnapshot(snapshot)).toBe(true);
		expect(snapshot.progress).toMatchObject({ mandatory: 1, verified: 0 });
		expect(snapshot.remaining).toEqual([{ requirement_id: terminal.remaining[0], status: "UNMET" }]);
		expect(snapshot.terminal).toMatchObject({ verified: 0, remaining: 1 });
		expect(f.store.publicEvents(before.mission_id, f.kernel.state!.revision - 1, 1).events[0].payload).toEqual(
			snapshot,
		);
		const state = f.kernel.state!;
		f.reopen();
		expect(f.store.publicSnapshot(before.mission_id)).toEqual(snapshot);
		expect(f.store.load(before.mission_id)).toEqual(state);
		expect(state.used.execution).toBe(1);
	});
	it("reconnects through stable paged events without exposing private bytes or repeating an invocation", async () => {
		const f = fixture();
		writeFileSync(join(f.cwd, "parser.txt"), "PRIVATE_CONTENT api_key=private-secret");
		const baseline = f.kernel.state!;
		const initial = f.store.publicSnapshot(baseline.mission_id);
		expect(isPublicMissionSnapshot(initial)).toBe(true);
		expect(initial).toMatchObject({ revision: baseline.revision, terminal: null, used: { execution: 0 } });
		const result = await f.kernel.execute("read", "private-read", { path: "parser.txt" });
		expect(result.isError, JSON.stringify(result)).not.toBe(true);
		const report = f.kernel.finalize();
		expect(report.status, JSON.stringify(report)).toBe("VERIFIED_COMPLETE");
		const state = f.kernel.state!;
		const expected = f.store.publicSnapshot(state.mission_id);
		expect(expected).toMatchObject({ terminal: { status: "VERIFIED_COMPLETE" }, used: { execution: 1 } });
		const first = f.store.publicEvents(state.mission_id, initial.revision, 1);
		expect(first.events).toHaveLength(1);
		expect(first.has_more).toBe(true);
		expect(f.store.publicEvents(state.mission_id, initial.revision, 1).events).toEqual(first.events);
		const events = [...first.events];
		let page = first;
		while (page.has_more) {
			page = f.store.publicEvents(state.mission_id, page.next_revision, 1);
			events.push(...page.events);
		}
		expect(events.at(-1)!.payload).toEqual(expected);
		expect(new Set(events.map((event) => event.event_id)).size).toBe(events.length);
		expect(events.every((event, index) => event.revision === initial.revision + index + 1)).toBe(true);
		expect(events.every((event) => isPublicMissionSnapshot(event.payload))).toBe(true);
		for (const privateText of ["PRIVATE_CONTENT", "PRIVATE_INSTRUCTION", "private-secret", "parser.txt", f.cwd])
			expect(JSON.stringify(page).includes(privateText)).toBe(false);
		const records = f.store.records(state.mission_id);
		const publicEvents = f.store.publicEvents(state.mission_id, 0, 64);
		f.reopen();
		expect(f.store.publicEvents(state.mission_id, 0, 64)).toEqual(publicEvents);
		expect(f.store.publicSnapshot(state.mission_id)).toEqual(expected);
		expect(f.store.records(state.mission_id)).toEqual(records);
		expect(f.store.load(state.mission_id)).toEqual(state);
		expect(readFileSync(join(f.cwd, "parser.txt"), "utf8")).toBe("PRIVATE_CONTENT api_key=private-secret");
	});
	it("retains uncertain operation identity and held capacity in a stopped snapshot", async () => {
		const f = fixture("run: printf uncertain");
		let invocations = 0;
		f.kernel.register(
			{
				...createBashTool(f.cwd),
				execute: async () => {
					invocations++;
					throw new Error("lost adapter response PRIVATE_ERROR");
				},
			},
			"bash",
		);
		await expect(
			f.kernel.execute("bash", "uncertain-public-operation", { command: "printf uncertain" }),
		).rejects.toThrow("reconcile, never blindly retry");
		f.kernel.finalize();
		const state = f.kernel.state!;
		const snapshot = f.store.publicSnapshot(state.mission_id);
		const operation = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
		expect(isPublicMissionSnapshot(snapshot)).toBe(true);
		expect(snapshot).toMatchObject({
			phase: "OUTCOME_UNKNOWN",
			terminal: { status: "OUTCOME_UNKNOWN", unknown_operation: operation.operation_id },
			current_operations: [{ operation_id: operation.operation_id, status: "OUTCOME_UNKNOWN" }],
			used: { execution: 1 },
		});
		const reservation = f.store.get(state.mission_id, operation.reservation_ref!, "BudgetReservation");
		expect(reservation.state).toBe("RETAINED");
		expect(snapshot.reserved.input_tokens).toBe(reservation.amounts.input_tokens);
		expect(snapshot.reserved.cost).toBe(reservation.amounts.cost);
		expect(JSON.stringify(snapshot).includes("PRIVATE_ERROR")).toBe(false);
		f.reopen();
		expect(f.store.publicSnapshot(state.mission_id)).toEqual(snapshot);
		expect(invocations).toBe(1);
	});
	it("preserves delivered-unverified progress and limitations across reopening", async () => {
		const f = fixture(
			`padma: ${JSON.stringify({
				objective: "Deliver a draft for review",
				allow_edits: true,
				requirements: [
					{ text: "Draft bytes", rule: "CONTENT", target: "draft.txt", expected: "draft" },
					{ text: "Human review", rule: "SUBJECTIVE", target: "draft.txt" },
				],
			})}`,
		);
		f.kernel.register(createWriteTool(f.cwd), "write");
		await f.kernel.execute("write", "public-draft", { path: "draft.txt", content: "draft" });
		const report = f.kernel.finalize();
		expect(report.status).toBe("DELIVERED_UNVERIFIED");
		const snapshot = f.store.publicSnapshot(report.mission_id);
		expect(snapshot.progress).toMatchObject({ mandatory: 2, verified: 1 });
		expect(snapshot.terminal).toMatchObject({ status: "DELIVERED_UNVERIFIED", remaining: 1, output_omitted: false });
		expect(snapshot.terminal!.limitations).toBeGreaterThan(0);
		expect(isPublicMissionSnapshot(snapshot)).toBe(true);
		f.reopen();
		expect(f.store.publicSnapshot(report.mission_id)).toEqual(snapshot);
		expect(isPublicMissionSnapshot(f.store.publicSnapshot(report.mission_id))).toBe(true);
	});
	it("keeps a late confirmed operation visible without rewriting its earlier uncertain report", async () => {
		const f = fixture("run: printf observed");
		let invocations = 0;
		let reportRef: string | undefined;
		f.kernel.register(
			{
				...createBashTool(f.cwd),
				execute: async () => {
					invocations++;
					writeFileSync(join(f.cwd, "observed.txt"), "actual effect");
					reportRef = f.kernel.finalize("OUTCOME_UNKNOWN").record_id;
					return {
						content: [{ type: "text", text: "observed" }],
						details: {},
						structuredContent: { exit_code: 0 },
					};
				},
			},
			"bash",
		);
		await f.kernel.execute("bash", "late-confirmation", { command: "printf observed" });
		const state = f.kernel.state!;
		const operation = f.store.get(state.mission_id, state.operations[0], "OperationRecord");
		expect(operation.status).toBe("CONFIRMED_COMPLETE");
		const report = f.store.get(state.mission_id, reportRef!, "TerminalReport");
		const snapshot = f.store.publicSnapshot(state.mission_id);
		expect(isPublicMissionSnapshot(snapshot)).toBe(true);
		expect(snapshot).toMatchObject({
			terminal: { report_ref: reportRef, status: "OUTCOME_UNKNOWN", unknown_operation: operation.operation_id },
			current_operations: [{ operation_id: operation.operation_id, status: "CONFIRMED_COMPLETE" }],
		});
		expect(invocations).toBe(1);
		expect(state.used.execution).toBe(1);
		expect(readFileSync(join(f.cwd, "observed.txt"), "utf8")).toBe("actual effect");
		f.reopen();
		expect(f.store.get(state.mission_id, reportRef!, "TerminalReport")).toEqual(report);
		expect(f.store.publicSnapshot(state.mission_id)).toEqual(snapshot);
		expect(f.store.publicEvents(state.mission_id, state.revision - 1, 1).events[0].payload).toEqual(snapshot);
	});
	it("rejects fabricated public verdicts and emits no event for a rolled back transition", () => {
		const f = fixture();
		const state = f.kernel.state!;
		const before = f.store.publicEvents(state.mission_id);
		const forged = makeRecord(state.mission_id, state.revision + 1, "PublicMissionEvent", {
			event_id: `${state.mission_id}:${state.revision + 1}`,
			event_type: "MISSION_STATE",
			operation_id: null,
			payload: { ...before.snapshot, revision: state.revision + 1, phase: "VERIFIED_COMPLETE" },
		});
		expect(() => f.store.commit(state.revision, { ...state, revision: state.revision + 1 }, [forged])).toThrow(
			"derived only from a validated store commit",
		);
		expect(() =>
			f.store.commit(state.revision, { ...state, revision: state.revision + 1, phase: "VERIFIED_COMPLETE" }, []),
		).toThrow();
		expect(f.store.publicEvents(state.mission_id)).toEqual(before);
	});
	it("does not invent events for history captured before the public protocol", () => {
		const f = fixture();
		const state = f.kernel.state!;
		const db = new DatabaseSync(f.store.databasePath);
		try {
			db.prepare("DELETE FROM records WHERE mission=? AND type='PublicMissionEvent'").run(state.mission_id);
		} finally {
			db.close();
		}
		const page = f.store.publicEvents(state.mission_id);
		expect(page).toMatchObject({
			events: [],
			history_gap: true,
			history_from_revision: null,
			has_more: false,
			next_revision: state.revision,
			snapshot: { revision: state.revision, phase: state.phase },
		});
		expect(f.store.load(state.mission_id)).toEqual(state);
	});
	it("bounds obligation views without hiding the count and rejects invalid cursors", () => {
		const f = fixture(
			`padma: ${JSON.stringify({
				objective: "inspect behavior",
				requirements: Array.from({ length: 70 }, (_, index) => ({
					text: `PRIVATE_REQUIREMENT_${index}`,
					rule: "SEMANTIC",
					target: "parser.txt",
				})),
			})}`,
		);
		const state = f.kernel.state!;
		const snapshot = f.store.publicSnapshot(state.mission_id);
		expect(snapshot.remaining).toHaveLength(32);
		expect(snapshot.remaining_omitted).toBe(38);
		expect(snapshot.progress.mandatory).toBe(70);
		expect(isPublicMissionSnapshot(snapshot)).toBe(true);
		expect(JSON.stringify(snapshot).includes("PRIVATE_REQUIREMENT")).toBe(false);
		for (const cursor of [-1, 0.5, Number.NaN, state.revision + 1])
			expect(() => f.store.publicEvents(state.mission_id, cursor)).toThrow("cursor");
		for (const limit of [0, 65, Number.NaN])
			expect(() => f.store.publicEvents(state.mission_id, 0, limit)).toThrow("bounded");
	});
});
