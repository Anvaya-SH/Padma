// Sūkṣmaśastra Structural Edit Plan & Coverage Model (Part E, Part H, S6-PLAN-001, S6-PLAN-002, S6-COV-001..004)

import type { Anchor } from "./anchors.ts";

export type TransformationKind =
	| "rename"
	| "insert"
	| "replace_node"
	| "delete"
	| "move"
	| "rewrite_imports"
	| "change_signature"
	| "config_migration"
	| "custom";

export interface Transformation {
	readonly transformation_id: string;
	readonly kind: TransformationKind;
	readonly target_file: string; // Repo-relative path
	readonly anchor_id?: string;
	readonly replacement_text?: string;
	readonly parameters?: Record<string, unknown>;
	readonly dependent_anchors?: string[];
	readonly affected_nodes: string[];
	readonly deliberately_unchanged_nodes: string[];
}

export type UncoveredSurfaceCode =
	| "REFLECTION"
	| "DYNAMIC_IMPORT"
	| "STRING_BASED_REFERENCE"
	| "GENERATED_CODE"
	| "CROSS_LANGUAGE"
	| "EXTERNAL_API_CONSUMERS"
	| "DEPENDENCY_INJECTION"
	| "MACRO_OR_TEMPLATE"
	| "UNINDEXED_FILES"
	| "STRING_OR_COMMENT_MENTION";

export interface UncoveredSurfaceEntry {
	readonly code: UncoveredSurfaceCode;
	readonly count: number;
	readonly examples: string[]; // Bounded to 5, text bounded to 120 chars
}

export interface EditCoverage {
	readonly mode: "COMPILER_ASSISTED" | "GRAPH_ONLY" | "SYNTAX_ONLY";
	readonly references_found: {
		readonly compiled: number;
		readonly parsed: number;
		readonly inferred: number;
	};
	readonly uncovered_surface: UncoveredSurfaceEntry[];
	readonly atlas_completeness: "EXACT_WITHIN_INDEX" | "LOWER_BOUND" | "UNKNOWN";
	readonly relevant_tests: Array<{
		readonly test_id: string;
		readonly reason: string;
		readonly provenance: string;
	}>;
	readonly external_contract_changes: Array<{
		readonly contract_id: string;
		readonly change: "REMOVED" | "RENAMED" | "SIGNATURE_CHANGED";
	}>;
	readonly suggested_checks: string[];
}

export type PlanStatus = "DRAFT" | "VALIDATED" | "PREPARED" | "APPLIED" | "CONFLICT" | "REJECTED";

export interface BoundRepoTarget {
	readonly canonical_path: string;
	readonly repository_identity: string;
}

export interface ArtifactReference {
	readonly digest: string;
	readonly size: number;
	readonly path?: string;
}

export interface StructuralEditPlan {
	readonly plan_id: string;
	readonly repo_binding: BoundRepoTarget;
	readonly base_commit: string;
	readonly workspace_generation: string;
	readonly atlas_snapshot_id: string;
	readonly language_and_parser_versions: Record<string, string>;
	readonly intent: string;
	readonly anchors: Anchor[];
	readonly transformations: Transformation[];
	readonly impact_evidence: Array<{
		readonly id: string;
		readonly provenance: string;
		readonly location: string;
	}>;
	readonly coverage: EditCoverage;
	readonly preconditions: string[];
	readonly expected_diff_ref: ArtifactReference;
	readonly post_parse_report_ref: ArtifactReference;
	readonly diagnostics_delta_ref?: ArtifactReference;
	readonly candidate_validation_commands: string[];
	readonly suggested_risk_tier: 0 | 1 | 2 | 3 | 4;
	readonly rollback_ref?: ArtifactReference;
	readonly status: PlanStatus;
	readonly rejection_reason?: string;
	readonly parent_plan_id?: string;
}
