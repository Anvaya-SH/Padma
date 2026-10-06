# Sandhana mission state over RPC

`get_state` returns `data.mission`, or `null` before a mission exists. The versioned `SANDHANA_PUBLIC/1` snapshot reports the committed mission identity, revision, route, phase, bound workspace identity, current operations, mandatory-obligation progress, remaining capacity, authorization-decision references and terminal-report summary.

Instructions, arguments, source content, private errors and process handles are excluded. Workspace and target references identify backend bindings. Artifact references identify retained evidence; this protocol does not return its private contents. Remaining obligations are limited to 32, current operations to four and terminal artifacts to 16. Each list includes an omitted count. Unknown token or cost measurements remain `null`; outstanding reservations reduce the displayed available capacity.

Active progress reflects recorded requirement status. Once a terminal report exists, verified and remaining obligations follow its final current-evidence assessment. An earlier verified requirement whose source became stale appears as unmet in the stopped snapshot. Rendering or replaying this view does not recheck targets or alter historical proof.

Each validated store transaction appends one `PublicMissionEvent` in the same SQLite transaction, including transitions that have no other new record. Its stable `event_id` is `<mission_id>:<revision>`. A failed transaction publishes no event. A repeated acknowledgement of an already committed transaction publishes no duplicate event. Public snapshots are derived views; callers cannot submit them as authoritative records.

The RPC stream sends these records as `sandhana_event`, with `event_id`, `event_type`, `mission_id`, `revision`, nullable `operation_id` and a complete safe snapshot in `payload`. They are distinct from provider/session events. A provider response ending cannot supply the mission's terminal verdict.

To reconnect, obtain `get_state`, retain its mission identity and revision, then request subsequent committed events:

```json
{"id":"catchup","type":"get_mission_events","missionId":"<mission_id>","afterRevision":12,"limit":32}
```

The response contains the current `snapshot`, ordered `events`, `next_revision`, `has_more`, `history_from_revision` and `history_gap`. Pages allow 1–64 events. Continue from `next_revision` while `has_more` is true. Apply snapshots only when their revision exceeds the displayed revision, and deduplicate by `event_id`. Receiving the same page again is safe. Querying these views reads retained records without opening targets, launching tools or charging another invocation.

`history_gap` reports missing revisions between the requested cursor and this page's `next_revision`, including missing initial, interior or final events. `history_from_revision` is the oldest retained public-event revision, or `null` when none exist. An intermediate page advances to its last event; the final page advances to the snapshot revision even when its final events are unavailable. Use the authoritative snapshot to recover current state while retaining the explicit history limitation. Older events are never fabricated. The mission must belong to the active RPC session. Invalid or future cursors and oversized pages are rejected. Storage replay also rejects inconsistent row identity, revision, digest or duplicate revisions, including its bounded lookahead record.

`RpcClient.getState()` exposes the snapshot. `getMissionEvents(missionId, afterRevision, limit)` validates the public envelope and each durable event, mission identity, stable IDs, ordered revisions, page bounds, cursor and gap metadata. A retained event at the snapshot revision must agree with that snapshot. Invalid pages are rejected before being returned to the caller. Fetching history does not advance the live-subscription cursor. `onMissionEvent()` receives validated committed snapshots and suppresses duplicate or older revisions across reconnection; `onEvent()` retains provider/session events. Clients can use the explicit history API for their timeline. An authorization-decision reference remains subject to the kernel's current action, target, revision and grant checks before any dispatch.

`get_mission_authorization` and `RpcClient.getMissionAuthorization(missionId)` inspect the latest retained missing-authorization decision for the mission's current intent, including a denial recorded before an operation marker exists. The mission must belong to the active RPC session. The versioned `SANDHANA_AUTHORIZATION/1` view includes the current mission revision and a nullable request. Each request identifies the decision, prepared action, operation, action digest, prepared/evaluated revisions, intent epoch, expiry and exact target binding/workspace/generation. Its bounded action and effect categories distinguish observations, file replacements, target removal and opaque process effects. A retained replacement can identify its expected content digest.

Arguments, command text, target paths and private source bytes are omitted. `arguments_omitted` is explicit. The client validates the schema, revision relationships and action/effect consistency before returning the view. Requests from earlier trusted intent or superseded decisions are not offered. Inspection reads stored records without target access, new invocation usage or authority changes.

Denied write/edit preparations retain their exact replacement digest and prediction without publishing a preimage artifact or checkpoint. Source reads still require their own current authority and remain charged to the mission. An unconditional target denial is retained as policy evidence and is not offered as an authorization request.

The view requires new preparation and explicit consent from current client input. `expires_at` belongs to the retained scope decision, including an already expired decision. Fetching that request does not renew it. `RpcClient.authorizeMissionAction(view)` submits a strict response through the existing `prompt` entry. Call it only after the user has chosen to authorize that exact retained action. The prompt disposition acknowledges input acceptance; committed mission events and the terminal report supply the result.

The equivalent user instruction is `authorize: ` followed by this JSON, copied from the current view:

```json
{"version":"SANDHANA_APPROVAL/1","mission_id":"<mission_id>","revision":12,"decision_ref":"<decision_ref>","prepared_ref":"<prepared_ref>","action_digest":"<64-character SHA256>"}
```

Admission requires a stopped mission in the current session, its current revision and the latest unconsumed missing-authorization request. Foreign, altered, duplicate or extension responses are rejected. The sourced `ActionApproval` and resume retain the original command, requirements, spending, deadline and prior terminal report. They grant no general edit or read authority.

The controller reuses the retained exact arguments through the governed tool wrapper without another model decision. Fresh preparation must preserve the target/workspace identity, generation, arguments, effect, adapter contract/registration, environment, risk and limits. Only the new binding record identity and intent epoch may differ. The bound grant names one prepared record, exact action digest, operation class, target and environment, and expires 30 seconds plus the retained operation timeout after the user response. Preparation source reads still require their independent current authority and budget. A changed preparation fails without a new effect grant or recovery artifact.

Current policy, revocation, intent, target and resource checks still apply at dispatch. Tier 3 arbitrary shell remains ineligible. One approval binds one preparation; another attempt requires independently applicable authority. Its bound grant cannot authorize later tests or automatic repair. Reopening or replaying these records never dispatches a target. A generic approval message or merely copying a preview into model/extension content cannot authorize it. Completion still depends on the original mandatory obligations and actual verifier evidence.
