// Jālacitra Coverage and Completeness (Part G4, J5-COMP-001 through J5-COMP-005)

import type { ProvenanceClass } from "./provenance.ts";
import type { BlindSpotCode, ReasonCode } from "./reason-codes.ts";

export type Completeness = "EXACT_WITHIN_INDEX" | "LOWER_BOUND" | "UNKNOWN";

export type LanguageCoverageLevel = "FULL" | "PARTIAL" | "FILE_LEVEL_ONLY";

export interface SkippedFileSummary {
	reason: ReasonCode;
	count: number;
	sample_paths: string[]; // max 5 paths
}

export interface LanguageCoverage {
	language: string;
	adapter_version: string;
	coverage: LanguageCoverageLevel;
}

export interface BlindSpotEntry {
	code: BlindSpotCode;
	count: number;
	description: string;
}

export interface Coverage {
	scope: {
		repo_id: string;
		snapshot_id: string;
		generation: number;
	};
	files_considered: number;
	files_indexed: number;
	files_skipped: SkippedFileSummary[];
	languages: LanguageCoverage[];
	known_blind_spots: BlindSpotEntry[];
	completeness: Completeness;
	limitations: string[];
}

export interface NegativeEvidence {
	checked: string;
	classes?: ProvenanceClass[];
	result: string;
	completeness: Completeness;
}

export function defaultCoverage(repo_id: string, snapshot_id: string, generation: number): Coverage {
	return {
		scope: { repo_id, snapshot_id, generation },
		files_considered: 0,
		files_indexed: 0,
		files_skipped: [],
		languages: [],
		known_blind_spots: [],
		completeness: "UNKNOWN",
		limitations: [],
	};
}
