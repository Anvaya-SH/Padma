# Padma Continuous Memory — Avartana, Sarasangraha, Smritikosha

Practical bounded continuity for Sandhana missions. No infinite memory is claimed.

## Layers

- Authority (Sandhana mission state) — requirements, prohibitions, route, binding, authorization, budget, operations, verification.
- Observations (exact bytes, tool outputs, artifacts, Git objects) — immutable, versioned, cited by digest.
- Derived (excerpts, packets, capsules, analysis) — cites observations, marked stale when dependencies change.
- Experience (Smritikosha reusable records) — verified conventions, preferences, procedures, failure signatures with provenance.

## Avartana (bounded retrieval)

- Exact read first, then deterministic lookup, lexical search, then bounded analysis.
- Long outputs become durable `tool_artifact` sources; only a preview enters the prompt.
- Tools: `avartana_search`, `avartana_read`, `avartana_expand`, `avartana_analyze`, `avartana_sources`, `avartana_context_status`.
- Coverage distinguishes searched vs skipped vs unexamined. Freshness is enforced for `current_generation` requests.
- Recursive analysis is a bounded leaf (`depth<=1`, `leafCalls<=6` by default) with no tools, no authorization, no side effects.

## Sarasangraha (compaction)

- `MissionPosition` is built deterministically from durable state, not from prose.
- Protected state (requirements, prohibitions, auth, operations, budget, verification, target, corrections) is checksummed; a conflicting capsule is rejected.
- Capsules are projections stored as `SARASANGRAHA_CAPSULE/1` evidence. Pins (`SARASANGRAHA_PIN/1`, max 16, 64 KiB) survive compaction.
- Tools: `sarasangraha_compact`, `restore`, `pin`, `unpin`, `status`, `explain`.
- Controller compacts on pressure (`compaction_threshold 0.8`) instead of truncating authority.

## Smritikosha (persistent memory)

- SQLite `smritikosha.sqlite` alongside the mission store (`:memory:` in tests). Tables: `memory_records`, `memory_versions`, `memory_index_terms`.
- Kinds: project convention, failure signature, procedure, user preference, user goal, inferred pattern, session binding.
- Origins: explicit, observed, derived, inferred. Lifecycles: candidate, verified, stale, revoked.
- Explicit user statements verify immediately; inferred patterns need 3x support and stay weak.
- Retrieval is hybrid (exact scope + lexical + recency + lifecycle), bounded top-K 1..8, with reason, applicability, revalidation flag and conflicts.
- Memories never authorize scope, never prove current state, never execute procedures directly. Procedures dispatch through registered tools.
- Secrets are rejected at admission and mutation.
- Tools: `smritikosha_recall`, `inspect`, `consider`, `store`, `correct`, `demote`, `forget`, `status`.
- Automatic recall injects at most 6 relevant memories before framing; automatic candidate extraction after completion admits at most 5 candidates as candidate/verified.

## Reachability

All 20 tools are in `kernel.knowledgeTools()` and injected in `SandhanaController` every turn plus `governedContext`. Capability audit (`capability-audit.ts`) fails the build when a tool is implemented but not reachable. User commands `/context` and `/memory` call the same services.

## Future integration

- Jalacitra can mount as an Avartana source family.
- Suksmasastra uses recalled conventions but still needs current auth.
- Setu may use failure signatures as hypotheses.
- Mandala workers return candidates; only the parent admits memory.
