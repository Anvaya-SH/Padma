# Sūkṣmaśastra (Phase 6): Pre-Flight Discovery & Architecture Decisions

**Document**: `docs/phase6/discovery.md`  
**Phase**: Phase 6 — Sūkṣmaśastra ("Scalpel"): Structural Code Editing  
**Branch**: `phase6-sukshmashastra`  
**Status**: Committed Pre-Flight Baseline  

---

## 1. System Context and Seams (S6-PRE-002)

This document records the exact inspected paths, interface signatures, capabilities, and identified seams across the existing Padma kernel (Phase 2), durable operations (Phase 3), RLM (Phase 4), and Jālacitra (Phase 5).

### 1.1 Capability Registration and Niyamapatra Admission
- **Path**: `capabilities/jalacitra/ports/kernel-registration.ts` & `packages/coding-agent/src/core/sandhana/kernel.ts`.
- **Contract**:
  - `CapabilityRegistrationManifest`: Defines `capabilityId`, `version`, `displayName`, `description`, and `operations: OperationSchemaDefinition[]`.
  - `OperationSchemaDefinition`: Specifies `operationName`, `schemaVersion`, `description`, `sideEffectClass` (`READ_ONLY` / `NONE_OBSERVATIONAL` vs `LOCAL_STATE_MUTATION` / `REPOSITORY_WRITE`), `riskTier` (`LOW`, `MEDIUM`, `HIGH`), TypeBox/JSON `inputSchema`, `outputSchema`, and `negativeExamples: NegativeExample[]`.
- **Phase 6 Alignment**: Sūkṣmaśastra registers as `sukshmashastra` capability with operations:
  - `plan.create` (Side-effect: `NONE_OBSERVATIONAL`, Tier: 0/1)
  - `plan.validate` (Side-effect: `NONE_OBSERVATIONAL`, Tier: 0)
  - `plan.preview` (Side-effect: `NONE_OBSERVATIONAL`, Tier: 0)
  - `plan.rebase` (Side-effect: `NONE_OBSERVATIONAL`, Tier: 0/1)
  - `plan.explain` (Side-effect: `NONE_OBSERVATIONAL`, Tier: 0)
  - `plan.apply` (Side-effect: `REPOSITORY_WRITE`, Tier: 1–4 depending on export/scope/size)

### 1.2 Prepared-Action Contract and Kṣepaṇa Boundary
- **Path**: `packages/coding-agent/src/core/sandhana/operations.ts`, `kernel.ts`, `code.ts`.
- **Contract**:
  - Every action modifying repository files must be prepared as a `PreparedAction` record referencing an admitted `RegisteredActionSchema` and target `TargetBinding`.
  - Dispatch passes through `kernel.dispatchPrepared(id, signal, progress)`.
  - `plan.apply` acts strictly as the Kṣepaṇa adapter invoked by the kernel. It cannot be invoked directly by agents or extensions without prior Karṣaṇa approval and reservation.

### 1.3 File-Write Adapter (Atomic Replace, Locking, Digest Compare)
- **Path**: `packages/coding-agent/src/core/sandhana/code.ts` (`guardedReplace`) and `packages/coding-agent/src/core/sandhana/file-lock.ts` (`acquireFileLock`).
- **Contract**:
  - `acquireFileLock(binding, operation)`: Acquires SQLite database transaction locks (`BEGIN IMMEDIATE`) on per-file lock databases under `.padma/file-locks/`.
  - `sameBinding(binding, meter)`: Re-checks inode, device, size, and content digest (`preimage_digest`) under lock before replacement.
  - Same-directory temp file (`${target}.padma-${uuid}.tmp`) with `0o600` permissions, `fsync()`, mode copying from original file, and atomic `rename()`.
- **Phase 6 Extension**: Multi-file coordination requires locking all target files in sorted canonical path order (deadlock-free), writing a start marker before any file rename, maintaining a rollback preimage bundle, and writing a completion marker after all renames succeed.

### 1.4 ScopePolicy.evaluate for Write Operations
- **Path**: `packages/coding-agent/src/core/sandhana/code.ts` (`ScopePolicy`) & `capabilities/jalacitra/ports/scope-policy.ts` (`JalacitraScopeGuard`).
- **Contract**:
  - `inside(root, path)`: Confirms path is confined within workspace root.
  - `secretPath(path)`: Denies sensitive paths (`.env`, `credentials`, `.git`, `.ssh`, `.padma`, `.sandhana-storage`).
  - In Sūkṣmaśastra, `ScopePolicy` is evaluated for write access across *all* files touched by a `StructuralEditPlan`. If any path returns `SCOPE_DENIED` or `NEEDS_CURRENT_AUTHORIZATION`, the entire plan is refused; partial execution is disallowed.

### 1.5 Koṣa Debit
- **Path**: `capabilities/jalacitra/ports/kosa-budget.ts` & `packages/coding-agent/src/core/sandhana/configuration.ts`.
- **Contract**:
  - `reportUsage(operationName, usage, missionId)`: Debits AST parsing, LanguageService lookups, and diff generation from mission budget.
  - If a semantic language service run is estimated to exceed 10% of remaining budget, it defers with `SEMANTIC_DEFERRED`.

### 1.6 Sākṣya Evidence and Artifact Storage
- **Path**: `capabilities/jalacitra/ports/saksya-evidence.ts` (`SaksyaEvidencePort`, `ArtifactStoragePort`).
- **Contract**:
  - `Evidence.append`: Stores structured observations with provenance (`deterministic_check` for diff/parse checks, `tool_observation` for compiler queries, `model_interpretation` for model-provided replacements).
  - `Artifacts.put`: Stores unified diffs, post-parse syntax validation reports, and rollback preimages keyed by SHA-256 digest.

### 1.7 Checkpoint and Rollback Support
- **Path**: `packages/coding-agent/src/core/sandhana/operations.ts` & `code.ts`.
- **Contract**:
  - Full restorable preimage snapshots of all target files are created during the `PREPARED` phase.
  - If a multi-file apply fails mid-operation, the completed files are rolled back immediately to their preimages (`APPLY_ROLLED_BACK`). If rollback fails, `APPLY_PARTIAL` is reported.

### 1.8 Jālacitra Atlas Integration
- **Path**: `capabilities/jalacitra/api/atlas.ts`.
- **Signatures**:
  - `atlas.status(ctx)`: Reports current index generation and freshness.
  - `atlas.locate(params, ctx)`: Locates nodes and verifies freshness against live digests.
  - `atlas.resolveSymbol(params, ctx)`: Resolves symbol name to candidate nodes with exact matching and ambiguity policy.
  - `atlas.expandImpact(params, ctx)`: Returns impacted symbols, calls, and files up to depth bound.
  - `atlas.findRelevantTests(params, ctx)`: Identifies relevant test files and test suites.
  - `atlas.notifyEditApplied(summary)`: Advisory notification to trigger Jālacitra incremental invalidation pipeline.

### 1.9 Tool Process Timeouts & Execution Guards
- **Path**: `packages/coding-agent/src/core/tools/dispatch-guard.ts` & `capabilities/jalacitra/adapters/typescript/semantic-adapter.ts`.
- **Contract**:
  - Compiler runs and subprocesses use `AbortSignal` with bounded wall-clock timers.
  - No external project code, scripts, or build plugins are executed.

---

## 2. Architectural Decisions (S6-PRE-003)

### Decision D-1: Edit Engine
- **Options Considered**:
  1. *tree-sitter (native C++ or wasm bindings)*: High speed, universal grammar, but introduces native compilation dependencies (node-gyp / prebuilts) that pose friction and instability on Windows, and lacks deep TypeScript type/symbol intelligence.
  2. *ts-morph*: Wrapper over TypeScript compiler, adds heavy dependency tree, potential version drift from repo TypeScript.
  3. *TypeScript Compiler API + Language Service (`typescript`)*: Already installed and pinned in workspace (`typescript@5.x`), zero new dependencies, native AST navigation (`ts.createSourceFile`), exact node spans, syntax error diagnostics (`getSyntacticDiagnostics`), and full semantic language service (`ts.createLanguageService`) for renames, references, and import handling.
- **Choice**: **TypeScript Compiler API (`ts.createSourceFile`) for structural AST anchors, syntax parsing, and range replacements + TypeScript Language Service (`ts.createLanguageService`) for semantic queries (renames, references, import changes).**
- **Reason**: 100% fidelity for TypeScript/JavaScript/JSX/TSX, zero external dependency churn or lockfile risks, matches Jālacitra's existing adapter architecture, and natively supports Windows without native toolchain prerequisites.
- **Revisit Condition**: If non-JS/TS languages (e.g. Python, Rust) are required in future phases, introduce language-specific AST adapters or wasm tree-sitter.

### Decision D-2: Patch Representation
- **Options Considered**:
  1. *Unified diff strings as primary format*: Fragile line matching, sensitive to surrounding whitespace, cannot reliably ensure structural AST boundaries.
  2. *Sorted non-overlapping byte/character range replacements per file (`[start, end, newText]`)*: Exact, unambiguous, composable, and order-independent when non-overlapping.
- **Choice**: **Sorted, non-overlapping byte-range replacements per file, plus a derived unified diff.**
- **Reason**: Byte-range replacements are mathematically precise on UTF-8 buffers. Sorting in reverse order (highest offset first) allows single-pass in-memory application without coordinate invalidation. Overlap is detected deterministically in $O(N \log N)$ (`EDIT_OVERLAP`). Unified diff is derived directly from base and target text for human/reviewer preview.
- **Revisit Condition**: None; standard for AST-level refactoring.

### Decision D-3: Atomic Apply Strategy
- **Options Considered**:
  1. *Direct in-place write*: Prone to partial writes and file corruption on crash.
  2. *Per-file same-directory temp file + atomic rename*: POSIX atomic, NTFS replace atomic under file locks.
  3. *Git working tree commit/checkout*: Heavyweight, interferes with user's uncommitted git worktree state and concurrent agents.
- **Choice**: **Same-directory temp file (`${target}.padma-${uuid}.tmp`) with SQLite write locks, preimage verification, start/completion markers, and rollback restoration on failure.**
- **Reason**: Preserves all guarantees of `guardedReplace` (S6-INV-003, S6-INV-006). Acquiring locks in sorted canonical path order prevents deadlocks. Writing a start marker with file digests allows crash recovery to unambiguously classify state as `CONFIRMED_COMPLETE`, `NOT_APPLIED`, or `PARTIAL`.
- **Revisit Condition**: None.

### Decision D-4: Formatting Policy
- **Options Considered**:
  1. *Full-file formatting with external prettier/biome*: Causes large diff churn outside touched AST ranges, violating S6-INV-008.
  2. *Executable configuration execution*: Security risk violating S6-SEC-002 and S6-SEC-003.
  3. *Range-limited formatting with declarative configuration*: Formats only the inserted/modified byte ranges using declarative configuration (e.g. `biome.json` or declarative options). If executable configs (`prettier.config.js`, `eslint.config.js`) are detected, skip formatting and emit `FORMAT_SKIPPED_EXECUTABLE_CONFIG`.
- **Choice**: **Range-limited formatting adhering strictly to declarative configuration; skip formatting and flag `FORMAT_SKIPPED_EXECUTABLE_CONFIG` if config is executable.**
- **Reason**: Eliminates whitespace churn outside modified ranges and enforces prompt-injection / code-execution hygiene.
- **Revisit Condition**: None.

### Decision D-5: Line Endings and Encoding Policy
- **Options Considered**:
  1. *Normalize everything to LF*: Modifies line endings in CRLF repositories on Windows, causing massive unnecessary git diffs.
  2. *Lossy fallback decoding*: Silently corrupts non-UTF8 characters.
  3. *Strict fidelity preservation*: Detect CRLF vs LF per target file, preserve UTF-8 BOM if present, preserve trailing newline status, preserve file mode/executable bits, and reject files with un-decodable byte sequences (`UNSUPPORTED_ENCODING`).
- **Choice**: **Strict fidelity preservation.**
- **Reason**: Complies with S6-SEC-006 and S6-INV-008.
- **Revisit Condition**: None.

---

## 3. Stop and Report Assessment (S6-PRE-004)

- **Kernel Ports**: All required ports (`TargetBinding`, `PreparedAction`, `FileLock`, `guardedReplace`, `ScopePolicy`, `KosaDebit`, `SaksyaEvidence`) exist in Phase 2 (`sandhana/`).
- **Jālacitra Identities**: Node and symbol identities in `capabilities/jalacitra` are stable and deterministic (`sym:<qualified_name>`, `file:<path>`), and query APIs (`atlas.*`) are operational.
- **Phase 2 Invariants**: Sūkṣmaśastra will operate strictly as a capability and Kṣepaṇa adapter without altering Phase 2 kernel semantics.

Pre-flight discovery is complete. Proceeding to implementation order.
