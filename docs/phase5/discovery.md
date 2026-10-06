# Jālacitra Pre-Flight Discovery Report (Phase 5)

## 1. Port Inspection Table

| Port / Facility | File Path | Found Signature | Plan Mismatch / Notes |
|---|---|---|---|
| **Tool Registration** | `packages/coding-agent/src/core/sandhana/kernel.ts` | `register(tool: AgentTool, kind: AdapterKind \| null): AgentTool` | Plan describes `Capability.prepare` and `Capability.execute`. In Phase 2, `SandhanaKernel` wraps `AgentTool` instances with sequential execution, failure recording, and action-cycle governance. |
| **Action Admission (Yantra / Niyamapatra)** | `packages/coding-agent/src/core/sandhana/records.ts` | `ActionSchema: RegisteredActionSchema` (`tool_id`, `operation_class`, `version`, `arguments_digest`, `side_effect`, `risk_floor`, `timeout_ms`, `output_limit`, `conditional_commit`, `idempotency`, `repeatability`, `structural`, `contract`) | Action schemas are versioned records validated inside Sandhāna transactions. Jālacitra operations will be registered with deterministic schema records and side effect classes. |
| **Target Binding (Ādhāra)** | `packages/coding-agent/src/core/sandhana/code.ts` | `bindTarget(cwd: string, label: string, mission: string, revision: number, session: string, meter?: RetrievalMeter): RecordOf<"TargetBinding">` | Returns `TargetBinding` with `canonical_path`, `workspace_id`, `repository_identity`, `worktree_identity`, `environment`, `generation`, `preimage_digest`, and `valid`. Re-validated via `sameBinding()`. |
| **Scope Policy (ScopePolicy)** | `packages/coding-agent/src/core/sandhana/code.ts` | `ScopePolicy.prototype.evaluate(action: RecordOf<"PreparedAction">, context: PolicyContext): RecordOf<"ScopeDecision">` | Takes `PolicyContext` (`{ revision, policy_version, authorizations, binding, now, predicates }`) and returns `outcome: "ALLOW" \| "DENY" \| "NEEDS_CURRENT_AUTHORIZATION"`. Denials produce `SCOPE_DENIED`. |
| **Budget Accounting (Koṣa)** | `packages/coding-agent/src/core/sandhana/records.ts` / `kernel.ts` | `BudgetReservation` schema; `state.used` and `state.ceilings` (`Resources` vector) | Resources include `execution`, `preflight`, `ticks`, `input_tokens`, `output_tokens`, `output_bytes`, `artifact_bytes`, `retrieval_bytes`, `elapsed_ms`, `cost`, `refinement`. Usage is debited via mission transactions. |
| **Evidence & Artifacts (Sākṣya)** | `packages/coding-agent/src/core/sandhana/store.ts` | `MissionStore.prototype.append<T>(type: T, fields: Draft<T>, id?: string): RecordOf<T>` and `MissionStore.prototype.artifact(mission: string, id: string): Buffer` | Records of kind `OBSERVATION`, `INTERPRETATION`, `VERIFICATION`, `CONTROL` are committed to SQLite. Large payloads are stored in the `artifacts` table. |
| **Event Identification** | `packages/coding-agent/src/core/sandhana/records.ts` | `event_id: string`, formatted as dot-separated domain tags | Event records use `jalacitra.<operation>.<phase>` (e.g., `jalacitra.index.planned`, `jalacitra.index.committed`). |
| **Operation Manager (Dīrghakriyā)** | `packages/coding-agent/src/core/sandhana/operations.ts` | `OperationManager.prototype.submit(id: string, dependencies: OperationDependency[], priority?: number): RecordOf<"OperationSchedule">` and `prepare(...)` | Long operations use `OperationSchedule` with lifecycle states `QUEUED`, `DISPATCHED`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`, `CANCEL_REQUESTED`, `UNCERTAIN`. |
| **Uncertain Reconciliation (Anirṇītaphala)** | `packages/coding-agent/src/core/sandhana/reconciliation.ts` | `ReconciliationRecord` with rules such as `LOCAL_FILE_POSTCONDITION/1` | Resolves `OUTCOME_UNKNOWN` by checking concrete postconditions without unguided repeats. |
| **RLM Context Retrieval (Āvartana)** | `packages/coding-agent/src/core/sandhana/avartana/contracts.ts` / `runtime.ts` | `Avartana.prototype.context(request: ContextRequest, signal?: AbortSignal, leaf?: LeafCall): Promise<ContextAnswer>` | Freshness vocabulary is `"historical_allowed" \| "current_generation" \| "live"`. Source families currently list `"project_graph_future"` as an unsupported future placeholder. |
| **Git Tooling** | `packages/coding-agent/src/core/sandhana/avartana/git.ts` | `gitView(root, args, meter, signal)` | Git operations are shelled out using `execFile("git", ...)` with `--no-pager`, `--no-optional-locks`, timeout 30s, and sanitized environment. |
| **File Read / Search** | `packages/coding-agent/src/core/sandhana/io.ts`, `search.ts` | `observedFile(path, meter, options)`, `boundedSearch(root, pattern, options)` | Reads are bounded by 8 MiB per file with retrieval meter accounting. |

---

## 2. Seams and Minimal Adapters

1. **`LaterPort = "repository_graph"` Seam:**
   - *Status in Phase 2*: `ports.ts` exports `LaterPort = "repository_graph"` and `unavailablePort("repository_graph")`.
   - *Minimal Adapter*: Create `JalacitraKernelPort` implementing `SandhanaPort<AtlasQueryInput, AtlasQueryResult>` to bridge between Sandhāna kernel calls and the `atlas.*` query engine.

2. **`SourceFamily = "project_graph_future"` in Avartana:**
   - *Status in Phase 4*: `contracts.ts` and `runtime.ts` designate `"project_graph_future"` in `unsupported = new Set(["project_graph_future", ...])`.
   - *Minimal Adapter*: Provide `JalacitraContextSourceAdapter` implementing `ContextSourceAdapter`:
     ```ts
     interface ContextSourceAdapter {
       family: SourceFamily;
       version: string;
       capabilities: SourceDescriptor["capabilities"];
       resolve(request: ContextRequest, locator: string, signal: AbortSignal): Promise<SourceDescriptor[]>;
       read(request: ContextRequest, source: SourceDescriptor, range: SourceRange, signal: AbortSignal): Promise<Snippet>;
     }
     ```
     This adapter maps `ContextRequest` to `atlas.*` operations, returning location handles and citations without modifying RLM's core contracts.

3. **Kernel Tool Registration Seam:**
   - *Status*: `SandhanaKernel.register` wraps tools with TypeBox parameter schemas and synchronous/sequential execution.
   - *Minimal Adapter*: Expose `atlas.*` operations as registered tools (`atlas_status`, `atlas_query`, `atlas_index`, etc.) with registered schemas and strict read-only/observational classifications.

---

## 3. Pre-Flight Decision Log Summary

See full log in [`decision-log.md`](file:///C:/Users/Hp/OneDrive/Desktop/Padma/docs/phase5/decision-log.md).
- **D-1 (Language/Runtime)**: TypeScript on Node.js v22.23.2, ESM (`NodeNext`), erasable syntax only.
- **D-2 (SQLite Binding)**: Node.js built-in `node:sqlite` (`DatabaseSync`). Zero external dependencies, synchronous transactions, WAL mode, JSON functions, instant cold start.
- **D-3 (Parsing Technology)**: Pure syntactic AST extraction using TypeScript's `ts.createSourceFile` (v7.0.2) with `setParentNodes = false` for TypeScript/JavaScript/JSX/TSX as the primary model-free syntactic parser; pluggable adapter design with recorded parser/grammar versions. Zero C++ compilation toolchain issues on Windows.
- **D-4 (Initial Language Adapters)**: Full AST extraction for TypeScript/JavaScript and ecosystem extensions (I4, I5); manifests (`package.json`, `tsconfig*.json`, etc.); config key names (JSON, TOML, YAML, `.env`); test frameworks (Vitest, Jest, `node:test`, Playwright, Cypress); generic file-level fallback for all other languages.
- **D-5 (Clustering Algorithm)**: Deterministic modularity-based Label Propagation over undirected projection of structural edges, seeded with a fixed integer, tie-broken by canonical identity, with hierarchical directory fallback.
- **D-6 (Store Location)**: Padma-owned cache directory `~/.padma/cache/jalacitra/<repo_fingerprint>.sqlite` outside user source tree.
- **D-7 (Compiler & LSP Relations)**: On-demand TypeScript Semantic Adapter using installed project `tsconfig.json` and compiler API, strictly budget-gated and durable.

---

## 4. Five Key Risks in this Repository

1. **Windows File Locking Concurrency (`EBUSY` / `EPERM`):**
   - *Problem*: Windows places exclusive locks on open files and SQLite WAL/SHM handles. Unclean process terminations or overlapping processes can cause lock acquisition failures.
   - *Mitigation*: Use SQLite busy timeout (5000ms), cooperative file locking, atomic temporary file replacement, and clean error recovery on process exit.

2. **Parser Memory and Latency on Pathological / Large Files:**
   - *Problem*: Very large bundle files (e.g. 5+ MB JS bundles) or deeply nested expressions can block the event loop or trigger Node heap exhaustion.
   - *Mitigation*: Hard file size ceiling (1 MiB for source, 5 MiB for data), 5-second per-file wall-clock timeout, parse-tree node count cap, immediate release of AST memory per batch, and `PARSE_TIMEOUT` status.

3. **Stale Cache vs. Live Workspace Drift:**
   - *Problem*: Fast external edits or filesystem clocks with coarse timestamp resolution can cause missed changes if only mtime is checked.
   - *Mitigation*: Fast `(size, mtime)` pre-filter combined with authoritative SHA-256 content digests for new/modified files, and explicit `live` freshness stat passes.

4. **Edge Explosion via Barrel Files and Re-Export Chains:**
   - *Problem*: Re-exporting index files (`export * from ...`) can cause combinatorial fan-out and hub nodes that swamp impact analysis.
   - *Mitigation*: Bound re-export chain traversal (depth <= 8), cycle detection, and hub node truncation (degree threshold 500) reported with `HUB_NODE_NOT_EXPANDED`.

5. **Untrusted Code and Secret Leakage in Indexed Repositories:**
   - *Problem*: Repositories may contain secrets (`.env`, `.pem`, tokens), prompt injections ("ignore previous instructions"), or executable configuration files.
   - *Mitigation*: Exclude secret filenames, scrub content for credential patterns, parse configurations purely as static data without evaluation, and enforce `untrusted: true` markers on all text excerpts.

---

## 5. Module Layout Adjusted to Repository

The module layout is placed under `capabilities/jalacitra/` (root-level capability as specified in the plan and prompt), with TypeScript types and paths mapped in `tsconfig.json` and Biome rules in `biome.json`:

```text
capabilities/jalacitra/
  index.ts                  # Public entry point: createAtlas(), types, constants
  api/                      # atlas.* operations
    status.ts
    ensure-index.ts
    resolve-symbol.ts
    locate.ts
    neighbors.ts
    expand-impact.ts
    find-relevant-tests.ts
    explain-build-path.ts
    path.ts
    explain.ts
    dependencies.ts
    config-usage.ts
    regions.ts
    runtime-observation.ts
    export.ts
    discard.ts
  model/                    # Core graph domain models
    ids.ts                  # Stable canonical identities and hashes
    nodes.ts                # Node kinds and attribute validation
    edges.ts                # Edge kinds, weights, candidate groups
    edge-semantics.ts       # Edge traversal directions and impact semantics
    provenance.ts           # PARSED, COMPILED, RUNTIME_CONFIRMED, INFERRED
    freshness.ts            # FRESH, UNVERIFIED, STALE, INVALIDATED, PARTIAL
    coverage.ts             # Coverage, blind spots, completeness
    reason-codes.ts         # Central catalog of reason codes
  store/                    # Persistence layer
    schema.sql              # DDL schema definitions
    store.ts                # SQLite database management (node:sqlite)
    migrations.ts           # Schema versioning and migration runner
    journal.ts              # Build journal for crash recovery
    shrink-guard.ts         # Shrink guard safety check
  inventory/                # Repository file discovery
    enumerate.ts            # Git and bounded filesystem walk
    ignore.ts               # Hard exclusions, .padmaignore, .gitignore
    classify.ts             # File classification (source, test, config, etc.)
    digest.ts               # Content digests and mtime caching
  adapters/                 # Language and format extractors
    adapter.ts              # LanguageAdapter interface and registry
    typescript/
      base.ts               # Base TS/JS syntax extractor
      ecosystem.ts          # Declarations, merging, React, routing, env
    manifest/
      manifest.ts           # package.json, tsconfig, workspaces
    config/
      config.ts             # JSON, TOML, YAML, dotenv key-name extractors
    tests/
      tests.ts              # Vitest, Jest, node:test, Playwright extractors
    generic/
      fallback.ts           # File-level only fallback
    toy/
      toy.ts                # Test adapter verifying zero-schema extensibility
  resolve/                  # Reference resolution
    resolver.ts             # Lexical scope and import binding resolution
    module.ts               # Node/TS module resolution rules
    ambiguity.ts            # UNIQUE, MULTI, UNRESOLVED grouping
  invalidate/               # Dependency-aware invalidation
    invalidator.ts          # Change detection and dependency propagation
    dependencies.ts         # dependencies_of_rows maintenance
  schedule/                 # Execution scheduling
    scheduler.ts            # Synchronous inline vs durable background execution
  regions/                  # Subsystem community detection
    community.ts            # Deterministic modularity-based clustering
    labeling.ts             # LLM-free heuristic naming
  ports/                    # Integration adapters
    kernel.ts               # Sandhana capability and tool registrations
    rlm.ts                  # Avartana context source adapter
    operations.ts           # Phase 3 OperationManager durable bridge
    phase-hooks.ts          # Extension interfaces for Phases 6, 7, 9, 14, 15
  export/                   # Serialization
    export.ts               # Versioned graph export
    import-hints.ts         # Optional external hint import
  testing/                  # Test utilities and fixtures
    harness.ts              # Test harness and assertion helpers
    golden-builder.ts       # Golden graph comparisons
    fixtures/               # Deterministic fixture repositories
docs/phase5/
  discovery.md              # This pre-flight discovery report
  decision-log.md           # Pre-flight architectural decisions
  schema.md                 # Complete SQLite schema and attribute specifications
  api.md                    # Public API contract and operation catalog
  runbook.md                # Operational guidelines, failure recovery, doctor
  traceability.md           # Requirement-to-test traceability matrix
  final-report.md           # Final delivery report
```

---

## 6. Implementation of Phase 4 RLM Source Interface

Jālacitra integrates with Phase 4's Āvartana via `JalacitraContextSourceAdapter`:
1. **Source Family**: Mounts under `SourceFamily = "project_graph_future"` (or equivalent registered source family).
2. **Capabilities**: Declares `["read_range", "search_literal", "structured_text"]`.
3. **Reference Mapping**:
   - `resolve()` translates questions and locators into `atlas.resolve_symbol`, `atlas.locate`, or `atlas.expand_impact`.
   - Returns `SourceDescriptor` items with `observedVersion`, `adapterVersion`, content digests, and exact location handles (`file_id`, byte offsets, lines).
   - `read()` retrieves narrow citations without returning raw whole-file text; source bytes are fetched directly from the current file through RLM, ensuring the model always sees current bytes.
4. **Freshness Mapping**:
   - `live`: Runs bounded stat-and-digest verification on underlying files before returning rows. Downgrades with reason `VERIFY_CEILING` if ceiling is exceeded.
   - `current_generation`: Returns rows valid for current `index_generation`.
   - `historical_allowed`: Returns historical generation rows with explicit validity intervals.
5. **Limitations and Blind Spots**:
   - Maps blind spots (`DYNAMIC_DISPATCH`, `REFLECTION`, etc.) to RLM's `unresolved` questions and `limitations`.
   - Never fabricates certainty; reports `completeness = "LOWER_BOUND"`.
