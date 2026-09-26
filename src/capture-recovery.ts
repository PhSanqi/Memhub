import {
  isCaptureIngested,
  listCaptureEvents,
  listDevices,
  readCaptureIngestIntentStatus,
  withCaptureIngestAttempt
} from "./capture.js";
import { ingestCaptureIntoMemory } from "./capture-ingest.js";
import { discoverDistillationJobs } from "./distillation-discovery.js";
import type { MemhubRuntime } from "./runtime.js";

/**
 * Explicit single-event redrive. This is deliberately not a global sweeper:
 * capture provenance and project scope must be checked before any Core write.
 * A successful marker remains durable when downstream queueing fails.
 */
export async function recoverCaptureIngest(input: {
  stateRoot: string;
  runtime: MemhubRuntime;
  eventId: string;
  projectId: string;
  dryRun: boolean;
}) {
  const { stateRoot, runtime, eventId, projectId } = input;
  const event = (await listCaptureEvents(stateRoot, runtime.accountId, { eventId }))[0];
  if (!event) throw new Error("capture event not found for account");
  if (event.capture_status !== "complete" || !event.user_text?.trim() || !event.assistant_text?.trim()) {
    throw new Error("recover_ingest requires a complete capture with user_text and assistant_text");
  }
  if (!event.project_hint || await runtime.projects.resolve(runtime.accountId, event.project_hint) !== projectId) {
    throw new Error("capture project_hint does not match the explicitly resolved project");
  }
  const device = (await listDevices(stateRoot, runtime.accountId)).find((item) =>
    item.device_id === event.device_id && !item.revoked_at
  );
  if (!device) throw new Error("capture device missing or revoked; manual provenance review required");
  const markerExists = await isCaptureIngested(stateRoot, runtime.accountId, eventId);
  if (event.ingested && !markerExists) throw new Error("capture index/marker conflict; manual repair required");
  if (input.dryRun) {
    return {
      ok: true, dry_run: true, event_id: eventId, project: projectId,
      capture_status: event.capture_status, already_ingested: markerExists,
      instructions: "No Memory Core write, marker change, or distillation enqueue occurred."
    };
  }
  // Share the same per-event lock and durable intent as HTTP capture. The
  // snapshot is rechecked after lock acquisition before any Core write.
  const attempt = await withCaptureIngestAttempt({
    stateRoot, accountId: runtime.accountId, eventId, expectedEvent: event,
    ingest: (current) => ingestCaptureIntoMemory({ event: current, device, runtime, projectId })
  });
  if (!attempt.alreadyIngested && !attempt.result?.ingested) {
    throw new Error("capture ingestion did not complete");
  }
  let discovery: Awaited<ReturnType<typeof discoverDistillationJobs>> | undefined;
  let discovery_error: string | undefined;
  try {
    discovery = await discoverDistillationJobs({
      stateRoot, accountId: runtime.accountId,
      resolveProject: (hint) => runtime.projects.resolve(runtime.accountId, hint),
      enqueue: true, conversationId: event.conversation_id
    });
  } catch (error) {
    discovery_error = error instanceof Error ? error.message : String(error);
  }
  return {
    ok: true, event_id: eventId, project: projectId,
    already_ingested: attempt.alreadyIngested, ingested: true,
    ...(discovery ? { discovery } : {}),
    ...(discovery_error ? { discovery_error } : {})
  };
}

/**
 * Automatic crash recovery is deliberately narrower than recover_ingest:
 * only captures with a matching durable ingest intent are eligible. Legacy
 * complete captures with no intent, conflicting intents, revoked devices and
 * unresolved projects remain manual-review cases.
 */
export async function reconcileFrozenCaptureIngests(input: {
  stateRoot: string;
  runtime: MemhubRuntime;
}): Promise<{
  scanned: number;
  frozen: number;
  recovered: number;
  skipped: number;
  failed: number;
}> {
  const { stateRoot, runtime } = input;
  const captures = await listCaptureEvents(stateRoot, runtime.accountId, {
    completeOnly: true,
    ingested: false
  });
  const devices = await listDevices(stateRoot, runtime.accountId);
  let frozen = 0;
  let recovered = 0;
  let skipped = 0;
  let failed = 0;
  for (const event of captures) {
    const intent = await readCaptureIngestIntentStatus(
      stateRoot, runtime.accountId, event.event_id
    );
    if (intent !== "matching") {
      skipped += 1;
      continue;
    }
    frozen += 1;
    try {
      if (!event.project_hint) {
        skipped += 1;
        continue;
      }
      const projectId = await runtime.projects.resolve(runtime.accountId, event.project_hint);
      if (!projectId) {
        skipped += 1;
        continue;
      }
      const device = devices.find((item) =>
        item.device_id === event.device_id && !item.revoked_at
      );
      if (!device) {
        skipped += 1;
        continue;
      }
      const attempt = await withCaptureIngestAttempt({
        stateRoot,
        accountId: runtime.accountId,
        eventId: event.event_id,
        expectedEvent: event,
        ingest: (current) => ingestCaptureIntoMemory({
          event: current, device, runtime, projectId
        })
      });
      if (attempt.alreadyIngested || attempt.result?.ingested) recovered += 1;
      else failed += 1;
    } catch {
      // Keep the frozen intent and raw capture intact for the next retry or
      // explicit operator review. Never mutate/delete evidence on failure.
      failed += 1;
    }
  }
  return {
    scanned: captures.length,
    frozen,
    recovered,
    skipped,
    failed
  };
}
