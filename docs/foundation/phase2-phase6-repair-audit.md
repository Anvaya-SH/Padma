# Phase 2 / Phase 6 repair audit

## Scope and completion state

Requested objective: audit the whole checkout against `Padma_Phase_2.md`, repair broken kernel/ordinary-entry behavior and Phase 6 loopholes, and verify before claiming completion. The complete 1,521-line Phase 2 specification has been read. Existing implementation notes explicitly retain unfinished requirements. This audit is active, not a complete compliance or security certification. Existing unrelated working-tree changes are preserved. No commits, builds, publishing or live inference were requested or performed in this pass.

## Verified terminal defects and current repair

- The controller calls `userTerminalText`, while the kernel and store admit/charge `renderTerminal`. These functions previously emitted different bytes. An actual read regression reproduced this mismatch; the reporting test run returned 8 passed and 1 failed.
- The separate chat renderer returned unrestricted fields without redacting its untruncated path. It also discarded exact check descriptions in favor of counts.
- Reporting now has one bounded, redacted projection for store admission and ordinary chat. Machine verification payloads, evidence references and internal artifact/report URIs stay in durable records; readable check commands, target and verdict are projected instead. Required unknown-operation identity and no-repeat instructions remain visible. Actual retrieved source text is not stripped merely for mentioning kernel vocabulary.
- The first rerun passed all 9 existing reporting cases. A subsequent additional projection/redaction case still needs final verification.
- Interactive operation rendering had two paths: no definition and definition without renderers. The latter bypassed special presentation and exposed the complete wrapper arguments. Both also exposed structured scheduler/runtime/proof envelopes in results. Two dedicated regressions failed in their original implementations.
- Both paths now share the same operation call title and select only status/reason or requested output text from structured operation responses. Output omission markers and denied-action explanations are retained.
- The final six-file selection passed **96 tests** in 290.73 seconds: reporting, interactive tool presentation, ordinary conversation, exact commands without provider credentials, routing proof, and shell identity. This includes the additional redaction test and both previously failing operation renderers. No live inference was used.
- The first root `npm run check` passed lint and dependency/import/graph/lock stages but failed with eight TypeScript diagnostics in concurrently changing exact-command, routing, shell and fixture code. Other work corrected the compiler callback and native-symbol interface; this pass made the routing schema's static severity match its existing 0/1/2 runtime contract, used the typed shell marker property, and strengthened the no-inference fixture to reject unknown token reservations as well as nonzero ones. No authority check was removed or weakened.
- The subsequent full `npm run check` **passed with exit code 0**: 1,723 files, lint, pinned/runtime dependencies, relative imports, entry graphs, shrinkwrap/install-lock consistency, complete TypeScript and browser smoke. One formatting change was applied. This is scoped repair evidence, not proof of the whole objective.

## Exact command/directory authorization defect

The example `run the command npm run check in the dir Onedrive\\Desktop\\Padma` loses its directory in `compiler.cleanNaturalShellCommand`; it grants only the command at the original workspace. The provider proposes `cd /c/... && npm run check`, which is a different literal action and is correctly denied by the existing guard. The fix must bind an explicit user command/directory pair, not relax literal matching or strip provider shell syntax.

Implementation obligations for the next scoped change:

1. Preserve directory data outside command quotes; keep typed and quoted command bytes unchanged.
2. Add a structured optional native cwd field; execute through OS spawn cwd rather than composing `cd`.
3. Persist separate exact shell command/target grants. Existing root shell grants and `inside(grant.target, binding.canonical_path)` must not authorize arbitrary descendants.
4. Bind the invocation directory, retain selected workspace/environment identity, require actual directory identity, and recheck native command/cwd/environment at spawn.
5. Compile PROCESS requirements against that directory; acceptance checks and resumed commands must preserve it.
6. Resolve command-relative dependency paths against the invocation directory.
7. Test wrong target/command, quoted lookalikes, escaping and symlink targets, late replacement/revocation, PowerShell, stale proof, and unknown-effect no-repeat behavior through the actual session/faux provider seam.

Read-only investigation verified current literal-parser updates exist; cwd support does not. No model-generated directory may mint authority.

## Phase 6 source audit findings

Phase 6 exists under `capabilities/sukshmashastra`, with 29 implementation and 8 test files. Its operation manifest is not mounted into the normal coding-agent session. These findings establish exported-library defects, not a demonstrated currently reachable session bypass.

1. **Custom codemod host escape:** `transformations/custom.ts` injects host constructors and callbacks into `node:vm`. The actual exported function returned `win32` for a harmless `Object.constructor('return process')().platform` probe. `pipeline/plan-builder.ts` runs this during read-only validation. Preparation must not gain host effect authority. Removing host references and disabling string code generation alone must not be advertised as an OS security sandbox.
2. **Unchecked apply:** `ksepana/adapter.ts` accepts plain mutable PREPARED/VALIDATED plans, independent workspace roots, optional rollback/store, and optional preimage checks. It does not validate the immutable diff against the proposed transformation or intersect current kernel authorization/budget/start state. Traversal, absolute-path, wrong-workspace and symlink targets require zero-write regressions.
3. **No locking:** the adapter's acquired locks are empty callbacks. Digest checks precede asynchronous temporary-file work and rename without a final preimage check. Cooperating writers and intervening user edits can overwrite each other. Multi-file sequential replacement is not universally atomic.
4. **Unsafe restoration/recovery:** `pipeline/rollback.ts` writes originals unconditionally. Recovery trusts workspace-local start/completion marker existence and rolls back changed targets, including newer user edits; failure can clear the unresolved marker. Recovery must use durable operation custody, current scope and guarded postimage/preimage comparisons, retaining uncertainty on missing proof.
5. **Non-durable artifacts:** the artifact store is an in-memory Map; same-process recovery tests do not prove restart recovery. Durable bytes and crash-window tests are required.
6. **False syntax proof:** the validator accepts balanced invalid JavaScript `function f(,) {}`. Use an actual applicable parser and distinguish unsupported grammar from successful validation.

Existing Phase 6 tests are not discovered by workspace test scripts because the capability is not a workspace package. Focused explicit `node --test capabilities/sukshmashastra/testing/*.test.ts` selection is needed after scoped repairs; do not invoke the full Vitest suite.

## Remaining audit work

- Complete explicit command/cwd repair and Phase 6 fixes above.
- Recheck ordinary session/RPC/JSON/export/replay/privacy and output accounting, including untrusted extension/model surfaces.
- Audit all mandatory Phase 2 boundaries against current source and focused evidence: store references and transitions, authority, cumulative budget, binding freshness, dispatch monopoly, recovery, checkpoint promotion, hypotheses/progress, verification and subjective delivery.
- Maintain an explicit requirement-to-source/test map and record actual failures and reruns. A root typecheck or a small green selection is not evidence that the whole objective is complete.
