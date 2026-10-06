// Sūkṣmaśastra Sākṣya Evidence Recording Port (Part I, S6-KER-005)
// Records structured observations and artifact references into Sākṣya.

import { createHash } from "node:crypto";
import type { StructuralEditPlan } from "../model/plan.ts";

export interface SaksyaEvidenceRecord {
	readonly observationId: string;
	readonly operation: string;
	readonly parametersDigest: string;
	readonly planId: string;
	readonly completeness: "EXACT_WITHIN_INDEX" | "LOWER_BOUND" | "UNKNOWN";
	readonly origin: "deterministic_check" | "tool_observation";
	readonly artifactDigest?: string;
	readonly timestamp: string;
}

export interface SaksyaPort {
	append(record: SaksyaEvidenceRecord, missionId?: string): Promise<void>;
}

export class SukshmashastraEvidenceRecorder {
	private port?: SaksyaPort;

	constructor(port?: SaksyaPort) {
		this.port = port;
	}

	setPort(port: SaksyaPort): void {
		this.port = port;
	}

	async recordPlanValidation(plan: StructuralEditPlan, missionId?: string): Promise<SaksyaEvidenceRecord> {
		const paramJson = JSON.stringify({
			plan_id: plan.plan_id,
			base_commit: plan.base_commit,
			anchors: plan.anchors.length,
			transformations: plan.transformations.length,
		});
		const parametersDigest = createHash("sha256").update(paramJson).digest("hex");

		const record: SaksyaEvidenceRecord = {
			observationId: `obs_sukshma_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
			operation: "plan.validate",
			parametersDigest,
			planId: plan.plan_id,
			completeness: plan.coverage.atlas_completeness,
			origin: "deterministic_check",
			artifactDigest: plan.expected_diff_ref.digest,
			timestamp: new Date().toISOString(),
		};

		if (this.port) {
			try {
				await this.port.append(record, missionId);
			} catch {
				// Non-fatal
			}
		}

		return record;
	}
}

export const defaultEvidenceRecorder = new SukshmashastraEvidenceRecorder();
