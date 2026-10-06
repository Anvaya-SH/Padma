// Jālacitra Ambiguity Model (Part G2, J5-AMB-001 through J5-AMB-004)

export type Ambiguity = "UNIQUE" | "MULTI" | "UNRESOLVED";

export type AmbiguityPolicy = "REPORT" | "STRICT" | "BEST_EFFORT";

export type CandidateRankReason =
	| "SAME_DIRECTORY"
	| "SAME_FILE"
	| "EXPORTED_MATCH"
	| "EXACT_TYPE_MATCH"
	| "DECLARATION_MERGE"
	| "SHORTEST_PATH"
	| "ONLY_COMPATIBLE_EXPORT";
