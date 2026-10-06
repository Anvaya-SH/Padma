// Sūkṣmaśastra Crash Recovery Module (Part F2, S6-APP-004)
// Detects interrupted applies via .start and .complete markers, inspects on-disk preimages,
// and classifies crash recovery state as CONFIRMED_COMPLETE, NOT_APPLIED, or PARTIAL.

import fs from "node:fs/promises";
import path from "node:path";
import { computeContentDigest, type RollbackBundle, restoreRollbackBundle } from "../pipeline/rollback.ts";
import type { InMemoryArtifactStore } from "../ports/artifact-store.ts";

export type CrashRecoveryStatus = "CONFIRMED_COMPLETE" | "NOT_APPLIED" | "PARTIAL";

export interface CrashRecoveryResult {
	readonly status: CrashRecoveryStatus;
	readonly plan_id: string;
	readonly message: string;
	readonly restoredFiles?: string[];
}

/**
 * Recovers repository state after a crash or power failure during plan application.
 */
export async function recoverCrashState(
	planId: string,
	workspaceRoot: string,
	artifactStore: InMemoryArtifactStore,
): Promise<CrashRecoveryResult> {
	const markerDir = path.join(workspaceRoot, ".padma", "markers");
	const startMarkerPath = path.join(markerDir, `${planId}.start`);
	const completeMarkerPath = path.join(markerDir, `${planId}.complete`);

	// Case 1: Completion marker exists -> Apply was confirmed complete
	try {
		await fs.access(completeMarkerPath);
		return {
			status: "CONFIRMED_COMPLETE",
			plan_id: planId,
			message: "Plan application confirmed complete via completion marker",
		};
	} catch {
		// Not complete
	}

	// Case 2: Start marker does not exist -> Never started or cleanly cleaned up
	try {
		await fs.access(startMarkerPath);
	} catch {
		return {
			status: "NOT_APPLIED",
			plan_id: planId,
			message: "No start marker found; plan was never applied to disk",
		};
	}

	// Case 3: Start marker exists but no completion marker -> Interrupted mid-apply!
	const startRaw = await fs.readFile(startMarkerPath, "utf8");
	const startData = JSON.parse(startRaw);
	const rollbackDigest = startData.rollback_ref as string | undefined;

	if (!rollbackDigest) {
		return {
			status: "PARTIAL",
			plan_id: planId,
			message: "Interrupted apply found but no rollback artifact reference recorded",
		};
	}

	const bundleRaw = await artifactStore.get(rollbackDigest);
	if (!bundleRaw) {
		return {
			status: "PARTIAL",
			plan_id: planId,
			message: `Rollback artifact '${rollbackDigest}' missing from store; manual review required`,
		};
	}

	const bundle: RollbackBundle = JSON.parse(bundleRaw);

	// Inspect on-disk state of all files in bundle
	let allMatchPreimage = true;

	for (const f of bundle.files) {
		const fullPath = path.resolve(workspaceRoot, f.path);
		try {
			const currentText = await fs.readFile(fullPath, "utf8");
			const currentDigest = computeContentDigest(currentText);
			if (currentDigest !== f.originalDigest) {
				allMatchPreimage = false;
			}
		} catch {
			allMatchPreimage = false;
		}
	}

	if (allMatchPreimage) {
		// No files were modified before the crash
		await fs.unlink(startMarkerPath).catch(() => {});
		return {
			status: "NOT_APPLIED",
			plan_id: planId,
			message: "All target files match their preimages; no changes were committed to disk",
		};
	}

	// Some or all files modified: perform safe rollback to preimage
	const restoreRes = await restoreRollbackBundle(bundle, workspaceRoot);
	await fs.unlink(startMarkerPath).catch(() => {});

	if (restoreRes.success) {
		return {
			status: "PARTIAL",
			plan_id: planId,
			message: "Crash interrupted apply mid-rename; safely restored all files to pre-edit baseline",
			restoredFiles: restoreRes.restored,
		};
	}

	return {
		status: "PARTIAL",
		plan_id: planId,
		message: `Crash interrupted apply and rollback failed: ${restoreRes.errors.join("; ")}`,
		restoredFiles: restoreRes.restored,
	};
}
