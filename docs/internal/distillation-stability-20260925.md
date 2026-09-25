# Distillation and runtime stability audit (2026-09-25)

## Evidence and scope

The production capture index had 302 events: 236 complete, 235 ingested, and 66 incomplete. The sole complete un-ingested event was a marked AIDE test event. The job store had 44 completed and seven historical failed migration jobs; no pending job. The automatic policy was disabled and no persisted policy file existed. Memory Core's read-only `quick_check` returned `ok`. Gateway, Core and Bridge were active. These facts do not establish that all ChatGPT conversations were captured.

## Confirmed failure modes and changes

1. `next` consumed existing jobs but did not discover new evidence. Added explicit account-scoped `discover` with read-only preview and idempotent enqueue; when enabled, an empty `next` now reconciles and retries leasing before reporting idle. It does not imply complete historical coverage.
2. Automatic processing defaulted to off; the HTTP threshold path used a modulo condition and idle processing required at least two turns. Unified both triggers with a single capture reconciler, including one-turn idle processing.
3. `memmy_turn` commits ingested L1 but did not trigger the automatic queue. It now uses the same reconciler. Queue failure after successful L1 ingestion no longer turns the HTTP capture response into an ingestion failure; a subsequent scan can recover the missed job.
4. A session-open idempotency key was shared by all turns in one continuity while the request body could vary with workspace metadata. Session-open now uses a stable per-event request ID and retains the project-scoped session ID.
5. Auto activation now records an ingestion-time cutover. Historical evidence is not silently replayed, while a partial turn completed after activation is eligible. Legacy enabled policies lacking a cutover fail closed.
6. HTTP error responses include a request correlation header; failed HTTP requests produce structured, body-free log entries. The MCP server version is derived from the packaged version instead of a stale hard-coded value.

## Limits and remaining structural work

- Memhub cannot discover uncaptured ChatGPT history or invoke a subscription model inside the server. The ChatGPT Automation is the semantic executor; a platform safety block occurs before the MCP server and cannot be fixed by changing a local token.
- The gateway source combines MCP registration, HTTP identity, capture, admin routes and inline UI in one large module. Extracting the HTTP/UI/control-plane modules is recommended in staged, contract-tested changes rather than a blind rewrite.
- The job store uses a file mutation lock and a harness-name lease owner. A future revision should introduce an opaque per-lease generation token and explicit renewal to prevent a stale worker with the same harness name from submitting after a lease is reassigned. This requires an MCP contract migration and compatibility tests.
- Capture marker and job enqueue are not a single database transaction. The reconciler provides eventual recovery, but a durable outbox would strengthen crash recovery and large-scale throughput.
- Historical failed migration jobs require valid project-scoped evidence reconstruction; automatic discovery deliberately does not retry them or ingest test evidence.

## Verification contract

Run `npm test`, `npm run stability:check`, a read-only Memory Core integrity check, and authenticated production MCP smoke after deployment. Verify active OursMemory writer separately and never clear its lock or restart it as part of Memhub Gateway rollout. Report code/build/service/production MCP as distinct states.
