// Jālacitra Node Kinds and Attributes (Part F2, F4, J5-NODE-001 through J5-NODE-003, J5-ATTR-001 through J5-ATTR-003)

import type { FreshnessState } from "./freshness.ts";

export type NodeKind =
	| "repository"
	| "commit"
	| "workspace_generation"
	| "build_target"
	| "package"
	| "module"
	| "file"
	| "symbol"
	| "dependency"
	| "test_case"
	| "config_key"
	| "external_contract"
	| "build_artifact"
	| "unresolved_ref"
	| "ui_element_binding"
	| "event_binding";

export type SymbolKind =
	| "function"
	| "method"
	| "class"
	| "interface"
	| "type_alias"
	| "enum"
	| "enum_member"
	| "variable"
	| "constant"
	| "property"
	| "namespace"
	| "decorator"
	| "jsx_component"
	| "test_helper"
	| "other";

export type FileClass =
	| "source"
	| "test"
	| "config"
	| "manifest"
	| "generated"
	| "vendored"
	| "docs"
	| "asset"
	| "other";

export interface NodeRecord {
	id: string;
	kind: NodeKind;
	canonical: string;
	name?: string | null;
	parent_id?: string | null;
	valid_from: number;
	valid_to?: number | null;
	attrs?: Record<string, unknown>;
	freshness?: FreshnessState;
}

export const ALLOWED_NODE_ATTR_KEYS: Record<NodeKind, ReadonlySet<string>> = {
	repository: new Set(["vcs", "root_identity", "case_sensitive"]),
	commit: new Set(["sha", "parents", "author_time"]),
	workspace_generation: new Set(["generation", "base_commit", "dirty"]),
	build_target: new Set(["tool", "config_file_id", "name", "command_digest", "command_excerpt", "command_complex"]),
	package: new Set(["ecosystem", "name", "version", "manifest_file_id"]),
	module: new Set(["language", "module_path"]),
	file: new Set([
		"path",
		"language",
		"size_bytes",
		"content_digest",
		"class",
		"class_method",
		"is_binary",
		"mtime_ns",
		"declaration_file",
		"boundary",
	]),
	symbol: new Set([
		"symbol_kind",
		"qualified_name",
		"visibility",
		"exported",
		"signature_digest",
		"declaration_group",
		"role",
		"heuristic",
		"component_heuristic",
		"type_only",
		"docstring_present",
		"docstring_digest",
	]),
	dependency: new Set(["ecosystem", "name", "version_spec", "scope"]),
	test_case: new Set(["framework", "qualified_name", "file_id", "kind"]),
	config_key: new Set(["scope", "key_path", "declared", "exposed_to_client", "client_exposure_unknown"]),
	external_contract: new Set(["contract_kind", "descriptor", "method", "path", "framework", "convention_version"]),
	build_artifact: new Set(["artifact_kind", "path_pattern", "produced_by_target_id", "expected"]),
	unresolved_ref: new Set(["raw_text_digest", "raw_text_excerpt", "reference_kind", "reason_code", "target_package"]),
	ui_element_binding: new Set(["element_id", "scene_generation", "build_generation"]),
	event_binding: new Set(["event_name", "scene_generation", "build_generation"]),
};

export function validateNodeAttrs(kind: NodeKind, attrs: Record<string, unknown>): Record<string, unknown> {
	const allowed = ALLOWED_NODE_ATTR_KEYS[kind];
	const cleaned: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(attrs)) {
		if (value === undefined) continue;
		if (allowed && !allowed.has(key)) {
			// Unknown key: drop with notice
			continue;
		}

		// J5-ATTR-002: Bounded values
		if (typeof value === "string") {
			if (value.length > 512) {
				cleaned[key] = value.slice(0, 512);
			} else {
				cleaned[key] = value;
			}
		} else if (Array.isArray(value)) {
			if (value.length > 64) {
				cleaned[key] = value.slice(0, 64);
			} else {
				cleaned[key] = value;
			}
		} else {
			cleaned[key] = value;
		}
	}

	return cleaned;
}
