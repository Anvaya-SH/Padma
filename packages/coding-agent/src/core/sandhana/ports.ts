import { type Failure, SandhanaError } from "./errors.ts";
import type { MissionState, RecordOf } from "./records.ts";

export type LaterPort =
	| "context"
	| "repository_graph"
	| "structural_edit"
	| "investigation"
	| "scene_action"
	| "ui_source_mapping"
	| "rehearsal"
	| "cyber_policy"
	| "plugins"
	| "contributors"
	| "verified_memory"
	| "timeline_rsi"
	| "client_projection";
export type PortResult<T> =
	| { status: "AVAILABLE"; value: T }
	| { status: "UNAVAILABLE"; port: LaterPort; reason: string; failure: Failure };
/** Later capabilities return proposals/evidence only. None receives a primitive executor. */
export interface SandhanaPort<Request, Response> {
	request(input: Request, position: Readonly<MissionState>): Promise<PortResult<Response>>;
}
export function unavailablePort<Request, Response>(port: LaterPort): SandhanaPort<Request, Response> {
	return {
		request: async () => ({
			status: "UNAVAILABLE",
			port,
			reason: "Capability not mounted in Phase 2; no action dispatched",
			failure: new SandhanaError("UNAVAILABLE_CAPABILITY", "Capability not mounted in Phase 2; no action dispatched")
				.failure,
		}),
	};
}
export interface IntersectingProductPolicy {
	mode: "padma_cyber";
	version: string;
	permits(action: Readonly<RecordOf<"PreparedAction">>, position: Readonly<MissionState>): boolean;
}
export function requestProductMode(
	mode: "padma_code" | "padma_cyber",
	state: Readonly<MissionState>,
): PortResult<Readonly<MissionState>> {
	return mode === "padma_code"
		? { status: "AVAILABLE", value: state }
		: {
				status: "UNAVAILABLE",
				port: "cyber_policy",
				reason: "Padma Cyber policy is not implemented; mission identity, budget and authorization unchanged",
				failure: new SandhanaError(
					"UNAVAILABLE_CAPABILITY",
					"Padma Cyber policy is not implemented; mission identity, budget and authorization unchanged",
				).failure,
			};
}
