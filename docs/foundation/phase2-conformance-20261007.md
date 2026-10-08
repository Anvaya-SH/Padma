# Phase 2 usage and conformance — 2026-10-07

The mounted path is `AgentSession.prompt()` → the pinned Pi `AgentLoopController` port → `SandhanaController` → `SandhanaKernel.dispatchPrepared()`. Provider streaming, tool proposals, session events and the existing TUI remain on that path. Native batches use the same dispatcher for each operation; deterministic exact reads need no provider decision. The reusable agent library also retains its upstream loop for independent library callers.

This continuation closes gaps in the existing implementation: explicit legacy calibration, proportional acceptance capacity, route-independent outer limits, native stream separation, historical best-state preservation, executor identity at invocation, public credential redaction, consistent charged/delivered terminal text, current transcript compaction and startup input handoff. Existing records, SQLite persistence, registry, policy, verification and recovery were inspected and exercised rather than replaced with a second framework.

## Source and scope

The checkout's source is `Padma_Plan.md`, 4,909 lines, together with `Padma_Phase_2_Implementation_Prompt.md`. It has R01–R08 and normative sections 40–41. Referenced enhanced-plan sections 44, 47–50 and 53 are unavailable here; their contents are not assumed. The actual upstream pin is Pi 1.0.0, `9fba660cf1caca0ade5bea72269352416e595a19`, documented in [upstream.md](upstream.md). Earlier entries in [sandhana-phase2.md](sandhana-phase2.md) are historical evidence and include superseded defaults and pin information.

Phase 2 covers local coding, one sequential controller, governed reads/edits/test commands, durable accounting, real recovery bytes and evidence-backed completion. This document does not claim completion of later GUI, Cyber, worker portfolio, probe-generation or external-supervision capabilities.

## Run the mounted path

From the repository root with hydrated dependencies and Node >=22.19:

```powershell
node --experimental-strip-types packages/coding-agent/src/cli.ts --no-session --no-extensions --no-skills --print "read LICENSE"
```

Exact reads, literal listings and status requests can run without inference credentials when their reviewed adapter is available. Ordinary development requests use the configured provider through the same session. For example, submit `Fix the parser rejecting valid values; preserve empty-input rejection` through the existing interactive, print or RPC prompt entry. Current instructions authorize scoped reversible repair and recognized local tests; arbitrary shell effects require an exact current command grant.

For deterministic command coverage, submit a structured instruction through that same prompt entry:

```text
padma: {"objective":"repair exact content and check behavior","allow_edits":true,"shell_commands":["node --test parser.test.cjs"],"quality_checks":["node --test parser.test.cjs"],"requirements":[{"text":"requested bytes","rule":"CONTENT","target":"parser.cjs","expected":"the requested complete file text"},{"text":"current behavior","rule":"PROCESS","target":".","expected":"node --test parser.test.cjs","dependencies":["parser.cjs","parser.test.cjs"]}]}
```

CONTENT verifies requested exact bytes. PROCESS verifies the declared command's current result with bound dependencies; semantic behavior requires named executed cases and cited current implementation/test assertions. An unrelated green command cannot establish semantic completion.

Trusted application configuration enters through `createAgentSession({ cwd, sandhanaConfiguration })`, or the existing session-services constructor, and is captured in the mission's `KernelConfiguration`. Repository text is never loaded as trusted settings:

```typescript
const { session } = await createAgentSession({
  cwd: process.cwd(),
  sandhanaConfiguration: {
    version: "sandhana/1",
    calibration_profile: "STANDARD/1",
    routes: { MADHYAMA: { execution: 30, ticks: 12 } },
    resources: { elapsed_ms: 600000, cost: 2 },
    artifact: { max_bytes: 1048576, retention_ms: null },
  },
});
await session.prompt("Fix parser behavior and preserve valid inputs");
```

Import `createAgentSession` at the top of your SDK program from the coding-agent package. The standard defaults are 256 execution invocations and 128 native decision ticks on every route, under the same token/byte/time/cost ceilings. These are configurable backstops, not targets. Initial route selection captures the outer allowance; later escalation cannot add capacity, including with custom route values.

At the transition boundary, any persisted calibration that would change the current envelope is rejected without committing the route change. Older nonuniform route settings therefore cannot mint capacity at reopen; an explicit resource amendment is required. Historical configuration and spending remain retained.

`calibration_profile: "LEGACY/1"` explicitly selects historical 3/40/100 invocation and 3/12/40 tick calibrations with 0/6/15 verification reserves. Only the initially selected route supplies the mission envelope. Under STANDARD, a zero configured reserve derives distinct declared checks, exact-content inspection targets and a three-operation estimate for semantic coding acceptance. This estimate grants no command and establishes no oracle. An explicitly configured nonzero reserve remains authoritative. Repeated identical checks are deduplicated; existing adequate evidence can cover acceptance without extra calls.

Current user steering can submit `budget: {"version":1,"ceilings":{"execution":50}}`. Stopped missions use `resume <mission-id> budget: {"version":1,"ceilings":{"execution":50}}`. These append authorized changes while retaining identity, spending and the original deadline. A resource change grants no new target authority. Plain `resume <mission-id>` reopens retained state and reconciles supported uncertain file effects before further effects.

## Responsibilities

| Responsibility | Executable owner |
|---|---|
| Āśaya / Saṅkalpa / Mārga | Compiler: original instruction, preservation clauses, amendments, reviewed provenance and route. |
| Yukti / Vikalpa / Niyantṛ | Native controller decision, structural hypothesis identity, actual attempts, evidence-derived progress and bounded stopping. |
| Ādāna / Bandhana | Authorized metered source reads, current canonical binding, exact schema/arguments and preimage. |
| Lakṣya / Karṣaṇa / Kṣepaṇa | Predicted effect, current policy, owned reservation and atomic durable start before supported dispatch. |
| Phala / Parīkṣā / Sākṣya | Actual raw result and native stream custody, interpretation versus observation, immutable evidence references. |
| Koṣa | Shared vector accounting; actual/unknown usage, overrun admission stop, protected acceptance capacity. |
| Sthitibindu / Śreṣṭhasthiti / Rakṣitasthiti | Actual pre/postimage artifacts, historical validated coverage, conflict-aware guarded restoration. |
| Pramāṇa / Pariṣkāra | Current requirement coverage and applicable quality checks; no default extra critic call. |
| Backend terminal decision | Kernel predicates and one redacted, byte-admitted delivery/replay projection. |

## Trust, storage and recovery limits

Canonical record schemas live in `records.ts`; `MissionStore` stores immutable JSON records and artifact blobs with guarded expected-revision projection commits in SQLite. Persistent sessions use a sibling logical `.sandhana.sqlite`; Windows redirects to private physical storage under `.sandhana-storage`. Memory sessions use `:memory:`. Windows ACLs protect evidence from unrelated ordinary accounts; the same account and administrators are not isolated. Native stdout/stderr views are bounded to a combined 1 MiB or the smaller admitted limit. Untagged custom operations expose combined output without invented stream identity. `streams_truncated`, native completeness receipts and retained artifact references state omissions.

Read/preimage/source checks use actual canonical paths, current authority and metered bytes. Managed write/edit/restore use same-account SQLite writer coordination, preimage checks and supported same-filesystem atomic replacement. Unrelated writers can race the final check; this is not universal filesystem compare-and-swap. Network filesystems, cross-account locking and atomic multi-file restoration are not established.

Checkpoints restore the supported file bytes or guarded absence. They do not restore the entire Git tree, undo external effects or promise arbitrary metadata reconstruction. Starting unrelated tracked/untracked content stays outside targeted rollback. An intervening user edit or revoked authority prevents restore. Historical passing proof keeps an existing recovery point after a later failure; it cannot promote a new point or verify current changed bytes. Expired/missing recovery blobs remain identifiable but cannot be restored or used as current proof.

An exact command grant and cwd do not sandbox a shell's transitive filesystem, network or credential effects. Local tests are trusted project code within the declared command authorization. Protected evaluation must use an actual separate execution boundary. Arbitrary extension executors are not structural guarantees; native-start and final adapter guards still apply.

After a committed consequential start without an observed result, retain OUTCOME_UNKNOWN and unmeasured capacity. Supported file reconciliation compares a fresh complete observation to the prepared postcondition without replay; it establishes current local state, not actor identity, intermediate effects or reconstructed usage. Unsupported process/external effects remain unknown. Cancellation requests do not establish cancellation or reverse effects. Public views redact sensitive fields; raw restricted bytes retain evidence meaning and explicit access/retention limits.

Context compaction replays native system sections and tool changes into their current state. It preserves instructions, immediate user input, requirements, authority, budget and unresolved operations. Settled operations and superseded declarations remain in durable history. Repeating historical schemas previously exhausted the conservative byte-based input allowance during a short parser repair; current replay fixes that failure without expanding the model window or adding inference. If the actual protected state cannot fit, admission still stops rather than dropping authority.

## Verification map

Paths below are relative to `packages/coding-agent/test`. These name behavioral assertions rather than claiming every later capability is production-ready. Observed run results are listed at the end.

| Prompt ID | Exercised assertion / file |
|---|---|
| N01 | Same native bytes, one invocation, zero inference: `sandhana-phase2-trials`, `suite/sandhana-exact-no-auth`. |
| N02 | Same ENOENT target/code, truthful failure, zero inference: the same files. |
| N03 | Complete flat listing, bounded raw serialization, native spool custody: `sandhana`, `sandhana-output`, `sandhana-source-admission`. |
| N04 | Parser-repair two-read batch and guarded edit/test through native provider responses: `suite/sandhana-session`. |
| N05 | Real original failing parser cases, preservation coverage and current patch: `suite/sandhana-session`; TTL baseline/fix in `sandhana-phase2-trials`. |
| N06 | Two actual refutations followed by a current repair and completion through the same session/mission/envelope: `suite/sandhana-session`; route proof in `sandhana-routing-proof`. Deep mode stays sequential; automatic downgrade is not required for completion. |
| S01 | Invalid/unknown schema rejection and durable feedback: `sandhana-hypotheses`, `sandhana-enforcement`. |
| S02 | Changed registration/executor/schema cannot inherit preparation: `sandhana-adapter-identity`. |
| S03 | Changed guarded preimage, target conflict and missing identity: `sandhana`, `sandhana-enforcement`. |
| S04 | Repository replacement at same path blocks mutation: `sandhana`. |
| S05 | Canonical scope, protected source and symlink rejection: `sandhana-source-admission`, `sandhana`. |
| S06 | Invalid source and expired/revoked grants: `sandhana-source-admission`, store authority assertions in `sandhana-enforcement`. |
| S07 | Final-dispatch revocation, policy change, retained amendment obligations: `sandhana`, `sandhana-enforcement`. |
| S08 | A true narrower predicate preserves base denial/missing authority; a false one restricts a base allow: `sandhana-phase2-policy`. |
| S09 | File injection remains observation; input transform cannot widen authority: `sandhana`, `suite/sandhana-session`. |
| B01 | Wrong owned reservation and duplicate owners rejected transactionally: `sandhana-enforcement`. |
| B02 | Competing invocation/model reservations: `sandhana`, `sandhana-model-budget`. |
| B03 | Exact overrun, malformed/unknown measurements and future launch stop: `sandhana-model-budget`, `suite/sandhana-provider-admission`. |
| B04 | Duplicate usage, conflicting settlement and one terminal output charge: `sandhana-enforcement`, `sandhana-model-budget`, `sandhana-reporting`. |
| B05 | Route/restart preserve spending and captured envelope; a persisted future-route quota cannot increase it: `sandhana-phase2-config`, `sandhana-routing-proof`, `sandhana-configuration`. |
| B06 | Specific semantic repair/check can use protected capacity; unrelated discovery cannot: `sandhana-acceptance`. |
| E01 | Model/binding verdict cannot replace actual result proof: `sandhana-enforcement`, `sandhana-acceptance`. |
| E02 | Unrelated successful process, missing preservation case or failing behavior stays unverified: `sandhana`, `sandhana-acceptance`. |
| E03 | Current content/process dependencies invalidate earlier proof: `sandhana-enforcement`, `sandhana-finalization`. |
| E04 | Expired/lost artifact, native incompleteness, omitted serialization: `sandhana-finalization`, `sandhana-hypotheses`, `sandhana-output`. |
| E05 | Stable ID with conflicting payload rejected: `sandhana`. |
| R01 | Expected-revision conflict rolls back: `sandhana`. |
| R02 | Changed registration/authority before durable start invokes nothing: `sandhana-adapter-identity`, `sandhana`. |
| R03 | Actual child exits after write/restore; reopen retains unknown original usage and inspects: `sandhana-reconciliation`. |
| R04 | Reopen delivers same terminal report without execution: `sandhana-enforcement`. |
| R05 | Timed-out real effect remains unknown; incomplete descendant pipe capture cannot prove completion: `sandhana`, `sandhana-source-admission`. |
| C01 | Real bytes and created-file absence restore through guard: `sandhana-enforcement`, `sandhana-phase2-trials`. |
| C02 | Actual dirty Git index/worktree and untracked file: unrelated bytes and their porcelain status survive targeted edit/restore in `sandhana-phase2-trials`. |
| C03 | Intervening user edit blocks restore: `sandhana-enforcement`. |
| C04 | Failed speculative candidate retains actual passing recovery bytes; forged new promotion rejected: `sandhana-phase2-trials`. |
| H01 | Cosmetic fingerprints do not create branches/reset progress: `sandhana-hypotheses`, `sandhana`. |
| H02 | Changed source premise permits a charged observation/branch: `sandhana-hypotheses`, `sandhana-enforcement`. |
| V01 | Current content, command and preservation proof permits backend completion: `sandhana-phase2-trials`, `suite/sandhana-session`. |
| V02 | Failed mandatory/applicable quality check forbids both completion states: `sandhana-finalization`, `sandhana-acceptance`. |
| V03 | Subjective draft includes honest limitation and review action: `sandhana`. |
| V04 | Missing objective semantic coverage remains partial: `sandhana-acceptance`, `suite/sandhana-session`. |
| V05 | Unknown effect takes precedence over local delivery: `sandhana-reporting`, `sandhana-reconciliation`. |
| P01 | Upstream controller/loop/Agent regressions, native session and startup handoff: agent-package tests, `suite/sandhana-session`, `interactive-mode-startup-input`. |
| P02 | Durable reopen retains state/evidence/usage/unresolved operations: `sandhana-configuration`, `sandhana-reconciliation`, `sandhana-recovery-progress`. |

## Local comparison method

`sandhana-phase2-trials.test.ts` compares the current pinned fork's native primitives with the governed kernel, identical temporary source/tests/cwd and deterministic prescribed actions. No model, memory, external credentials or protected evaluator is involved. The scored outcome is exact bytes/error identity or the three public TTL cases. Both matched repair paths execute failing baseline → write → passing check. The subsequent failing candidate/restore/recheck is separately counted recovery work. This is a local conformance trial, not an original Pi 1.0.4 development benchmark or a claim about live-model reasoning.

Run from `packages/coding-agent`:

```powershell
node ../../node_modules/vitest/dist/cli.js --run test/sandhana-phase2-trials.test.ts --no-file-parallelism --reporter=verbose --testTimeout=120000 --silent=false
```

The test prints actual milliseconds, invocation counts, vector usage and terminal states. Warm-cache behavior, loaded Windows process startup and private-storage setup affect elapsed time; repeated measurements are required for a performance conclusion. The observed guard/storage cost is real and no speedup is claimed. Zero additional model calls does not mean zero overhead.

Observed matched trial run (2026-10-07, loaded Windows host, exact versioned STANDARD defaults, native primitives from the checked-out pinned fork):

| Trial | Native elapsed | Governed elapsed | Native / governed invocations | Extra inference | Terminal |
|---|---:|---:|---:|---:|---|
| Exact read | 72.86 ms | 2,715.33 ms | 1 / 1 | 0 | VERIFIED_COMPLETE |
| Missing read | 8.09 ms | 1,901.38 ms | 1 / 1 | 0 | EXECUTION_FAILED, original ENOENT target |
| Zero-TTL baseline → correction → passing cases | 2,768.72 ms | 15,535.29 ms | 3 / 3 | 0 | Current three-case behavioral proof |

The matched TTL ledger recorded 3 executions, 0 ticks, 0 input/output tokens, cost 0, 6,587 artifact bytes, 8,088 output bytes and 3,856 retrieval bytes. Including the subsequent failed candidate, failed check, restore and current recheck, it recorded 7 executions, 0 ticks, 13,683 artifact bytes, 16,582 output bytes and 10,216 retrieval bytes, with VERIFIED_COMPLETE after actual restore. The whole trial took 110.25 seconds. Tracked unrelated edits and untracked content retained their bytes and Git porcelain status. Guard/store work adds latency in these small tasks; this run establishes correctness and call counts, not a performance improvement. Trial records print the complete vector, including measured operation elapsed time separately from wall time.

Initial focused runs exposed obsolete fixed-reserve assertions, unguarded fake executor fixtures, executor replacement at invocation, historical best-state invalidation, terminal newline loss, repeated-schema capacity exhaustion and repeated redaction damaging JSON. Regression fixtures were corrected to execute the real native start boundary; implementation bugs were repaired. Several loaded-host runs also hit the runner's 120-second deadline despite completing their assertions; the long local restore trial and final session run use a 300-second **test-runner** timeout. Mission deadlines, shell timeouts, admission guards and asserted outcomes were not relaxed.

The source CLI invocation above completed with actual LICENSE bytes and VERIFIED_COMPLETE. The startup-input file's 11 tests passed, and 78 upstream agent/controller/loop tests passed. Interactive terminal visual smoke remains unverified: the repository's [interactive-testing workflow](../../.padma/skills/interactive-testing.md) says “Run the TUI in a controlled terminal” using tmux, and `Get-Command tmux` found no executable on this Windows host. No alternate visual smoke or model reply is claimed. `npm run build`, `npm test` and the full Vitest suite were not run, as required by AGENTS.md; targeted Vitest files and the mandatory root `npm run check` provide the stated evidence.

## Phase 3 handoff

Keep the same operation identities, owned reservations, authority references and terminal predicates. Further work must establish crash-safe long-running supervision/reconnect, validated cancellation and descendant cleanup for each supported platform, authoritative process/external reconciliation, dependency scheduling, and actual environment isolation. Existing Phase 3 code in the shared checkout is not credited as newly implemented here. Transitive shell dependency coverage, cross-account/network-filesystem guarantees and multi-file transactional restore remain explicit limits. Protected benchmark/evaluator credentials and its declared setup are unavailable; user-reported 64.6%/66.7% and aspirational 85%/89% are not reproduced or asserted.

## Current result

Phase 2 implementation is complete for the supported local coding path. The actual mounted session exercises guarded native batches, ordinary and evidence-backed deep work, original preservation obligations, current behavioral proof, actual checkpoint recovery and truthful terminal delivery. The authorized startup-input fix is included. Changes are uncommitted.

Final validation after the relevant fixes:

| Check | Observed result |
|---|---|
| Root `npm run check` | Exit 0: formatting, pinned/runtime dependencies, TypeScript imports, entry graphs, shrinkwrap/install-lock verification, `tsc --noEmit` and browser smoke. |
| `git diff --check` | Exit 0. |
| `suite/sandhana-session.test.ts` | All 17 passed, including actual parser repair with/without preservation proof, same-controller deep completion, resume, mandatory-check repair and quality refinement. |
| `sandhana-phase2-config`, `sandhana-routing-proof`, `sandhana-configuration` | All 35 passed, including persisted quota rejection in the controller and direct store commits, sourced resource amendments and historical route proof. |
| `sandhana-position-packet`, `sandhana-public-output`, `sandhana-reporting`, `suite/avartana-session` | All 26 passed, including JSON-preserving credential redaction and native transcript replay. |
| `sandhana-enforcement` | All 21 passed. |
| Native source/output/adapter regression run plus local trials | All 45 passed after the executor/fixture corrections; the subsequent three dirty-Git/local comparison cases also passed with the recorded metrics above. |
| Startup and memory files | All 44 passed (11 startup, 33 memory). |
| Upstream agent/controller/loop files | All 78 passed. |
| `avartana.test.ts` | All 17 passed, including immutable Git retrieval, protected position reconstruction and retained checkpoint bytes. |
| Remaining focused verification | Compiler, model-budget, RPC state, acceptance, hypotheses, finalization, core mission, no-auth exact commands, provider admission, stream custody and recovery-progress assertions passed in the focused runs. Two process-death cases that hit host-load timeouts passed in an isolated rerun; no child deadline was relaxed. |
| Source CLI exact read | Actual LICENSE contents followed by VERIFIED_COMPLETE; exit 0. |

These are targeted runs and corrective reruns, not a claimed full-suite pass or a live-model benchmark. The initial 11-file run had 196 passes and eight failures; corrected relevant reruns establish the current results above. The protected evaluator/setup, referenced unavailable enhanced-plan sections, interactive tmux visual smoke and advanced Phase 3 guarantees remain the explicit evidence/scope limits described above. No benchmark percentage is asserted.
