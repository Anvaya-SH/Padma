/** Shared identity and outcome types for Avartana, Sarasangraha and Smritikosha. */

export type KnowledgeStatus =
	| "CURRENT"
	| "HISTORICAL"
	| "PARTIAL"
	| "STALE"
	| "UNAVAILABLE"
	| "DENIED"
	| "CANCELLED"
	| "FAILED";

export type AuthorityRef = { kind: "authority"; mission: string; id: string };
export type EvidenceRef = { kind: "evidence"; mission: string; id: string };
export type ArtifactRef = { kind: "artifact"; mission: string; id: string };
export type DerivedRef = { kind: "derived"; mission: string; id: string };
export type ExperienceRef = { kind: "experience"; namespace: string; id: string; admission: AuthorityRef };

export type SourceKind = "file" | "command_output" | "session" | "artifact" | "git" | "document" | "memory" | "other";

export interface SourceIdentity {
	sourceId: string;
	adapterId: string;
	kind: SourceKind;
	workspaceId?: string;
	repositoryId?: string;
	versionId?: string;
	generation?: number;
	contentHash?: string;
	createdAt?: string;
}

export interface KnowledgeDependency {
	sourceId: string;
	versionId: string;
	generation?: string;
	contentHash?: string;
	stale: boolean;
	reason?: string;
}

export interface CoverageReport {
	requested: number;
	searched: number;
	skipped: { sourceId: string; reason: string }[];
	exactResults: number;
	truncated: number;
	unexamined: number | null;
	complete: boolean;
	stopReason: string | null;
}

export interface Limitation {
	code: string;
	reason: string;
}

export function toKnowledgeStatus(answerStatus: string): KnowledgeStatus {
	switch (answerStatus) {
		case "ANSWERED":
			return "CURRENT";
		case "PARTIAL":
		case "NO_MATCH_IN_PARTIAL_SCOPE":
			return "PARTIAL";
		case "NOT_FOUND_IN_COMPLETE_SCOPE":
			return "CURRENT";
		case "STALE":
			return "STALE";
		case "UNAVAILABLE":
			return "UNAVAILABLE";
		case "DENIED":
			return "DENIED";
		case "CANCELLED":
			return "CANCELLED";
		default:
			return "FAILED";
	}
}
