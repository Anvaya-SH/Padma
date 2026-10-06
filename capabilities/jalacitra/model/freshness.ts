// Jālacitra Freshness States (Part G3, J5-FRESH-001 through J5-FRESH-003)

export type FreshnessState = "FRESH" | "UNVERIFIED" | "STALE" | "INVALIDATED" | "PARTIAL";

export type FreshnessRequest = "live" | "current_generation" | "historical_allowed";

export interface FreshnessMetadata {
	requested: FreshnessRequest;
	delivered: FreshnessRequest;
	downgrade_reason?: string;
	index_building?: boolean;
	last_verified_at: string;
}
