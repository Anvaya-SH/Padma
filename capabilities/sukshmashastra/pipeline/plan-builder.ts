// Sūkṣmaśastra 8-Stage Plan Validation Pipeline (Part F1, S6-PIPE-001, S6-PIPE-002, S6-INV-001..005)
// Builds, validates, previews, and secures structural edit plans.

import { resolveAnchor } from "../anchors/resolver.ts";
import { deriveMergedImpact } from "../engine/impact-merger.ts";
import { checkSyntax, validateStructuralDeclarations } from "../engine/syntax-validator.ts";
import type { Anchor } from "../model/anchors.ts";
import {
	applyRangeEdits,
	type ByteRangeEdit,
	computeFileDiff,
	createUnifiedDiffReport,
	type FileDiffPreview,
	validateNoOverlappingEdits,
} from "../model/diff.ts";
import type { BoundRepoTarget, StructuralEditPlan, Transformation } from "../model/plan.ts";
import { SukshmashastraError } from "../model/reason-codes.ts";
import { defaultArtifactStore, type InMemoryArtifactStore } from "../ports/artifact-store.ts";
import { dispatchTransformation, validateFileLanguageSupport } from "../transformations/index.ts";
import { createRollbackArtifact } from "./rollback.ts";

export interface PlanBuilderInput {
	readonly planId?: string;
	readonly repoBinding: BoundRepoTarget;
	readonly activeBinding: BoundRepoTarget;
	readonly baseCommit: string;
	readonly activeBaseCommit: string;
	readonly workspaceGeneration: string;
	readonly activeWorkspaceGeneration: string;
	readonly atlasSnapshotId?: string;
	readonly intent: string;
	readonly anchors: readonly Anchor[];
	readonly transformations: readonly Transformation[];
	readonly files: ReadonlyMap<string, string>; // path -> content
	readonly artifactStore?: InMemoryArtifactStore;
}

const SECRET_PATTERNS = [
	/-----BEGIN [A-Z0-9 ]+PRIVATE KEY-----/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\bghp_[a-zA-Z0-9]{36}\b/,
	/\bsk-[a-zA-Z0-9]{32,}\b/,
	/\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/,
];

/**
 * Validates sensitive file access and path confinement (S6-INV-001, S6-SEC-004, S6-SEC-005).
 */
export function validateScopeAndPath(filePath: string): void {
	const normalized = filePath.replace(/\\/g, "/");

	// Path traversal / escaping root
	if (
		normalized.startsWith("/") ||
		normalized.startsWith("../") ||
		normalized.includes("/../") ||
		/^[a-zA-Z]:/.test(normalized)
	) {
		throw new SukshmashastraError(
			"PATH_OUTSIDE_ROOT",
			`File path '${filePath}' resolves outside repository workspace`,
		);
	}

	// Sensitive paths matching kernel secretPath definition
	const lower = normalized.toLowerCase();
	const isSecretFile =
		/(?:^|[\\/])(?:\.env(?:\..*)?|auth\.json|credentials(?:\.json)?|.*\.(?:pem|key))$/i.test(lower) ||
		/(?:^|[\\/])(?:\.ssh|\.gnupg|\.git|\.padma|\.sandhana-storage)(?:[\\/]|$)/i.test(lower);

	if (isSecretFile) {
		throw new SukshmashastraError("SCOPE_DENIED", `File path '${filePath}' is restricted by ScopePolicy`);
	}
}

/**
 * Scans replacement text for accidentally included secrets or API keys (S6-SEC-001).
 */
export function scanForSecrets(text: string): void {
	for (const pattern of SECRET_PATTERNS) {
		if (pattern.test(text)) {
			throw new SukshmashastraError(
				"SECRET_IN_REPLACEMENT",
				"Proposed replacement text contains a detected secret or private key pattern",
			);
		}
	}
}

/**
 * Executes the complete 8-stage Validation Pipeline (S6-PIPE-001).
 */
export async function buildAndValidatePlan(input: PlanBuilderInput): Promise<StructuralEditPlan> {
	const planId = input.planId ?? `plan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
	const store = input.artifactStore ?? defaultArtifactStore;

	// ==========================================
	// STAGE 1: BINDING & SCOPE CHECK (S6-KER-001, S6-KER-002)
	// ==========================================
	if (
		input.repoBinding.canonical_path !== input.activeBinding.canonical_path ||
		input.repoBinding.repository_identity !== input.activeBinding.repository_identity ||
		input.baseCommit !== input.activeBaseCommit ||
		input.workspaceGeneration !== input.activeWorkspaceGeneration
	) {
		throw new SukshmashastraError(
			"BINDING_MISMATCH",
			`Target binding mismatch: base_commit '${input.baseCommit}' vs active '${input.activeBaseCommit}', gen '${input.workspaceGeneration}' vs '${input.activeWorkspaceGeneration}'`,
		);
	}

	for (const tx of input.transformations) {
		validateScopeAndPath(tx.target_file);
		validateFileLanguageSupport(tx.target_file, tx.kind);
	}

	// ==========================================
	// STAGE 2: ANCHOR RESOLUTION (S6-ANC-001..004)
	// ==========================================
	const resolvedAnchorsMap = new Map<string, Anchor>();
	const verifiedAnchors: Anchor[] = [];

	for (const anchor of input.anchors) {
		const targetFile = anchor.targetFile ?? anchor.file_id?.replace(/^file:/, "");
		const content = input.files.get(targetFile);
		if (content === undefined) {
			throw new SukshmashastraError(
				"NOT_FOUND",
				`Target file '${targetFile}' for anchor '${anchor.anchor_id ?? anchor.id}' not present in context`,
			);
		}

		const bytes = new TextEncoder().encode(content);
		const res = resolveAnchor(anchor, bytes);
		if (res.status === "NOT_FOUND") {
			throw new SukshmashastraError(
				"NOT_FOUND",
				`Anchor '${anchor.structural_selector ?? anchor.selector}' could not be resolved in '${targetFile}'`,
			);
		}
		if (res.status === "AMBIGUOUS") {
			throw new SukshmashastraError(
				"AMBIGUOUS",
				`Anchor '${anchor.structural_selector ?? anchor.selector}' is ambiguous in '${targetFile}' (${res.candidates.length} candidates found)`,
			);
		}

		const resolvedRange = (res as any).range as [number, number];
		const anchorId = anchor.anchor_id ?? anchor.id ?? `anc_${verifiedAnchors.length}`;
		const verifiedAnchor: Anchor = {
			...anchor,
			anchor_id: anchorId,
			id: anchorId,
			file_id: anchor.file_id ?? `file:${targetFile}`,
			targetFile,
			source_range: resolvedRange,
			range: {
				startByte: resolvedRange[0],
				endByte: resolvedRange[1],
			},
		};

		resolvedAnchorsMap.set(anchorId, verifiedAnchor);
		if (anchor.id) resolvedAnchorsMap.set(anchor.id, verifiedAnchor);
		verifiedAnchors.push(verifiedAnchor);
	}

	// ==========================================
	// STAGE 3: TRANSFORMATION GENERATION & OVERLAP CHECK (S6-TX-001, S6-TX-002)
	// ==========================================
	const fileEditsMap = new Map<string, ByteRangeEdit[]>();
	const mentionsUnmodifiedAll: any[] = [];
	const expectedDeletedSymbols = new Set<string>();

	for (const tx of input.transformations) {
		const content = input.files.get(tx.target_file);
		if (content === undefined) {
			throw new SukshmashastraError("NOT_FOUND", `File '${tx.target_file}' not found in workspace`);
		}

		if (tx.kind === "delete" && tx.anchor_id) {
			const anc = resolvedAnchorsMap.get(tx.anchor_id);
			if (anc) expectedDeletedSymbols.add(`${anc.kind}:${anc.identifier}`);
		}

		// Check secrets in replacement text
		if (tx.replacement_text) {
			scanForSecrets(tx.replacement_text);
		}

		const res = await dispatchTransformation(content, tx, resolvedAnchorsMap);
		if (res.mentions_unmodified) {
			mentionsUnmodifiedAll.push(...res.mentions_unmodified);
		}

		const current = fileEditsMap.get(tx.target_file) ?? [];
		current.push(...res.edits);
		fileEditsMap.set(tx.target_file, current);
	}

	// Check for edit overlap per file
	for (const [, edits] of fileEditsMap.entries()) {
		validateNoOverlappingEdits(edits);
	}

	// ==========================================
	// STAGE 4: SECRET SCANNING (already completed above)
	// ==========================================

	// ==========================================
	// STAGE 5: IN-MEMORY APPLICATION
	// ==========================================
	const modifiedFilesMap = new Map<string, string>();
	for (const [filePath, content] of input.files.entries()) {
		const edits = fileEditsMap.get(filePath);
		if (edits && edits.length > 0) {
			const modified = applyRangeEdits(content, edits);
			scanForSecrets(modified);
			modifiedFilesMap.set(filePath, modified);
		} else {
			modifiedFilesMap.set(filePath, content);
		}
	}

	// ==========================================
	// STAGE 6: SYNTAX & INVARIANT CHECKS (S6-INV-005)
	// ==========================================
	const postParseReport: Record<string, any> = {};

	for (const [filePath, edits] of fileEditsMap.entries()) {
		if (edits.length === 0) continue;
		const pre = input.files.get(filePath)!;
		const post = modifiedFilesMap.get(filePath)!;

		// 1. Syntax check
		const syntaxRes = checkSyntax(post, filePath);
		if (!syntaxRes.valid) {
			throw new SukshmashastraError(
				"REJECTED_SYNTAX_ERROR",
				`File '${filePath}' has syntax errors after edits: ${syntaxRes.errors.join("; ")}`,
			);
		}

		// 2. Structural declaration invariant check
		const structRes = validateStructuralDeclarations(pre, post, expectedDeletedSymbols);
		if (!structRes.valid) {
			throw new SukshmashastraError(
				"UNDECLARED_STRUCTURAL_CHANGE",
				`Undeclared structural deletions in '${filePath}': ${structRes.undeclaredDeletions.join(", ")}`,
			);
		}

		postParseReport[filePath] = {
			valid: true,
			declarationsCount: syntaxRes.declarationsCount,
			topLevelNames: syntaxRes.topLevelNames,
		};
	}

	// ==========================================
	// STAGE 7: DIFF GENERATION & RISK TIER DERIVATION (S6-INV-008, S6-INV-010)
	// ==========================================
	const fileDiffs: FileDiffPreview[] = [];
	for (const [filePath, edits] of fileEditsMap.entries()) {
		if (edits.length === 0) continue;
		const orig = input.files.get(filePath)!;
		const mod = modifiedFilesMap.get(filePath)!;
		fileDiffs.push(computeFileDiff(filePath, orig, mod));
	}

	const diffReport = createUnifiedDiffReport(fileDiffs);

	// Risk Tier Derivation
	let suggestedTier: 0 | 1 | 2 | 3 | 4 = 1;
	const isLarge = diffReport.totalAddedLines + diffReport.totalRemovedLines > 2000 || diffReport.totalFiles > 50;

	if (isLarge) {
		suggestedTier = 4;
	} else if (diffReport.totalFiles > 5 || input.transformations.some((t) => t.kind === "change_signature")) {
		suggestedTier = 3;
	} else if (fileDiffs.some((fd) => fd.addedLines + fd.removedLines > 50)) {
		suggestedTier = 2;
	}

	// Store diff and post-parse artifacts
	const diffRef = await store.put(diffReport.rawUnifiedDiff);
	const postParseRef = await store.put(JSON.stringify(postParseReport, null, 2));

	// Derive impact & coverage
	const targetSymbols: string[] = verifiedAnchors
		.map((a) => a.identifier ?? a.structural_selector ?? a.selector ?? "")
		.filter(Boolean);

	const impactRes = await deriveMergedImpact({
		repoRoot: input.repoBinding.canonical_path,
		targetSymbols,
		sourceFiles: input.files instanceof Map ? input.files : new Map(Object.entries(input.files)),
	});

	// ==========================================
	// STAGE 8: ROLLBACK ARTIFACT GENERATION (S6-APP-003)
	// ==========================================
	const touchedFiles = Array.from(fileEditsMap.keys()).map((p) => ({
		path: p,
		content: input.files.get(p)!,
	}));

	const rollback = await createRollbackArtifact(planId, touchedFiles, store);

	return {
		plan_id: planId,
		repo_binding: input.repoBinding,
		base_commit: input.baseCommit,
		workspace_generation: input.workspaceGeneration,
		atlas_snapshot_id: input.atlasSnapshotId ?? "snap_active",
		language_and_parser_versions: {
			typescript: "5.x",
			sukshmashastra: "1.0.0",
		},
		intent: input.intent,
		anchors: verifiedAnchors,
		transformations: [...input.transformations],
		impact_evidence: impactRes.references.map((r) => ({
			id: r.id,
			provenance: r.provenance,
			location: `${r.targetFile}:${r.line}`,
		})),
		coverage: impactRes.coverage,
		preconditions: verifiedAnchors.map((a) => `file:${a.targetFile}#${a.signatureDigest ?? a.identifier}`),
		expected_diff_ref: {
			digest: diffRef.digest,
			size: diffRef.size,
		},
		post_parse_report_ref: {
			digest: postParseRef.digest,
			size: postParseRef.size,
		},
		candidate_validation_commands: impactRes.coverage.suggested_checks,
		suggested_risk_tier: suggestedTier,
		rollback_ref: rollback.reference,
		status: "VALIDATED",
	};
}
