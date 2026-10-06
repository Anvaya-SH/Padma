# Jālacitra Requirements Traceability Matrix

Version: 1.0.0
Phase: 5 (Version-Aware Project Intelligence / Atlas)

This matrix maps every requirement ID from `Padma_Phase5_Jalacitra_Prompt.md` to its implementation files and test cases.

| Requirement ID | Description | Implementation File | Verification Test File |
|---|---|---|---|
| **J5-ID-001** | Deterministic 16-hex IDs from canonical strings | `capabilities/jalacitra/model/ids.ts` | `capabilities/jalacitra/testing/model.test.ts` |
| **J5-ID-002** | Path normalization independent of OS separators | `capabilities/jalacitra/model/ids.ts` | `capabilities/jalacitra/testing/model.test.ts` |
| **J5-ID-003** | Identity determinism across repeated invocations | `capabilities/jalacitra/model/ids.ts` | `capabilities/jalacitra/testing/model.test.ts` |
| **J5-ID-004** | Distinct repositories produce distinct IDs | `capabilities/jalacitra/model/ids.ts` | `capabilities/jalacitra/testing/model.test.ts` |
| **J5-NODE-001** | Standard entity node kinds and attributes | `capabilities/jalacitra/model/nodes.ts` | `capabilities/jalacitra/testing/model.test.ts` |
| **J5-NODE-002** | Symbol parentage and scope binding | `capabilities/jalacitra/resolve/resolver.ts` | `capabilities/jalacitra/testing/ts-adapter.test.ts` |
| **J5-EDGE-001** | Directed edge relations catalog | `capabilities/jalacitra/model/edges.ts` | `capabilities/jalacitra/testing/model.test.ts` |
| **J5-EDGE-002** | Edge semantics (imports, calls, references, tests) | `capabilities/jalacitra/model/edge-semantics.ts` | `capabilities/jalacitra/testing/model.test.ts` |
| **J5-PROV-001** | Strict 4-tier provenance classes (no single float) | `capabilities/jalacitra/model/provenance.ts` | `capabilities/jalacitra/testing/model.test.ts` |
| **J5-PROV-002** | Weakest provenance calculation for composite results | `capabilities/jalacitra/model/provenance.ts` | `capabilities/jalacitra/testing/model.test.ts` |
| **J5-AMB-001** | Ambiguity classification (UNIQUE, MULTI, UNRESOLVED) | `capabilities/jalacitra/model/ambiguity.ts` | `capabilities/jalacitra/testing/query.test.ts` |
| **J5-AMB-002** | Ambiguity resolution policies (REPORT, STRICT, BEST_EFFORT) | `capabilities/jalacitra/api/resolve-symbol.ts` | `capabilities/jalacitra/testing/query.test.ts` |
| **J5-FRESH-001** | Version-aware freshness states (FRESH, UNVERIFIED, STALE) | `capabilities/jalacitra/model/freshness.ts` | `capabilities/jalacitra/testing/query.test.ts` |
| **J5-FRESH-002** | Live file content digest verification | `capabilities/jalacitra/api/locate.ts` | `capabilities/jalacitra/testing/query.test.ts` |
| **J5-COV-001** | Query coverage envelope (considered, indexed, skipped) | `capabilities/jalacitra/api/coverage-helper.ts` | `capabilities/jalacitra/testing/query.test.ts` |
| **J5-COV-002** | Blind spots reporting & LOWER_BOUND completeness | `capabilities/jalacitra/api/coverage-helper.ts` | `capabilities/jalacitra/testing/query.test.ts` |
| **J5-OBS-001** | Fixed reason-code catalog completeness | `capabilities/jalacitra/model/reason-codes.ts` | `capabilities/jalacitra/testing/model.test.ts` |
| **J5-OBS-003** | Atlas Doctor diagnostic audit | `capabilities/jalacitra/doctor/doctor.ts` | `capabilities/jalacitra/testing/export-doctor.test.ts` |
| **J5-STORE-001** | SQLite store schema & integrity checks | `capabilities/jalacitra/store/store.ts` | `capabilities/jalacitra/testing/store.test.ts` |
| **J5-STORE-002** | Schema CHECK constraints enforcement | `capabilities/jalacitra/store/schema.sql` | `capabilities/jalacitra/testing/store.test.ts` |
| **J5-STORE-003** | Monotonic generation minting and intervals | `capabilities/jalacitra/store/store.ts` | `capabilities/jalacitra/testing/store.test.ts` |
| **J5-STORE-004** | Build Journal crash recovery | `capabilities/jalacitra/store/journal.ts` | `capabilities/jalacitra/testing/store.test.ts` |
| **J5-STORE-005** | Shrink guard threshold & abort mechanism | `capabilities/jalacitra/store/shrink-guard.ts` | `capabilities/jalacitra/testing/store.test.ts` |
| **J5-STORE-006** | Generational pruning of historical rows | `capabilities/jalacitra/store/store.ts` | `capabilities/jalacitra/testing/store.test.ts` |
| **J5-INV-001** | Ignore precedence (.padmaignore over .gitignore) | `capabilities/jalacitra/inventory/ignore.ts` | `capabilities/jalacitra/testing/inventory.test.ts` |
| **J5-INV-002** | File classification and language detection | `capabilities/jalacitra/inventory/classify.ts` | `capabilities/jalacitra/testing/inventory.test.ts` |
| **J5-INV-003** | Content digest calculation determinism | `capabilities/jalacitra/inventory/digest.ts` | `capabilities/jalacitra/testing/inventory.test.ts` |
| **J5-INV-004** | Repository enumeration & hostile symlink rejection | `capabilities/jalacitra/inventory/enumerate.ts` | `capabilities/jalacitra/testing/inventory.test.ts` |
| **J5-INV-008** | Secret file exclusion & .env key-only extraction | `capabilities/jalacitra/inventory/ignore.ts` | `capabilities/jalacitra/testing/inventory.test.ts` |
| **J5-ADAPT-001** | Language adapter interface & registry | `capabilities/jalacitra/adapters/adapter.ts` | `capabilities/jalacitra/testing/adapters.test.ts` |
| **J5-TS-001** | TypeScript declaration and reference extraction | `capabilities/jalacitra/adapters/typescript/ts-adapter.ts` | `capabilities/jalacitra/testing/ts-adapter.test.ts` |
| **J5-TS-002** | AST balanced parenthesis call extraction | `capabilities/jalacitra/adapters/typescript/ast-walker.ts` | `capabilities/jalacitra/testing/ts-adapter.test.ts` |
| **J5-TSE-002** | TypeScript declaration merging detection | `capabilities/jalacitra/adapters/typescript/ecosystem.ts` | `capabilities/jalacitra/testing/ecosystem.test.ts` |
| **J5-TSE-005** | Monorepo workspace package boundary resolution | `capabilities/jalacitra/adapters/typescript/ecosystem.ts` | `capabilities/jalacitra/testing/ecosystem.test.ts` |
| **J5-TSE-007** | React component and hook relationship extraction | `capabilities/jalacitra/adapters/typescript/ecosystem.ts` | `capabilities/jalacitra/testing/ecosystem.test.ts` |
| **J5-TSE-008** | File-system and Next-style route mapping | `capabilities/jalacitra/adapters/typescript/ecosystem.ts` | `capabilities/jalacitra/testing/ecosystem.test.ts` |
| **J5-TSE-009** | Server framework route extraction (Express/Fastify) | `capabilities/jalacitra/adapters/typescript/ecosystem.ts` | `capabilities/jalacitra/testing/ecosystem.test.ts` |
| **J5-TSE-011** | Environment variable client exposure analysis | `capabilities/jalacitra/adapters/typescript/ecosystem.ts` | `capabilities/jalacitra/testing/ecosystem.test.ts` |
| **J5-MAN-001** | Manifest adapter (package.json scripts & dependencies) | `capabilities/jalacitra/adapters/manifest/manifest-adapter.ts` | `capabilities/jalacitra/testing/linkers.test.ts` |
| **J5-CFG-001** | Config adapter extracts key names only, never values | `capabilities/jalacitra/adapters/config/config-adapter.ts` | `capabilities/jalacitra/testing/linkers.test.ts` |
| **J5-TST-001** | Test framework adapter (test cases & family grouping) | `capabilities/jalacitra/adapters/tests/test-adapter.ts` | `capabilities/jalacitra/testing/linkers.test.ts` |
| **J5-LINK-001** | Cross-file test linker (calls, imports, conventions) | `capabilities/jalacitra/resolve/linkers.ts` | `capabilities/jalacitra/testing/linkers.test.ts` |
| **J5-LINK-002** | Cross-file config linker (reads_config edges) | `capabilities/jalacitra/resolve/linkers.ts` | `capabilities/jalacitra/testing/linkers.test.ts` |
| **J5-INC-001** | Change detection stat/digest pass authority | `capabilities/jalacitra/invalidate/invalidation-planner.ts` | `capabilities/jalacitra/testing/equivalence.test.ts` |
| **J5-INC-005** | Incremental update equivalence property (J5-INV-011) | `capabilities/jalacitra/invalidate/update-pipeline.ts` | `capabilities/jalacitra/testing/equivalence.test.ts` |
| **J5-TXN-001** | Atomic single SQLite transaction commit | `capabilities/jalacitra/invalidate/update-pipeline.ts` | `capabilities/jalacitra/testing/store.test.ts` |
| **J5-TXN-003** | Shrink guard prevents accidental repository loss | `capabilities/jalacitra/store/shrink-guard.ts` | `capabilities/jalacitra/testing/store.test.ts` |
| **J5-LONG-001** | Synchronous vs Durable classification threshold | `capabilities/jalacitra/durable/durable-builds.ts` | `capabilities/jalacitra/testing/durable.test.ts` |
| **J5-LONG-002** | Progress reporting & cooperative cancellation | `capabilities/jalacitra/durable/durable-builds.ts` | `capabilities/jalacitra/testing/durable.test.ts` |
| **J5-LONG-003** | Idempotency & crash recovery reconciliation | `capabilities/jalacitra/durable/durable-builds.ts` | `capabilities/jalacitra/testing/durable.test.ts` |
| **J5-CMP-001** | Semantic adapter interface | `capabilities/jalacitra/adapters/typescript/semantic-adapter.ts` | `capabilities/jalacitra/testing/semantic.test.ts` |
| **J5-CMP-002** | TypeScript semantic adapter & SEMANTIC_UNAVAILABLE | `capabilities/jalacitra/adapters/typescript/semantic-adapter.ts` | `capabilities/jalacitra/testing/semantic.test.ts` |
| **J5-CMP-005** | Budget gate ceiling & SEMANTIC_DEFERRED | `capabilities/jalacitra/adapters/typescript/semantic-adapter.ts` | `capabilities/jalacitra/testing/semantic.test.ts` |
| **J5-CMP-008** | No-execution guarantee & hostile plugin rejection | `capabilities/jalacitra/adapters/typescript/semantic-adapter.ts` | `capabilities/jalacitra/testing/semantic.test.ts` |
| **J5-API-001** | Atlas query engine operations surface | `capabilities/jalacitra/api/atlas.ts` | `capabilities/jalacitra/testing/query.test.ts` |
| **J5-MISS-001** | Missing index read returns INDEX_ABSENT without silent build | `capabilities/jalacitra/api/atlas.ts` | `capabilities/jalacitra/testing/query.test.ts` |
| **J5-REG-001** | Undirected weighted graph projection for regions | `capabilities/jalacitra/regions/community.ts` | `capabilities/jalacitra/testing/regions.test.ts` |
| **J5-REG-002** | Deterministic modularity clustering with fixed seed | `capabilities/jalacitra/regions/community.ts` | `capabilities/jalacitra/testing/regions.test.ts` |
| **J5-REG-003** | Heuristic region labeling without model calls | `capabilities/jalacitra/regions/community.ts` | `capabilities/jalacitra/testing/regions.test.ts` |
| **J5-REG-004** | Cohesion and bridges reporting (INFERRED provenance) | `capabilities/jalacitra/regions/community.ts` | `capabilities/jalacitra/testing/regions.test.ts` |
| **J5-REG-005** | DIRECTORY_FALLBACK complexity degradation | `capabilities/jalacitra/regions/community.ts` | `capabilities/jalacitra/testing/regions.test.ts` |
| **J5-KER-001** | Capability registration manifest & operation schemas | `capabilities/jalacitra/ports/kernel-registration.ts` | `capabilities/jalacitra/testing/kernel.test.ts` |
| **J5-KER-002** | ScopePolicy evaluation and SCOPE_DENIED reason code | `capabilities/jalacitra/ports/scope-policy.ts` | `capabilities/jalacitra/testing/kernel.test.ts` |
| **J5-KER-003** | Product mode switch (Code vs Cyber) & query-time filter | `capabilities/jalacitra/ports/scope-policy.ts` | `capabilities/jalacitra/testing/kernel.test.ts` |
| **J5-KER-004** | Koṣa budget accounting debit & usage_log fallback | `capabilities/jalacitra/ports/kosa-budget.ts` | `capabilities/jalacitra/testing/kernel.test.ts` |
| **J5-KER-005** | Sākṣya evidence recording with item provenances | `capabilities/jalacitra/ports/saksya-evidence.ts` | `capabilities/jalacitra/testing/kernel.test.ts` |
| **J5-KER-006** | Hypothesis boundary establishing weakest provenance | `capabilities/jalacitra/ports/hypothesis.ts` | `capabilities/jalacitra/testing/kernel.test.ts` |
| **J5-KER-007** | Kernel events emission without source text | `capabilities/jalacitra/ports/events.ts` | `capabilities/jalacitra/testing/kernel.test.ts` |
| **J5-RLM-001** | RLM adapter returns references and handles, never prose | `capabilities/jalacitra/ports/rlm-source-adapter.ts` | `capabilities/jalacitra/testing/rlm-adapter.test.ts` |
| **J5-RLM-002** | Freshness mapping (current_generation vs live) | `capabilities/jalacitra/ports/rlm-source-adapter.ts` | `capabilities/jalacitra/testing/rlm-adapter.test.ts` |
| **J5-RLM-004** | Compaction key retaining snapshot ID for Sārasaṅgraha | `capabilities/jalacitra/ports/rlm-source-adapter.ts` | `capabilities/jalacitra/testing/rlm-adapter.test.ts` |
| **J5-RT-001** | Runtime observation requires evidence (EVIDENCE_REQUIRED) | `capabilities/jalacitra/runtime/runtime-ingestion.ts` | `capabilities/jalacitra/testing/runtime.test.ts` |
| **J5-RT-002** | Target missing at generation yields OBSERVATION_GENERATION_MISMATCH | `capabilities/jalacitra/runtime/runtime-ingestion.ts` | `capabilities/jalacitra/testing/runtime.test.ts` |
| **J5-RT-003** | RUNTIME_CONFIRMED edge validity bounded to observation generation | `capabilities/jalacitra/runtime/runtime-ingestion.ts` | `capabilities/jalacitra/testing/runtime.test.ts` |
| **J5-RT-004** | Test coverage import (LCOV) without running tests | `capabilities/jalacitra/runtime/runtime-ingestion.ts` | `capabilities/jalacitra/testing/runtime.test.ts` |
| **J5-SEC-001** | Resource ceilings prevent crashes on pathological input | `capabilities/jalacitra/inventory/enumerate.ts` | `capabilities/jalacitra/testing/security.test.ts` |
| **J5-SEC-002** | Root confinement rejects path traversal attempts | `capabilities/jalacitra/api/explain-build-path.ts` | `capabilities/jalacitra/testing/security.test.ts` |
| **J5-SEC-003** | No execution guarantee for executable config formats | `capabilities/jalacitra/adapters/config/config-adapter.ts` | `capabilities/jalacitra/testing/security.test.ts` |
| **J5-SEC-004** | Untrusted text is data (injection non-propagation) | `capabilities/jalacitra/export/export-contract.ts` | `capabilities/jalacitra/testing/security.test.ts` |
| **J5-SEC-005** | Canary secret hygiene (secret values never in store bytes) | `capabilities/jalacitra/inventory/ignore.ts` | `capabilities/jalacitra/testing/security.test.ts` |
| **J5-SEC-006** | Identity safety (only relative paths in IDs) | `capabilities/jalacitra/model/ids.ts` | `capabilities/jalacitra/testing/security.test.ts` |
| **J5-EXP-001** | Export contract produces self-describing JSON with untrusted: true | `capabilities/jalacitra/export/export-contract.ts` | `capabilities/jalacitra/testing/export-doctor.test.ts` |
| **J5-IMP-001** | External hint import enforces INFERRED ceiling and non-promotion | `capabilities/jalacitra/adapters/external/graphify-import.ts` | `capabilities/jalacitra/testing/export-doctor.test.ts` |
| **J5-TEST-001** | Traceability matrix completeness | `docs/phase5/traceability.md` | Traceability verification pass |
