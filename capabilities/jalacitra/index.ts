// Jālacitra Public API Entry Point (Phase 5)

export { Atlas, type AtlasOptions, createAtlas } from "./api/atlas.ts";
export type { ConfigReader, ConfigUsageData, ConfigUsageParams } from "./api/config-usage.ts";
export {
	type BoundTarget,
	buildQueryResult,
	createDefaultContext,
	type FreshnessDelivered,
	type FreshnessRequest,
	type QueryContext,
	type QueryResult,
	type SnapshotMeta,
	type TruncationInfo,
	type UsageReport,
	UsageTracker,
} from "./api/context.ts";
export type { DeclaredDependency, DependenciesData, DependenciesParams } from "./api/dependencies.ts";
export type { DiscardData, DiscardParams } from "./api/discard.ts";
export type { EnsureIndexData, EnsureIndexScope } from "./api/ensure-index.ts";
export type { ExpandImpactData, ExpandImpactParams, ImpactItem } from "./api/expand-impact.ts";
export type { EdgeExplanation, ExplainData, ExplainParams, NodeExplanation } from "./api/explain.ts";
export type { BuildTargetExplanation, ExplainBuildPathData, ExplainBuildPathParams } from "./api/explain-build-path.ts";
export type {
	FindRelevantTestsData,
	FindRelevantTestsParams,
	RelevantTestCandidate,
} from "./api/find-relevant-tests.ts";
export type { LocateData, LocateParams } from "./api/locate.ts";
export type { HubNodeNotice, NeighborsData, NeighborsParams } from "./api/neighbors.ts";
export type { GraphPath, PathData, PathParams } from "./api/path.ts";
export type { ResolveSymbolParams, SymbolCandidate } from "./api/resolve-symbol.ts";
export type { AtlasStatusData } from "./api/status.ts";
export type { Completeness, Coverage, NegativeEvidence } from "./model/coverage.ts";
export type { EdgeKind, EdgeRecord } from "./model/edges.ts";
export type { LocationHandle } from "./model/ids.ts";
export type { FileClass, NodeKind, NodeRecord } from "./model/nodes.ts";
export type { ProvenanceClass } from "./model/provenance.ts";
export type { BlindSpotCode, ReasonCode } from "./model/reason-codes.ts";
export { JalacitraStore } from "./store/store.ts";
