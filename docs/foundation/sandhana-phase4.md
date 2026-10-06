# Phase 4: Āvartana and Sārasaṅgraha

Initially implemented on Pi `0.87.1` at `02eed88fd8912e54a804ddebd409e2e4c08ac5ef`; the current integrated foundation is Pi `1.0.0` at `9fba660cf1caca0ade5bea72269352416e595a19`. See [upstream](upstream.md), [Phase 2](sandhana-phase2.md), [Phase 3](sandhana-phase3.md), and [seams](padma-seams.md).

## Ownership and use

Sandhāna remains the mission controller, executor, permission checker and budget owner. `SandhanaKernel.avartana` implements the context port; the controller mounts the `avartana` tool alongside the existing operation tools. Retrieval does not create a mission, dispatch generated code, reset usage or promote a model answer into verification.

Use exact ranges first. For example:

```json
{"question":"What timeout is configured?","sources":[{"family":"filesystem_text","locator":"config.json","range":{"kind":"lines_inclusive","first":8,"last":12}}]}
```

For a retained log, use its mission observation/artifact record ID, `family: "tool_artifact"`, `freshness: "historical_allowed"`, and a literal such as `specific_middle_error`. It reads retained output instead of running the command again. Checkpoint artifact IDs also reopen historical candidate bytes; this is not permission to restore them over current files.

The answer distinguishes observations, deterministic derivations, model interpretations, original authority references, unresolved questions and conflicts. `retained` points to the committed full retrieval projection when the model-facing answer is shortened. Oversized mandatory metadata blocks instead of disappearing.

## Sources and limits

Implemented source paths:

- Authoritative mission position and native attempt index.
- Visible mission evidence, derivations, retrievals and conflicts.
- Retained native tool output and checkpoint bytes.
- Bounded filesystem UTF-8 captures and scoped directory/literal traversal.
- Bounded JSON objects/JSONL records and top-level exact field extraction.
- Local Git blob/tree views at resolved immutable commits and historical working-tree/index diffs.

`session_archive`, `project_graph_future`, `experience_future` and `live_tool_stream` return typed unsupported-adapter results. There is no approved archived-session retrieval adapter, global personal-history search, project graph or experience database in this implementation. Existing redacted progress snapshots can be inspected as artifacts, but are not reconstructed into raw live stream chunks.

Byte ranges are half-open; lines are one-based inclusive. LF defines lines, BOM and CRLF bytes are retained, and no Unicode normalization occurs. Citations identify immutable captured bytes, their digest, decoded view and actual interval. Raw integrity does not establish semantic entailment. Lossy UTF-8, redaction and clamping are exposed and weaken answers. Known credential patterns and sensitive string fields are redacted before JSON encoding; this is not a complete secret detector or secure equality mechanism.

Directory enumeration is incremental and bounded. Symlinks, protected paths, `node_modules`, binary/lossy text and files above 8 MiB are excluded. `.gitignore` is not interpreted. Enumeration and line-index ceilings expose incomplete coverage; they never establish whole-repository absence. Literal matching is case-sensitive and single-line. Files captured at different times are not a coherent corpus snapshot. Read descriptor/path checks detect several changes, not every adversarial race or filesystem behavior.

Persisted single-scope continuations reenumerate and validate completed captures before reuse. Changed or incompletely enumerated corpora are rejected. There is no general distributed traversal cursor. Current/live Git diff requests are rejected: a retained diff is not a coherent snapshot of the present checkout. Git arguments, local object resolution and subprocess output are bounded; external diff/textconv/fetch behavior is disabled. Existing repository-status restrictions may reject worktrees/configuration requiring a further reviewed adapter. Successful views retain stderr and status; failure diagnostics include actual adapter codes and bounded UTF-8 stderr previews, not invented raw stderr citations.

## Search policy and selection

Literal searches can declare `expansion: { version: "AVARTANA_EXPANSION/1", minimumHits: 1, steps: [{ sourceIndex: 1, reason: "No hit in the named component" }] }`. Search starts at `sources[0]`; each step selects an explicitly allowlisted, strictly containing text scope. At most three expansions run, and they stop when enough distinct cited hits exist. No undeclared parent directory is searched. Expansion cannot accompany a typed plan or continuation. Each retained step names its reason, previous coverage, new capture count, traversal reference, remaining limits and outcome. Earlier negative evidence remains historical; the containing traversal owns the new coverage rather than adding duplicate overlapping source counts.

Scan bytes, admitted hits and elapsed time are shared across every scope, typed-plan node and expansion in one request. Traversal byte measurements include no-match scans, overlap and continuation revalidation. Extracting multiple snippets from an already scanned capture does not count the same capture again. Retained-source processing outside traversal counts each captured version once. The parent's ledger independently charges actual physical reads, binding and freshness checks. Failed traversals without a usable manifest report unknown scan measurement, not zero. Each scope receives only the remaining allowance; files growing after enumeration are checked at source-read reservation before allocation.

Candidate selection uses deterministic lexicographic features, not input order or confidence percentages: known conflicts, exact target, currentness, exact query, requirement relevance, operation correlation, evidence role, source/role diversity, bounded query terms and lossless presentation. `snippet.selection` exposes the features and their ordering. A retained `AVARTANA_SELECTION/1` projection also explains omitted candidates. Repeated logical version/ranges are deduplicated without replacing their original citation handles. Opposing known-conflict excerpts remain reference-only together if both cannot fit, instead of showing only a confirming side. Ranking cannot grant authority, establish semantic support or replace coverage.

## Bounded programs and interpretation

`AVARTANA_PLAN/1` accepts a finite DAG of `resolve`, `read_range`, `search_literal`, `enumerate_scope`, `select`, `partition`, `compare`, `aggregate`, `map_extract`, `compose`, `analyse`, and `return`. Schemas, source allowlists, cycles, limits, depth and unsupported reducers are checked before acquisition. This is an operator vocabulary, not a shell, Python evaluator or arbitrary generated function runner.

Partitioning preserves existing source-range boundaries. It does not infer function/heading dependencies or fabricate overlap. Comparison can retain differing captured field values as an unresolved scoped conflict; it does not infer that one environment is wrong. JSON extraction rejects duplicate keys within each object, malformed records and missing fields. Nested arrays/field paths are not implicitly flattened. Only safe-integer sums and covered record/range counts are supported. Fractional, missing and overflowing numbers remain unknown; displayed subtotals are not exact whole-source totals. Repeated representations of the same logical captured version/range do not multiply record counts.

Semantic leaves use the parent's configured provider, no tools and narrow cited excerpts. Parent reservations and reconciliation charge their real/unknown usage. Claims reference actual input citation indices; fabricated citations are rejected. Resolvable citations still do not prove semantic entailment. Model-derived claims stay `MODEL_INTERPRETATION` / `UNVERIFIED`. Exact normalized question/source repetition and depth/call ceilings bound loops; this is not a semantic equivalence detector. Cancellation prevents late claims from entering the current answer without discarding already incurred charges. A source conflict, unavailable adapter or capacity failure is not repaired by fabricating data.

## Configuration

Application configuration is captured as `AVARTANA_CONFIG/1` within versioned `sandhana/1` kernel configuration. Repository/source text cannot change it. Example:

```ts
const configuration = {
  version: "sandhana/1" as const,
  avartana: { semantic_enabled: false, max_scan_bytes: 1048576 },
};
```

Defaults are semantic enabled, 16 MiB scanned bytes, 32,000 return bytes, 64 hits, 12 ranges, 30 seconds, 6 leaf calls, depth 1, compaction pressure 0.8, an 8 MiB request-local raw-byte cache and evidence input fraction 0.2. Source-family enablement is explicit. Requests are clamped and validated again. The default context bound is 8,000 conservative estimated tokens; model projections use one serialized UTF-8 byte per estimated token, provider window/output bounds and overhead. This can reject input that a tokenizer would fit. Provider metadata/gateway acceptance and actual process heap size are not guaranteed by this estimate. Synchronous reads have pre/post deadline checks, not hard real-time interruption.

The cache is request-local, not a cross-user content index. Namespace, authorization, expiry, integrity and applicable currentness are checked on reuse. Raw blob reads reserve parent retrieval capacity before reading. Metadata/index allocations and SQLite/journal overhead are not a hard global RAM/disk quota. There is no background embedding job, vector database or required optional native dependency.

## Compaction and restart

`MISSION_POSITION/1` is reconstructed from committed SQLite records. It contains original instructions, every protected requirement and exact value, contract and grant references, budgets and reservations, hypotheses, checkpoints, pending operations, reconciliation needs, historical attempts, recent context references and conflicts. Live policy and grant-expiry status accompany the model projection; dispatch still revalidates target and payload authority.

`SARASANGRAHA_CAPSULE/1` is an optional deterministic position/cache record, not a replacement source of truth. Publication checks the previous authoritative position, permitting only publication/storage-accounting changes. Corrupt or stale capsules are not adopted as a new mission. Reconstruction does not call tools or repeat effects. Pending `OUTCOME_UNKNOWN` operations and retained reservations remain uncertain. Checkpoint bytes are historical candidates whose retention, digest and present target must be rechecked before any guarded restoration.

Capacity-aware packet assembly retains trusted instructions, authoritative position, provider tool schemas, response reserve, the immediate user decision and, when possible, a complete recent assistant/tool batch. Excess history is omitted rather than pasted into system instructions. Transformed provider context is checked again. A protected position that cannot fit produces a capacity blocker. Source excerpts remain data/tool or leaf user data, never a new system authority.

Retention expiry makes bytes unavailable even when metadata or a prior cache remains. Metadata/digests alone are not quote or verification proof. Authoritative records and raw referenced evidence are not pruned by this phase. Logical expiry is not physical erasure or automatic disk reclamation; there is no new garbage collector, backup-erasure service or durable live-chunk retention guarantee. Losing the only authoritative store cannot be repaired from a model narrative.

## Verification scope

`test/avartana-policy.test.ts` additionally covers request-wide multi-scope/plan limits, no-match byte accounting, hit omissions, growth before read admission, finite expansion and its stopping/visibility boundaries, deterministic ranking, duplicate ranges and opposing conflict retention.

Focused tests exercise actual kernel reads, UTF-8 citations, changed files, namespace/revocation/expiry checks, partial traversal continuation, JSONL extraction/arithmetic, conflicts, guarded interrupted writes, database restart/checkpoint recovery, real native process output, local immutable Git commits and actual faux-provider sessions including tool-free leaves, rejected invented citations, semantic disabling, redacted JSON and capacity-pressure compaction. No real provider keys or paid calls are used.

Correction validation: one serialized run passed **111 tests across eight files**, including **40 context tests** and adjacent configuration, source-admission, output, provider-admission and launched-capture regressions. `npm run check` and `git diff --check` passed. An earlier run exposed a deduplication regression replacing the original citation handle; first-capture identity is now preserved. A cleanup-hook timeout in that run passed on the unchanged subsequent run. The first root check exceeded its command timeout; subsequent complete checks passed. No full workspace suite, build, live provider request or commit was run.

This is bounded retrieval/reconstruction, not perfect or infinite memory. The entire Phase 4 scenario matrix, every filesystem race and every provider/context transform have not been exhaustively established. No superiority, benchmark win, complete archive recall or arbitrary-format extraction is claimed. “Recursive Language Models” remains the external research term, not the Padma subsystem name.
