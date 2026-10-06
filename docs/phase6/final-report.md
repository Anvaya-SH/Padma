# Sūkṣmaśastra ("Scalpel"): Structural Code Editing — Phase 6 Final Report

**Phase:** Phase 6 of the Padma Build Order  
**Branch:** `phase6-sukshmashastra`  
**Base Commit:** `02eed88fd8912e54a804ddebd409e2e4c08ac5ef`  
**Status:** Complete — All requirements implemented, 70 automated tests passing, 0 linter errors, `npm run check` clean.

---

## 1. Executive Summary & Mission

Sūkṣmaśastra ("The Scalpel") implements high-precision, AST-aware structural code transformations for Padma. Whereas traditional text diffs operate on raw byte offsets and first-pattern matches—risking broken syntax, silent comment mangling, and stale writes—Sūkṣmaśastra introduces anchor-driven edits validated through a multi-stage pipeline, atomic sorted file locking, and crash-resilient application.

### Key Capabilities Built
1. **Structural Anchoring (`anchors/`):** Grammar-based selectors (`kind:name`), signature hashing, overload disambiguation, and `MOVED` detection when functions or classes shift position.
2. **27-Code Diagnostic Reason Catalog (`model/reason-codes.ts`):** Canonical taxonomy covering pre-execution, application, semantic integrity, rebase, and coverage gaps.
3. **Core Transformation Operators (`transformations/`):** Full support for rename, rewrite-imports, replace-node, insert, delete, move declaration, change signature, config migration (JSON/JSONC/YAML), and sandboxed VM codemods.
4. **8-Stage Validation Pipeline (`pipeline/plan-builder.ts`):** Immutable, content-addressed `StructuralEditPlan` construction with pre- and post-apply AST syntax checks.
5. **Kṣepaṇa Boundary & Multi-File Coordinator (`ksepana/adapter.ts`):** Deadlock-free sorted path locking, preimage verification, temporary same-directory staging (`.tmp-xxx`), atomic renames, and start/completion crash markers.
6. **Crash Recovery Engine (`ksepana/recovery.ts`):** Startup scanning of orphaned crash markers with automatic restoration from verified preimage bundles.
7. **Structural Rebase & Worker Merge (`rebase/`):** Three-way AST conflict detection, deterministic rebasing across concurrent modifications, and non-overlapping worker plan merging.
8. **Jālacitra Atlas Impact Merger (`engine/impact-merger.ts`):** Integration with Phase 5 dependency and test graphs, combined with honest blind-spot detection for reflection, dynamic imports, and string mentions.
9. **Kernel Capability Integration (`ports/`):** First-class registration under the Sandhāna action cycle, Koṣa resource budget accounting, and Sākṣya cryptographic evidence generation.

---

## 2. Architecture & Component Structure

```
capabilities/sukshmashastra/
├── anchors/
│   ├── grammar.ts              # Selector grammar parser (kind:name, hierarchical paths)
│   └── resolver.ts             # Anchor resolution, overload matching, signature digests, MOVED detection
├── engine/
│   ├── syntax-validator.ts     # TypeScript compiler AST syntax & declaration integrity checks
│   └── impact-merger.ts        # Jālacitra Atlas integration & syntactic/semantic blind spot detector
├── ksepana/
│   ├── adapter.ts              # Multi-file Kṣepaṇa adapter with sorted locks & atomic promotion
│   └── recovery.ts             # Crash marker scanner & rollback preimage recovery engine
├── model/
│   ├── anchors.ts              # Anchor & Candidate data contracts
│   ├── diff.ts                 # Sorted non-overlapping range edits & unified diff emitter
│   ├── plan.ts                 # StructuralEditPlan & EditCoverage schema definitions
│   └── reason-codes.ts         # 27 canonical reason codes & SukshmashastraError class
├── pipeline/
│   ├── plan-builder.ts         # 8-stage plan creation & validation pipeline
│   └── rollback.ts             # Preimage bundle creation, hashing & restoration helpers
├── ports/
│   ├── artifact-store.ts       # Content-addressed artifact store port
│   ├── events.ts               # Structural editing lifecycle event emitter
│   ├── kernel-registration.ts  # Sandhāna kernel capability registration & action cycle
│   ├── kosa.ts                 # Resource budget manager (nodes, bytes, mutations)
│   └── saksya.ts               # Cryptographic evidence & audit trail port
├── rebase/
│   ├── merge.ts                # Subagent worker plan merger
│   └── rebase.ts               # Structural 3-way conflict analyzer & plan rebase engine
├── testing/
│   ├── anchor-resolution.test.ts # Layer 2: Anchor resolution & signature matching
│   ├── apply-and-recovery.test.ts # Layer 4: Atomic file application & crash recovery
│   ├── grammar-and-diff.test.ts  # Layer 1: Grammar parser & byte-range diffing
│   ├── pipeline.test.ts          # Layer 4: 8-stage plan builder & validation
│   ├── rebase.test.ts            # Layer 5: 3-way conflict analysis & worker merging
│   ├── security.test.ts          # Layer 6: Security hygiene, Koṣa budgets & kernel lifecycle
│   ├── syntax-and-impact.test.ts # Layer 1 & 4: Syntax validation & impact merging
│   └── transformations.test.ts   # Layer 3: All 10 transformation operators
└── transformations/
    ├── change-signature.ts     # Signature modification & call-site reordering
    ├── config-migration.ts     # JSON, JSONC, and YAML structural migrations
    ├── custom.ts               # Sandboxed VM codemod runner
    ├── delete.ts               # Node deletion with reference validation
    ├── index.ts                # Transformation dispatcher & language gating
    ├── insert.ts               # Node insertion (BEFORE, AFTER, INSIDE_START, INSIDE_END)
    ├── move.ts                 # Multi-file symbol migration with auto-import
    ├── rename.ts               # Semantic identifier rename across references & JSX
    ├── replace-node.ts         # AST node replacement
    └── rewrite-imports.ts      # Specifier addition, removal, and module rewrites
```

---

## 3. Pre-Flight Decisions (D-1 through D-5)

As recorded in `docs/phase6/discovery.md`, five core architectural decisions were evaluated and locked:

1. **Decision D-1: AST Parsing Engine Selection**
   - *Chosen:* Native TypeScript Compiler API (`ts.createSourceFile`) in script target `ESNext` with JSX support.
   - *Rationale:* Zero external dependencies, exact alignment with repository TS standard, zero drift against language specifications, fully typed AST nodes.

2. **Decision D-2: Locking & Concurrency Model**
   - *Chosen:* In-memory asynchronous mutex map keyed by canonical normalized paths, acquired in strict lexicographical order with a 10-second timeout.
   - *Rationale:* Eliminates deadlock risks across concurrent multi-file operations; conforms with single-process Sandhāna kernel architecture.

3. **Decision D-3: Rollback Preimage Packaging & Storage**
   - *Chosen:* Self-contained `RollbackBundle` storing SHA-256 digests and pristine file bytes, persisted to both disk (`.rollback.json`) and the content-addressed artifact store.
   - *Rationale:* Fast crash recovery without external database dependencies; tamper-evident through SHA-256 verification before restoration.

4. **Decision D-4: Configuration Format Support**
   - *Chosen:* Support JSON, JSONC (with comment preservation), and YAML. Refuse executable config scripts (`.js`, `.ts`) with `FORMAT_SKIPPED_EXECUTABLE_CONFIG`.
   - *Rationale:* Declarative configurations can be safely parsed and mutated without executing untrusted code or introducing side effects.

5. **Decision D-5: AST Diff Representation**
   - *Chosen:* Sorted non-overlapping byte range replacements (`ByteRangeEdit[]`) paired with unified diff output.
   - *Rationale:* Guarantees deterministic, collision-free text applications and human-readable audit diffs for Pramāṇa and user review.

---

## 4. Invariants Verification

All 12 non-negotiable invariants (`S6-INV-001` through `S6-INV-012`) were implemented and empirically verified:

- **`S6-INV-001` (No Direct Writes):** Verified by `apply-and-recovery.test.ts`. Transformations emit byte edits; only `ksepana/adapter.ts` writes files, gated by the kernel's Kṣepaṇa boundary.
- **`S6-INV-002` (Anchors, Not First Matches):** Verified by `anchor-resolution.test.ts`. Ambiguous matches throw `AMBIGUOUS` with candidate lists; unanchored text replacements are disallowed.
- **`S6-INV-003` (Preimage Validation Under Write Locks):** Verified by `security.test.ts` and `apply-and-recovery.test.ts`. File locks are acquired prior to reading preimages. Diverged hashes reject with `PREIMAGE_MISMATCH`.
- **`S6-INV-004` (Parse Before Apply):** Verified by `syntax-and-impact.test.ts`. Transformed text is parsed via `checkSyntax`; any syntax diagnostic aborts the pipeline with `REJECTED_SYNTAX_ERROR`.
- **`S6-INV-005` (Declaration Integrity):** Verified by `syntax-and-impact.test.ts` and `transformations.test.ts`. Node deletions verify zero live references; unused exports and orphan declarations are caught.
- **`S6-INV-006` (Smallest Coherent Patch):** Verified by `grammar-and-diff.test.ts` and `transformations.test.ts`. Import rewrites append only new specifiers; formatting outside target nodes remains unchanged.
- **`S6-INV-007` (Honest Coverage with Visible Limits):** Verified by `syntax-and-impact.test.ts`. Reflection (`eval`, `Reflect`), dynamic imports (`import()`), and string literals are flagged in `uncovered_references`.
- **`S6-INV-008` (Plan Before Execute):** Verified by `pipeline.test.ts`. Plans are content-addressed and immutable before Kṣepaṇa submission.
- **`S6-INV-009` (Deterministic Rebase):** Verified by `rebase.test.ts`. Rebase produces an updated plan with ancestor linkage or refuses with explicit `CONFLICT` reports.
- **`S6-INV-010` (Artifact Durability):** Verified by `pipeline.test.ts`. Preimages, diffs, and AST logs are stored in `InMemoryArtifactStore`.
- **`S6-INV-011` (Refuse Unparseable Syntax):** Verified by `transformations.test.ts`. Unsupported languages (e.g., Python, Rust) are cleanly rejected with `UNSUPPORTED_LANGUAGE`.
- **`S6-INV-012` (Zero `any`):** Verified by `tsc --noEmit` and `biome check`. All public interfaces, return types, and schemas are strictly typed.

---

## 5. Test Evidence by Layer (`S6-TEST-001`)

The automated test suite runs via Node.js native test runner (`node --test`) without external harnesses or network dependencies.

```
# tests 70
# suites 35
# pass 70
# fail 0
# duration_ms 2789.1
```

### Layer Breakdown

1. **Layer 1: Grammar & Byte-Range Diffing (`testing/grammar-and-diff.test.ts`)**
   - Selectors: Parses function, method, class, interface, and property selectors.
   - Range Edits: Applies non-overlapping edits in reverse byte order; rejects overlapping spans with `CONFLICT`.
   - Diff Emitter: Generates unified diffs with line-accurate chunks.

2. **Layer 2: Anchor Resolution & Disambiguation (`testing/anchor-resolution.test.ts`)**
   - Exact Matching: Resolves unique anchors when file digest and range match.
   - Ambiguity Detection: Returns `AMBIGUOUS` with candidate lists for overloads and duplicate class member names.
   - Signature Matching: Detects moved declarations when line numbers drift, returning `MOVED` with verified signature digests.
   - Container Chains: Scans class and namespace scopes to locate nested members.

3. **Layer 3: Structural Transformation Operators (`testing/transformations.test.ts`)**
   - Rename: Identifiers across declarations, call sites, JSX components, and shorthand object properties.
   - Rewrite Imports: Modifies named imports without whitespace churn; cleans up empty statements; rewrites module paths.
   - Replace Node: Syntactic replacement with immediate post-parse validation.
   - Insert Node: Placement at `BEFORE`, `AFTER`, `INSIDE_START`, and `INSIDE_END`.
   - Delete Node: Deletes declarations cleanly; blocks deletion when active references exist (`DELETE_REFERENCES_REMAIN`).
   - Move Declaration: Moves symbol to target file, adds target export, and inserts caller import while checking for circular dependencies.
   - Change Signature: Reorders, renames, and adds parameters; flags dynamic spread arguments for manual review.
   - Config Migration: Modifies JSON, JSONC (comments preserved), and YAML; refuses `.ts`/`.js` executable configs.
   - Custom Codemod: Executes in isolated VM sandbox; catches syntax errors and runtime exceptions.
   - Language Gating: Accepts `.ts`, `.tsx`, `.js`, `.jsx`; refuses `.py`, `.rs`, `.go` with `UNSUPPORTED_LANGUAGE`.

4. **Layer 4: Validation Pipeline & Kṣepaṇa Application (`testing/pipeline.test.ts`, `testing/apply-and-recovery.test.ts`)**
   - Plan Builder: 8-stage pipeline compiles validated `StructuralEditPlan`.
   - Atomic Staging: Writes to same-directory `.tmp-xxx` files and promotes via atomic rename.
   - Preimage Verification: Verifies exact byte hashes; rejects on drift.
   - Crash Recovery: Restores from rollback bundle when simulated crash markers are detected.

5. **Layer 5: Structural Rebase & Plan Merging (`testing/rebase.test.ts`)**
   - 3-Way Conflict: Detects concurrent modifications to edit ranges.
   - Rebase: Updates target ranges against modified base revisions.
   - Worker Merger: Merges distinct subagent worker plans; rejects colliding file edits.

6. **Layer 6: Security, Koṣa Budget & Lifecycle (`testing/security.test.ts`)**
   - Sandbox Security: Path traversal (`../`) and sensitive file edits (`.env`, `.pem`) blocked.
   - Koṣa Budgets: Enforces node limits and mutation limits.
   - Kernel Integration: Sandhāna action cycle conformance (`PROPOSED -> VALIDATED -> APPLIED`), event emissions, and Sākṣya audit tokens.

---

## 6. Performance & Scalability Boundaries

- **Memory Usage:** In-memory AST representations are scoped per target file and garbage-collected after plan sealing.
- **Lock Footprint:** Sorted locks are held only during the critical file-write section (typically < 10ms per multi-file plan), avoiding lock contention.
- **Timeout Bounds:** Mutex acquisition times out after 10,000ms to guarantee no subagent or background task hangs indefinitely.

---

## 7. Limitations, Boundaries & Non-Goals

1. **Non-TS/JS Languages:** Structural parsing is intentionally restricted to TypeScript/JavaScript/JSX/TSX. Polyglot structural editing is deferred to future language-specific adapters.
2. **Behavioral Correctness:** Sūkṣmaśastra guarantees structural and syntactic correctness. It does not judge whether the program logic meets business specifications (owned by Pramāṇa).
3. **Automated Conflict Resolution:** Where AST edits directly collide, Sūkṣmaśastra does not attempt heuristic AI merges; it flags a deterministic `CONFLICT` requiring upstream worker replanning.

---

## 8. Handoffs to Phase 7 (Causal Investigation & Debugging)

1. **Failure Application:** Phase 7 can generate targeted bug fixes as `StructuralEditPlan`s and execute them through Sūkṣmaśastra's atomic adapter.
2. **Rebase Support:** If concurrent diagnostic agents edit files during investigation, Phase 7 can invoke `rebasePlan` to update fix plans against live file contents.
3. **Coverage & Blind Spots:** Phase 7 can inspect `EditCoverage.uncovered_references` to identify potential dynamic call sites or reflection patterns that warrant runtime tracing.

---

## 9. Conclusion

Phase 6 (Sūkṣmaśastra) is fully realized and operational. All core requirements, invariants, tests, and documentation are complete and verified against the monorepo quality standards.
