import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PublicMissionSnapshot } from "../../src/core/sandhana/public-protocol.ts";
import { RpcClient } from "../../src/modes/rpc/rpc-client.ts";
import type { RpcResponse, RpcSessionState } from "../../src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness } from "./harness.ts";

let harness: Harness;
let active: PublicMissionSnapshot;
let stopped: PublicMissionSnapshot;
let session: RpcSessionState;
beforeAll(async () => {
	harness = await createHarness();
	const kernel = harness.session.sandhana;
	kernel.captureInput("Inspect the parser behavior", "USER");
	kernel.begin("");
	active = kernel.store.publicSnapshot(kernel.state!.mission_id);
	kernel.finalize("PARTIALLY_COMPLETE");
	stopped = kernel.store.publicSnapshot(kernel.state!.mission_id);
	session = {
		mission: active,
		model: harness.getModel(),
		thinkingLevel: harness.session.thinkingLevel,
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		sessionId: harness.session.sessionId,
		autoCompactionEnabled: true,
		messageCount: 0,
		pendingMessageCount: 0,
	};
});
afterAll(() => harness?.cleanup());

const malformed: [string, (snapshot: PublicMissionSnapshot) => unknown][] = [
	["private source", (snapshot) => ({ ...snapshot, source: "PRIVATE_RPC_SNAPSHOT_BYTES" })],
	["unsafe revision", (snapshot) => ({ ...snapshot, revision: Number.MAX_SAFE_INTEGER + 1 })],
	["invented terminal phase", (snapshot) => ({ ...snapshot, phase: "VERIFIED_COMPLETE" })],
	["inconsistent terminal status", (snapshot) => ({ ...snapshot, terminal: stopped.terminal })],
	[
		"impossible verified count",
		(snapshot) => ({ ...snapshot, progress: { ...snapshot.progress, verified: snapshot.progress.mandatory + 1 } }),
	],
	["missing remaining obligation", (snapshot) => ({ ...snapshot, remaining: [] })],
	[
		"duplicate obligation",
		(snapshot) => ({
			...snapshot,
			progress: { ...snapshot.progress, mandatory: 2 },
			remaining: [snapshot.remaining[0], snapshot.remaining[0]],
		}),
	],
	[
		"private obligation status",
		(snapshot) => ({
			...snapshot,
			remaining: [{ ...snapshot.remaining[0], status: "api_key=PRIVATE_STATUS_SECRET" }],
		}),
	],
	[
		"future operation",
		(snapshot) => ({
			...snapshot,
			current_operations: [
				{
					operation_id: "pending",
					status: "IN_PROGRESS",
					prepared_revision: snapshot.revision + 1,
					target_binding_ref: "binding",
					action_digest: "digest",
				},
			],
		}),
	],
	[
		"future authorization",
		(snapshot) => ({
			...snapshot,
			authorization_request: {
				decision_ref: "decision",
				operation_id: "pending",
				action_digest: "digest",
				target_binding_ref: "binding",
				evaluated_revision: snapshot.revision,
			},
		}),
	],
	["negative reservation", (snapshot) => ({ ...snapshot, reserved: { ...snapshot.reserved, input_tokens: -1 } })],
	[
		"duplicate operation",
		(snapshot) => {
			const operation = {
				operation_id: "pending",
				status: "NOT_STARTED",
				prepared_revision: 1,
				target_binding_ref: "binding",
				action_digest: "digest",
			};
			return { ...snapshot, current_operations: [operation, operation] };
		},
	],
	[
		"authorization for another action",
		(snapshot) => ({
			...snapshot,
			current_operations: [
				{
					operation_id: "pending",
					status: "NOT_STARTED",
					prepared_revision: 1,
					target_binding_ref: "binding",
					action_digest: "original",
				},
			],
			authorization_request: {
				decision_ref: "decision",
				operation_id: "pending",
				action_digest: "changed",
				target_binding_ref: "binding",
				evaluated_revision: snapshot.revision - 1,
			},
		}),
	],
	[
		"terminal verified count differs from progress",
		(snapshot) => ({ ...stopped, revision: snapshot.revision, terminal: { ...stopped.terminal!, verified: 1 } }),
	],
	[
		"terminal hides a remaining obligation",
		(snapshot) => ({ ...stopped, revision: snapshot.revision, terminal: { ...stopped.terminal!, remaining: 0 } }),
	],
	[
		"verified completion with outstanding obligations",
		(snapshot) => ({
			...stopped,
			revision: snapshot.revision,
			phase: "VERIFIED_COMPLETE",
			terminal: { ...stopped.terminal!, status: "VERIFIED_COMPLETE" },
		}),
	],
	[
		"delivery without limitations",
		(snapshot) => ({
			...stopped,
			revision: snapshot.revision,
			phase: "DELIVERED_UNVERIFIED",
			terminal: { ...stopped.terminal!, status: "DELIVERED_UNVERIFIED", limitations: 0 },
		}),
	],
	[
		"delivery with omitted output",
		(snapshot) => ({
			...stopped,
			revision: snapshot.revision,
			phase: "DELIVERED_UNVERIFIED",
			terminal: { ...stopped.terminal!, status: "DELIVERED_UNVERIFIED", output_omitted: true },
		}),
	],
	[
		"partial completion with an unknown outcome",
		(snapshot) => ({
			...stopped,
			revision: snapshot.revision,
			terminal: { ...stopped.terminal!, unknown_operation: "uncertain" },
		}),
	],
	[
		"verified completion with an operation still running",
		(snapshot) => ({
			...snapshot,
			phase: "VERIFIED_COMPLETE",
			progress: { ...snapshot.progress, verified: snapshot.progress.mandatory },
			remaining: [],
			terminal: {
				...stopped.terminal!,
				status: "VERIFIED_COMPLETE",
				verified: snapshot.progress.mandatory,
				remaining: 0,
			},
			current_operations: [
				{
					operation_id: "pending",
					status: "IN_PROGRESS",
					prepared_revision: 1,
					target_binding_ref: "binding",
					action_digest: "digest",
				},
			],
		}),
	],
	[
		"partial completion with an operation still running",
		(snapshot) => ({
			...stopped,
			revision: snapshot.revision,
			current_operations: [
				{
					operation_id: "pending",
					status: "IN_PROGRESS",
					prepared_revision: 1,
					target_binding_ref: "binding",
					action_digest: "digest",
				},
			],
		}),
	],
	[
		"unknown outcome names another operation",
		(snapshot) => ({
			...stopped,
			revision: snapshot.revision,
			phase: "OUTCOME_UNKNOWN",
			terminal: { ...stopped.terminal!, status: "OUTCOME_UNKNOWN", unknown_operation: "different" },
			current_operations: [
				{
					operation_id: "pending",
					status: "OUTCOME_UNKNOWN",
					prepared_revision: 1,
					target_binding_ref: "binding",
					action_digest: "digest",
				},
			],
		}),
	],
];

describe("public mission snapshot consistency through every RPC client entry", () => {
	it.each(malformed)("rejects %s from getState without changing the mission", async (_name, change) => {
		const client = new RpcClient();
		const privateClient = client as unknown as { send(command: object): Promise<RpcResponse> };
		const before = harness.session.sandhana.state!;
		privateClient.send = vi.fn(
			async () =>
				({
					type: "response",
					command: "get_state",
					success: true,
					data: { ...session, mission: change(active) },
				}) as RpcResponse,
		);
		await expect(client.getState()).rejects.toThrow("mission snapshot");
		expect(harness.session.sandhana.state).toEqual(before);
		expect(harness.faux.state.callCount).toBe(0);
	});
	it.each(malformed)("rejects %s from a replay page even when its history is unavailable", async (_name, change) => {
		const client = new RpcClient();
		const privateClient = client as unknown as { send(command: object): Promise<RpcResponse> };
		privateClient.send = vi.fn(
			async () =>
				({
					type: "response",
					command: "get_mission_events",
					success: true,
					data: {
						snapshot: change(active),
						events: [],
						next_revision: active.revision,
						has_more: false,
						history_from_revision: null,
						history_gap: true,
					},
				}) as RpcResponse,
		);
		await expect(client.getMissionEvents(active.mission_id)).rejects.toThrow("public mission event page");
	});
	it.each(malformed)("discards %s live events without consuming the valid revision", (_name, change) => {
		const client = new RpcClient();
		const privateClient = client as unknown as { handleLine(line: string): void };
		const received = vi.fn();
		client.onMissionEvent(received);
		const event = {
			type: "sandhana_event",
			event_type: "MISSION_STATE",
			event_id: `${active.mission_id}:${active.revision}`,
			mission_id: active.mission_id,
			revision: active.revision,
			operation_id: null,
			payload: active,
		};
		privateClient.handleLine(JSON.stringify({ ...event, payload: change(active) }));
		expect(received).not.toHaveBeenCalled();
		privateClient.handleLine(JSON.stringify(event));
		privateClient.handleLine(JSON.stringify(event));
		expect(received).toHaveBeenCalledTimes(1);
	});
	it("rejects a contradictory historical payload even when the page snapshot is valid", async () => {
		const kernel = harness.session.sandhana;
		const page = kernel.store.publicEvents(stopped.mission_id, 0, 64);
		const client = new RpcClient();
		const privateClient = client as unknown as { send(command: object): Promise<RpcResponse> };
		const first = page.events[0];
		const events = [{ ...first, payload: { ...first.payload, phase: "VERIFIED_COMPLETE" } }, ...page.events.slice(1)];
		privateClient.send = vi.fn(
			async () =>
				({
					type: "response",
					command: "get_mission_events",
					success: true,
					data: { ...page, events },
				}) as RpcResponse,
		);
		await expect(client.getMissionEvents(stopped.mission_id, 0, 64)).rejects.toThrow("public mission event page");
		privateClient.send = vi.fn(
			async (): Promise<RpcResponse> => ({
				type: "response",
				command: "get_mission_events",
				success: true,
				data: page,
			}),
		);
		expect(await client.getMissionEvents(stopped.mission_id, 0, 64)).toEqual(page);
	});
	it("accepts actual active, stopped and absent mission views without consuming live delivery", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as {
			send(command: object): Promise<RpcResponse>;
			handleLine(line: string): void;
		};
		const received = vi.fn();
		client.onMissionEvent(received);
		for (const mission of [null, active, stopped]) {
			privateClient.send = vi.fn(
				async (): Promise<RpcResponse> => ({
					type: "response",
					command: "get_state",
					success: true,
					data: { ...session, mission },
				}),
			);
			expect(await client.getState()).toEqual({ ...session, mission });
		}
		expect(received).not.toHaveBeenCalled();
		privateClient.handleLine(
			JSON.stringify({
				type: "sandhana_event",
				event_type: "MISSION_STATE",
				event_id: `${active.mission_id}:${active.revision}`,
				mission_id: active.mission_id,
				revision: active.revision,
				operation_id: null,
				payload: active,
			}),
		);
		expect(received).toHaveBeenCalledTimes(1);
	});
	it("accepts an uncertain operation reference outside the bounded operation list", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as { send(command: object): Promise<RpcResponse> };
		const mission: PublicMissionSnapshot = {
			...stopped,
			phase: "OUTCOME_UNKNOWN",
			current_operations: Array.from({ length: 4 }, (_, index) => ({
				operation_id: `visible-${index}`,
				status: "OUTCOME_UNKNOWN",
				prepared_revision: 1,
				target_binding_ref: "binding",
				action_digest: "digest",
			})),
			operations_omitted: 1,
			terminal: { ...stopped.terminal!, status: "OUTCOME_UNKNOWN", unknown_operation: "omitted" },
		};
		privateClient.send = vi.fn(
			async (): Promise<RpcResponse> => ({
				type: "response",
				command: "get_state",
				success: true,
				data: { ...session, mission },
			}),
		);
		expect((await client.getState()).mission).toEqual(mission);
	});
	it("rejects missing mission fields and responses to another command", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as { send(command: object): Promise<RpcResponse> };
		for (const data of [undefined, null, {}, []]) {
			privateClient.send = vi.fn(
				async () => ({ type: "response", command: "get_state", success: true, data }) as RpcResponse,
			);
			await expect(client.getState()).rejects.toThrow("mission snapshot");
		}
		privateClient.send = vi.fn(
			async () =>
				({
					type: "response",
					command: "get_mission_events",
					success: true,
					data: session,
				}) as unknown as RpcResponse,
		);
		await expect(client.getState()).rejects.toThrow("mission snapshot");
	});
});
