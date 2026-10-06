# Memory Phase Checkpoints

## Checkpoint A — Avartana (done)

- Source adapters reuse guarded kernel paths: filesystem, Git objects/diffs, tool artifacts, mission evidence/position, structured text.
- Exact range reads work via `avartana.read`; long outputs stay durable as `tool_artifact` and are searchable.
- Search returns coverage (eligible/enumerated/examined/complete/omitted/unexamined) and limitations; partial vs exhaustive is explicit.
- Freshness enforced for `current_generation`; historical families default to `historical_allowed`.
- Bounded recursive analysis via leaf (`depth<=1`, `leafCalls<=6` default), no tools/effects/authorization in frames; cancellation and revision checks enforced.
- Live tools: `avartana.search`, `avartana.read`, `avartana.expand`, `avartana.analyze`, `avartana.sources`, `avartana.context_status` in `kernel.knowledgeTools()` and `SandhanaController`.
- Evidence: every retrieval retains `AVARTANA_RETRIEVAL/1`; conflicts/derivations retained with provenance.
- Tests: `test/sandhana-memory-phase.test.ts` Sub-Phase A (10 tests) + `test/avartana.test.ts` (17) + `test/avartana-policy.test.ts` pass via real tool `execute` path.
- Limitation: semantic embeddings not implemented; deterministic lexical retrieval only (by design). Session archive and graph futures remain `UNAVAILABLE` honestly.

## Checkpoint B — Sarasangraha (done)

- `MissionPosition` built deterministically from durable state; `buildCapsule`/`validateCapsule` enforce protected-state digest.
- Pins bounded (16, 64 KiB) with reasons, persisted as `SARASANGRAHA_PIN/1`; unpin supported.
- Tools: `sarasangraha.compact`, `restore`, `pin`, `unpin`, `status`, `explain` reachable via same tool surface.
- Controller compacts on pressure (`compaction_threshold 0.8`) via `assemblePacket`; restart reconstructs from durable state, marks stale deps, preserves pins.
- Corrupt capsules rejected without destroying durable record; uncertain operations stay `OUTCOME_UNKNOWN` across restart.
- Tests: Sub-Phase B (7 tests) pass, including compact→restart→restore and pin bounds.
- Limitation: capsule is a projection, not a full transcript replay; rehydration requires explicit `avartana.read`.

## Checkpoint C — Smritikosha (done)

- SQLite `smritikosha.sqlite` (lazy open, `:memory:` in tests) with `memory_records`, `memory_versions`, `memory_index_terms`.
- Kinds/origins/lifecycles per spec; explicit verifies immediately, inferred needs 3x support; secrets rejected; duplicates require correction.
- Hybrid bounded retrieval (scope + lexical + recency + lifecycle), top-K 1..8, with reason, applicability, revalidation flag, conflicts.
- Contradiction preserved as versions; demote/stale, correct with lineage, forget revokes immediately; stale writes rejected via optimistic versioning.
- Intent continuity packet (max 6) injected before framing; candidate extraction after completion (max 5) as candidate/verified only.
- Tools: `smritikosha.recall`, `inspect`, `consider`, `store`, `correct`, `demote`, `forget`, `status` with teaching descriptions; warnings state memory never grants auth nor proves present state.
- Cyber rule enforced by never creating `Authorization` from memory; procedures dispatch only via registered tools.
- User commands `/context` and `/memory` call the same services as agent tools.
- Tests: Sub-Phase C (15 tests) + merged acceptance (1) pass via tool path; capability audit covers all 20 tools.
- Limitation: no vector embeddings (lexical only); no background daemon; file-based store only, no distributed DB.
