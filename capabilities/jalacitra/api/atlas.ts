// Jālacitra Atlas Query Engine (Part M, J5-API-001 through J5-API-006, J5-MISS-001 through J5-MISS-003)

import { existsSync } from "node:fs";
import { JalacitraStore } from "../store/store.ts";
import { type ConfigUsageData, type ConfigUsageParams, configUsage } from "./config-usage.ts";
import {
	buildQueryResult,
	createDefaultContext,
	type QueryContext,
	type QueryResult,
	type SnapshotMeta,
	UsageTracker,
} from "./context.ts";
import { type DependenciesData, type DependenciesParams, dependencies } from "./dependencies.ts";
import { type DiscardData, type DiscardParams, discard } from "./discard.ts";
import { type EnsureIndexData, type EnsureIndexScope, ensureIndex } from "./ensure-index.ts";
import { type ExpandImpactData, type ExpandImpactParams, expandImpact } from "./expand-impact.ts";
import { type ExplainData, type ExplainParams, explain } from "./explain.ts";
import { type ExplainBuildPathData, type ExplainBuildPathParams, explainBuildPath } from "./explain-build-path.ts";
import { type FindRelevantTestsData, type FindRelevantTestsParams, findRelevantTests } from "./find-relevant-tests.ts";
import { type LocateData, type LocateParams, locate } from "./locate.ts";
import { type NeighborsData, type NeighborsParams, neighbors } from "./neighbors.ts";
import { findPath, type PathData, type PathParams } from "./path.ts";
import { type ResolveSymbolParams, resolveSymbol, type SymbolCandidate } from "./resolve-symbol.ts";
import { type AtlasStatusData, status } from "./status.ts";

export interface AtlasOptions {
	dbPath: string;
	repoRoot: string;
	repoIdentity: string;
}

export class Atlas {
	readonly dbPath: string;
	readonly repoRoot: string;
	readonly repoIdentity: string;
	private _store: JalacitraStore | null = null;

	constructor(options: AtlasOptions) {
		this.dbPath = options.dbPath;
		this.repoRoot = options.repoRoot;
		this.repoIdentity = options.repoIdentity;
	}

	get store(): JalacitraStore {
		if (!this._store) {
			this._store = new JalacitraStore(this.dbPath, this.repoIdentity);
		}
		return this._store;
	}

	hasStore(): boolean {
		if (this.dbPath === ":memory:") return this._store !== null;
		return existsSync(this.dbPath);
	}

	close(): void {
		if (this._store) {
			this._store.close();
			this._store = null;
		}
	}

	private guardStoreAbsent<T>(ctx: QueryContext, opName: string): QueryResult<T> | null {
		if (!this.hasStore()) {
			const tracker = new UsageTracker();
			const snapshotMeta: SnapshotMeta = {
				snapshot_id: `snap:${this.repoIdentity}:0`,
				index_generation: 0,
				workspace_generation: "0",
				build_generation: null,
			};
			return buildQueryResult<T>({
				snapshot: snapshotMeta,
				freshness: {
					requested: ctx.freshness,
					delivered: "UNVERIFIED",
					downgrade_reason: "INDEX_ABSENT",
					last_verified_at: new Date().toISOString(),
				},
				data: null as unknown as T,
				coverage: {
					scope: { repo_id: this.repoIdentity, snapshot_id: `snap:${this.repoIdentity}:0`, generation: 0 },
					files_considered: 0,
					files_indexed: 0,
					files_skipped: [],
					languages: [],
					known_blind_spots: [],
					completeness: "UNKNOWN",
					limitations: ["INDEX_ABSENT: Graph store does not exist. Call atlas.ensure_index first."],
				},
				negative_evidence: [
					{
						checked: `operation:${opName}`,
						result: "INDEX_ABSENT",
						completeness: "UNKNOWN",
					},
				],
				usage: tracker.report(),
			});
		}
		return null;
	}

	status(ctx?: Partial<QueryContext>): QueryResult<AtlasStatusData> {
		const fullCtx = createDefaultContext(
			{ repository_identity: this.repoIdentity, canonical_path: this.repoRoot },
			ctx,
		);
		const s = this.hasStore() ? this.store : null;
		return status(fullCtx, s, this.dbPath);
	}

	ensureIndex(scope?: EnsureIndexScope, ctx?: Partial<QueryContext>): QueryResult<EnsureIndexData> {
		const fullCtx = createDefaultContext(
			{ repository_identity: this.repoIdentity, canonical_path: this.repoRoot },
			ctx,
		);
		return ensureIndex(fullCtx, this.store, scope);
	}

	resolveSymbol(params: ResolveSymbolParams, ctx?: Partial<QueryContext>): QueryResult<SymbolCandidate[]> {
		const fullCtx = createDefaultContext(
			{ repository_identity: this.repoIdentity, canonical_path: this.repoRoot },
			ctx,
		);
		const absent = this.guardStoreAbsent<SymbolCandidate[]>(fullCtx, "resolve_symbol");
		if (absent) return absent;
		return resolveSymbol(fullCtx, this.store, params);
	}

	locate(params: LocateParams, ctx?: Partial<QueryContext>): QueryResult<LocateData> {
		const fullCtx = createDefaultContext(
			{ repository_identity: this.repoIdentity, canonical_path: this.repoRoot },
			ctx,
		);
		return locate(fullCtx, this.store, params);
	}

	neighbors(params: NeighborsParams, ctx?: Partial<QueryContext>): QueryResult<NeighborsData> {
		const fullCtx = createDefaultContext(
			{ repository_identity: this.repoIdentity, canonical_path: this.repoRoot },
			ctx,
		);
		const absent = this.guardStoreAbsent<NeighborsData>(fullCtx, "neighbors");
		if (absent) return absent;
		return neighbors(fullCtx, this.store, params);
	}

	expandImpact(params: ExpandImpactParams, ctx?: Partial<QueryContext>): QueryResult<ExpandImpactData> {
		const fullCtx = createDefaultContext(
			{ repository_identity: this.repoIdentity, canonical_path: this.repoRoot },
			ctx,
		);
		const absent = this.guardStoreAbsent<ExpandImpactData>(fullCtx, "expand_impact");
		if (absent) return absent;
		return expandImpact(fullCtx, this.store, params);
	}

	findRelevantTests(params: FindRelevantTestsParams, ctx?: Partial<QueryContext>): QueryResult<FindRelevantTestsData> {
		const fullCtx = createDefaultContext(
			{ repository_identity: this.repoIdentity, canonical_path: this.repoRoot },
			ctx,
		);
		const absent = this.guardStoreAbsent<FindRelevantTestsData>(fullCtx, "find_relevant_tests");
		if (absent) return absent;
		return findRelevantTests(fullCtx, this.store, params);
	}

	explainBuildPath(params: ExplainBuildPathParams, ctx?: Partial<QueryContext>): QueryResult<ExplainBuildPathData> {
		const fullCtx = createDefaultContext(
			{ repository_identity: this.repoIdentity, canonical_path: this.repoRoot },
			ctx,
		);
		const absent = this.guardStoreAbsent<ExplainBuildPathData>(fullCtx, "explain_build_path");
		if (absent) return absent;
		return explainBuildPath(fullCtx, this.store, params);
	}

	path(params: PathParams, ctx?: Partial<QueryContext>): QueryResult<PathData> {
		const fullCtx = createDefaultContext(
			{ repository_identity: this.repoIdentity, canonical_path: this.repoRoot },
			ctx,
		);
		const absent = this.guardStoreAbsent<PathData>(fullCtx, "path");
		if (absent) return absent;
		return findPath(fullCtx, this.store, params);
	}

	explain(params: ExplainParams, ctx?: Partial<QueryContext>): QueryResult<ExplainData | null> {
		const fullCtx = createDefaultContext(
			{ repository_identity: this.repoIdentity, canonical_path: this.repoRoot },
			ctx,
		);
		const absent = this.guardStoreAbsent<ExplainData | null>(fullCtx, "explain");
		if (absent) return absent;
		return explain(fullCtx, this.store, params);
	}

	dependencies(params: DependenciesParams, ctx?: Partial<QueryContext>): QueryResult<DependenciesData> {
		const fullCtx = createDefaultContext(
			{ repository_identity: this.repoIdentity, canonical_path: this.repoRoot },
			ctx,
		);
		const absent = this.guardStoreAbsent<DependenciesData>(fullCtx, "dependencies");
		if (absent) return absent;
		return dependencies(fullCtx, this.store, params);
	}

	configUsage(params: ConfigUsageParams, ctx?: Partial<QueryContext>): QueryResult<ConfigUsageData> {
		const fullCtx = createDefaultContext(
			{ repository_identity: this.repoIdentity, canonical_path: this.repoRoot },
			ctx,
		);
		const absent = this.guardStoreAbsent<ConfigUsageData>(fullCtx, "config_usage");
		if (absent) return absent;
		return configUsage(fullCtx, this.store, params);
	}

	discard(params: DiscardParams, ctx?: Partial<QueryContext>): QueryResult<DiscardData> {
		const fullCtx = createDefaultContext(
			{ repository_identity: this.repoIdentity, canonical_path: this.repoRoot },
			ctx,
		);
		return discard(fullCtx, this.store, params);
	}
}

export function createAtlas(options: AtlasOptions): Atlas {
	return new Atlas(options);
}
