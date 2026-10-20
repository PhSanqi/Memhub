import { createHash } from "node:crypto";
import type { CaptureActor, StoredCaptureEvent } from "./capture.js";
import type { MemhubRuntime } from "./runtime.js";
import { redactSecrets } from "./secret-redaction.js";

export interface CaptureIngestResult {
  ingested: boolean;
  reason?: string;
  session_id?: string;
  turn_id?: string;
  project_id: string | null;
}

/**
 * Promote a completed capture event into Memory Core.
 *
 * Partial L1 events remain in Memhub raw turn storage until the same event_id
 * is completed. Ingestion never triggers recall: this is a write path, not a
 * context-request path.
 */
export async function ingestCaptureIntoMemory(input: {
  event: StoredCaptureEvent;
  actor: CaptureActor;
  runtime: MemhubRuntime;
  projectId: string | null;
}): Promise<CaptureIngestResult> {
  const { event, actor, runtime, projectId } = input;
  // New captures are already redacted before persistence. Legacy stored raw
  // events (and anything written before this policy) are redacted here so the
  // Core copy never receives an inline secret. redactSecrets is idempotent, so
  // the already-redacted path is a no-op.
  const userText = redactSecrets(event.user_text ?? "").text.trim();
  const assistantText = redactSecrets(event.assistant_text ?? "").text.trim();
  const reasoningSummary = redactSecrets(event.reasoning_summary ?? event.tool_summary ?? "").text.trim();
  if (!userText || !assistantText || event.capture_status !== "complete") {
    return {
      ingested: false,
      reason: `turn_not_complete:${event.capture_status}`,
      project_id: projectId
    };
  }

  // Memory Core requires a session envelope, but Memhub does not use host
  // conversation/session identity as durable routing state. Give each L1
  // event its own deterministic Core session so replay remains idempotent.
  const sessionId = captureSessionId(runtime.accountId, event.event_id);
  const turnId = captureTurnId(runtime.accountId, event.host, event.event_id);
  const namespace = {
    source: "memhub-capture",
    profileId: "default",
    userId: runtime.userId,
    tenantId: runtime.accountId,
    sessionKey: `event:${event.event_id}`,
    ...(projectId ? { projectId } : {}),
    ...(event.workspace_id ? { workspaceId: event.workspace_id } : {}),
    ...(event.workspace_path ? { workspacePath: event.workspace_path } : {})
  };
  const common = {
    adapterId: "memhub-capture",
    namespace
  };

  // A session may be resumed by many turns with different workspace metadata.
  // Use a stable per-event requestId so an earlier session.open idempotency key
  // cannot conflict with the next turn's request body.
  await runtime.memoryClient.openSession({
    ...common,
    requestId: deterministicId(
      "mhcap_req",
      `${runtime.accountId}\0${event.host}\0${event.event_id}:session`
    ),
    source: "memhub-capture",
    sessionId,
    ...(projectId ? { projectId } : {}),
    ...(event.workspace_id ? { workspaceId: event.workspace_id } : {}),
    ...(event.workspace_path ? { workspacePath: event.workspace_path } : {}),
    meta: {
      actor_id: actor.actor_id,
      actor_name: event.host,
      host: event.host,
      conversation_id: event.conversation_id,
      continuity_id: event.continuity_id
    }
  });

  await runtime.memoryClient.completeTurn(turnId, {
    ...common,
    requestId: deterministicId(
      "mhcap_req",
      `${runtime.accountId}\0${event.host}\0${event.event_id}:complete`
    ),
    sessionId,
    query: userText,
    answer: assistantText,
    ...(reasoningSummary ? { reasoningSummary } : {}),
    tags: unique([
      "memhub-capture",
      `host:${event.host}`,
      ...(projectId ? [`project:${projectId}`] : ["global"])
    ]),
    artifacts: [{
      type: "memhub_capture",
      event_id: event.event_id,
      actor_id: actor.actor_id,
      ...(event.host_version ? { host_version: event.host_version } : {}),
      ...(event.turn_id ? { original_turn_id: event.turn_id } : {}),
      continuity_id: event.continuity_id,
      capture_status: event.capture_status,
      ...(event.previous_event_id ? { previous_event_id: event.previous_event_id } : {}),
      timestamp: event.timestamp,
      ...(event.workspace_id ? { workspace_id: event.workspace_id } : {}),
      ...(event.workspace_path ? { workspace_path: event.workspace_path } : {}),
      ...(event.provenance ? { provenance: event.provenance } : {})
    }],
    status: "succeeded"
  });

  return {
    ingested: true,
    session_id: sessionId,
    turn_id: turnId,
    project_id: projectId
  };
}

function deterministicId(prefix: string, source: string): string {
  return `${prefix}_${createHash("sha256").update(source, "utf8").digest("hex").slice(0, 40)}`;
}

export function captureSessionId(accountId: string, eventId: string): string {
  return deterministicId("mhcap_session", `${accountId}\0${eventId}`);
}

/**
 * The deterministic Core turn id for an ingested capture. Shared with the
 * Control Plane so a capture and its Core raw turn can be paired by identity
 * instead of by re-matching trimmed text.
 */
export function captureTurnId(accountId: string, host: string, eventId: string): string {
  return deterministicId("mhcap_turn", `${accountId}\0${host}\0${eventId}`);
}

/**
 * The raw-turn id Memory Core derives for an ingested capture. Core does not
 * store the request turn id as `rawTurnId`; it uses
 * `raw_${stableHash(`${sessionId}:${turnId}`).slice(0, 20)}`, with the session
 * id Memhub passes in openSession and the turn id passed in completeTurn
 * (`vendor/memory-core/src/service/turn/turn-normalization.js:30`,
 * `session-turn-service.js:924`).
 *
 * The vendored Core module lives outside this package's `src` rootDir, so
 * `stableHash`'s string path is mirrored here. `tests/p6-l1-dedupe.mjs` pins
 * this helper against the vendored `rawTurnIdForSessionTurn`/`stableHash`.
 */
export function captureCoreRawTurnId(accountId: string, host: string, eventId: string): string {
  return rawTurnIdForSessionTurn(
    captureSessionId(accountId, eventId),
    captureTurnId(accountId, host, eventId)
  );
}

const STABLE_STRINGIFY_MAX_STRING_LENGTH = 20_000;

function rawTurnIdForSessionTurn(sessionId: string, turnId: string): string {
  return `raw_${stableHash(`${sessionId}:${turnId}`).slice(0, 20)}`;
}

/** Mirrors `stableHash` from `vendor/memory-core/src/utils/id.js` for strings. */
function stableHash(value: string): string {
  // Core's stableStringify calls limitStableString before JSON.stringify.
  const limited = value.length <= STABLE_STRINGIFY_MAX_STRING_LENGTH
    ? value
    : `${value.slice(0, STABLE_STRINGIFY_MAX_STRING_LENGTH)}[stable-stringify:string-truncated:${value.length - STABLE_STRINGIFY_MAX_STRING_LENGTH}]`;
  return createHash("sha256").update(JSON.stringify(limited), "utf8").digest("hex");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
