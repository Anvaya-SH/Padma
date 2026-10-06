// Jālacitra Sākṣya Evidence Recording Port (Part N1, J5-KER-005)
// Records compact query observations and artifact references into Sākṣya.
// Preserves per-item provenance list for INFERRED rows to prevent laundering.

import { createHash } from "node:crypto";
import type { QueryResult } from "../api/context.ts";
import type { ProvenanceClass } from "../model/provenance.ts";

export type EvidenceOrigin = "deterministic_check" | "tool_observation";

export interface ItemProvenanceEntry {
	id: string;
	provenance: ProvenanceClass;
	isAmbiguous?: boolean;
}

export interface SaksyaObservation {
	observationId: string;
	operation: string;
	parametersDigest: string;
	snapshotId: string;
	generations: number[];
	resultCount: number;
	completeness: "EXACT_WITHIN_INDEX" | "LOWER_BOUND" | "UNKNOWN";
	origin: EvidenceOrigin;
	itemIdentities: string[];
	itemProvenances: ItemProvenanceEntry[];
	artifactDigest?: string;
	timestamp: string;
}

export interface SaksyaEvidencePort {
	append(observation: SaksyaObservation, missionId?: string): Promise<void>;
}

export interface ArtifactStoragePort {
	put(content: string): Promise<{ digest: string; size: number }>;
}

const INLINE_PAYLOAD_LIMIT_BYTES = 4096;
const MAX_ITEM_IDENTITIES_STORED = 100;

export class JalacitraEvidenceRecorder {
	private evidencePort?: SaksyaEvidencePort;
	private artifactPort?: ArtifactStoragePort;

	constructor(options?: { evidencePort?: SaksyaEvidencePort; artifactPort?: ArtifactStoragePort }) {
		this.evidencePort = options?.evidencePort;
		this.artifactPort = options?.artifactPort;
	}

	setEvidencePort(port: SaksyaEvidencePort): void {
		this.evidencePort = port;
	}

	setArtifactPort(port: ArtifactStoragePort): void {
		this.artifactPort = port;
	}

	/**
	 * Records a compact observation in Sākṣya.
	 */
	async recordQueryEvidence<T>(
		operation: string,
		params: Record<string, unknown>,
		queryResult: QueryResult<T>,
		missionId?: string,
	): Promise<SaksyaObservation> {
		const paramJson = JSON.stringify(params, Object.keys(params).sort());
		const parametersDigest = createHash("sha256").update(paramJson).digest("hex");

		// Extract item identities and provenances from data
		const itemIdentities: string[] = [];
		const itemProvenances: ItemProvenanceEntry[] = [];
		let hasRuntimeObservation = false;

		const data = queryResult.data;
		if (Array.isArray(data)) {
			for (const item of data) {
				if (item && typeof item === "object") {
					const cast = item as {
						id?: string;
						canonical_name?: string;
						provenance?: ProvenanceClass;
						is_ambiguous?: boolean;
					};
					const ident = cast.id ?? cast.canonical_name ?? "item";
					if (itemIdentities.length < MAX_ITEM_IDENTITIES_STORED) {
						itemIdentities.push(ident);
					}
					const prov = cast.provenance ?? "PARSED";
					if (prov === "RUNTIME_CONFIRMED") {
						hasRuntimeObservation = true;
					}
					itemProvenances.push({
						id: ident,
						provenance: prov,
						isAmbiguous: cast.is_ambiguous,
					});
				}
			}
		}

		// Origin: deterministic_check for PARSED/COMPILED, tool_observation for RUNTIME_CONFIRMED
		const origin: EvidenceOrigin = hasRuntimeObservation ? "tool_observation" : "deterministic_check";

		// Check payload size for artifact offloading
		const fullJson = JSON.stringify(queryResult);
		let artifactDigest: string | undefined;

		if (Buffer.byteLength(fullJson, "utf8") > INLINE_PAYLOAD_LIMIT_BYTES && this.artifactPort) {
			try {
				const stored = await this.artifactPort.put(fullJson);
				artifactDigest = stored.digest;
			} catch {
				// Non-fatal if artifact put fails
			}
		}

		const observation: SaksyaObservation = {
			observationId: `obs_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
			operation,
			parametersDigest,
			snapshotId: queryResult.snapshot.snapshot_id,
			generations: [queryResult.snapshot.index_generation],
			resultCount: Array.isArray(data) ? data.length : 1,
			completeness: queryResult.coverage.completeness,
			origin,
			itemIdentities,
			itemProvenances,
			artifactDigest,
			timestamp: new Date().toISOString(),
		};

		if (this.evidencePort) {
			try {
				await this.evidencePort.append(observation, missionId);
			} catch {
				// Non-fatal
			}
		}

		return observation;
	}
}

export const defaultEvidenceRecorder = new JalacitraEvidenceRecorder();
