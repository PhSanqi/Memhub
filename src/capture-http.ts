import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authenticateDevice,
  normalizeCaptureEvent,
  storeCaptureEvent,
  withCaptureIngestAttempt
} from "./capture.js";
import { ingestCaptureIntoMemory } from "./capture-ingest.js";
import { asHttpJsonBodyError, readJsonBody } from "./http-json.js";
import { MemoryCoreHttpError } from "./local-memory-client.js";
import type { MemhubRuntime } from "./runtime.js";

export async function handleCaptureHttpRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  stateRoot: string;
  runtimeFor: (accountId: string) => MemhubRuntime;
  queueDistillation: (args: {
    stateRoot: string;
    accountId: string;
    projectId: string | null;
    conversationId: string;
  }) => Promise<unknown | null>;
}): Promise<void> {
  const { request, response, stateRoot, runtimeFor, queueDistillation } = input;
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST" }).end();
    return;
  }
  const deviceToken = bearerToken(singleHeader(request.headers.authorization)) ??
    singleHeader(request.headers["x-memhub-device-token"]);
  if (!deviceToken) {
    json(response, 401, { error: "missing_device_token" });
    return;
  }
  const device = await authenticateDevice(stateRoot, deviceToken);
  if (!device) {
    json(response, 403, { error: "invalid_or_revoked_device" });
    return;
  }

  let incomingCapture;
  try {
    incomingCapture = normalizeCaptureEvent(await readJsonBody(request));
  } catch (error) {
    const bodyError = asHttpJsonBodyError(error);
    json(response, bodyError?.statusCode ?? 400, {
      error: bodyError?.code ?? "invalid_capture",
      message: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  const runtime = runtimeFor(device.account_id);
  if (incomingCapture.project_hint) {
    try {
      const projects = await runtime.router.listProjects(device.account_id);
      if (projects.length > 0 && !projects.includes(incomingCapture.project_hint)) {
        throw new Error(`unknown project for account: ${incomingCapture.project_hint}`);
      }
    } catch (error) {
      json(response, 422, {
        error: "invalid_project_hint",
        event_id: incomingCapture.event_id,
        message: error instanceof Error ? error.message : String(error)
      });
      return;
    }
  }

  let stored;
  try {
    stored = await storeCaptureEvent(stateRoot, device, incomingCapture);
  } catch (error) {
    json(response, 400, {
      error: "capture_conflict",
      event_id: incomingCapture.event_id,
      message: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  let projectId: string | null;
  try {
    projectId = await runtime.router.currentProject(device.account_id, stored.event.conversation_id);
    if (!stored.event.project_hint && projectId) {
      const tagged = await storeCaptureEvent(stateRoot, device, {
        ...stored.event,
        project_hint: projectId
      });
      stored = {
        created: stored.created,
        updated: stored.updated || tagged.updated,
        event: tagged.event
      };
    }
    if (stored.event.project_hint) {
      await runtime.router.bindProject(
        device.account_id,
        stored.event.conversation_id,
        stored.event.project_hint
      );
      projectId = stored.event.project_hint;
    }
  } catch (error) {
    json(response, 422, {
      error: "invalid_project_hint",
      event_id: stored.event.event_id,
      message: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  let ingestion:
    | Awaited<ReturnType<typeof ingestCaptureIntoMemory>>
    | { ingested: true; duplicate: true; project_id: string | null } = {
      ingested: true,
      duplicate: true,
      project_id: projectId
    };
  try {
    const attempt = await withCaptureIngestAttempt({
      stateRoot,
      accountId: device.account_id,
      eventId: stored.event.event_id,
      expectedEvent: stored.event,
      ingest: (event) => ingestCaptureIntoMemory({
        event,
        device,
        runtime,
        projectId
      })
    });
    ingestion = attempt.alreadyIngested
      ? { ingested: true, duplicate: true, project_id: projectId }
      : attempt.result!;
  } catch (error) {
    const upstreamConflict = error instanceof MemoryCoreHttpError && error.status === 409;
    const frozenConflict = /capture (changed before ingestion|ingest intent\/payload conflict)/.test(
      error instanceof Error ? error.message : String(error)
    );
    json(response, upstreamConflict || frozenConflict ? 409 : 503, {
      error: upstreamConflict || frozenConflict
        ? "capture_ingest_conflict"
        : "capture_ingest_failed",
      event_id: stored.event.event_id,
      message: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  let distillation_queue_error: string | undefined;
  if (ingestion.ingested && projectId) {
    try {
      const distillation = await queueDistillation({
        stateRoot,
        accountId: device.account_id,
        projectId,
        conversationId: stored.event.conversation_id
      });
      if (distillation) {
        ingestion = { ...ingestion, distillation } as typeof ingestion & {
          distillation: unknown;
        };
      }
    } catch (error) {
      distillation_queue_error = error instanceof Error ? error.message : String(error);
      console.error("[memhub] capture distillation queue:", distillation_queue_error);
    }
  }

  json(response, stored.created ? 201 : 200, {
    accepted: true,
    duplicate: !stored.created && !stored.updated,
    updated: stored.updated,
    event_id: stored.event.event_id,
    device_id: device.device_id,
    ingestion,
    ...(distillation_queue_error ? { distillation_queue_error } : {})
  });
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(value));
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || undefined;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
