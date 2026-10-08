# Harness usability verification, 2026-10-07

## Scope

This follow-up checks normal task delivery, the system guide supplied to the native model, retained context, and execution through the default model. It complements `phase2-conformance-20261007.md`; it does not claim exhaustive coverage of every provider, extension, external service, or failure interleaving.

Live probes use the configured `openai-codex/gpt-6.1-sol` model and `xhigh` effort without changing the user's settings. Their inputs, session stores, and outputs are isolated under `%TEMP%/padma-harness-goal-20261007`. Suite tests use the faux provider and local fixtures; they require no provider keys or paid requests.

## Problems reproduced and corrected

| Reproduction | Correction |
| --- | --- |
| A file question correctly produced `5`, then the engine replaced it with a partial-completion report. | Keep a useful native answer after successful read-only work. Preserve the diagnostic verifier result. |
| A repair read both source files, but compaction dropped the earlier read. Reopening a retained tool artifact incorrectly required a current workspace generation. | Retain complete recent tool batches that fit. Retained artifacts use historical freshness by default; live-file retrieval keeps current-generation checks. |
| The model fixed addition and ran four passing cases, but stagnation stopped the final coverage decision. | Allow one bounded tool-free coverage assessment of retained named checks before the optional-work stop. Retain the same deadline, resource limits, source checks, and deduplication. |
| A verified repair gave a useful summary that was replaced by generic completion text. | Admit the useful summary as terminal presentation only after current evidence passes. Exact-read presentation, uncertain effects, and failed checks keep their existing precedence. |
| A background worker finished while the model was deciding to wait, leaving its output unreported. | Feed settled references into the next decision. Output retrieval defaults to the latest retained result when the model omits its reference; explicit invalid references remain rejected. |
| Windows memory opened a nested private path and failed to open SQLite. | Derive shared memory storage from the logical session directory. Verify persistence and revocation across mission databases. |
| Automatic memory extraction created a file restriction record despite an explicit instruction not to create other memories. | Skip automatic extraction for the tested explicit memory restrictions; manual storage and revocation remain available. |
| Valid retained sources were labelled unavailable, and a final citation combined multiple test definitions. | Describe artifact availability accurately, provide bounded retained inputs at verification, retain validated per-case plans, and expose actual rejection feedback to the next native decision. |
| Normal tool displays exposed context records and scheduler states. | Collapse context and memory records to useful excerpts or plain outcomes. Background progress uses plain language; expanded diagnostics retain inspection details. |
| Replacing the system prompt could remove the callable-tool guide. | Rebuild the guide from the actual tool declarations after prompt replacement and before input admission. |
| An interrupted assistant response exposed an unfinished control proposal. | Strip a reserved opening block through its closing tag or the end of the response, preserving the preceding answer and raw diagnostics. |
| A repair explicitly requested `node --test totals.test.cjs`, but its first proposed execution was treated as optional work and rejected at diagnosis. | Compile an explicit named local repair test into required quality checks with protected capacity. Quoted data, prohibited commands, compound commands, and outside test targets cannot establish this obligation. Semantic requirements remain independently subject to source-bound verification. |
| An early submitted result ran all nine required tests successfully, then ended without a coverage assessment and delivered a generic unverified reply. | Admit the existing bounded assessment for a submitted candidate with current retained checks. Early submissions without an actual check, stale or partial reads, uncertain operations, duplicate inputs, and exhausted ticks retain their admission checks. |
| A valid assessment covering two changed implementations failed while promoting the second checkpoint, referring to a promotion that had not committed yet. | Resolve initial and pending checkpoint records within the same transition. Both single and grouped multi-file assessments now commit recoverable references that remain valid after reopening. |
| An early rejected native coverage proposal prevented the first bounded assessment even after real tests passed. | Preserve planning-only rejection guards, but allow one source-bound assessment of actual current checks. Existing input-set deduplication still prevents repeated questions across reopening. |

The controller consumes control proposals from the native response before projecting ordinary assistant events. Normal assistant events, persisted public messages, and print output omit reserved proposal blocks. Validated proposals and diagnostic records remain in private mission history. Persisted diagnostics retain terminal codes and coverage scope; ordinary replies do not append those records.

## Verification matrix

| Area | Evidence |
| --- | --- |
| Current tools and extension prompt replacement | Faux-provider session assertions inspect the actual request guide, excluded tools, and compaction. |
| Read-only answers | Default-model arithmetic question and a native read session regression. |
| Edit, source currentness, named checks, preservation | Default-model addition repair; four real Node cases include positive, negative, decimal, and invalid-input behavior. A session regression verifies both mandatory obligations with actual named results. |
| Finalization | Local regressions reject changed/deleted sources, changed dependencies, revoked grants, stale policy, expired artifacts, missing output, and zero/skipped cases. |
| Background lifecycle | Native local Node worker regression checks start/exit evidence, one operation, actual completion, and event-driven waiting. Default-model probe is recorded below. |
| Context retrieval and pin lifecycle | Native retained-artifact freshness, compacted packet, and pin/compact/unpin regressions. |
| Memory lifecycle | Persistent Windows storage, cross-mission project memory, explicit opt-out, and an isolated default-model store/recall/inspect/forget round trip. |
| Ordinary display and privacy | Terminal delivery, public events, tool-component rendering, print mode, uncertain effect, and UTF-8/output-capacity regressions. |
| Shell timeout | Explicit shorter timeouts remain effective; the default timeout fix has separate scoped regression coverage. The original uncertain build operation was not replayed. |

## Live follow-up results

The retained session traces and mission databases were re-inspected on 2026-10-08. The fourth through eighth multi-file trials use fresh fixtures on 2026-10-08.

| Probe | Observed result |
| --- | --- |
| `background-third` | Five model decisions; one actual worker command. Native execution confirmed exit 0 and output `started` then `finished`; terminal `VERIFIED_COMPLETE`. |
| `memory-third` | Six model decisions. Store, recall, inspect, forget, and final recall succeeded. The database contains one explicit-user preference with lifecycle `REVOKED`; final recall returned no matches. The semantic mission remained `PARTIALLY_COMPLETE`; this is tool-lifecycle evidence, not an artifact-verification claim. |
| `repair-ninth` | Eight model decisions. Addition and TypeError preservation were corrected; four actual Node cases passed. Terminal `VERIFIED_COMPLETE`; the useful final answer was retained. |
| `multifile-third` | Both implementations were corrected, but no test command ran. The model redundantly looked for source references that were already in the system position, then ended with `PARTIALLY_COMPLETE`. No success is claimed. |
| `multifile-fourth` | Nine model decisions. Both implementations were corrected, TypeError and input preservation remained intact, and all nine actual Node cases passed. The initial check proposal was rejected before dispatch; subsequent source-bound planning admitted one actual check. Terminal `VERIFIED_COMPLETE`; final delivery lists changed files and actual named results. |
| `multifile-fifth` | Five paid model decisions, plus two synthetic assistant messages. Both implementations were corrected and the required check ran once automatically: nine passed, none failed or skipped. The test file remained unchanged. Coverage assessment was omitted before finalization; terminal `PARTIALLY_COMPLETE`. This reproduced the early-completion defect. |
| `multifile-sixth` | Seven paid model decisions. Both implementations were corrected and one actual check passed all nine cases. The bounded tool-free assessment ran, but a valid multi-file result failed on an uncommitted checkpoint reference. Terminal `PARTIALLY_COMPLETE`; no completion claim is made. The unchanged test file matched the original SHA-256. |
| `multifile-seventh` | Seven paid model decisions. Both implementations were corrected; one actual check passed all nine cases with none failed or skipped. One redundant context retrieval was refused. Early rejected coverage proposals prevented the first bounded assessment of the actual results; terminal `PARTIALLY_COMPLETE` replaced a useful native summary with generic unverified text. All eight actual operations were confirmed complete and the test hash matched the original. |
| `multifile-eighth` | Eight paid model decisions plus the terminal message. Both implementations were corrected, and the exact requested check ran once: nine passed, none failed or skipped. Despite one refused redundant retrieval and early rejected proposals, one bounded tool-free assessment received all three full source reads and actual TAP output with no omitted inputs. Two supported results covered the five line cases and four invoice cases. Both verification reports passed; terminal `VERIFIED_COMPLETE` retained the useful changed-file and test summary. All eight actual operations were confirmed complete, and the original test SHA-256 was unchanged. |

The guide now explains matching existing `evidence_index` READ targets to observation IDs and proceeding to the scoped check without status or source-discovery calls. The fresh isolated `multifile-eighth` trial verified the checkpoint and rejected-proposal fixes with the same default model and unchanged task material. A diagnostic store opening during the live write raced with SQLite's transient journal and was refused safely; opening the retained store after process completion succeeded. No data was reset or command replayed.

Current focused verification on 2026-10-08: all 50 tests passed across public-output privacy, terminal reporting, tool display, user delivery, and shell timeout. The three added unfinished-block cases failed before the privacy fix and passed after it. The timeout regression executed one real command lasting 125 seconds, with confirmed output closure and no replay. Broader session and repository checks are recorded below.

The two added multi-file checkpoint cases failed with the actual unresolved-reference error before the promotion fix and passed after it, including terminal reopening and all retained checkpoint references. Overlapping test and compiler runs exhausted host memory (about 200 MB free of 12 GB) and produced test-runner timeouts without assertion failures. Those owned runs were stopped. The corrected-source serial run passed 55 of 56 tests across acceptance, harness instructions, operations, error reporting, and session recovery; its sole failure was a planning-case runner timeout. That case passed alone in 192.3 seconds (six model decisions, five actual invocations, one real check), with a 900-second diagnostic runner allowance. Product deadlines and budgets were not changed. All 56 cases have now passed across the serial run and isolated rerun.

The compiler's 40 tests and the 11 startup-input tests passed separately. The rejected-proposal follow-up reproduced two failures before the fix: rejection before or after a real check blocked its first bounded assessment. Repeated assessment of already admitted inputs and rejection without actual results remained blocked. All 42 tests across acceptance, protected capacity, and harness instructions passed serially in 1,658.38 seconds, including the four added rejection cases and both multi-file checkpoint cases. The existing natural repair with preservation passed. Its missing-preservation fixture exhausted its queued faux responses at the newly admitted assessment; the fixture now supplies an honest tool-free response acknowledging the missing case and still asserts partial completion, six actual invocations, and no extra tools. The modified case passed in an isolated rerun (208.75 seconds), retaining one verified obligation and partial completion.

Final root `npm run check` exited 0 after the live trial: formatting checked 1,776 files without changes, and pinned/runtime dependencies, TypeScript imports, entry graphs, shrinkwrap/install-lock verification, `tsc --noEmit`, and browser smoke passed. Changes remain uncommitted. The eight temporary helper scripts created in this continuation were removed; isolated fixture traces and mission databases remain available.

These fixes were exercised through the source CLI; the packaged launcher was not rebuilt. From the repository root, use `node packages/coding-agent/src/cli.ts` to run the tested source implementation. The original uncertain build operation was not replayed, and its historical success is not asserted.

## Complex local challenge prompts

Run these in disposable fixture workspaces, with existing tests supplied before the task. Start with one challenge per task so failures can be attributed to a concrete action.

1. **Recoverable job queue.** Implement a local file-backed queue with stable job IDs, ordered dependencies, cancellation, process restart recovery, and a durable record for ambiguous completion. Provide a fake worker and named tests for duplicate submission, worker crash before/after the effect, dependency failure, and restart. Require an ambiguous job to be inspected before any replacement execution. Ask Padma to fix failures and report actual test results.

2. **Configuration migration with rollback.** Migrate a versioned configuration format across twenty fixture files. Preserve unknown fields, validate each new file, handle malformed input without partial replacement, and make a second migration a no-op. Supply named tests for every preservation and failure case. Ask Padma to implement the migration, run the scoped tests, inspect the resulting files, and explain any uncovered case.

3. **Streaming parser repair.** Repair a chunked protocol parser handling Unicode boundaries, split delimiters, malformed frames, cancellation, and backpressure. Supply fixed named cases plus a deterministic seed for randomized chunking. Require the original API and existing tests to remain intact. Ask Padma to identify the failing mechanism, repair it, and run only the relevant test files.

These are proposed stress cases, not completed live validations. Network deployment, remote effects, arbitrary custom tool behavior, real terminal interaction, and every provider configuration remain outside this verification scope.
