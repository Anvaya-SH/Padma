import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@anvaya.sh/padma-agent-core";
import { ContextError } from "../avartana/contracts.ts";
import { assemblePacket, buildCapsule, type Capsule, missionPosition, validateCapsule } from "../avartana/position.ts";
import type { SandhanaKernel } from "../kernel.ts";
import { canonical, digest } from "../records.ts";

export interface PinRecord {
	pinId: string;
	missionId: string;
	revision: number;
	kind: "exact_ref" | "derived_note";
	locator: string;
	reason: string;
	createdAt: number;
	bytes: number;
}

export interface SarasangrahaStatus {
	pressure: number;
	latestCapsule: { id: string; revision: number; at: number } | null;
	staleDependencies: { sourceId: string; reason: string }[];
	protectedHealth: "HEALTHY" | "CORRUPT";
	recoverable: boolean;
	pins: number;
	pinBytes: number;
}

const MAX_PINS = 16;
const MAX_PIN_BYTES = 8 * 1024;
const MAX_TOTAL_PIN_BYTES = 64 * 1024;

/** Faithful compaction and reconstruction. Protected state always comes from authority, never from prose. */
export class SarasangrahaService {
	private kernel: SandhanaKernel;
	private pins = new Map<string, PinRecord[]>();
	private lastExplain = new Map<
		string,
		{ kept: string[]; externalized: string[]; summarized: string[]; discarded: string[]; at: number }
	>();
	constructor(kernel: SandhanaKernel) {
		this.kernel = kernel;
	}

	compact(): { capsuleId: string; revision: number; protectedDigest: string } {
		const state = this.kernel.state;
		if (!state || !this.kernel.active)
			throw new ContextError("REVISION_CONFLICT", "Compaction requires the active mission");
		const capsule = buildCapsule(this.kernel.store, state);
		validateCapsule(this.kernel.store, state, capsule);
		const id = this.kernel.retainContextProjection("SARASANGRAHA_CAPSULE/1", capsule);
		const pins = this.pins.get(state.mission_id) ?? [];
		this.lastExplain.set(state.mission_id, {
			kept: [
				`requirements:${state.requirements.length}`,
				`prohibitions:${capsule.position.prohibitions.length}`,
				`authorizations:${state.authorizations.length}`,
				`operations:${state.operations.length}`,
				`pins:${pins.length}`,
			],
			externalized: [
				...capsule.position.recentContext.map((ref) => ref.id),
				...capsule.position.pendingVerification.flatMap((req) => req.evidence.map((ref) => ref.id)),
			].slice(0, 12),
			summarized: [`mission:${state.mission_id}@rev${state.revision}`, `route:${state.route}`],
			discarded: ["disposable conversational redundancy", "repeated tool chatter", "unverified model prose"],
			at: Date.now(),
		});
		return { capsuleId: id, revision: state.revision, protectedDigest: capsule.protectedDigest };
	}

	restore(): { revision: number; requirements: number; stale: string[]; pins: number } {
		const state = this.kernel.state;
		if (!state) throw new ContextError("REVISION_CONFLICT", "Restore requires a loaded mission");
		const refs = this.kernel.store.contextReferences(
			state.mission_id,
			"SARASANGRAHA_CAPSULE/1",
			state.revision,
			true,
		);
		const latest = refs[0];
		const stale: string[] = [];
		if (latest) {
			const event = this.kernel.store.get(state.mission_id, latest, "EvidenceRecord");
			const capsule = event.payload as Capsule;
			try {
				validateCapsule(this.kernel.store, state, capsule);
			} catch {
				stale.push(`capsule:${latest}:protected-state mismatch; authority retained`);
			}
			for (const dep of capsule.position.contextConflicts ?? []) {
				stale.push(`conflict:${dep.ref.id}`);
			}
		}
		const position = missionPosition(this.kernel.store, state);
		for (const req of position.pendingVerification) {
			if (req.recordedStatus === "VERIFIED") continue;
			stale.push(`requirement:${req.id}:revalidate`);
		}
		const pins = (this.pins.get(state.mission_id) ?? []).length;
		return { revision: state.revision, requirements: state.requirements.length, stale: stale.slice(0, 16), pins };
	}

	pin(kind: PinRecord["kind"], locator: string, reason: string): PinRecord {
		const state = this.kernel.state;
		if (!state || !this.kernel.active)
			throw new ContextError("REVISION_CONFLICT", "Pinning requires the active mission");
		if (!locator || locator.length > MAX_PIN_BYTES)
			throw new ContextError("MALFORMED_REQUEST", "Pin locator exceeds 8 KiB bound");
		if (!reason || reason.length > 500)
			throw new ContextError("MALFORMED_REQUEST", "Pin requires a reason up to 500 chars");
		const list = this.pins.get(state.mission_id) ?? [];
		if (list.length >= MAX_PINS) throw new ContextError("CAPACITY", `At most ${MAX_PINS} pins per mission`);
		const total = list.reduce((sum, pin) => sum + pin.bytes, 0) + Buffer.byteLength(locator);
		if (total > MAX_TOTAL_PIN_BYTES) throw new ContextError("CAPACITY", "Pinned bytes exceed 64 KiB mission bound");
		const pin: PinRecord = {
			pinId: `pin_${randomUUID().slice(0, 8)}`,
			missionId: state.mission_id,
			revision: state.revision,
			kind,
			locator,
			reason,
			createdAt: Date.now(),
			bytes: Buffer.byteLength(locator),
		};
		list.push(pin);
		this.pins.set(state.mission_id, list);
		this.kernel.retainContextProjection("SARASANGRAHA_PIN/1", pin);
		return pin;
	}

	unpin(pinId: string): boolean {
		const state = this.kernel.state;
		if (!state) throw new ContextError("REVISION_CONFLICT", "Unpin requires a loaded mission");
		const list = this.pins.get(state.mission_id) ?? [];
		const next = list.filter((pin) => pin.pinId !== pinId);
		if (next.length === list.length) return false;
		this.pins.set(state.mission_id, next);
		this.kernel.retainContextProjection("SARASANGRAHA_UNPIN/1", { pinId, at: Date.now() });
		return true;
	}

	status(): SarasangrahaStatus {
		const state = this.kernel.state;
		if (!state) throw new ContextError("REVISION_CONFLICT", "Status requires a loaded mission");
		const refs = this.kernel.store.contextReferences(
			state.mission_id,
			"SARASANGRAHA_CAPSULE/1",
			state.revision,
			true,
		);
		const latest = refs[0];
		let protectedHealth: SarasangrahaStatus["protectedHealth"] = "HEALTHY";
		let latestCapsule: SarasangrahaStatus["latestCapsule"] = null;
		if (latest) {
			const event = this.kernel.store.get(state.mission_id, latest, "EvidenceRecord");
			const capsule = event.payload as Capsule;
			latestCapsule = { id: latest, revision: capsule.basisRevision, at: event.captured_at };
			if (
				digest(capsule.position) !== capsule.protectedDigest ||
				canonical(capsule.position.requirements) === canonical([])
			) {
				protectedHealth = "CORRUPT";
			}
		}
		const staleDependencies: { sourceId: string; reason: string }[] = [];
		for (const ref of this.kernel.store.contextReferences(state.mission_id, "AVARTANA_RETRIEVAL/1", state.revision)) {
			const event = this.kernel.store.get(state.mission_id, ref, "EvidenceRecord");
			const payload = event.payload as { request?: { missionRevision?: number } };
			if (payload.request?.missionRevision !== undefined && payload.request.missionRevision !== state.revision) {
				staleDependencies.push({ sourceId: ref, reason: "basis revision changed" });
			}
			if (staleDependencies.length >= 8) break;
		}
		const pins = this.pins.get(state.mission_id) ?? [];
		const pressure = this.pressure();
		return {
			pressure,
			latestCapsule,
			staleDependencies,
			protectedHealth,
			recoverable: Boolean(state.command && state.contract),
			pins: pins.length,
			pinBytes: pins.reduce((sum, pin) => sum + pin.bytes, 0),
		};
	}

	explain(): { kept: string[]; externalized: string[]; summarized: string[]; discarded: string[]; at: number | null } {
		const state = this.kernel.state;
		if (!state) throw new ContextError("REVISION_CONFLICT", "Explain requires a loaded mission");
		return (
			this.lastExplain.get(state.mission_id) ?? {
				kept: [],
				externalized: [],
				summarized: [],
				discarded: [],
				at: null,
			}
		);
	}

	pinnedRefs(): PinRecord[] {
		const state = this.kernel.state;
		if (!state) return [];
		return [...(this.pins.get(state.mission_id) ?? [])];
	}

	private pressure(): number {
		const state = this.kernel.state;
		if (!state) return 0;
		const used = state.used.output_bytes + state.used.retrieval_bytes + state.used.artifact_bytes;
		const ceiling = state.ceilings.output_bytes + state.ceilings.retrieval_bytes + state.ceilings.artifact_bytes;
		if (!ceiling) return 0;
		return Math.min(1, used / ceiling);
	}

	assembleForModel(
		messages: AgentMessage[],
		tools: { name: string }[],
		window: number,
		output: number,
		overhead: number,
		compact: boolean,
	): ReturnType<typeof assemblePacket> {
		const state = this.kernel.state;
		if (!state) throw new ContextError("REVISION_CONFLICT", "Context assembly requires a loaded mission");
		const position = missionPosition(this.kernel.store, state);
		return assemblePacket(position, messages, tools as never, window, output, overhead, compact);
	}
}
