// Jālacitra Edge Kinds and Relations (Part F3, J5-EDGE-001 through J5-EDGE-004)

import type { Ambiguity } from "./ambiguity.ts";
import type { FreshnessState } from "./freshness.ts";
import type { LocationHandle } from "./ids.ts";
import type { ProvenanceClass } from "./provenance.ts";

export type EdgeKind =
	| "contains"
	| "imports"
	| "declares"
	| "exports"
	| "references"
	| "calls"
	| "overrides"
	| "extends"
	| "configures"
	| "reads_config"
	| "generates"
	| "builds"
	| "tests"
	| "depends_on"
	| "exposes"
	| "consumes"
	| "observed_at_runtime"
	| "renamed_from"
	| "source_of"
	| "unresolved_to"
	| "handled_by"
	| "rendered_from";

export interface EdgeRecord {
	id: string;
	kind: EdgeKind;
	src: string;
	dst: string;
	class: ProvenanceClass;
	method: string;
	tool_name?: string | null;
	tool_version?: string | null;
	src_file?: string | null;
	src_start?: number | null;
	src_end?: number | null;
	src_digest?: string | null;
	evidence_ref?: string | null;
	ambiguity?: Ambiguity;
	candidate_group?: string | null;
	candidate_reason?: string | null;
	weight?: number;
	valid_from: number;
	valid_to?: number | null;
	attrs?: Record<string, unknown>;
	freshness?: FreshnessState;
	source_ref?: LocationHandle;
}

export const ALLOWED_EDGE_ATTR_KEYS = new Set([
	"dynamic",
	"lazy",
	"type_only",
	"via",
	"augmentation",
	"boundary",
	"expected",
	"reason",
	"invalidated_reason",
	"convention",
	"framework",
	"heuristic",
	"candidate_count",
	"federated",
]);

export function validateEdgeAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(attrs)) {
		if (value === undefined) continue;
		if (!ALLOWED_EDGE_ATTR_KEYS.has(key)) continue;

		if (typeof value === "string") {
			cleaned[key] = value.length > 512 ? value.slice(0, 512) : value;
		} else if (Array.isArray(value)) {
			cleaned[key] = value.length > 64 ? value.slice(0, 64) : value;
		} else {
			cleaned[key] = value;
		}
	}
	return cleaned;
}
