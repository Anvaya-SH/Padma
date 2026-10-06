# Phase 3: durable subordinate operations

## Mounted implementation

`packages/coding-agent/src/core/sandhana/operations.ts` is subordinate to Sandhana. It has no provider, independent mission loop, budget, or completion verdict. `kernel.ts` separates `prepareOperation()` from `dispatchPrepared()` while preserving the existing guarded file replacement, shell spawn guard, Phala capture, Pariksha comparison, verification, and cumulative account.

`OperationSchedule` records reference the original `OperationRecord`, preparation, action digest, registered schema, target binding/preconditions, authorization decision, reservation, and prediction. Those records remain in the same revisioned SQLite transaction history. Scheduling has QUEUED, DISPATCHED, RUNNING, CANCEL_REQUESTED, COMPLETED, FAILED, CANCELLED, and UNCERTAIN states; effects retain NOT_STARTED, IN_PROGRESS, CONFIRMED_COMPLETE, FAILED, and OUTCOME_UNKNOWN. Append-only control evidence records every scheduling transition and its source revision. Claims use expected-revision transactions, not expiring leases or PID ownership guesses. Duplicate submission/settlement does not create another effect or invocation charge.

Dependencies explicitly require EFFECT_CONFIRMED or PROCESS_SUCCEEDED. Cycles, missing references, and cross-mission references are rejected. Required observations, retained postimages, process exits, and current prerequisite target/source generations are checked before launch. A stale prerequisite cannot authorize dependent execution. Failed/uncertain prerequisites cancel dependent queued work with a reason and release only unstarted reservations. Existing preparations are never silently rebound.

Only separate reviewed local reads/listings have established concurrent independence. Writes, tests/builds, status/search, and opaque shell operations remain ordered. An uncertain guarded single-target replacement can coexist with an unaffected separate observation; opaque shell uncertainty fences all target execution. Default concurrency is one below 8 GiB physical memory, otherwise two, with a maximum of four and a queue bound of 64. Current mission policy, intent, target identity/generation, adapter registration, environment, reservation, dependencies, and deadline are checked at the final Kshepana boundary.

## Access and steering

The controller exposes `sandhana_operation` through Pi's validated tool executor:

- `submit`: registered tool and arguments, optionally dependency operation IDs and their required conditions.
- `inspect`: durable schedule, effect, execution observations, and attachment availability.
- `output`: associated artifact/evidence reference with a byte offset and at most 8192 bytes.
- `cancel`: request cancellation; never implies rollback.
- `reconcile`: retain a known result, or persist the exact unresolved reconciliation limitation. Supported file reconciliation uses the existing explicit `resume <mission-id>` target-inspection path.

SDK code can use `kernel.operations` for preparation/submission, inspection, recovery, cancellation, reconnection, and bounded output. Controls used by the model are charged to the parent account. Output slices charge cumulative retrieval and presentation bytes; progress charges retained artifact/output bytes. Cancellation of an owned execution remains available at resource exhaustion and records its actual control invocation as an overrun rather than borrowing another allowance.

Trusted user steering uses ordinary session steering input:

```text
operations: {"concurrency":1}
operations: {"cancel":"operation-id"}
operations: {"priority":{"id":"operation-id","value":10}}
operations: {"deny_targets":["path/to/affected-target"]}
```

Concurrency changes do not cancel already running independent work. Denied targets are append-only, sourced user constraints; unaffected operations retain their original preparations. General new requirements/target changes invalidate queued preparations through the existing intent epoch. Stop requests revoke authority, cancel queued work, and request cancellation of validated running handles. Late results retain their original action and cannot verify newer steering requirements or replace a previous terminal report.

## Events, output, and recovery

Pi's existing tool lifecycle events show scheduling truth, progress references, dependency blocks, cancellation requests, and uncertainty. Sandhana can make useful independent decisions while operations run. When it has no useful action, it waits for backend events rather than repeatedly calling a model to poll. Progress snapshots are coalesced to at most one per second and sixteen retained snapshots; later omitted progress is reported explicitly. These are bounded redacted adapter snapshots, not invented percentages or complete streaming-log claims. Native output still uses Phase 2's receipt-bound combined stdout/stderr capture and bounded retained final artifacts. Streams remain combined; no separate stdout/stderr ordering is claimed.

Native shell observations include an owned child token, PID, host/runtime identity, spawn timestamp, Node child supervisor, observed exit/signal/EOF, and cancellation request/dispatched flags. Cancellation uses the existing process-tree mechanism only through the validated live runtime callback. A stored PID cannot receive cancellation after restart; the native path also refuses to signal an already exited child. Process exit and prior target effects are separate facts. An exit observed before cancellation retains actual completion; interruption after an earlier effect retains uncertainty and measured usage.

Client disconnect is supported only when the owning runtime continues. Explicit abort and interactive shutdown may terminate work according to their existing contracts. There is **no supervised runtime-restart process reattachment** and **no remote execution backend**. Reopening loads the original mission and operations, retains known results, and fences unresolved durable starts without replay. Adapter registrations capture live executor/closure custody: a queue surviving runtime loss is not automatically dispatched through a replacement registration. It must be stopped and freshly prepared under current policy; guarded local replacement reconciliation remains supported independently.

A real process-death fixture exits after guarded rename but before result persistence. Reopening selects the original uncertain operation, inspects actual target bytes through the existing governed read, settles its file postcondition without another write, and retains its original unmeasured reservation. Differing bytes, unsupported partial effects, or opaque process effects cannot establish absence or safe repeat. No universal exactly-once external execution, rollback, resource-volume reconstruction, or arbitrary idempotency endpoint is claimed.

## Development checks

New deterministic checks use temporary files, controlled native processes, SQLite, and the actual Pi session with the faux provider. They cover safe overlap, ordered conflicting writes, observed/fresh dependencies, missing references/cycles, competing claims, queued revocation, target constraints, concurrency reduction, cancellation/completion races, invalid handles, client reconnection without relaunch, crash snapshot recovery, actual runtime death after replacement, duplicate settlement, uncertain retry fences, late results after steering/stopped reports, durable bounded output, and protected verification capacity.

Final `npm run check` passed: Biome, pinned/runtime dependencies, TypeScript imports, entry graphs, both lock consistency checks, TypeScript, and browser smoke. The final serialized focused run passed **224 tests across 20 files**, including **24 new operation/recovery/session checks** and existing kernel, authorization, budget, output, reporting, reconciliation, migration, governor, hypotheses, session, and native shell regressions. Node SQLite emits its existing experimental runtime warning. No full suite, build, real provider request, commit, worker-agent orchestration, remote backend, or GUI redesign was run.
