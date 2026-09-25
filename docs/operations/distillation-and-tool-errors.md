# Distillation automation and tool failures

Memhub's server owns durable evidence and jobs; an active connected Harness owns semantic synthesis. A ChatGPT scheduled task is a separate scheduler, not a Memhub cron job. A scheduled run does not grant Memhub access to uncaptured ChatGPT history or to the user's subscription-model session.

## Diagnose the stage, not the generic error text

1. **Host safety block before tool execution:** no Memhub request ID or matching Gateway request may exist. This cannot be disabled from Memhub. Record the host-visible error and time; do not treat it as a Memory Core authorization failure.
2. **Transport/result failure:** the tool may have committed its side effect even if the host reports an internal error. Read durable capture/job/artifact state before retrying a write. Reuse the same operation identifier only for the exact same request.
3. **Gateway/Memory Core HTTP error:** correlate `x-memhub-request-id`, the Gateway's structured HTTP error record, and Memory Core `requestId` when available. `401 invalid memory service token` concerns the Core credential; `409 idempotency key reused with different request body` concerns a mismatched request body, not a missing approval code. Do not log or copy credentials.
4. **Normal idle:** `No pending distillation job` means no job can be leased now. It says nothing about uncaptured conversations, complete-but-uningested evidence, or work waiting for the idle threshold.
5. **Lock contention:** check the actual owner and live process before intervention. Memhub's file lock automatically recovers only a verifiably dead local owner; foreign-host or malformed owner records fail closed rather than being reclaimed by age. OursMemory's canonical writer lock is a separate mechanism and must not be touched by Memhub maintenance.

## Safe daily run

Use `memhub_distill action=discover` for a dry-run coverage report, then an actual reconciliation if enabled; older connector schemas can use `next`, which attempts discovery on an empty queue. Preserve the same `source_harness` across `next`, chunk reads and `submit`/`skip`. Inspect `auto_enabled`, `auto_since`, `captured_total`, `complete_uningested`, `incomplete`, `eligible`, `already_queued`, `waiting`, `queued`, and pending/leased/failed counts separately. The `auto_since` ingestion cutover deliberately excludes older evidence from automatic replay. Historical repair requires an evidence-scoped review, not a blanket retry of failed migration jobs.

The capture endpoint normally ingests a complete event into Memory Core before marking it ingested. Discovery only queues complete, ingested, project-resolved evidence. A complete-but-uningested item needs separate investigation; do not silently promote it or reinterpret incomplete/failed capture as completed evidence. Empty or disabled discovery cannot synthesize a memory on its own.

## Version and deployment checks

Distinguish the canonical repository, built `dist/`, running Gateway/Core/Bridge, and the connected host's cached MCP tool schema. A deployed server may support a new action before an existing connector refreshes its schema. Verify `npm test`, a real health probe, the running process's actual build, and an authenticated MCP call independently. A passing health endpoint is not proof that the host's tool invocation succeeded.

Automatic policy updates use the same cross-process state lock as other config mutations, so concurrent admin changes cannot overwrite each other's settings or silently reset the ingestion cutover. Discovery reports the durable queue counts after enqueueing, not a stale pre-scan snapshot.
