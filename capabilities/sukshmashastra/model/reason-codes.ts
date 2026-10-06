// Sūkṣmaśastra Reason-Code Catalog (Part B, Part H, Appendix B)
// Central registry of all reason codes emitted by Sūkṣmaśastra.

export type ReasonCategory =
	| "BINDING"
	| "RESOLUTION"
	| "VALIDATION"
	| "CONFLICT"
	| "APPLY"
	| "SECURITY"
	| "BUDGET"
	| "FORMAT"
	| "LANGUAGE";

export interface ReasonCodeDefinition {
	readonly code: string;
	readonly category: ReasonCategory;
	readonly description: string;
	readonly userActionable: boolean;
}

export const REASON_CODES: Record<string, ReasonCodeDefinition> = {
	BINDING_MISMATCH: {
		code: "BINDING_MISMATCH",
		category: "BINDING",
		description:
			"Repository binding, base commit, or workspace generation does not match the active mission binding.",
		userActionable: true,
	},
	AMBIGUOUS: {
		code: "AMBIGUOUS",
		category: "RESOLUTION",
		description: "Structural anchor resolved to multiple candidate symbols or syntax nodes without an explicit pick.",
		userActionable: true,
	},
	NOT_FOUND: {
		code: "NOT_FOUND",
		category: "RESOLUTION",
		description: "Structural anchor could not be resolved in the target file at current revision.",
		userActionable: true,
	},
	STALE_PREIMAGE: {
		code: "STALE_PREIMAGE",
		category: "RESOLUTION",
		description:
			"Target file content digest changed since plan creation and anchor identity cannot be re-established.",
		userActionable: true,
	},
	MOVED: {
		code: "MOVED",
		category: "RESOLUTION",
		description: "Target node moved to a different range but preserves stable symbol identity and signature digest.",
		userActionable: false,
	},
	GRAPH_PARSE_MISMATCH: {
		code: "GRAPH_PARSE_MISMATCH",
		category: "RESOLUTION",
		description: "Jālacitra graph location handle disagrees with fresh parse range; fresh parse range was adopted.",
		userActionable: false,
	},
	EDIT_OVERLAP: {
		code: "EDIT_OVERLAP",
		category: "VALIDATION",
		description: "Multiple transformations within the plan produce overlapping replacement byte ranges.",
		userActionable: true,
	},
	UNDECLARED_STRUCTURAL_CHANGE: {
		code: "UNDECLARED_STRUCTURAL_CHANGE",
		category: "VALIDATION",
		description:
			"Post-edit parse reveals an unexpected deletion or alteration of a top-level declaration not declared in the plan.",
		userActionable: true,
	},
	GENERATED_FILE_SKIPPED: {
		code: "GENERATED_FILE_SKIPPED",
		category: "VALIDATION",
		description: "Target file is marked as generated and was skipped; editing source or regeneration is advised.",
		userActionable: true,
	},
	MANUAL_REVIEW_REQUIRED: {
		code: "MANUAL_REVIEW_REQUIRED",
		category: "VALIDATION",
		description:
			"Transformation affected dynamic dispatch, spread arguments, or reflection requiring manual engineer review.",
		userActionable: true,
	},
	STRING_OR_COMMENT_MENTION: {
		code: "STRING_OR_COMMENT_MENTION",
		category: "VALIDATION",
		description:
			"Occurrence of symbol name in string literal or comment was listed for review and not automatically renamed.",
		userActionable: true,
	},
	LARGE_CHANGE: {
		code: "LARGE_CHANGE",
		category: "VALIDATION",
		description:
			"Plan exceeds standard size threshold (>2000 lines or >50 files), triggering higher recommended risk tier.",
		userActionable: true,
	},
	PREIMAGE_CHANGED: {
		code: "PREIMAGE_CHANGED",
		category: "APPLY",
		description:
			"Target file content digest at commit boundary did not match expected preimage under lock; operation aborted.",
		userActionable: true,
	},
	APPLY_ROLLED_BACK: {
		code: "APPLY_ROLLED_BACK",
		category: "APPLY",
		description:
			"Atomic rename failed partway through multi-file apply; completed files were restored from rollback preimages.",
		userActionable: true,
	},
	APPLY_PARTIAL: {
		code: "APPLY_PARTIAL",
		category: "APPLY",
		description: "Rename failed partway and rollback restoration failed; partial file replacements remain on disk.",
		userActionable: true,
	},
	CONFLICT: {
		code: "CONFLICT",
		category: "CONFLICT",
		description:
			"Concurrent file modification or conflicting transformation preconditions prevent clean structural rebase.",
		userActionable: true,
	},
	SEMANTIC_RECHECK_RECOMMENDED: {
		code: "SEMANTIC_RECHECK_RECOMMENDED",
		category: "CONFLICT",
		description:
			"Structural rebase succeeded syntactically but surrounding callers or types changed; semantic verification recommended.",
		userActionable: true,
	},
	DIAGNOSTICS_DEFERRED: {
		code: "DIAGNOSTICS_DEFERRED",
		category: "BUDGET",
		description:
			"Computing post-edit diagnostics delta was deferred because it exceeded allocated time or memory budget.",
		userActionable: false,
	},
	SEMANTIC_DEFERRED: {
		code: "SEMANTIC_DEFERRED",
		category: "BUDGET",
		description:
			"Compiler language service query was deferred because estimated cost exceeded remaining Koṣa budget ceiling.",
		userActionable: false,
	},
	FORMAT_SKIPPED_EXECUTABLE_CONFIG: {
		code: "FORMAT_SKIPPED_EXECUTABLE_CONFIG",
		category: "FORMAT",
		description:
			"Formatting was skipped because formatter configuration is executable (e.g. JS/TS) rather than purely declarative.",
		userActionable: false,
	},
	SECRET_IN_REPLACEMENT: {
		code: "SECRET_IN_REPLACEMENT",
		category: "SECURITY",
		description: "Replacement artifact text contains detected secret or private key pattern; planning blocked.",
		userActionable: true,
	},
	PATH_OUTSIDE_ROOT: {
		code: "PATH_OUTSIDE_ROOT",
		category: "SECURITY",
		description:
			"Target path resolves outside workspace root or attempts directory traversal via symlink or relative escapes.",
		userActionable: true,
	},
	UNSUPPORTED_ENCODING: {
		code: "UNSUPPORTED_ENCODING",
		category: "SECURITY",
		description: "File content cannot be losslessly decoded as UTF-8 or standard supported text encoding.",
		userActionable: true,
	},
	UNSUPPORTED_LANGUAGE: {
		code: "UNSUPPORTED_LANGUAGE",
		category: "LANGUAGE",
		description:
			"Target file language does not support structural editing in Phase 6 (only TypeScript/JavaScript is supported).",
		userActionable: true,
	},
	SCOPE_DENIED: {
		code: "SCOPE_DENIED",
		category: "SECURITY",
		description: "Target file path is denied by ScopePolicy, engagement rules, or sensitive file protection.",
		userActionable: true,
	},
	REJECTED_SYNTAX_ERROR: {
		code: "REJECTED_SYNTAX_ERROR",
		category: "VALIDATION",
		description: "Proposed transformation introduces syntax errors in a file that parsed cleanly before editing.",
		userActionable: true,
	},
	DELETE_REFERENCES_REMAIN: {
		code: "DELETE_REFERENCES_REMAIN",
		category: "VALIDATION",
		description: "Attempted to delete a symbol that still has active parsed or compiled references in the codebase.",
		userActionable: true,
	},
};

export type ReasonCode = keyof typeof REASON_CODES;

/**
 * Validates that a reason code is registered in the catalog.
 * Throws or returns undefined if invalid.
 */
export function getReasonCode(code: string): ReasonCodeDefinition | undefined {
	return REASON_CODES[code];
}

export function assertReasonCode(code: string): ReasonCodeDefinition {
	const def = REASON_CODES[code];
	if (!def) {
		throw new Error(`Uncatalogued Sūkṣmaśastra reason code: '${code}'`);
	}
	return def;
}

export class SukshmashastraError extends Error {
	readonly reasonCode: ReasonCode;
	constructor(code: ReasonCode, message?: string) {
		const def = getReasonCode(code);
		const fullMessage = message ? `${code}: ${message}` : `${code}: ${def?.description ?? ""}`;
		super(fullMessage);
		this.name = "SukshmashastraError";
		this.reasonCode = code;
	}
}
