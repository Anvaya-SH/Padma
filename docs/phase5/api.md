# Jālacitra API Reference

Version: 1.0.0
Phase: 5 (Version-Aware Project Intelligence / Atlas)

## Overview

The `atlas.*` API provides a query and management surface for Padma's version-aware code intelligence graph. All query operations take an explicit `QueryContext` and return a standard envelope `QueryResult<T>`.

### Envelope Structure (`QueryResult<T>`)

```ts
interface QueryResult<T> {
  snapshot_id: string;
  generation: number;
  freshness: FreshnessDelivered;
  data: T;
  coverage: Coverage;
  negative_evidence: NegativeEvidence[];
  truncation: TruncationInfo;
  usage: UsageReport;
  evidence_ref?: string;
}
```

---

## Operations Catalog

### 1. `atlas.status`
- **Side Effect**: `READ_ONLY`
- **Risk Tier**: `LOW`
- **Purpose**: Inspects the store state, current generation, node and edge counts, and schema version.
- **Parameters**: `repoRoot: string`

### 2. `atlas.ensure_index`
- **Side Effect**: `LOCAL_STATE_MUTATION`
- **Risk Tier**: `MEDIUM`
- **Purpose**: Dispatches synchronous or durable index update to bring index freshness up to `current_generation` or `live`.
- **Parameters**: `repoRoot: string`, `freshness?: "current_generation" | "live"`, `forceRebuild?: boolean`

### 3. `atlas.resolve_symbol`
- **Side Effect**: `READ_ONLY`
- **Risk Tier**: `LOW`
- **Purpose**: Resolves symbols by name across the index. Returns deterministic sorted candidates with exact match precedence, provenance, and negative evidence.
- **Parameters**: `repoRoot: string`, `name: string`, `within?: string`, `kind?: string`, `ambiguity_policy?: "REPORT" | "STRICT" | "BEST_EFFORT"`

### 4. `atlas.locate`
- **Side Effect**: `READ_ONLY`
- **Risk Tier**: `LOW`
- **Purpose**: Retrieves a node and performs live content digest verification against the live file system to detect changes or deletions.
- **Parameters**: `repoRoot: string`, `node_id: string`, `verify_live?: boolean`

### 5. `atlas.neighbors`
- **Side Effect**: `READ_ONLY`
- **Risk Tier**: `LOW`
- **Purpose**: Performs bounded graph traversal around a node with cycle safety and hub guards (`DEFAULT_HUB_DEGREE_THRESHOLD = 500`).
- **Parameters**: `repoRoot: string`, `node_id: string`, `direction?: "outgoing" | "incoming" | "both"`, `depth?: number`

### 6. `atlas.expand_impact`
- **Side Effect**: `READ_ONLY`
- **Risk Tier**: `LOW`
- **Purpose**: Computes potential transitive dependents of changed files or symbols, grouped by hop, with `impact_is_potential_not_proven: true`.
- **Parameters**: `repoRoot: string`, `node_ids: string[]`, `depth?: number`, `include_type_only?: boolean`

### 7. `atlas.find_relevant_tests`
- **Side Effect**: `READ_ONLY`
- **Risk Tier**: `LOW`
- **Purpose**: Locates tests linked to code via call graphs, import graphs, naming conventions, or runtime coverage, returning `LOWER_BOUND` completeness where blind spots exist.
- **Parameters**: `repoRoot: string`, `target_node_id?: string`, `target_file_path?: string`

### 8. `atlas.explain_build_path`
- **Side Effect**: `READ_ONLY`
- **Risk Tier**: `LOW`
- **Purpose**: Explains build targets, inputs, expected/observed artifacts, and source map links for a file.
- **Parameters**: `repoRoot: string`, `file_id: string`

### 9. `atlas.path`
- **Side Effect**: `READ_ONLY`
- **Risk Tier**: `LOW`
- **Purpose**: Finds the shortest dependency path between two nodes with deterministic tie-breaking (provenance strength -> fewest ambiguous edges -> canonical identity).
- **Parameters**: `repoRoot: string`, `source_id: string`, `target_id: string`

### 10. `atlas.explain`
- **Side Effect**: `READ_ONLY`
- **Risk Tier**: `LOW`
- **Purpose**: Full provenance audit and syntax range explanation for a node or edge.
- **Parameters**: `repoRoot: string`, `entity_id: string`

### 11. `atlas.dependencies`
- **Side Effect**: `READ_ONLY`
- **Risk Tier**: `LOW`
- **Purpose**: Lists declared manifest dependencies and build targets.
- **Parameters**: `repoRoot: string`, `target_name?: string`

### 12. `atlas.config_usage`
- **Side Effect**: `READ_ONLY`
- **Risk Tier**: `LOW`
- **Purpose**: Reports declared vs read config keys, client exposures, and unused keys.
- **Parameters**: `repoRoot: string`, `key: string`

### 13. `atlas.discard`
- **Side Effect**: `DESTRUCTIVE_LOCAL_MUTATION`
- **Risk Tier**: `HIGH`
- **Purpose**: Completely deletes store files and cached graph state. Requires explicit `confirm: true`.
- **Parameters**: `repoRoot: string`, `confirm: boolean`

### 14. `atlas.record_runtime_observation`
- **Side Effect**: `LOCAL_STATE_MUTATION`
- **Risk Tier**: `MEDIUM`
- **Purpose**: Records dynamic runtime trace calls as `RUNTIME_CONFIRMED` edges bound to the observation's generation.
- **Parameters**: `repoIdentity: string`, `sourceNodeId: string`, `targetNodeId: string`, `generation: number`, `evidence: StoredEvidenceRecord`

---

## Inter-Phase Integration Ports

### Karaṇadarśana (Phase 7) & Setu (Phase 9) Ingestion
- **Port**: `RuntimeIngestionPort.recordRuntimeObservation` and `importCoverage`.
- **Payload Contract**:
  - `evidence`: Sākṣya evidence record token (`runtime_trace`, `tool_observation`, `deterministic_check`).
  - `generation`: Specific index generation when trace occurred.
  - `scene_binding`: Optional Setu scene identifier stored in edge attributes.
  - **Generation mismatch**: If observed target node does not exist at observation generation, records `unresolved_ref` with `OBSERVATION_GENERATION_MISMATCH`.
  - **Validity**: Bounded strictly to generation interval; never carried forward into new generations.

### RLM Context Source Adapter (Phase 4)
- **Adapter**: `JalacitraRlmSourceAdapter`.
- **Output**: Returns **references** and location handles, NOT prose.
- **Snippets**: Include `provenance` class, `source_generation`, `freshness`, `selection_reason`, and `compaction_key`.

### Workbench Export Contract (Phase 17)
- **Contract**: `AtlasExporter.exportSnapshot`.
- **Output**: Versioned, self-describing JSON with `untrusted: true` on all excerpts, relative paths only, no config values or canary secrets.
