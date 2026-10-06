/** Smritikosha persistent memory record model. */

export type MemoryKind =
	| "PROJECT_CONVENTION"
	| "FAILURE_SIGNATURE"
	| "PROCEDURE"
	| "USER_PREFERENCE"
	| "USER_GOAL"
	| "INFERRED_PATTERN"
	| "SESSION_BINDING";

export type MemoryOrigin = "EXPLICIT_USER" | "OBSERVED" | "DERIVED" | "INFERRED";

export type MemoryLifecycle = "CANDIDATE" | "VERIFIED" | "STALE" | "REVOKED";

export type MemoryApplicability =
	| "APPLICABLE"
	| "POSSIBLY_APPLICABLE"
	| "REQUIRES_REVALIDATION"
	| "INCOMPATIBLE"
	| "STALE";

export interface MemoryRecord {
	memoryId: string;
	version: number;
	kind: MemoryKind;
	subject: string;
	normalizedKey?: string;
	content: Record<string, unknown>;
	origin: MemoryOrigin;
	lifecycle: MemoryLifecycle;
	userScope?: string;
	projectScope?: string;
	repositoryScope?: string;
	environmentFingerprint?: string;
	applicabilityPredicates: string[];
	requiredPermissions?: string[];
	actionSchemaIds?: string[];
	supportingEvidence: { kind: string; mission: string; id: string }[];
	counterexampleEvidence: { kind: string; mission: string; id: string }[];
	sourceMissionIds: string[];
	confidence?: number;
	supportCount?: number;
	lastValidatedAt?: string;
	expiresAt?: string;
	invalidationTriggers?: string[];
	createdAt: string;
	updatedAt: string;
}

export interface MemoryHit {
	record: MemoryRecord;
	applicability: MemoryApplicability;
	reason: string;
	lastValidation: string | null;
	revalidationRequired: boolean;
	conflicts: string[];
}

export interface IntentContinuityPacket {
	version: "INTENT_CONTINUITY/1";
	preferences: { id: string; text: string; origin: MemoryOrigin; scope: string }[];
	goals: { id: string; text: string; origin: MemoryOrigin }[];
	invariants: { id: string; text: string }[];
	decisions: { id: string; text: string }[];
	inferred: { id: string; text: string; supportCount: number }[];
	priorMissions: { missionId: string; reason: string }[];
	generatedAt: string;
}

const SECRET_PATTERNS = [
	/api[_-]?key/i,
	/secret/i,
	/token/i,
	/private[_-]?key/i,
	/password/i,
	/bearer/i,
	/credential/i,
];

export function containsSecret(text: string): boolean {
	return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export function normalizeKey(subject: string): string {
	return subject.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 256);
}

export function isExplicit(record: Pick<MemoryRecord, "origin">): boolean {
	return record.origin === "EXPLICIT_USER";
}
