// Sūkṣmaśastra Transformations Index & Dispatcher (Part E2, S6-TX-001..004)
// Exports all transformation operators and dispatches transformations by kind.

import type { Anchor } from "../model/anchors.ts";
import type { ByteRangeEdit } from "../model/diff.ts";
import type { Transformation } from "../model/plan.ts";
import { SukshmashastraError } from "../model/reason-codes.ts";

export * from "./change-signature.ts";
export * from "./config-migration.ts";
export * from "./custom.ts";
export * from "./delete.ts";
export * from "./insert.ts";
export * from "./move.ts";
export * from "./rename.ts";
export * from "./replace-node.ts";
export * from "./rewrite-imports.ts";

import { changeSignature, type SignatureChangeSpec } from "./change-signature.ts";
import { type ConfigUpdateSpec, migrateConfig } from "./config-migration.ts";
import { runCustomCodemod } from "./custom.ts";
import { deleteNode } from "./delete.ts";
import { type InsertionPlacement, insertNode } from "./insert.ts";
import { type MentionUnmodified, renameIdentifier } from "./rename.ts";
import { replaceNode } from "./replace-node.ts";
import {
	type AddImportSpec,
	addImport,
	type RemoveImportSpec,
	removeImport,
	rewriteImportSpecifier,
	rewriteModuleSpecifier,
} from "./rewrite-imports.ts";

const SUPPORTED_TS_JS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

const CONFIG_EXTS = new Set([".json", ".jsonc", ".yaml", ".yml"]);

/**
 * Validates that the file has a supported extension for structural editing (S6-TX-004).
 */
export function validateFileLanguageSupport(filePath: string, kind: string): void {
	const lower = filePath.toLowerCase();
	const extIdx = lower.lastIndexOf(".");
	const ext = extIdx !== -1 ? lower.slice(extIdx) : "";

	if (kind === "config_migration") {
		if (!CONFIG_EXTS.has(ext)) {
			throw new SukshmashastraError(
				"UNSUPPORTED_LANGUAGE",
				`Configuration migration does not support file format '${ext}' (only JSON, JSONC, YAML)`,
			);
		}
		return;
	}

	if (!SUPPORTED_TS_JS_EXTS.has(ext)) {
		throw new SukshmashastraError(
			"UNSUPPORTED_LANGUAGE",
			`Structural editing in Phase 6 only supports TypeScript and JavaScript (.ts, .tsx, .js, .jsx). Received: '${ext}'`,
		);
	}
}

export interface TransformationDispatchResult {
	readonly edits: ByteRangeEdit[];
	readonly mentions_unmodified?: MentionUnmodified[];
	readonly flags?: Array<{
		readonly code: "MANUAL_REVIEW_REQUIRED";
		readonly message: string;
		readonly location: string;
	}>;
}

/**
 * Dispatches a transformation according to its kind against source text.
 */
export async function dispatchTransformation(
	source: string,
	tx: Transformation,
	anchors: Map<string, Anchor>,
): Promise<TransformationDispatchResult> {
	validateFileLanguageSupport(tx.target_file, tx.kind);

	const anchor = tx.anchor_id ? anchors.get(tx.anchor_id) : undefined;

	switch (tx.kind) {
		case "rename": {
			const oldName = String(tx.parameters?.oldName ?? anchor?.identifier ?? "");
			const newName = String(tx.parameters?.newName ?? tx.replacement_text ?? "");
			if (!oldName || !newName) {
				throw new Error("Rename transformation requires 'oldName' and 'newName'");
			}
			const res = renameIdentifier(source, oldName, newName, {
				scopeStart: anchor?.range?.startByte,
				scopeEnd: anchor?.range?.endByte,
			});
			return {
				edits: res.edits,
				mentions_unmodified: res.mentions_unmodified,
			};
		}

		case "replace_node": {
			if (!anchor) {
				throw new SukshmashastraError("NOT_FOUND", `Anchor '${tx.anchor_id}' not found`);
			}
			if (tx.replacement_text === undefined) {
				throw new Error("replace_node requires replacement_text");
			}
			const res = replaceNode(source, anchor, tx.replacement_text);
			return { edits: res.edits };
		}

		case "insert": {
			if (!anchor) {
				throw new SukshmashastraError("NOT_FOUND", `Anchor '${tx.anchor_id}' not found`);
			}
			const placement = (tx.parameters?.placement ?? "AFTER") as InsertionPlacement;
			const text = tx.replacement_text ?? "";
			const res = insertNode(source, anchor, placement, text);
			return { edits: res.edits };
		}

		case "delete": {
			if (!anchor) {
				throw new SukshmashastraError("NOT_FOUND", `Anchor '${tx.anchor_id}' not found`);
			}
			const activeRefs = (tx.parameters?.activeReferences as any) ?? [];
			const res = deleteNode(source, anchor, activeRefs);
			return { edits: res.edits };
		}

		case "rewrite_imports": {
			const subKind = tx.parameters?.subKind as string;
			if (subKind === "add") {
				const edits = addImport(source, tx.parameters?.spec as AddImportSpec);
				return { edits };
			}
			if (subKind === "remove") {
				const edits = removeImport(source, tx.parameters?.spec as RemoveImportSpec);
				return { edits };
			}
			if (subKind === "rewrite_module") {
				const oldMod = String(tx.parameters?.oldModule);
				const newMod = String(tx.parameters?.newModule);
				const edits = rewriteModuleSpecifier(source, oldMod, newMod);
				return { edits };
			}
			if (subKind === "rewrite_specifier") {
				const oldSpec = String(tx.parameters?.oldSpecifier);
				const newSpec = String(tx.parameters?.newSpecifier);
				const edits = rewriteImportSpecifier(source, {
					oldSpecifier: oldSpec,
					newSpecifier: newSpec,
					moduleSpecifier: tx.parameters?.moduleSpecifier as string | undefined,
				});
				return { edits };
			}
			throw new Error(`Unsupported rewrite_imports subKind: ${subKind}`);
		}

		case "change_signature": {
			if (!anchor) {
				throw new SukshmashastraError("NOT_FOUND", `Anchor '${tx.anchor_id}' not found`);
			}
			const spec = (tx.parameters?.spec as SignatureChangeSpec) ?? {};
			const callSites = (tx.parameters?.callSites as any) ?? [];
			const res = changeSignature(source, anchor, spec, callSites);
			return { edits: res.edits, flags: res.flags };
		}

		case "config_migration": {
			const updates = (tx.parameters?.updates as ConfigUpdateSpec[]) ?? [];
			const res = migrateConfig(tx.target_file, source, updates);
			return { edits: res.edits };
		}

		case "custom": {
			const script = tx.replacement_text ?? "";
			const res = await runCustomCodemod(source, script, 5000, tx.target_file);
			return { edits: res.edits };
		}

		default:
			throw new Error(`Unknown transformation kind: ${tx.kind}`);
	}
}
