# Jālacitra Store Schema Documentation

Version: 1.0.0
Phase: 5 (Version-Aware Project Intelligence / Atlas)

## Overview

Jālacitra uses SQLite (via Node.js `node:sqlite` in WAL mode) as its backing graph store. Every node and edge is bound to integer generation intervals (`valid_from` to `valid_to`), ensuring version-aware historical validity, deterministic invalidation, and snapshot isolation.

## SQLite Configuration & Pragmas

- `journal_mode = WAL`: Read concurrency without blocking writers.
- `synchronous = NORMAL`: Crash-safe without disk write bottleneck.
- `foreign_keys = ON`: Strict foreign key constraint verification across all relational tables.
- `busy_timeout = 5000`: 5-second lock timeout for single-writer concurrency control.

---

## Tables

### 1. `generations`
Records workspace and build generations minted by the pipeline.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `index_generation` | INTEGER | PRIMARY KEY AUTOINCREMENT | Monotonic integer generation identifier |
| `workspace_generation` | TEXT | | Upstream VCS / workspace generation string |
| `build_generation` | TEXT | | Upstream build snapshot identifier |
| `base_commit` | TEXT | | Git commit hash if in a Git repository |
| `dirty` | INTEGER | NOT NULL DEFAULT 0 | 1 if uncommitted changes were present |
| `config_fingerprint` | TEXT | NOT NULL | Composite digest of tsconfig/package.json/env configs |
| `committed_at` | TEXT | NOT NULL | ISO 8601 timestamp of generation commit |
| `note` | TEXT | | Optional annotation |

### 2. `nodes`
Entities in the repository (repositories, workspaces, packages, modules, files, symbols, configs, test cases, build targets, regions, unresolved references).

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | Deterministic 16-hex hash of canonical identity |
| `kind` | TEXT | NOT NULL CHECK (kind IN (...)) | Entity kind |
| `canonical` | TEXT | NOT NULL | Unique canonical identifier string |
| `name` | TEXT | | Unqualified entity name |
| `parent_id` | TEXT | REFERENCES nodes(id) | Enclosing file or node |
| `valid_from` | INTEGER | NOT NULL REFERENCES generations(index_generation) | First generation where node is valid |
| `valid_to` | INTEGER | REFERENCES generations(index_generation) | Generation at which node was closed (NULL = current) |
| `attrs` | TEXT | NOT NULL DEFAULT '{}' CHECK (json_valid(attrs)) | Structured metadata (range, visibility, exported, etc.) |

### 3. `files`
Metadata for indexed files in the repository.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `node_id` | TEXT | PRIMARY KEY REFERENCES nodes(id) | Node ID of file |
| `path` | TEXT | NOT NULL | Relative normalized path from repo root |
| `language` | TEXT | | Detected language ("typescript", "json", etc.) |
| `class` | TEXT | NOT NULL | File class ("source", "test", "config", "manifest", etc.) |
| `size_bytes` | INTEGER | NOT NULL | File size in bytes |
| `content_digest` | TEXT | NOT NULL | SHA-256 digest of file contents |
| `mtime_ns` | TEXT | | Nanosecond modification timestamp (stored as string to avoid 64-bit integer overflow) |
| `is_binary` | INTEGER | NOT NULL DEFAULT 0 | 1 if binary file |

### 4. `extractions`
Status and blind spots for each file and language adapter.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `file_node_id` | TEXT | NOT NULL REFERENCES nodes(id) | File node |
| `adapter_id` | TEXT | NOT NULL | Adapter identifier (e.g. "typescript") |
| `adapter_version` | TEXT | NOT NULL | Adapter version string |
| `grammar_version` | TEXT | | Grammar or parser version |
| `config_fingerprint` | TEXT | NOT NULL | Config fingerprint consumed during extraction |
| `content_digest` | TEXT | NOT NULL | File digest at extraction time |
| `status` | TEXT | NOT NULL | "OK", "PARTIAL", "FAILED", "SKIPPED" |
| `reason_code` | TEXT | | Reason code for non-OK status |
| `blind_spots` | TEXT | NOT NULL DEFAULT '{}' | JSON map of blind spot reason codes to counts |
| `extracted_at_generation` | INTEGER | NOT NULL | Generation when extraction ran |

### 5. `edges`
Directed relations between nodes with explicit provenance and ambiguity.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | Deterministic hash of edge tuple |
| `kind` | TEXT | NOT NULL CHECK (kind IN (...)) | Edge kind (declares, imports, calls, references, tests, reads_config, builds, unresolved_to) |
| `src` | TEXT | NOT NULL REFERENCES nodes(id) | Source node |
| `dst` | TEXT | NOT NULL REFERENCES nodes(id) | Destination node |
| `class` | TEXT | NOT NULL CHECK (class IN ('PARSED','COMPILED','RUNTIME_CONFIRMED','INFERRED')) | Provenance class |
| `method` | TEXT | NOT NULL | Extraction method ("ast", "ts_compiler", "runtime_trace", etc.) |
| `tool_name` | TEXT | | Tool name |
| `tool_version` | TEXT | | Tool version |
| `src_file` | TEXT | REFERENCES nodes(id) | Originating file |
| `src_start` | INTEGER | | Source byte start |
| `src_end` | INTEGER | | Source byte end |
| `src_digest` | TEXT | | Range content digest |
| `evidence_ref` | TEXT | | Required if class = 'RUNTIME_CONFIRMED' |
| `ambiguity` | TEXT | NOT NULL DEFAULT 'UNIQUE' CHECK (ambiguity IN ('UNIQUE','MULTI','UNRESOLVED')) | Ambiguity classification |
| `candidate_group` | TEXT | | Group ID if MULTI ambiguity |
| `candidate_reason` | TEXT | | Disambiguation reason |
| `weight` | INTEGER | NOT NULL DEFAULT 1 | Edge weight |
| `valid_from` | INTEGER | NOT NULL REFERENCES generations(index_generation) | Valid start generation |
| `valid_to` | INTEGER | REFERENCES generations(index_generation) | Valid end generation (NULL = current) |
| `attrs` | TEXT | NOT NULL DEFAULT '{}' | Structured attributes |

### 6. `dependencies_of_rows`
Tracks dependencies between graph rows and source/config files for incremental invalidation.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `row_kind` | TEXT | NOT NULL CHECK (row_kind IN ('node','edge')) | Row kind |
| `row_id` | TEXT | NOT NULL | Node ID or Edge ID |
| `depends_on_file` | TEXT | REFERENCES nodes(id) | File node ID this row depends upon |
| `depends_on_config` | TEXT | | Config component path this row depends upon |

### 7. `regions` & `region_members`
Topological modularity communities and file membership.

### 8. `usage_log`
Operation usage audit records (wall time, files read, bytes read, output bytes).

### 9. `build_journal`
Tracks in-flight builds for crash safety and reconciliation (`PLANNED`, `RUNNING`, `COMMITTED`, `ABORTED`).
