# Jālacitra Operational Runbook

Version: 1.0.0
Phase: 5 (Version-Aware Project Intelligence / Atlas)

## 1. Index Lifecycle & Classification

Jālacitra classifies build operations into two execution tiers:
- **Synchronous (Inline, Bounded)**:
  - Updates touching $\le 200$ files and projected under 2 seconds wall time.
  - Zero-change verification passes.
  - Single-file lazy extraction.
- **Durable (Background, Dīrghakriyā)**:
  - First full build of a repository.
  - Updates touching $> 200$ files or full re-index triggers.
  - On-demand TypeScript semantic compiler passes.

Queries arriving while a durable build is running read authoritatively from the previous committed generation with `index_building: true`. They never block indefinitely and never return partial new-generation rows.

---

## 2. Crash Recovery & Reconciliation

An index build is an idempotent derived-state operation with idempotency key:
$$\text{SHA256}(\text{repo\_identity} : \text{change\_digest} : \text{adapter\_version} : \text{config\_fingerprint})$$

When a process crashes or restarts mid-build:
1. `store.open()` inspects the `build_journal` table.
2. Any journal entry in `PLANNED` or `RUNNING` status indicates an interrupted build.
3. The store rolls back any temporary uncommitted state, marks the entry `ABORTED` with `INTERRUPTED_CRASH_RECOVERY`, and treats the previous generation as authoritative.
4. The coordinator classifies the operation as `SAFELY_REDISPATCHABLE`.

---

## 3. Shrink Guard Intervention & Override

Before committing a new generation, Jālacitra compares the proposed node and edge counts to the previous generation:
- **Threshold**: Rejects commit if graph drops by $> 30\%$ of nodes or $> 40\%$ of edges without a corresponding fraction of file removals or ignore rules.
- **Intervention**: The commit is aborted with reason `SHRINK_GUARD`. The previous generation remains authoritative.
- **Manual Override Procedure**:
  - When a major refactoring or file deletion is intentional, provide `shrinkOverrideReason`:
    ```ts
    pipeline.buildFullOrIncremental(store, {
      repoRoot: "/repo",
      repoIdentity: "repo:sample",
      shrinkOverrideReason: "Intentional deletion of legacy v1 directory",
    });
    ```
  - The override reason is logged in `build_journal` and `usage_log`.

---

## 4. Health Checks with Atlas Doctor

Run the doctor diagnostic suite to check database consistency:
```bash
padma atlas doctor
```
Audits performed:
- `PRAGMA integrity_check` (detects file corruption / page defects).
- `PRAGMA foreign_key_check` (detects broken relational references).
- Orphan node detection (detects symbols with non-existent parent file IDs).
- Dependency table consistency (detects dangling file dependencies).

Findings severity:
- `INFO`: Normal operational health.
- `WARNING`: Recommends `RECOMMEND_REINDEX` (e.g. orphan nodes from interrupted batch).
- `ERROR`: Recommends `RECOMMEND_DISCARD` (corrupt database pages). Doctor **never** performs silent guess-repairs.

---

## 5. Discard Procedure

When corruption occurs or a clean rebuild is requested:
1. Ensure no mission is writing to the store.
2. Run `atlas.discard({ repoRoot, confirm: true })`.
3. The store closes the SQLite connection and wipes the database files (`.sqlite`, `.sqlite-wal`, `.sqlite-shm`).
4. Re-run `atlas.ensure_index` to produce a fresh generation 1.
