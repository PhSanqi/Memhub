import { createHash } from "node:crypto";
import type { DeviceRecord, StoredCaptureEvent } from "./capture.js";
import type { MemhubRuntime } from "./runtime.js";

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
 * Partial hook events remain in Memhub raw capture storage until the same
 * event_id is completed by a later hook. Capture never triggers recall:
 * automatic upload is a write path, not a context-request path.
 */
export async function ingestCaptureIntoMemory(input: {
  event: StoredCaptureEvent;
  device: Pick<DeviceRecord, "device_id" | "account_id" | "name">;
  runtime: MemhubRuntime;
  projectId: string | null;
}): Promise<CaptureIngestResult> {
  const { event, device, runtime, projectId } = input;
  const userText = event.user_text?.trim();
  const assistantText = event.assistant_text?.trim();
  if (!userText || !assistantText || event.capture_status !== "complete") {
    return {
      ingested: false,
      reason: `turn_not_complete:${event.capture_status}`,
      project_id: projectId
    };
  }

  // Memory sessions are project-scoped. A host conversation that switches
  // projects therefore gets a new Memory session while retaining its host
  // conversation_id in provenance/bindings.
  const sessionId = captureSessionId(runtime.accountId, event.host, event.continuity_id, projectId);
  const turnId = deterministicId(
    "mhcap_turn",
    `${runtime.accountId}\0${event.host}\0${event.event_id}`
  );
  const namespace = {
    source: "memhub-capture",
    profileId: "default",
    userId: runtime.userId,
    tenantId: runtime.accountId,
    sessionKey: `${event.host}:${event.continuity_id}`,
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
      device_id: device.device_id,
      device_name: device.name,
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
    ...((event.reasoning_summary ?? event.tool_summary)
      ? { reasoningSummary: event.reasoning_summary ?? event.tool_summary }
      : {}),
    tags: unique([
      "memhub-capture",
      `host:${event.host}`,
      ...(projectId ? [`project:${projectId}`] : ["global"])
    ]),
    artifacts: [{
      type: "memhub_capture",
      event_id: event.event_id,
      device_id: device.device_id,
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

export function captureSessionId(accountId: string, host: string, continuityId: string, projectId: string | null): string {
  return deterministicId("mhcap_session", `${accountId}\0${host}\0${continuityId}\0${projectId ?? "global"}`);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
