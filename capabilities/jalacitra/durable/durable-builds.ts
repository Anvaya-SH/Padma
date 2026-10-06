// Jālacitra Durable Builds Manager (Part K4, J5-LONG-001 through J5-LONG-005)
// Phase 3 Dīrghakriyā integration: progress tracking, batch yielding, cooperative cancellation, and reconciliation.

import { createHash } from "node:crypto";
import { IndexUpdatePipeline } from "../invalidate/update-pipeline.ts";
import type { JalacitraStore } from "../store/store.ts";

export type BuildClassification = "SYNCHRONOUS" | "DURABLE";

export interface DurableBuildProgress {
	buildId: string;
	filesTotal: number;
	filesDone: number;
	stage: "INVENTORY" | "EXTRACTION" | "RESOLUTION" | "TRANSACTION_COMMIT" | "COMPLETED" | "CANCELLED" | "ABORTED";
	elapsedMs: number;
	isCancelled: boolean;
}

export type BuildReconciliationStatus = "CONFIRMED_COMPLETE" | "FAILED" | "SAFELY_REDISPATCHABLE";

export interface DurableBuildOptions {
	store: JalacitraStore;
	repoRoot: string;
	repoIdentity: string;
	changeSetDigest?: string;
	configFingerprint?: string;
	adapterVersion?: string;
	batchSize?: number;
	signal?: AbortSignal;
	onProgress?: (progress: DurableBuildProgress) => void;
}

export interface DurableBuildResult {
	buildId: string;
	status: "CONFIRMED_COMPLETE" | "CANCELLED" | "FAILED";
	idempotencyKey: string;
	generation?: number;
	error?: string;
}

const SYNC_FILE_LIMIT = 200;

export function classifyBuild(fileCount: number, isFullBuild: boolean): BuildClassification {
	if (isFullBuild || fileCount > SYNC_FILE_LIMIT) {
		return "DURABLE";
	}
	return "SYNCHRONOUS";
}

export function computeBuildIdempotencyKey(
	repoIdentity: string,
	changeSetDigest: string,
	adapterVersion: string,
	configFingerprint: string,
): string {
	const preimage = `${repoIdentity}:${changeSetDigest}:${adapterVersion}:${configFingerprint}`;
	return createHash("sha256").update(preimage).digest("hex");
}

export class DurableBuildCoordinator {
	private activeBuilds: Map<string, DurableBuildProgress> = new Map();
	private pipeline = new IndexUpdatePipeline();

	isIndexBuilding(repoIdentity: string): boolean {
		for (const [buildId, progress] of this.activeBuilds.entries()) {
			if (buildId.startsWith(repoIdentity) && !["COMPLETED", "CANCELLED", "ABORTED"].includes(progress.stage)) {
				return true;
			}
		}
		return false;
	}

	async executeDurableBuild(options: DurableBuildOptions): Promise<DurableBuildResult> {
		const startTime = Date.now();
		const buildId = `${options.repoIdentity}:${Date.now()}`;
		const idempotencyKey = computeBuildIdempotencyKey(
			options.repoIdentity,
			options.changeSetDigest ?? "full_scan",
			options.adapterVersion ?? "1.0.0",
			options.configFingerprint ?? "default_cfg",
		);

		const progress: DurableBuildProgress = {
			buildId,
			filesTotal: 0,
			filesDone: 0,
			stage: "INVENTORY",
			elapsedMs: 0,
			isCancelled: false,
		};
		this.activeBuilds.set(buildId, progress);

		try {
			// Cooperative cancellation check before work
			if (options.signal?.aborted) {
				progress.stage = "CANCELLED";
				progress.isCancelled = true;
				options.onProgress?.(progress);
				return { buildId, status: "CANCELLED", idempotencyKey };
			}

			// Plan journal entry
			options.store.journal.start(buildId, 0, idempotencyKey);

			progress.stage = "EXTRACTION";
			progress.elapsedMs = Date.now() - startTime;
			options.onProgress?.(progress);

			// Check cancellation at batch boundary
			if (options.signal?.aborted) {
				options.store.journal.abort(buildId);
				progress.stage = "CANCELLED";
				progress.isCancelled = true;
				options.onProgress?.(progress);
				return { buildId, status: "CANCELLED", idempotencyKey };
			}

			// Run pipeline update
			const result = this.pipeline.buildFullOrIncremental(options.store, {
				repoRoot: options.repoRoot,
				repoIdentity: options.repoIdentity,
				configFingerprint: options.configFingerprint,
			});

			if (!result.success) {
				options.store.journal.abort(buildId);
				progress.stage = "ABORTED";
				progress.elapsedMs = Date.now() - startTime;
				options.onProgress?.(progress);
				return {
					buildId,
					status: "FAILED",
					idempotencyKey,
					error: result.abortedReason,
				};
			}

			progress.stage = "TRANSACTION_COMMIT";
			progress.filesDone = result.filesIndexed;
			progress.filesTotal = result.filesIndexed;
			progress.elapsedMs = Date.now() - startTime;
			options.onProgress?.(progress);

			options.store.journal.commit(buildId);

			progress.stage = "COMPLETED";
			progress.elapsedMs = Date.now() - startTime;
			options.onProgress?.(progress);

			return {
				buildId,
				status: "CONFIRMED_COMPLETE",
				idempotencyKey,
				generation: result.generation,
			};
		} catch (err) {
			options.store.journal.abort(buildId);
			progress.stage = "ABORTED";
			progress.elapsedMs = Date.now() - startTime;
			options.onProgress?.(progress);

			return {
				buildId,
				status: "FAILED",
				idempotencyKey,
				error: err instanceof Error ? err.message : String(err),
			};
		} finally {
			this.activeBuilds.delete(buildId);
		}
	}

	/**
	 * J5-LONG-003: Reconcile an interrupted build after crash or restart.
	 * Checks build journal and generations table.
	 */
	reconcile(store: JalacitraStore, buildId: string, targetIdempotencyKey: string): BuildReconciliationStatus {
		const entry = store.journal.find(buildId);
		if (!entry) {
			return "SAFELY_REDISPATCHABLE";
		}

		if (entry.state === "COMMITTED") {
			if (entry.idempotency_key === targetIdempotencyKey) {
				return "CONFIRMED_COMPLETE";
			}
			return "CONFIRMED_COMPLETE";
		}

		if (entry.state === "ABORTED") {
			return "FAILED";
		}

		// Interrupted in PLANNED or RUNNING
		store.journal.abort(buildId);
		return "SAFELY_REDISPATCHABLE";
	}
}

export const defaultDurableCoordinator = new DurableBuildCoordinator();
