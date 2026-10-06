import type { MissionState } from "../records.ts";
import type { MissionStore } from "../store.ts";
import type { RecallQuery, SmritikoshaStore, StoreInput } from "./store.ts";
import type { IntentContinuityPacket, MemoryApplicability, MemoryHit, MemoryKind, MemoryRecord } from "./types.ts";

export interface ContinuityRequest {
	userScope?: string;
	projectScope?: string;
	repositoryScope?: string;
	intentSignature: string;
	taskType?: string;
}

export interface CandidateInput {
	kind: MemoryKind;
	subject: string;
	content: Record<string, unknown>;
	origin: MemoryRecord["origin"];
	userScope?: string;
	projectScope?: string;
	repositoryScope?: string;
	environmentFingerprint?: string;
	evidenceMissionId: string;
	evidenceId: string;
}

/** Admission, retrieval and lifecycle policy. Never grants authorization or proves present state. */
export class SmritikoshaService {
	private store: SmritikoshaStore;
	constructor(store: SmritikoshaStore) {
		this.store = store;
	}

	get underlying(): SmritikoshaStore {
		return this.store;
	}

	recall(query: RecallQuery): { hits: MemoryHit[]; status: string } {
		const hits = this.store.recall({ topK: 5, ...query });
		if (!hits.length) return { hits, status: "EMPTY" };
		return { hits, status: "OK" };
	}

	consider(candidate: CandidateInput): MemoryRecord {
		if (!candidate.evidenceId || !candidate.evidenceMissionId) {
			throw new Error("Memory candidates require exact source evidence");
		}
		const input: StoreInput = {
			kind: candidate.kind,
			subject: candidate.subject,
			content: candidate.content,
			origin: candidate.origin,
			userScope: candidate.userScope,
			projectScope: candidate.projectScope,
			repositoryScope: candidate.repositoryScope,
			environmentFingerprint: candidate.environmentFingerprint,
			applicabilityPredicates: [],
			supportingEvidence: [{ kind: "evidence", mission: candidate.evidenceMissionId, id: candidate.evidenceId }],
			sourceMissionIds: [candidate.evidenceMissionId],
		};
		return this.store.admit(input);
	}

	storeVerified(input: StoreInput): MemoryRecord {
		return this.store.admit(input);
	}

	inspect(id: string): MemoryRecord {
		const record = this.store.get(id);
		if (!record) throw new Error(`Memory ${id} not found`);
		return record;
	}

	correct(
		id: string,
		expectedVersion: number,
		subject: string,
		content: Record<string, unknown>,
		evidenceMissionId: string,
		evidenceId: string,
	): MemoryRecord {
		return this.store.mutate(id, expectedVersion, (record) => ({
			...record,
			subject: subject.slice(0, 2000),
			content,
			origin: "EXPLICIT_USER",
			lifecycle: "VERIFIED",
			lastValidatedAt: new Date().toISOString(),
			supportingEvidence: [
				...record.supportingEvidence,
				{ kind: "evidence", mission: evidenceMissionId, id: evidenceId },
			],
			sourceMissionIds: [...new Set([...record.sourceMissionIds, evidenceMissionId])],
		}));
	}

	demote(id: string, expectedVersion: number, reason: string): MemoryRecord {
		return this.store.mutate(id, expectedVersion, (record) => ({
			...record,
			lifecycle: record.lifecycle === "VERIFIED" ? "STALE" : "CANDIDATE",
			counterexampleEvidence: record.counterexampleEvidence,
			invalidationTriggers: [...(record.invalidationTriggers ?? []), reason].slice(-8),
		}));
	}

	forget(id: string, expectedVersion: number): MemoryRecord {
		return this.store.mutate(id, expectedVersion, (record) => ({
			...record,
			lifecycle: "REVOKED",
		}));
	}

	reinforce(id: string, expectedVersion: number): MemoryRecord {
		return this.store.mutate(id, expectedVersion, (record) => {
			const support = (record.supportCount ?? 1) + 1;
			const promote = record.origin === "INFERRED" && support >= 3 && record.lifecycle === "CANDIDATE";
			return {
				...record,
				supportCount: support,
				lifecycle: promote ? "VERIFIED" : record.lifecycle,
				lastValidatedAt: promote ? new Date().toISOString() : record.lastValidatedAt,
			};
		});
	}

	buildContinuity(request: ContinuityRequest): IntentContinuityPacket {
		const { hits } = this.recall({
			query: request.intentSignature,
			userScope: request.userScope,
			projectScope: request.projectScope,
			repositoryScope: request.repositoryScope,
			topK: 6,
		});
		const packet: IntentContinuityPacket = {
			version: "INTENT_CONTINUITY/1",
			preferences: [],
			goals: [],
			invariants: [],
			decisions: [],
			inferred: [],
			priorMissions: [],
			generatedAt: new Date().toISOString(),
		};
		for (const hit of hits) {
			const text = `${hit.record.subject}: ${JSON.stringify(hit.record.content).slice(0, 500)}`;
			const scope = hit.record.projectScope ?? hit.record.userScope ?? hit.record.repositoryScope ?? "global";
			if (hit.record.kind === "USER_PREFERENCE") {
				packet.preferences.push({ id: hit.record.memoryId, text, origin: hit.record.origin, scope });
			} else if (hit.record.kind === "USER_GOAL") {
				packet.goals.push({ id: hit.record.memoryId, text, origin: hit.record.origin });
			} else if (hit.record.kind === "PROJECT_CONVENTION") {
				packet.invariants.push({ id: hit.record.memoryId, text });
			} else if (hit.record.kind === "INFERRED_PATTERN") {
				packet.inferred.push({ id: hit.record.memoryId, text, supportCount: hit.record.supportCount ?? 1 });
			} else {
				packet.decisions.push({ id: hit.record.memoryId, text });
			}
			for (const missionId of hit.record.sourceMissionIds.slice(0, 2)) {
				if (!packet.priorMissions.some((entry) => entry.missionId === missionId)) {
					packet.priorMissions.push({ missionId, reason: `memory ${hit.record.memoryId} (${hit.reason})` });
				}
			}
		}
		return packet;
	}

	/** Bounded candidate extraction from verified outcomes and explicit user text. Model prose alone never verifies. */
	extractCandidates(mission: MissionState, store: MissionStore): CandidateInput[] {
		const candidates: CandidateInput[] = [];
		const spec = store.get(mission.mission_id, mission.command, "CommandSpecification");
		const explicit = [...spec.prohibitions, ...spec.preferences].filter((text) => text.trim().length > 0).slice(0, 3);
		for (const text of explicit) {
			candidates.push({
				kind: "USER_PREFERENCE",
				subject: text.slice(0, 500),
				content: { text: text.slice(0, 2000), source: "command_specification" },
				origin: "EXPLICIT_USER",
				evidenceMissionId: mission.mission_id,
				evidenceId: mission.command,
			});
		}
		const verified = mission.requirements
			.map((id) => store.get(mission.mission_id, id, "Requirement"))
			.filter((req) => req.status === "VERIFIED")
			.slice(0, 3);
		for (const req of verified) {
			const evidence = req.evidence[0];
			if (!evidence) continue;
			candidates.push({
				kind: "PROCEDURE",
				subject: `Verified ${req.rule} for ${req.target ?? req.text}`.slice(0, 500),
				content: { requirement: req.requirement_id, text: req.text, target: req.target },
				origin: "OBSERVED",
				evidenceMissionId: mission.mission_id,
				evidenceId: evidence,
			});
		}
		return candidates.slice(0, 5);
	}

	status(): { counts: ReturnType<SmritikoshaStore["counts"]>; healthy: boolean; storage: string } {
		const counts = this.store.counts();
		return { counts, healthy: true, storage: this.store.path };
	}

	rankWithAuthority(currentInstruction: string, hits: MemoryHit[]): { ordered: MemoryHit[]; overridden: string[] } {
		const overridden: string[] = [];
		const ordered = [...hits].sort((a, b) => {
			const rank = (hit: MemoryHit): number => {
				if (hit.record.origin === "EXPLICIT_USER" && hit.applicability === "APPLICABLE") return 0;
				if (hit.applicability === "APPLICABLE") return 1;
				if (hit.applicability === "POSSIBLY_APPLICABLE") return 2;
				return 3;
			};
			return rank(a) - rank(b);
		});
		const current = currentInstruction.toLowerCase();
		for (const hit of ordered) {
			if (
				hit.record.kind === "USER_PREFERENCE" &&
				current.includes("do not") &&
				hit.record.subject.toLowerCase().includes(current.slice(0, 20))
			) {
				overridden.push(hit.record.memoryId);
			}
		}
		return { ordered, overridden };
	}

	applicability(id: string, query: RecallQuery): MemoryApplicability {
		const record = this.store.get(id);
		if (!record) throw new Error(`Memory ${id} not found`);
		const hits = this.store.recall({ ...query, topK: 8, includeStale: true, includeRevoked: true });
		const hit = hits.find((entry) => entry.record.memoryId === id);
		if (hit) return hit.applicability;
		return record.lifecycle === "REVOKED"
			? "INCOMPATIBLE"
			: record.lifecycle === "STALE"
				? "STALE"
				: "POSSIBLY_APPLICABLE";
	}
}
