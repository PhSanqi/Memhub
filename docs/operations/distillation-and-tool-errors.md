# Distillation automation and tool failures

Memhub's server owns durable evidence and jobs; an active connected Harness owns semantic synthesis. A ChatGPT scheduled task is a separate scheduler, not a Memhub cron job. A scheduled run does not grant Memhub access to uncaptured ChatGPT history or to the user's subscription-model session.

## Diagnose the stage, not the generic error text

For tool usage, read the connected MCP server's live `tools/list` inputSchema. It is the authoritative help for action enums, required fields and nested types; avoid a parallel handwritten parameter table that can drift from the deployed connector. A host may cache an older schema even after a server restart, so reconnect before concluding that an action such as `renew` is unsupported. `memhub_distill inspect_contract=true` provides the semantic distillation contract separately from the transport schema. `memmy_project_manage action=plan` rejects metadata updates with no effective changes and malformed aliases; `memhub_todo complete/reopen` intentionally remains idempotent and repeated calls do not advance its change timestamps.

1. **Host safety block before tool execution:** no Memhub request ID or matching Gateway request may exist. This cannot be disabled from Memhub. Record the host-visible error and time; do not treat it as a Memory Core authorization failure.
2. **Transport/result failure:** the tool may have committed its side effect even if the host reports an internal error. Read durable capture/job/artifact state before retrying a write. Reuse the same operation identifier only for the exact same request.
3. **Gateway/Memory Core HTTP error:** correlate `x-memhub-request-id`, the Gateway's structured HTTP error record, and Memory Core `requestId` when available. `401 invalid memory service token` concerns the Core credential; `409 idempotency key reused with different request body` concerns a mismatched request body, not a missing approval code. Do not log or copy credentials.
   A Core HTTP 409 during capture is returned to the device as `409 capture_ingest_conflict` (and leaves the durable capture un-ingested), not disguised as a retryable 503. Genuine transient Core failures remain `503 capture_ingest_failed`. Resolve the request-body conflict before replaying the same event; changing its idempotency key to bypass the conflict is unsafe.
   Device-side capture authentication remains distinct: missing device token is 401, invalid/revoked device token is 403, Core idempotency conflict is 409, and transient Core failure is surfaced as 503. Error responses carry `x-memhub-request-id`; neither Gateway error logs nor LocalMemoryRestClient error strings may echo bearer credentials.
4. **Normal idle:** `No pending distillation job` means no job can be leased now. It says nothing about uncaptured conversations, complete-but-uningested evidence, or work waiting for the idle threshold.
5. **Lock contention:** check the actual owner and live process before intervention. Memhub's file lock automatically recovers only a verifiably dead local owner; foreign-host or malformed owner records fail closed rather than being reclaimed by age. Any external application's canonical writer lock is a separate mechanism and must not be touched by Memhub maintenance.

## Safe daily run

Use `memhub_distill action=discover` for a dry-run coverage report, then an actual reconciliation if enabled; older connector schemas can use `next`, which attempts discovery on an empty queue. Preserve the same `source_harness` across `next`, chunk reads and `submit`/`skip`. Inspect `auto_enabled`, `auto_since`, `captured_total`, `complete_uningested`, `incomplete`, `eligible`, `already_queued`, `waiting`, `queued`, and pending/leased/failed counts separately. The `auto_since` ingestion cutover deliberately excludes older evidence from automatic replay. Historical repair requires an evidence-scoped review, not a blanket retry of failed migration jobs.

New Harness clients can opt into generation-fenced leases with `next` + `lease_token_supported=true`. Preserve the returned opaque `job.lease_token` and send it with every later `next(job_id)`, `submit`, or `skip`; for long synthesis, use `renew(job_id, lease_token, source_harness, lease_seconds)` before expiry. An expired/reassigned lease receives a different token even if the harness name is unchanged; old tokens are rejected. Existing clients that do not opt in retain legacy owner-only leases for compatibility, which do **not** provide same-owner stale-worker fencing. A renewal never shortens an active lease. Do not log lease tokens. This is a staged control-plane improvement, not an atomic transaction around the external Memory Core write; durable outbox and cross-store fault injection remain required before declaring end-to-end exactly-once behavior.

The capture endpoint normally ingests a complete event into Memory Core before marking it ingested. Discovery only queues complete, ingested, project-resolved evidence. A complete-but-uningested item needs separate investigation; do not silently promote it or reinterpret incomplete/failed capture as completed evidence. Empty or disabled discovery cannot synthesize a memory on its own.

The first successful `.ingested` marker records the ingestion cutover timestamp. Duplicate marking is idempotent and must not move historical evidence past `auto_since`; the marker is installed by atomic rename before the index is marked ingested. If queueing fails after a successful marker, rerun `discover`: the durable capture and deterministic job evidence keys allow reconciliation without blindly replaying a Memory Core write. If the marker is missing, investigate the original Core outcome and request-id contract before retrying ingestion; do not fabricate a marker. This recovery is not yet an atomic Core/Job outbox.

For an individually investigated complete-but-uningested device capture, use `memhub_distill action=recover_ingest event_id=<exact-id> project=<canonical-slug> dry_run=true` first. The live schema requires an explicit project and checks the stored project hint, account, registered non-revoked capture device, and complete user/assistant content. Omitting `dry_run` retries only that event using its stable Core request IDs, writes the ingestion marker after Core success, and attempts conversation-scoped discovery; a discovery failure is returned separately for a later `discover` retry. Missing/revoked devices, incomplete events, project mismatches, and Core 409 fail closed. It cannot repair captures that were never received, guarantee an already-ambiguous Core commit without its idempotency contract, or turn an uncaptured ChatGPT history into evidence; never run an unreviewed bulk recovery.

The local HTTP capture path and `recover_ingest` share an account/event-scoped ingest-attempt lock. Before the first complete Core write, an immutable `.ingest-intent` content fingerprint is durably created while holding the capture-index mutation lock; replays must match the frozen event, even if an upstream response was lost before `.ingested` was written. An in-flight or failed Core attempt is **not** permission for late capture enrichment under the same request ID. A pre-marker failure retains both raw capture and intent. Matching frozen intents are safe for automatic idempotent replay because the request payload and Core IDs are fixed; legacy complete captures with no intent, conflicting intents, missing raw data, revoked devices, or unresolved projects remain manual-review cases. Do not delete or rewrite an intent to force a retry. The read-only audit separates these cases and also distinguishes unqueued evidence that has reached the turn threshold or idle cutoff from normal evidence still waiting for its batching window; `eligible_unqueued` by itself does not mean an overdue job. This closes the local payload race, but does not make independent Core/Job stores atomic or prove exactly-once delivery.

The account-scoped read-only audit also returns bounded `review_samples`: at most 20 complete-uningested event IDs with their intent classification, and at most 20 unresolved ingested event IDs with a reason (`missing_project_hint`, `incomplete_turn_content`, or `unknown_project`). These contain only identifiers and project hints, never raw conversation text. The aggregate counts remain authoritative when there are more than 20; the samples are for targeted provenance investigation, not permission to rewrite project hints, replay legacy Core requests, or enqueue unresolved evidence.

After a successful Core write, the durable `.ingested` marker acts as the source of pending L1 evidence for downstream reconciliation. The HTTP Gateway reconciles immediately after binding its listener, then every 60 seconds; overlapping full-account runs are coalesced. Before discovery, it retries only matching frozen ingest intents with their original deterministic Core IDs, allowing a process crash after Core commit but before the marker to converge without operator intervention. It never auto-replays legacy no-intent captures. A crash between marker and job enqueue likewise needs no new Capture: discovery replays the marker into the existing job store, whose durable lock rejects overlapping L2 evidence. The real-stack crash smoke terminates separate processes after real Core success both before and after the marker, verifies restart convergence, and verifies repeated startup does not duplicate downstream evidence. These are at-least-once reconciliation properties with deterministic idempotency, not an atomic transaction or an exactly-once guarantee.

Use `memhub_distill action=audit` for a read-only durable-state diagnosis before recovery. It reports complete-but-uningested captures, ingested evidence before the automatic cutover, unresolved project evidence, durable eligible-but-unqueued L1, existing job states, and (only when the Gateway is explicitly configured with `MEMHUB_BRIDGE_HOME`) Bridge backlog. Audit does not call Core, enqueue jobs, recover Bridge claims, or infer uncaptured conversation history. A non-zero complete-uningested count is a review queue, not permission for bulk redrive.

Audit opens an existing capture index strictly read-only. It must not rebuild the SQLite index or create one on an empty account. Missing index with existing raw captures, dirty index state, index/marker disagreement, and malformed ingestion marker fail closed with a repair-required error. Repair the index through a separate authorized procedure before treating audit counts as current; the audit is a durable local snapshot, not a transaction spanning live Core/Bridge/Job stores.

Complete captures become immutable after ingestion: subsequent delivery of an identical event is idempotent, but late changes to its project, content, or provenance fail closed rather than silently diverging from the original Core request body. A simulated Core response loss after commit verifies that retry uses the same deterministic session/turn request IDs; it is a fault-injection test, not proof of atomic cross-service exactly-once delivery. Job enqueue also rejects overlapping L2 evidence for the same account/project/conversation under the durable queue lock. If competing batch boundaries leave a turn unclaimed, the next discovery pass can queue it without duplicating existing evidence.

## Version and deployment checks

Distinguish the canonical repository, built `dist/`, running Gateway/Core/Bridge, and the connected host's cached MCP tool schema. A deployed server may support a new action before an existing connector refreshes its schema. Verify `npm test`, a real health probe, the running process's actual build, and an authenticated MCP call independently. A passing health endpoint is not proof that the host's tool invocation succeeded.

Automatic policy updates use the same cross-process state lock as other config mutations, so concurrent admin changes cannot overwrite each other's settings or silently reset the ingestion cutover. Discovery reports the durable queue counts after enqueueing, not a stale pre-scan snapshot.

## Completed Core write versus secondary metadata and derived queue failures

An L2/L3 submit has several independent durable side effects: Memory Core
artifact write, optional L2 project description, completed source Job, and
the next-layer Job. Do not classify all of them as a single Core transaction.
When Core returns a stable artifact ID, a failed optional project description
now returns `project_description_error` without marking the source Job
failed. A failed L2→L3 or L3→L4 queue operation after durable Job completion
returns `next_layer_enqueue_error`, preserving the completed source Job.
Neither warning authorizes a new Core write to the same artifact.

`memhub_distill action=audit` now includes
`recovery.completed_l2_missing_l3` and up to 20
`review_samples.completed_l2_missing_l3` entries containing only the
completed source Job ID and project ID. It does not enqueue anything or
claim an L3 job. Investigate each exact missing derived claim and use
`memhub_distill action=reconcile_derived job_id=<completed-L2-job-id>
project=<canonical-project>` to inspect it. This action **defaults to
read-only**; only `dry_run=false` explicitly requests a missing L3 queue
claim. The source must be a completed, account-visible, project-matched L2
with a durable result ID, content and completion timestamp. Existing claims
are checked for matching project and exact source evidence; duplicate or
conflicting claims refuse recovery. An otherwise matching child that also
contains **extra unrelated evidence** is not an exact claim: both the
read-only audit and explicit reconciliation reject it, rather than trusting
one matching reference while silently importing other source material.
The queue's durable mutation lock makes
simultaneous reconciliations idempotent. The result includes only source
and derived Job IDs, not the full artifact text, and reports
`core_replayed=false`. Never recover by retrying a completed L2 Core write.
This does not yet provide automatic cross-store outbox recovery, and a
successful 200 response with a secondary warning should not be read as
end-to-end pipeline completion.

The read-only audit distinguishes a **missing** L3 claim from a
**conflicting** claim. `recovery.completed_l2_conflicting_l3` is non-zero
when the expected L2 evidence ref is claimed by multiple L3 jobs, by a
different project, or by an L3 evidence item whose layer/content/completion
timestamp does not exactly match the completed L2 result. These are
manual-repair conditions: `reconcile_derived` must fail closed rather than
treat a reused ref as proof of correct lineage.

For the account-scoped L3→L4 edge, the audit also evaluates the current
**latest completed L3 per project** evidence set. It reports
`recovery.current_l3_set_missing_l4` or
`recovery.current_l3_set_conflicting_l4` when that exact current set lacks
an L4 claim or is claimed with duplicate/scope/content provenance conflicts.
`review_samples.current_l3_set_l4` contains only bounded source Job IDs,
project IDs, matching L4 Job IDs and the conflict reason.

Use `memhub_distill action=reconcile_l4 job_id=<current-L3-job-id>` to
inspect this edge. It defaults to read-only and never calls Memory Core.
The source L3 must still be the newest completed L3 for its project; Memhub
then reconstructs the exact newest L3 result from every project and requires
at least two projects. Only `dry_run=false` may enqueue the missing
account-scoped L4 job. Existing exact claims are idempotent, while multiple
claims or reused refs with mismatched project/content/completion timestamps
fail closed. An L4 claim must contain exactly the current source set with
no additional hidden evidence, including after a concurrent queue claim
is returned. An older L3 version cannot authorize a current L4 rebuild.

## Lease generation after an external Core attempt

Opaque lease tokens fence a worker **generation**, not merely a harness
name. Immediately before an external Memory Core write Memhub verifies the
active lease and ensures enough remaining time for the bounded Core request.
Token-fenced generations are extended in place when necessary; a legacy
owner-only lease that is too close to expiry is rejected **before** Core is
called and must be reacquired. That local refusal is not recorded as a Core
failure. If the request then crosses its wall-clock deadline but the
same opaque token is still stored, a successful Core result may be recorded
by that generation; expiry alone is not evidence of reassignment. Leasing
unrelated work no longer sweeps or deletes tokens from other expired jobs.
An expired job receives a new token only when that exact job is actually
selected for reassignment. Once the token changes, the old worker cannot
complete or fail the replacement generation.

A Core success response that lacks a stable result ID is an **ambiguous
commit**. Its token generation is quarantined as a failed job with
`failure_kind=ambiguous_core_commit`, preventing lease expiry from silently
returning it to pending. Ordinary retry is disabled for that failure kind;
operators must reconcile the Core outcome first. Normal Core failures use
`failure_kind=core_error` and retain the existing explicit retry workflow.
The Control Plane retry mutation is enforced server-side as Admin-only
(not merely hidden in the workspace UI), and the UI suppresses retry
controls for ambiguous commits.

For successful writes, Memhub freezes `result_committed_at` immediately
after Memory Core returns, before waiting for the local Job-store mutation
lock. L3→L4 “current version” selection uses this Core response/write order,
falling back to historical `completed_at` for older Jobs. It must not use
`created_at`, because an older-created L3 worker can finish after a
newer-created worker and become the final Core revision. Derived L2→L3 and
L3→L4 evidence timestamps use the same frozen result timestamp, keeping
submit, audit and explicit reconciliation on one provenance rule.
