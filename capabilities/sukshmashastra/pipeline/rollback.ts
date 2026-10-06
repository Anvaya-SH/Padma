// Sūkṣmaśastra Rollback Preimage Artifacts (Part F1 Stage 8, S6-PIPE-001, S6-APP-003)
// Creates, serializes, and restores file preimages for atomic multi-file apply and crash recovery.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ArtifactReference } from "../model/plan.ts";
import type { InMemoryArtifactStore } from "../ports/artifact-store.ts";

export interface RollbackEntry {
	readonly path: string; // Repo-relative canonical path
	readonly originalDigest: string; // SHA-256 of original bytes
	readonly originalContent: string;
}

export interface RollbackBundle {
	readonly plan_id: string;
	readonly timestamp: string;
	readonly files: readonly RollbackEntry[];
}

/**
 * Computes SHA-256 digest of string or buffer.
 */
export function computeContentDigest(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Creates a rollback bundle artifact for a set of target files.
 */
export async function createRollbackArtifact(
	planId: string,
	files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
	artifactStore: InMemoryArtifactStore,
): Promise<{ reference: ArtifactReference; bundle: RollbackBundle }> {
	const entries: RollbackEntry[] = files.map((f) => ({
		path: f.path,
		originalDigest: computeContentDigest(f.content),
		originalContent: f.content,
	}));

	const bundle: RollbackBundle = {
		plan_id: planId,
		timestamp: new Date().toISOString(),
		files: entries,
	};

	const serialized = JSON.stringify(bundle, null, 2);
	const res = await artifactStore.put(serialized);

	return {
		reference: {
			digest: res.digest,
			size: res.size,
		},
		bundle,
	};
}

/**
 * Restores all files in a rollback bundle back to disk.
 */
export async function restoreRollbackBundle(
	bundle: RollbackBundle,
	workspaceRoot: string,
): Promise<{ success: boolean; restored: string[]; errors: string[] }> {
	const restored: string[] = [];
	const errors: string[] = [];

	for (const entry of bundle.files) {
		const fullPath = path.resolve(workspaceRoot, entry.path);
		try {
			await fs.writeFile(fullPath, entry.originalContent, "utf8");
			restored.push(entry.path);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			errors.push(`Failed restoring ${entry.path}: ${msg}`);
		}
	}

	return {
		success: errors.length === 0,
		restored,
		errors,
	};
}
