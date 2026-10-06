import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@anvaya.sh/padma-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { SandhanaKernel } from "../../src/core/sandhana/kernel.ts";
import type { PublicMissionEventPage, RpcMissionEvent } from "../../src/core/sandhana/public-protocol.ts";
import { digest } from "../../src/core/sandhana/records.ts";
import { createBashTool, createWriteTool } from "../../src/core/tools/index.ts";
import { RpcClient } from "../../src/modes/rpc/rpc-client.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import type { RpcResponse } from "../../src/modes/rpc/rpc-types.ts";
import { createHarness } from "./harness.ts";

const io = vi.hoisted(() => ({ lines: [] as string[], onLine: undefined as ((line: string) => void) | undefined }));
vi.mock("../../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		io.lines.push(line);
	},
}));
vi.mock("../../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, handler: (line: string) => void) => {
		io.onLine = handler;
		return () => {
			io.onLine = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));
afterEach(() => {
	io.lines = [];
	io.onLine = undefined;
});

describe("actual session RPC mission projection", () => {
	it("submits exact approval through the actual RPC prompt and returns backend completion without inference", async () => {
		const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
		type Listener = Parameters<typeof process.on>[1];
		const stdinListeners = process.stdin.listeners("end") as Listener[];
		const signalListeners = new Map(signals.map((signal) => [signal, process.listeners(signal) as Listener[]]));
		const harness = await createHarness();
		const runtime = {
			session: harness.session,
			setRebindSession: vi.fn(),
			dispose: vi.fn(async () => {}),
		} as unknown as AgentSessionRuntime;
		try {
			void runRpcMode(runtime);
			await vi.waitFor(() => expect(io.onLine).toBeDefined());
			let sequence = 0;
			const send = async (command: object): Promise<RpcResponse> => {
				const id = `approval-${++sequence}`;
				io.onLine!(JSON.stringify({ id, ...command }));
				let response: RpcResponse | undefined;
				await vi.waitFor(() => {
					response = io.lines
						.map((line) => JSON.parse(line) as RpcResponse)
						.find((value) => value.type === "response" && value.id === id);
					expect(response).toBeDefined();
				});
				return response!;
			};
			const client = new RpcClient();
			(client as unknown as { send(command: object): Promise<RpcResponse> }).send = send;
			expect(await client.getState()).toMatchObject({ mission: null });
			const path = join(harness.tempDir, "approved.txt");
			writeFileSync(path, "old");
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path: "approved.txt", content: "new" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("This provider response must remain unused"),
			]);
			await client.prompt(
				`padma: ${JSON.stringify({
					objective: "Deliver exact bytes",
					requirements: [{ text: "Bytes are new", rule: "CONTENT", target: "approved.txt", expected: "new" }],
				})}`,
			);
			await vi.waitFor(() => expect(harness.session.sandhana.terminal?.status).toBe("BLOCKED"));
			const kernel = harness.session.sandhana;
			const before = kernel.state!;
			expect(await client.getState()).toMatchObject({
				mission: { phase: "BLOCKED", terminal: { status: "BLOCKED" } },
			});
			const view = await client.getMissionAuthorization(before.mission_id);
			const request = view.request!;
			expect(await client.authorizeMissionAction(view)).toBe("started");
			await vi.waitFor(() => expect(kernel.terminal?.status).toBe("VERIFIED_COMPLETE"));
			expect(readFileSync(path, "utf8")).toBe("new");
			expect(kernel.state!.used.execution).toBe(1);
			expect(kernel.state!.used.ticks).toBe(1);
			expect(kernel.state!.started_at).toBe(before.started_at);
			expect(await client.getState()).toMatchObject({
				mission: { phase: "VERIFIED_COMPLETE", terminal: { status: "VERIFIED_COMPLETE", remaining: 0 } },
			});
			expect(await client.getMissionAuthorization(before.mission_id)).toMatchObject({ request: null });
			const settled = kernel.state!;
			await client.authorizeMissionAction(view);
			await vi.waitFor(() => expect(harness.eventsOfType("agent_end")).toHaveLength(3));
			expect(kernel.state).toEqual(settled);
			expect(readFileSync(path, "utf8")).toBe("new");
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(request.effect.postimage_digest).toBe(digest(Buffer.from("new")));
		} finally {
			harness.cleanup();
			for (const listener of process.stdin.listeners("end") as Listener[])
				if (!stdinListeners.includes(listener)) process.stdin.off("end", listener);
			for (const signal of signals)
				for (const listener of process.listeners(signal) as Listener[])
					if (!signalListeners.get(signal)!.includes(listener)) process.off(signal, listener);
		}
	});
	it("validates bounded authorization views without treating a preview as a grant", async () => {
		const harness = await createHarness();
		try {
			const kernel = harness.session.sandhana;
			kernel.captureInput("Read source.txt", "USER");
			kernel.begin("");
			await expect(
				kernel.prepareOperation("bash", "denied-preview", {
					command: "node private.cjs api_key=private-view-secret",
				}),
			).rejects.toMatchObject({ failure: { code: "AUTHORIZATION_REQUIRED" } });
			const state = kernel.state!;
			const view = kernel.store.publicAuthorization(state.mission_id);
			const request = view.request!;
			const client = new RpcClient();
			const privateClient = client as unknown as { send(command: object): Promise<RpcResponse> };
			const send = vi.fn(
				async (): Promise<RpcResponse> => ({
					type: "response",
					command: "get_mission_authorization",
					success: true,
					data: view,
				}),
			);
			privateClient.send = send;
			expect(await client.getMissionAuthorization(state.mission_id)).toEqual(view);
			expect(send).toHaveBeenCalledWith({ type: "get_mission_authorization", missionId: state.mission_id });
			const malformed: unknown[] = [
				{ ...view, mission_id: "another-mission" },
				{ ...view, arguments: { token: "private-extra" } },
				{ ...view, request: { ...request, arguments: { token: "private-extra" } } },
				{ ...view, revision: request.evaluated_revision },
				{ ...view, request: { ...request, prepared_revision: request.evaluated_revision + 1 } },
				{ ...view, request: { ...request, intent_epoch: 0 } },
				{ ...view, request: { ...request, arguments_omitted: false } },
				{ ...view, request: { ...request, requires_repreparation: false } },
				{ ...view, request: { ...request, response: "AUTO_APPROVE" } },
				{ ...view, request: { ...request, effect: { ...request.effect, kind: "OBSERVATION" } } },
				{ ...view, request: { ...request, effect: { ...request.effect, postimage_digest: "private" } } },
			];
			for (const candidate of malformed) {
				privateClient.send = vi.fn(
					async () =>
						({
							type: "response",
							command: "get_mission_authorization",
							success: true,
							data: candidate,
						}) as RpcResponse,
				);
				await expect(client.getMissionAuthorization(state.mission_id)).rejects.toThrow(
					"public mission authorization",
				);
			}
			privateClient.send = vi.fn(
				async (): Promise<RpcResponse> => ({
					type: "response",
					command: "get_mission_authorization",
					success: true,
					data: { ...view, request: null },
				}),
			);
			expect(await client.getMissionAuthorization(state.mission_id)).toEqual({ ...view, request: null });
			expect(kernel.state).toEqual(state);
			expect(state.used.execution).toBe(0);
			expect(state.operations).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});
	it("rejects malformed replay pages before returning untrusted client state", async () => {
		const harness = await createHarness();
		try {
			const kernel = harness.session.sandhana;
			kernel.captureInput("Read source.txt", "USER");
			kernel.begin("");
			for (let index = 0; index < 4; index++) {
				const current = kernel.state!;
				kernel.store.commit(current.revision, { ...current, revision: current.revision + 1 }, []);
			}
			const state = kernel.state!;
			const cursor = state.revision - 3;
			const page = kernel.store.publicEvents(state.mission_id, cursor, 3);
			const [first, second, last] = page.events;
			const malformed: [string, unknown][] = [
				["private snapshot property", { ...page, snapshot: { ...page.snapshot, source: "PRIVATE_CLIENT_BYTES" } }],
				[
					"private event property",
					{ ...page, events: [{ ...first, arguments: { token: "PRIVATE_CLIENT_SECRET" } }] },
				],
				["wrong record type", { ...page, events: [{ ...first, record_type: "TerminalReport" }] }],
				["foreign snapshot", { ...page, snapshot: { ...page.snapshot, mission_id: "foreign" } }],
				["snapshot invents a verdict", { ...page, snapshot: { ...page.snapshot, phase: "VERIFIED_COMPLETE" } }],
				[
					"duplicate record identity",
					{ ...page, events: [first, { ...second, record_id: first.record_id }, last] },
				],
				["foreign event", { ...page, events: [{ ...first, mission_id: "foreign" }, second, last] }],
				[
					"foreign payload",
					{ ...page, events: [{ ...first, payload: { ...first.payload, mission_id: "foreign" } }, second, last] },
				],
				["fabricated event ID", { ...page, events: [{ ...first, event_id: "invented" }, second, last] }],
				[
					"mismatched payload revision",
					{
						...page,
						events: [{ ...first, payload: { ...first.payload, revision: first.revision + 1 } }, second, last],
					},
				],
				["unordered events", { ...page, events: [...page.events].reverse() }],
				["duplicate event", { ...page, events: [first, first, last] }],
				["already consumed revision", { ...page, events: [{ ...first, revision: cursor }, second, last] }],
				["future snapshot", { ...page, snapshot: { ...page.snapshot, revision: cursor - 1 } }],
				["future event", { ...page, snapshot: { ...page.snapshot, revision: second.revision } }],
				["unsafe cursor", { ...page, next_revision: Number.MAX_SAFE_INTEGER + 1 }],
				["cursor hides history", { ...page, next_revision: cursor }],
				["unreported hole", { ...page, events: [first, last] }],
				["invented history gap", { ...page, history_gap: true }],
				["missing history floor", { ...page, history_from_revision: null }],
				["future history floor", { ...page, history_from_revision: state.revision + 1 }],
				["floor hides an event", { ...page, history_from_revision: second.revision }],
				["more beyond snapshot", { ...page, has_more: true }],
				["more without events", { ...page, events: [], has_more: true }],
			];
			const client = new RpcClient();
			const privateClient = client as unknown as { send(command: object): Promise<RpcResponse> };
			for (const [reason, candidate] of malformed) {
				privateClient.send = vi.fn(
					async () =>
						({
							type: "response",
							command: "get_mission_events",
							success: true,
							data: candidate,
						}) as RpcResponse,
				);
				await expect(client.getMissionEvents(state.mission_id, cursor, 3), reason).rejects.toThrow(
					"public mission event page",
				);
			}
			privateClient.send = vi.fn(
				async (): Promise<RpcResponse> => ({
					type: "response",
					command: "get_mission_events",
					success: true,
					data: page,
				}),
			);
			await expect(client.getMissionEvents(state.mission_id, cursor, 1)).rejects.toThrow(
				"public mission event page",
			);
			privateClient.send = vi.fn(
				async () =>
					({ type: "response", command: "get_state", success: true, data: page }) as unknown as RpcResponse,
			);
			await expect(client.getMissionEvents(state.mission_id, cursor, 3)).rejects.toThrow(
				"public mission event page",
			);
			expect(kernel.state).toEqual(state);
			expect(state.used.execution).toBe(0);
		} finally {
			harness.cleanup();
		}
	});
	it("accepts bounded pages and explicit gaps without consuming live event delivery", async () => {
		const harness = await createHarness();
		try {
			const kernel = harness.session.sandhana;
			kernel.captureInput("Read source.txt", "USER");
			kernel.begin("");
			for (let index = 0; index < 4; index++) {
				const current = kernel.state!;
				kernel.store.commit(current.revision, { ...current, revision: current.revision + 1 }, []);
			}
			const state = kernel.state!;
			const cursor = state.revision - 3;
			const first = kernel.store.publicEvents(state.mission_id, cursor, 1);
			const final = kernel.store.publicEvents(state.mission_id, first.next_revision, 3);
			const gap: PublicMissionEventPage = { ...final, events: final.events.slice(1), history_gap: true };
			const tail: PublicMissionEventPage = { ...final, events: final.events.slice(0, 1), history_gap: true };
			const unavailable: PublicMissionEventPage = {
				...final,
				events: [],
				history_gap: true,
				history_from_revision: null,
			};
			const caughtUp = kernel.store.publicEvents(state.mission_id, state.revision, 3);
			const client = new RpcClient();
			const privateClient = client as unknown as {
				handleLine(line: string): void;
				send(command: object): Promise<RpcResponse>;
			};
			const delivered = vi.fn();
			client.onMissionEvent(delivered);
			for (const [afterRevision, page] of [
				[cursor, first],
				[first.next_revision, final],
				[first.next_revision, gap],
				[first.next_revision, tail],
				[first.next_revision, unavailable],
				[state.revision, caughtUp],
			] as const) {
				privateClient.send = vi.fn(
					async (): Promise<RpcResponse> => ({
						type: "response",
						command: "get_mission_events",
						success: true,
						data: page,
					}),
				);
				expect(await client.getMissionEvents(state.mission_id, afterRevision, 3)).toEqual(page);
			}
			expect(delivered).not.toHaveBeenCalled();
			const event: RpcMissionEvent = {
				type: "sandhana_event",
				event_id: `${state.mission_id}:${state.revision}`,
				event_type: "MISSION_STATE",
				mission_id: state.mission_id,
				revision: state.revision,
				operation_id: null,
				payload: final.snapshot,
			};
			privateClient.handleLine(JSON.stringify(event));
			privateClient.handleLine(JSON.stringify(event));
			expect(delivered).toHaveBeenCalledTimes(1);
			const send = vi.fn(
				async (): Promise<RpcResponse> => ({
					type: "response",
					command: "get_mission_events",
					success: true,
					data: caughtUp,
				}),
			);
			privateClient.send = send;
			for (const invalid of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
				await expect(client.getMissionEvents(state.mission_id, invalid, 3)).rejects.toThrow("page request");
			for (const invalid of [0, 65, Number.NaN])
				await expect(client.getMissionEvents(state.mission_id, cursor, invalid)).rejects.toThrow("page request");
			await expect(client.getMissionEvents("", cursor, 3)).rejects.toThrow("page request");
			expect(send).not.toHaveBeenCalled();
			expect(kernel.state).toEqual(state);
			expect(state.used.execution).toBe(0);
		} finally {
			harness.cleanup();
		}
	});
	it("publishes committed state, reconnects from a cursor, and rejects another session's mission", async () => {
		const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
		type Listener = Parameters<typeof process.on>[1];
		const stdinListeners = process.stdin.listeners("end") as Listener[];
		const signalListeners = new Map(signals.map((signal) => [signal, process.listeners(signal) as Listener[]]));
		const harness = await createHarness();
		const runtime = {
			session: harness.session,
			setRebindSession: vi.fn(),
			dispose: vi.fn(async () => {}),
		} as unknown as AgentSessionRuntime;
		try {
			void runRpcMode(runtime);
			await vi.waitFor(() => expect(io.onLine).toBeDefined());
			const request = async (id: string, command: object): Promise<RpcResponse> => {
				io.onLine!(JSON.stringify({ id, ...command }));
				let response: RpcResponse | undefined;
				await vi.waitFor(() => {
					response = io.lines
						.map((line) => JSON.parse(line) as RpcResponse)
						.find((value) => value.type === "response" && value.id === id);
					expect(response).toBeDefined();
				});
				return response!;
			};
			const empty = await request("empty", { type: "get_state" });
			expect(empty).toMatchObject({ success: true, data: { mission: null } });
			const path = join(harness.tempDir, "source.txt");
			writeFileSync(path, "PRIVATE_RPC_CONTENT api_key=private-rpc-secret");
			harness.setResponses([fauxAssistantMessage("Unused provider response")]);
			await request("read", { type: "prompt", message: `Read "${path}"` });
			await vi.waitFor(() => expect(harness.session.sandhana.terminal?.status).toBe("VERIFIED_COMPLETE"));
			const stateResponse = await request("state", { type: "get_state" });
			expect(stateResponse.success).toBe(true);
			const state = (stateResponse as Extract<RpcResponse, { command: "get_state"; success: true }>).data;
			expect(state.mission).toMatchObject({ phase: "VERIFIED_COMPLETE", used: { execution: 1 } });
			const mission = state.mission!;
			const streamed = io.lines
				.map((line) => JSON.parse(line) as RpcMissionEvent)
				.filter((value) => value.type === "sandhana_event");
			expect(streamed.at(-1)?.payload).toEqual(mission);
			expect(streamed.every((event) => event.event_id === `${mission.mission_id}:${event.revision}`)).toBe(true);
			expect(JSON.stringify(streamed).includes("PRIVATE_RPC_CONTENT")).toBe(false);
			expect(JSON.stringify(state.mission).includes("private-rpc-secret")).toBe(false);
			const before = harness.session.sandhana.state!;
			const pageResponse = await request("events", {
				type: "get_mission_events",
				missionId: mission.mission_id,
				afterRevision: mission.revision - 1,
				limit: 1,
			});
			const page = (pageResponse as Extract<RpcResponse, { command: "get_mission_events"; success: true }>).data;
			expect(page).toMatchObject({ snapshot: mission, has_more: false, next_revision: mission.revision });
			expect(page.events).toHaveLength(1);
			expect(page.events[0].payload).toEqual(mission);
			const duplicate = await request("duplicate", {
				type: "get_mission_events",
				missionId: mission.mission_id,
				afterRevision: mission.revision - 1,
				limit: 1,
			});
			expect(duplicate).toMatchObject({ success: true, data: page });
			const foreign = new SandhanaKernel({
				cwd: () => harness.tempDir,
				session: () => "foreign-session",
				store: harness.session.sandhana.store,
			});
			foreign.captureInput("Read source.txt", "USER");
			foreign.begin("");
			expect(
				await request("foreign", { type: "get_mission_events", missionId: foreign.state!.mission_id }),
			).toMatchObject({ success: false, error: "Mission belongs to a different session" });
			expect(
				await request("foreign-authorization", {
					type: "get_mission_authorization",
					missionId: foreign.state!.mission_id,
				}),
			).toMatchObject({ success: false, error: "Mission belongs to a different session" });
			const awaiting = new SandhanaKernel({
				cwd: () => harness.tempDir,
				session: () => harness.session.sessionId,
				store: harness.session.sandhana.store,
			});
			awaiting.register(createBashTool(harness.tempDir), "bash");
			awaiting.captureInput("Read source.txt", "USER");
			awaiting.begin("");
			await expect(
				awaiting.prepareOperation("bash", "rpc-private-denial", {
					command: "node private.cjs api_key=private-rpc-approval-secret",
				}),
			).rejects.toMatchObject({ failure: { code: "AUTHORIZATION_REQUIRED" } });
			const awaitingState = awaiting.state!;
			const authorization = await request("authorization", {
				type: "get_mission_authorization",
				missionId: awaitingState.mission_id,
			});
			expect(authorization).toMatchObject({
				success: true,
				data: {
					mission_id: awaitingState.mission_id,
					revision: awaitingState.revision,
					request: {
						action: { tool_id: "bash", kind: "PROCESS" },
						effect: { kind: "OPAQUE_PROCESS", side_effect: true },
						requires_repreparation: true,
					},
				},
			});
			expect(JSON.stringify(authorization)).not.toContain("private-rpc-approval-secret");
			expect(
				await request("authorization-again", {
					type: "get_mission_authorization",
					missionId: awaitingState.mission_id,
				}),
			).toMatchObject({
				success: true,
				data: authorization.success && "data" in authorization ? authorization.data : undefined,
			});
			expect(awaiting.state).toEqual(awaitingState);
			expect(awaitingState.used.execution).toBe(0);
			awaiting.register(createWriteTool(harness.tempDir), "write");
			const replacement = "PRIVATE_RPC_REPLACEMENT api_key=private-rpc-edit-secret";
			await expect(
				awaiting.prepareOperation("write", "rpc-private-edit-denial", { path: "source.txt", content: replacement }),
			).rejects.toMatchObject({ failure: { code: "AUTHORIZATION_REQUIRED" } });
			const deniedEdit = awaiting.state!;
			const editAuthorization = await request("edit-authorization", {
				type: "get_mission_authorization",
				missionId: deniedEdit.mission_id,
			});
			expect(editAuthorization).toMatchObject({
				success: true,
				data: {
					revision: deniedEdit.revision,
					request: {
						action: { tool_id: "write", kind: "EDIT" },
						effect: { kind: "FILE_REPLACEMENT", postimage_digest: digest(Buffer.from(replacement)) },
					},
				},
			});
			for (const privateText of [
				"PRIVATE_RPC_CONTENT",
				"PRIVATE_RPC_REPLACEMENT",
				"private-rpc-edit-secret",
				"source.txt",
				harness.tempDir,
			])
				expect(JSON.stringify(editAuthorization)).not.toContain(privateText);
			const editClient = new RpcClient();
			const privateEditClient = editClient as unknown as { send(command: object): Promise<RpcResponse> };
			privateEditClient.send = vi.fn(async (): Promise<RpcResponse> => editAuthorization);
			expect(await editClient.getMissionAuthorization(deniedEdit.mission_id)).toEqual(
				(editAuthorization as Extract<RpcResponse, { command: "get_mission_authorization"; success: true }>).data,
			);
			expect(awaiting.state).toEqual(deniedEdit);
			expect(deniedEdit.checkpoints).toEqual([]);
			expect(deniedEdit.operations).toEqual([]);
			expect(deniedEdit.used.execution).toBe(0);
			expect(deniedEdit.used.artifact_bytes).toBe(0);
			expect(readFileSync(path, "utf8")).toBe("PRIVATE_RPC_CONTENT api_key=private-rpc-secret");
			awaiting.amend("Use a different target");
			expect(
				await request("stale-authorization", {
					type: "get_mission_authorization",
					missionId: awaitingState.mission_id,
				}),
			).toMatchObject({ success: true, data: { request: null } });
			expect(
				await request("bad-limit", { type: "get_mission_events", missionId: mission.mission_id, limit: 65 }),
			).toMatchObject({ success: false, error: expect.stringContaining("bounded") });
			expect(harness.session.sandhana.state).toEqual(before);
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			harness.cleanup();
			for (const listener of process.stdin.listeners("end") as Listener[])
				if (!stdinListeners.includes(listener)) process.stdin.off("end", listener);
			for (const signal of signals)
				for (const listener of process.listeners(signal) as Listener[])
					if (!signalListeners.get(signal)!.includes(listener)) process.off(signal, listener);
		}
	});
	it("keeps committed events separate from provider events and suppresses duplicate or older snapshots", async () => {
		const harness = await createHarness();
		try {
			harness.session.sandhana.captureInput("Read source.txt", "USER");
			harness.session.sandhana.begin("");
			const snapshot = harness.session.sandhana.store.publicSnapshot(harness.session.sandhana.state!.mission_id);
			const client = new RpcClient();
			const privateClient = client as unknown as {
				handleLine(line: string): void;
				send(command: object): Promise<RpcResponse>;
			};
			const provider = vi.fn();
			const missionEvents = vi.fn();
			client.onEvent(provider);
			client.onMissionEvent(missionEvents);
			const event: RpcMissionEvent = {
				type: "sandhana_event",
				event_type: "MISSION_STATE",
				operation_id: null,
				event_id: `${snapshot.mission_id}:${snapshot.revision}`,
				mission_id: snapshot.mission_id,
				revision: snapshot.revision,
				payload: snapshot,
			};
			privateClient.handleLine(JSON.stringify(event));
			privateClient.handleLine(JSON.stringify(event));
			privateClient.handleLine(JSON.stringify({ ...event, revision: snapshot.revision + 1 }));
			privateClient.handleLine(
				JSON.stringify({
					...event,
					revision: 0,
					event_id: `${snapshot.mission_id}:0`,
					payload: { ...snapshot, revision: 0 },
				}),
			);
			privateClient.handleLine(JSON.stringify({ type: "agent_settled" }));
			expect(missionEvents).toHaveBeenCalledTimes(1);
			expect(missionEvents).toHaveBeenCalledWith(event);
			expect(provider).toHaveBeenCalledTimes(1);
			expect(provider).toHaveBeenCalledWith({ type: "agent_settled" });
			const page: PublicMissionEventPage = {
				snapshot,
				events: [],
				next_revision: snapshot.revision,
				has_more: false,
				history_from_revision: 1,
				history_gap: false,
			};
			const send = vi.fn(
				async (): Promise<RpcResponse> => ({
					type: "response",
					command: "get_mission_events",
					success: true,
					data: page,
				}),
			);
			privateClient.send = send;
			expect(await client.getMissionEvents(snapshot.mission_id, snapshot.revision, 4)).toEqual(page);
			expect(send).toHaveBeenCalledWith({
				type: "get_mission_events",
				missionId: snapshot.mission_id,
				afterRevision: snapshot.revision,
				limit: 4,
			});
		} finally {
			harness.cleanup();
		}
	});
});
