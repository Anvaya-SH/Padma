// Jālacitra Reason Code Catalog (Appendix A, J5-OBS-005)

export type ReasonCategory = "SKIP" | "PARTIAL" | "UNRESOLVED" | "DOWNGRADE" | "DENIED" | "ERROR";

export type BlindSpotCode =
	| "DYNAMIC_DISPATCH"
	| "REFLECTION"
	| "DYNAMIC_IMPORT"
	| "EVAL_OR_EXEC"
	| "GENERATED_CODE_NOT_INDEXED"
	| "RUNTIME_PLUGIN_LOADING"
	| "STRING_BASED_REFERENCE"
	| "MACRO_OR_TEMPLATE"
	| "DEPENDENCY_INJECTION"
	| "DECLARATION_MERGING"
	| "BARREL_DEPTH_LIMIT"
	| "CROSS_LANGUAGE_BOUNDARY"
	| "PARSER_ERROR_RECOVERY"
	| "UNSUPPORTED_LANGUAGE"
	| "FILE_TOO_LARGE"
	| "BINARY_FILE"
	| "IGNORED_BY_RULE";

export interface ReasonCodeEntry {
	code: string;
	category: ReasonCategory;
	description: string;
	userActionable: boolean;
}

export const REASON_CODES: Record<string, ReasonCodeEntry> = {
	NO_REPOSITORY_BINDING: {
		code: "NO_REPOSITORY_BINDING",
		category: "DENIED",
		description: "Operation requested without a valid Ādhāra repository binding.",
		userActionable: true,
	},
	INDEX_ABSENT: {
		code: "INDEX_ABSENT",
		category: "DENIED",
		description: "Graph store does not exist for this repository; indexing is required.",
		userActionable: true,
	},
	SCHEMA_NEWER: {
		code: "SCHEMA_NEWER",
		category: "DENIED",
		description: "Store was created by a newer schema version than current capability supports.",
		userActionable: false,
	},
	IGNORED_BY_RULE: {
		code: "IGNORED_BY_RULE",
		category: "SKIP",
		description: "File excluded by .padmaignore, .gitignore, or ScopePolicy exclusion.",
		userActionable: true,
	},
	EXCLUDED_VCS_INTERNAL: {
		code: "EXCLUDED_VCS_INTERNAL",
		category: "SKIP",
		description: "Version-control internal directory (.git) excluded by hard policy.",
		userActionable: false,
	},
	EXCLUDED_DEPENDENCY_DIR: {
		code: "EXCLUDED_DEPENDENCY_DIR",
		category: "SKIP",
		description: "Dependency directory (node_modules, site-packages, vendor) excluded from file index.",
		userActionable: false,
	},
	EXCLUDED_SECRET_PATTERN: {
		code: "EXCLUDED_SECRET_PATTERN",
		category: "SKIP",
		description: "File name matches credential or private secret pattern.",
		userActionable: true,
	},
	BUILD_OUTPUT_ARTIFACT_ONLY: {
		code: "BUILD_OUTPUT_ARTIFACT_ONLY",
		category: "SKIP",
		description: "Build output directory indexed only at artifact level.",
		userActionable: false,
	},
	BINARY_FILE: {
		code: "BINARY_FILE",
		category: "SKIP",
		description: "Binary file recorded at file node level with no AST extraction.",
		userActionable: false,
	},
	FILE_TOO_LARGE: {
		code: "FILE_TOO_LARGE",
		category: "SKIP",
		description: "File size exceeds configured resource ceiling (1 MiB source, 5 MiB data).",
		userActionable: true,
	},
	SYMLINK_OUTSIDE_ROOT: {
		code: "SYMLINK_OUTSIDE_ROOT",
		category: "DENIED",
		description: "Symbolic link targets a path outside the repository root.",
		userActionable: false,
	},
	PATH_OUTSIDE_ROOT: {
		code: "PATH_OUTSIDE_ROOT",
		category: "DENIED",
		description: "Normalized path escapes the repository boundary.",
		userActionable: false,
	},
	CASE_COLLISION: {
		code: "CASE_COLLISION",
		category: "ERROR",
		description: "Two paths differ only by case on a case-insensitive filesystem.",
		userActionable: true,
	},
	PARSE_TIMEOUT: {
		code: "PARSE_TIMEOUT",
		category: "PARTIAL",
		description: "Parsing exceeded the per-file wall-clock timeout.",
		userActionable: false,
	},
	PARSE_FAILED: {
		code: "PARSE_FAILED",
		category: "PARTIAL",
		description: "Parser failed or crashed during file extraction.",
		userActionable: false,
	},
	PARSER_ERROR_RECOVERY: {
		code: "PARSER_ERROR_RECOVERY",
		category: "PARTIAL",
		description: "File syntax contained errors; extracted AST is partial.",
		userActionable: true,
	},
	UNSUPPORTED_LANGUAGE: {
		code: "UNSUPPORTED_LANGUAGE",
		category: "SKIP",
		description: "Language is covered only at file level; no symbol extractor exists.",
		userActionable: false,
	},
	CONFIG_TRUNCATED: {
		code: "CONFIG_TRUNCATED",
		category: "PARTIAL",
		description: "Configuration key extraction exceeded depth or key count limit.",
		userActionable: true,
	},
	CONFIG_EXECUTABLE_NOT_EVALUATED: {
		code: "CONFIG_EXECUTABLE_NOT_EVALUATED",
		category: "PARTIAL",
		description: "Executable configuration parsed statically without runtime evaluation.",
		userActionable: false,
	},
	SECRET_CONTENT_DETECTED: {
		code: "SECRET_CONTENT_DETECTED",
		category: "PARTIAL",
		description: "Line matched secret pattern; facts discarded and content redacted.",
		userActionable: true,
	},
	NO_SUCH_MODULE: {
		code: "NO_SUCH_MODULE",
		category: "UNRESOLVED",
		description: "Import specifier could not be resolved to any candidate file or package.",
		userActionable: true,
	},
	NO_SUCH_EXPORT: {
		code: "NO_SUCH_EXPORT",
		category: "UNRESOLVED",
		description: "Target module found, but named export does not exist.",
		userActionable: true,
	},
	AMBIGUOUS_STAR_EXPORT: {
		code: "AMBIGUOUS_STAR_EXPORT",
		category: "UNRESOLVED",
		description: "Multiple re-export chains provide competing definitions of the symbol.",
		userActionable: true,
	},
	DEPTH_LIMIT: {
		code: "DEPTH_LIMIT",
		category: "UNRESOLVED",
		description: "Re-export chain exceeded the configured resolution depth.",
		userActionable: false,
	},
	CYCLE_DETECTED: {
		code: "CYCLE_DETECTED",
		category: "UNRESOLVED",
		description: "Circular re-export or module dependency encountered during resolution.",
		userActionable: true,
	},
	DYNAMIC_SPECIFIER: {
		code: "DYNAMIC_SPECIFIER",
		category: "UNRESOLVED",
		description: "Non-literal specifier in dynamic import or require call.",
		userActionable: false,
	},
	EXTERNAL_NOT_INDEXED: {
		code: "EXTERNAL_NOT_INDEXED",
		category: "UNRESOLVED",
		description: "Dependency is outside the currently indexed package or repository scope.",
		userActionable: true,
	},
	FAN_OUT_TRUNCATED: {
		code: "FAN_OUT_TRUNCATED",
		category: "PARTIAL",
		description: "Heuristic candidate count exceeded max allowed fan-out.",
		userActionable: false,
	},
	HUB_NODE_NOT_EXPANDED: {
		code: "HUB_NODE_NOT_EXPANDED",
		category: "PARTIAL",
		description: "Node degree exceeds hub threshold; traversal stopped expansion.",
		userActionable: false,
	},
	MODULE_RESOLUTION_MODE_UNSUPPORTED: {
		code: "MODULE_RESOLUTION_MODE_UNSUPPORTED",
		category: "UNRESOLVED",
		description: "Configured TypeScript moduleResolution mode is unsupported.",
		userActionable: true,
	},
	CONFIG_ALIAS_CONFLICT: {
		code: "CONFIG_ALIAS_CONFLICT",
		category: "UNRESOLVED",
		description: "tsconfig paths and bundler aliases define conflicting resolutions.",
		userActionable: true,
	},
	HELPER_NAME_CONVENTION: {
		code: "HELPER_NAME_CONVENTION",
		category: "PARTIAL",
		description: "Test helper identified by naming convention rather than static call proof.",
		userActionable: false,
	},
	FRAMEWORK_CONVENTION: {
		code: "FRAMEWORK_CONVENTION",
		category: "PARTIAL",
		description: "HTTP route inferred from directory/file naming conventions.",
		userActionable: false,
	},
	DECLARATION_MERGE: {
		code: "DECLARATION_MERGE",
		category: "PARTIAL",
		description: "Multiple declarations share one qualified name.",
		userActionable: false,
	},
	OBSERVATION_GENERATION_MISMATCH: {
		code: "OBSERVATION_GENERATION_MISMATCH",
		category: "UNRESOLVED",
		description: "Runtime observation cannot be mapped to the current index generation.",
		userActionable: false,
	},
	EVIDENCE_REQUIRED: {
		code: "EVIDENCE_REQUIRED",
		category: "DENIED",
		description: "Runtime observation lacks verifiable Sākṣya evidence record.",
		userActionable: false,
	},
	SCOPE_DENIED: {
		code: "SCOPE_DENIED",
		category: "DENIED",
		description: "ScopePolicy evaluation denied read access to the requested path.",
		userActionable: true,
	},
	SEMANTIC_UNAVAILABLE: {
		code: "SEMANTIC_UNAVAILABLE",
		category: "DOWNGRADE",
		description: "TypeScript compiler or semantic tooling is not installed in the project.",
		userActionable: true,
	},
	SEMANTIC_DEFERRED: {
		code: "SEMANTIC_DEFERRED",
		category: "DOWNGRADE",
		description: "Semantic analysis deferred because cost estimate exceeds mission budget gate.",
		userActionable: true,
	},
	VERIFY_CEILING: {
		code: "VERIFY_CEILING",
		category: "DOWNGRADE",
		description: "Live verification file count exceeded ceiling; downgraded to current_generation.",
		userActionable: false,
	},
	SHRINK_GUARD: {
		code: "SHRINK_GUARD",
		category: "DENIED",
		description: "Proposed graph shrank drastically without explanation; commit refused.",
		userActionable: true,
	},
	SOURCE_CHANGED: {
		code: "SOURCE_CHANGED",
		category: "PARTIAL",
		description: "Source file modified since extraction.",
		userActionable: false,
	},
	SOURCE_REMOVED: {
		code: "SOURCE_REMOVED",
		category: "PARTIAL",
		description: "Source file deleted from the repository.",
		userActionable: false,
	},
	CONFIG_CHANGED: {
		code: "CONFIG_CHANGED",
		category: "PARTIAL",
		description: "Configuration fingerprint component changed.",
		userActionable: false,
	},
	TOOL_CHANGED: {
		code: "TOOL_CHANGED",
		category: "PARTIAL",
		description: "Parser or adapter version changed.",
		userActionable: false,
	},
	SCHEMA_CHANGED: {
		code: "SCHEMA_CHANGED",
		category: "PARTIAL",
		description: "Jālacitra database schema version advanced.",
		userActionable: false,
	},
	DEPENDENCY_CHANGED: {
		code: "DEPENDENCY_CHANGED",
		category: "PARTIAL",
		description: "A dependency or imported signature changed.",
		userActionable: false,
	},
};

export type ReasonCode = keyof typeof REASON_CODES;

export function isKnownReasonCode(code: string): code is ReasonCode {
	return Object.hasOwn(REASON_CODES, code);
}

export function assertReasonCode(code: string): ReasonCode {
	if (!isKnownReasonCode(code)) {
		throw new Error(`Reason code "${code}" is not registered in the central catalog`);
	}
	return code;
}
