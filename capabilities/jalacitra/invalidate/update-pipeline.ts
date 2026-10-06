// Jālacitra Update Pipeline with Shrink Guard & Journal (Part K1-K4, J5-INC-001..005, J5-TXN-001..004)

import { readFileSync } from "node:fs";
import { AdapterRegistry, type ExtractContext } from "../adapters/adapter.ts";
import { ConfigAdapter } from "../adapters/config/config-adapter.ts";
import { GenericFallbackAdapter } from "../adapters/generic/fallback.ts";
import { ManifestAdapter } from "../adapters/manifest/manifest-adapter.ts";
import { TestFrameworkAdapter } from "../adapters/tests/test-adapter.ts";
import { TypeScriptAdapter } from "../adapters/typescript/ts-adapter.ts";
import { enumerateRepository, type InventoryEntry } from "../inventory/enumerate.ts";
import { linkConfigToCode, linkTestsToCode } from "../resolve/linkers.ts";
import { type FileExtractionBatch, resolveGraph } from "../resolve/resolver.ts";
import { evaluateShrinkGuard, type ShrinkGuardLimits } from "../store/shrink-guard.ts";
import type { JalacitraStore } from "../store/store.ts";
import { planChangeSet } from "./invalidation-planner.ts";

export interface BuildOptions {
	repoRoot: string;
	repoIdentity: string;
	workspaceGeneration?: string | null;
	buildGeneration?: string | null;
	baseCommit?: string | null;
	dirty?: boolean;
	configFingerprint?: string;
	shrinkLimits?: ShrinkGuardLimits;
	shrinkOverrideReason?: string;
}

export interface BuildResult {
	success: boolean;
	generation: number;
	nodesCount: number;
	edgesCount: number;
	filesIndexed: number;
	wallMs: number;
	abortedReason?: string;
}

export class IndexUpdatePipeline {
	private registry = new AdapterRegistry();

	constructor() {
		this.registry.register(new TypeScriptAdapter());
		this.registry.register(new ManifestAdapter());
		this.registry.register(new ConfigAdapter());
		this.registry.register(new TestFrameworkAdapter());
		this.registry.register(new GenericFallbackAdapter());
	}

	buildFullOrIncremental(
		store: JalacitraStore,
		options: BuildOptions,
		cachedInventory?: Map<string, InventoryEntry>,
	): BuildResult {
		const startTime = Date.now();
		const currentGen = store.getCurrentGeneration();
		const isInitialBuild = currentGen === null;

		// 1. Enumerate repository
		const currentInventory = enumerateRepository(options.repoRoot);
		const prevMap = cachedInventory ?? new Map<string, InventoryEntry>();

		// 2. Journal entry
		const buildId = `build_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const fileDigestSummary = currentInventory.files
			.map((f) => `${f.path}:${f.contentDigest}`)
			.sort()
			.join(";");
		const idempotencyKey = `idem_${options.repoIdentity}_${fileDigestSummary}_${options.configFingerprint ?? "default"}`;
		store.journal.start(buildId, currentInventory.files.length, idempotencyKey);

		try {
			// 3. Plan changes
			const changeSet = planChangeSet(prevMap, currentInventory, store);

			// Extract all or incremental
			const extractionBatches: FileExtractionBatch[] = [];
			const ctx: ExtractContext = {
				repoView: {
					repoRoot: options.repoRoot,
					repoIdentity: options.repoIdentity,
					files: currentInventory.files.map((f) => f.path),
				},
				timeoutMs: 5000,
			};

			for (const file of currentInventory.files) {
				const adapter = this.registry.findForFile(file) ?? new GenericFallbackAdapter();
				let bytes: Uint8Array;
				try {
					bytes = readFileSync(file.absolutePath);
				} catch {
					continue;
				}
				const extractRes = this.registry.safeExtract(adapter, ctx, file, bytes);
				extractionBatches.push({ file, result: extractRes });
			}

			// 4. Resolve Graph
			const proposedGen = (currentGen?.index_generation ?? 0) + 1;
			const resolved = resolveGraph(options.repoIdentity, proposedGen, extractionBatches);

			// Run Linkers
			const testEdges = linkTestsToCode({
				repoId: options.repoIdentity,
				generation: proposedGen,
				nodes: resolved.nodes,
				edges: resolved.edges,
			});
			resolved.edges.push(...testEdges);

			const configRes = linkConfigToCode({
				repoId: options.repoIdentity,
				generation: proposedGen,
				nodes: resolved.nodes,
				edges: resolved.edges,
			});
			resolved.nodes.push(...configRes.newNodes);
			resolved.edges.push(...configRes.newEdges);

			// 5. Shrink Guard check
			if (!isInitialBuild) {
				const prevNodes = store.countNodes(currentGen.index_generation);
				const prevEdges = store.countEdges(currentGen.index_generation);
				const prevFiles = store.countFiles(currentGen.index_generation);

				const assessment = evaluateShrinkGuard(
					prevNodes,
					resolved.nodes.length,
					prevEdges,
					resolved.edges.length,
					prevFiles,
					changeSet.removed.length,
					options.shrinkLimits,
					options.shrinkOverrideReason,
				);

				if (!assessment.allowed) {
					store.journal.abort(buildId);
					return {
						success: false,
						generation: currentGen.index_generation,
						nodesCount: prevNodes,
						edgesCount: prevEdges,
						filesIndexed: 0,
						wallMs: Date.now() - startTime,
						abortedReason: assessment.reason ?? "SHRINK_GUARD",
					};
				}
			}

			// 6. Commit in atomic transaction
			store.beginTransaction();
			try {
				const newGen = store.mintGeneration(
					options.workspaceGeneration ?? null,
					options.buildGeneration ?? null,
					options.baseCommit ?? null,
					options.dirty ?? false,
					options.configFingerprint ?? "cfg_default",
					`Build ${buildId}`,
				);

				// Close superseded nodes and edges if not initial
				if (!isInitialBuild) {
					const prevNodeIds = store
						.findNodesByKind("file")
						.concat(store.findNodesByKind("symbol"))
						.map((n) => n.id);
					store.closeNodes(prevNodeIds, newGen);
					const prevEdgeIds = store.rawDb.prepare("SELECT id FROM edges WHERE valid_to IS NULL").all() as Array<{
						id: string;
					}>;
					store.closeEdges(
						prevEdgeIds.map((e) => e.id),
						newGen,
					);
				}

				// Insert new nodes, files, edges
				store.batchInsertNodes(resolved.nodes);
				for (const batch of extractionBatches) {
					store.insertFile({
						node_id: resolved.nodes.find((n) => n.attrs?.path === batch.file.path)?.id ?? batch.file.path,
						path: batch.file.path,
						language: batch.file.language,
						class: batch.file.class,
						size_bytes: batch.file.sizeBytes,
						content_digest: batch.file.contentDigest,
						mtime_ns: batch.file.mtimeNs ?? null,
						is_binary: batch.file.isBinary,
					});

					store.insertExtraction({
						file_node_id: resolved.nodes.find((n) => n.attrs?.path === batch.file.path)?.id ?? batch.file.path,
						adapter_id: "typescript",
						adapter_version: "1.0.0",
						grammar_version: "7.0.2",
						config_fingerprint: options.configFingerprint ?? "cfg_default",
						content_digest: batch.file.contentDigest,
						status: batch.result.status,
						reason_code: batch.result.reasonCode ?? null,
						blind_spots: batch.result.blindSpots,
						extracted_at_generation: newGen,
					});
				}

				store.batchInsertEdges(resolved.edges);

				for (const dep of resolved.rowDependencies) {
					store.insertRowDependency(dep.rowKind, dep.rowId, dep.dependsOnFile, dep.dependsOnConfig);
				}

				store.commitTransaction();
				store.journal.commit(buildId);

				return {
					success: true,
					generation: newGen,
					nodesCount: resolved.nodes.length,
					edgesCount: resolved.edges.length,
					filesIndexed: currentInventory.files.length,
					wallMs: Date.now() - startTime,
				};
			} catch (txnErr) {
				store.rollbackTransaction();
				throw txnErr;
			}
		} catch (err: unknown) {
			store.journal.abort(buildId);
			const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
			return {
				success: false,
				generation: currentGen?.index_generation ?? 0,
				nodesCount: 0,
				edgesCount: 0,
				filesIndexed: 0,
				wallMs: Date.now() - startTime,
				abortedReason: msg,
			};
		}
	}
}
