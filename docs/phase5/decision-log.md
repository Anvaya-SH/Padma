# Jālacitra Pre-Flight Decision Log (Phase 5)

## D-1 — Implementation Language and Runtime
- **Options Considered**:
  1. TypeScript on Node.js (repository standard, Node v22.23.2, ESM with `"type": "module"`).
  2. Python subprocess / daemon.
  3. Rust / Go native binary subprocess.
- **Choice**: TypeScript on Node.js (Node >= 22.19.0, NodeNext ESM).
- **Reason**: Zero foreign runtime dependencies, instant execution, seamless memory sharing with Sandhāna kernel, erasable syntax adherence, and cross-platform compatibility across Windows, Linux, and macOS without secondary interpreters.
- **Revisit Condition**: If an essential language parser cannot execute under Node.js without an external standalone process.

## D-2 — SQLite Binding
- **Options Considered**:
  1. `node:sqlite` (`DatabaseSync`): Node.js 22 built-in synchronous SQLite binding with prepared statements, WAL journal mode, JSON functions (`json_valid`), user version pragma, and transactional integrity.
  2. `better-sqlite3`: External native addon requiring node-gyp / MSVC C++ toolchain on Windows.
  3. `sql.js`: WebAssembly port, in-memory with manual filesystem flush, lacks robust OS-level WAL concurrency.
- **Choice**: `node:sqlite` (`DatabaseSync`).
- **Reason**: Native to Node v22.23.2 without build toolchain requirements on Windows, zero installation overhead, ~0ms cold start, synchronous transactional execution matching Sandhāna's `MissionStore` design.
- **Revisit Condition**: If non-synchronous asynchronous driver interfaces or custom compiled SQLite extensions become mandatory.

## D-3 — Parsing Technology
- **Options Considered**:
  1. Tree-sitter native bindings (`tree-sitter`, `tree-sitter-typescript`): Requires MSVC / C++ compilation tools on Windows; fails in environments without full toolchains.
  2. `web-tree-sitter` (WASM): Portable without compiler toolchains, but requires async WASM runtime loading and distribution of separate `.wasm` binary grammar files.
  3. TypeScript AST Parser (`ts.createSourceFile` from `typescript: 7.0.2`): Already installed in `devDependencies`, zero native compile steps, exact syntactic fidelity to TypeScript/JavaScript/TSX/JSX, error-tolerant parser recovery with error nodes, byte-accurate source ranges, line/column mapping, zero model calls, deterministic.
- **Choice**: Pure syntactic AST extraction using TypeScript's AST parser (`ts.createSourceFile` with `ts.ScriptTarget.Latest`, `setParentNodes = false`, `ts.ScriptKind.TSX`) for TypeScript/JavaScript/JSX/TSX as the primary model-free syntactic parser; pluggable adapter interface supporting WASM Tree-sitter grammars if needed.
- **Reason**: Deterministic, 100% portable on Windows without native compilers, fast cold start, accurate line/byte locations, and strict separation between pure syntactic `PARSED` facts and semantic `COMPILED` facts. Grammar/parser version is pinned to `ts.version` (`7.0.2`).
- **Revisit Condition**: When adding non-JS languages that cannot be parsed by TypeScript syntax parser or requiring custom grammar rules.

## D-4 — Initial Language Adapters
- **Options Considered**:
  1. TypeScript/JavaScript only.
  2. Multi-language (TypeScript, Python, Go, Rust) with full symbol extraction.
  3. TypeScript/JavaScript with ecosystem extractors + manifests/configs + test frameworks + generic file-level fallback.
- **Choice**: TypeScript/JavaScript with ecosystem extractors (I4, I5) as the single fully-extracted language; manifests (`package.json`, `tsconfig*.json`, `pnpm-workspace.yaml`, `turbo.json`), configuration key-names (JSON, JSONC, TOML, YAML, `.env`), test frameworks (Vitest, Jest, `node:test`, Playwright, Cypress), and generic file-level fallback for Python and other languages (`coverage: FILE_LEVEL_ONLY`). A toy adapter is included in test suites to verify zero-schema-change extensibility.
- **Reason**: Maximizes depth and accuracy for the target repository while respecting the prompt's boundary rules (Python and other languages are file-level only in Phase 5).
- **Revisit Condition**: When explicit user instruction requests full AST symbol extraction for Python or other ecosystems in subsequent phases.

## D-5 — Clustering Algorithm
- **Options Considered**:
  1. Louvain community detection with fixed random seed.
  2. Deterministic Label Propagation (LPA) with tie-breaking by canonical node identity.
  3. Hierarchical directory fallback.
- **Choice**: Deterministic modularity-based Label Propagation over undirected projection of `imports`, `calls`, `references`, and `tests` edges, with fixed seed (`42`), tie-breaking by canonical identity, and directory-based hierarchical fallback if iteration limit is reached.
- **Reason**: Guaranteed deterministic community detection without model calls or embeddings; reproducible across runs; labels generated purely via common path prefix and central symbol degree.
- **Revisit Condition**: If graph scale exceeds 100,000 nodes where modularity optimization exceeds latency limits.

## D-6 — Store Location
- **Options Considered**:
  1. Inside repository root `.padma/atlas.sqlite`.
  2. In system temporary directory `/tmp` or Windows `%TEMP%`.
  3. In a dedicated Padma-owned cache directory outside the user's source tree: `~/.padma/cache/jalacitra/<repo_fingerprint>.sqlite` (with fallback to local `.padma/cache` if home is inaccessible).
- **Choice**: Padma-owned user cache directory: `join(homedir(), ".padma", "cache", "jalacitra", `${repo_fingerprint}.sqlite`)`.
- **Reason**: Never mutates user's source tree; survives clean git operations (`git clean -fd`); keyed strictly by `repo_fingerprint` to isolate distinct repositories and worktrees; cleanly discardable.
- **Revisit Condition**: If user configures an explicit store path via environment or configuration.

## D-7 — Compiler and LSP Relations
- **Options Considered**:
  1. Full persistent language server (LSP) daemon in background.
  2. On-demand TypeScript Compiler API semantic run (`SemanticAdapter`) guarded by budget gate and durable execution.
  3. No semantic compiler integration.
- **Choice**: On-demand TypeScript semantic adapter (`SemanticAdapter`) using the project's installed TypeScript compiler and `tsconfig.json`, strictly gated by Koṣa budget reservation (wall time and memory), no-emit execution, and temporary isolated outputs.
- **Reason**: Preserves fast cold start and low memory on typical operations; provides `COMPILED` relations only when explicitly requested; no resident background daemon on the common path.
- **Revisit Condition**: If project lacks installed TypeScript compiler or uses non-standard compilation pipelines.
