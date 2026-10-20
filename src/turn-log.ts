import { createHash } from "node:crypto";
import {
  captureIsFullyExcludedFromMemory,
  captureProjectLookup,
  scheduleCaptureProjectBackfill,
  readCaptureProjectIndexPage,
  readIndexedCaptureEvent,
  isCaptureIngested,
  markCaptureIngested,
  normalizeCaptureEvent,
  storeCaptureEvent,
  withCaptureIngestAttempt,
  type MemhubCaptureEvent,
  type StoredCaptureEvent,
  TRUSTED_TURN_SOURCE_KINDS
} from "./capture.js";
import { resolveCaptureProject } from "./capture-project-resolution.js";
import { ingestCaptureIntoMemory } from "./capture-ingest.js";
import type { MemhubRuntime } from "./runtime.js";

export type L1TurnStatus = MemhubCaptureEvent["capture_status"];

export interface L1TurnInput {
  event_id?: string;
  host: string;
  host_version?: string;
  conversation_id: string;
  continuity_id?: string;
  turn_id?: string;
  previous_event_id?: string;
  timestamp?: string;
  workspace_id?: string;
  workspace_path?: string;
  project_hint?: string;
  user_text?: string;
  assistant_text?: string;
  reasoning_summary?: string;
  tool_summary?: string;
  capture_status?: L1TurnStatus;
  provenance?: Record<string, unknown>;
}

export interface L1TurnView {
  event_id: string;
  account_id: string;
  host: string;
  conversation_id: string;
  continuity_id: string;
  turn_id?: string;
  previous_event_id?: string;
  timestamp: string;
  project_hint?: string;
  resolved_project_id?: string | null;
  user_text?: string;
  assistant_text?: string;
  reasoning_summary?: string;
  tool_summary?: string;
  status: L1TurnStatus;
  ingested: boolean;
}

export async function upsertL1Turn(input: {
  stateRoot: string;
  runtime: MemhubRuntime;
  actorId: string;
  turn: L1TurnInput;
}): Promise<{
  turn: L1TurnView;
  created: boolean;
  updated: boolean;
  ingestion?: unknown;
  project_id: string | null;
}> {
  const event = normalizeCaptureEvent({
    ...input.turn,
    provenance: {
      ...(input.turn.provenance ?? {}),
      source_kinds: { ...TRUSTED_TURN_SOURCE_KINDS }
    },
    event_id: input.turn.event_id ?? stableTurnEventId(
      input.runtime.accountId,
      input.turn.continuity_id ?? input.turn.conversation_id,
      input.turn.turn_id ?? input.turn.timestamp ?? new Date().toISOString()
    ),
    timestamp: input.turn.timestamp ?? new Date().toISOString()
  });

  const stored = await storeCaptureEvent(input.stateRoot, {
    account_id: input.runtime.accountId,
    actor_id: input.actorId
  }, event);
  const projectId = (await resolveCaptureProject(stored.event,
    ref => input.runtime.projects.resolve(input.runtime.accountId, ref), input.stateRoot)).projectId;

  let ingestion: unknown;
  if (stored.event.capture_status === "complete" && captureIsFullyExcludedFromMemory(stored.event)) {
    await markCaptureIngested(input.stateRoot, input.runtime.accountId, stored.event.event_id);
    ingestion = { ingested: false, excluded: true, project_id: projectId };
  }
  if (
    ingestion === undefined &&
    stored.event.capture_status === "complete" &&
    !(await isCaptureIngested(input.stateRoot, input.runtime.accountId, stored.event.event_id))
  ) {
    const attempt = await withCaptureIngestAttempt({
      stateRoot: input.stateRoot,
      accountId: input.runtime.accountId,
      eventId: stored.event.event_id,
      expectedEvent: stored.event,
      ingest: (event) => ingestCaptureIntoMemory({
        event,
        actor: { account_id: input.runtime.accountId, actor_id: input.actorId },
        runtime: input.runtime,
        projectId
      })
    });
    ingestion = attempt.result;
  }

  return {
    turn: turnView(stored.event, await isCaptureIngested(
      input.stateRoot,
      input.runtime.accountId,
      stored.event.event_id
    )),
    created: stored.created,
    updated: stored.updated,
    ...(ingestion === undefined ? {} : { ingestion }),
    project_id: projectId
  };
}

export async function listL1Turns(input: {
  stateRoot: string;
  accountId: string;
  continuityId?: string;
  conversationId?: string;
  projectId?: string;
  limit?: number;
  offset?: number;
  resolveProject?: (ref: string) => Promise<string | null>;
}): Promise<L1TurnView[]> {
  const page = { projectIds: input.projectId ? [input.projectId] : [], continuityId: input.continuityId,
    conversationId: input.conversationId, includeAssignments: true,
    limit: Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100))), offset: input.offset };
  const registryLookup = input.resolveProject ?? captureProjectLookup(input.stateRoot, input.accountId);
  const lookups = new Map<string, Promise<string | null>>();
  const lookup = (ref: string) => {
    if (!lookups.has(ref)) lookups.set(ref, registryLookup(ref));
    return lookups.get(ref)!;
  };
  // Resolve a bounded pending probe before SQL pagination; cached nonmatches never consume its window.
  const pendingIds: string[] = [];
  if (input.projectId) {
    const pending = await readCaptureProjectIndexPage(input.stateRoot, input.accountId,
      { ...page, resolution: "pending", offset: 0, limit: 500 });
    for (const entry of pending) {
      const result = await resolveCaptureProject(entry, lookup, undefined, undefined, entry.assignment_snapshot);
      if (result.projectId === input.projectId) pendingIds.push(entry.event_id);
    }
  }
  const entries = await readCaptureProjectIndexPage(input.stateRoot, input.accountId,
    { ...page, resolution: "cached", resolvedPendingIds: pendingIds });
  const views: L1TurnView[] = [];
  for (const entry of entries) {
    const item = await readIndexedCaptureEvent(input.stateRoot, entry);
    const resolution = await resolveCaptureProject(item, lookup, undefined, undefined, entry.assignment_snapshot);
    views.push({ ...turnView(item, entry.ingested), resolved_project_id: resolution.projectId });
  }
  scheduleCaptureProjectBackfill(input.stateRoot, input.accountId);
  return views;
}

export async function recentL1Continuity(input: {
  stateRoot: string;
  accountId: string;
  continuityId: string;
  limit?: number;
}): Promise<L1TurnView[]> {
  const turns = await listL1Turns({
    stateRoot: input.stateRoot,
    accountId: input.accountId,
    continuityId: input.continuityId,
    limit: input.limit ?? 12
  });
  return turns.reverse();
}

function stableTurnEventId(accountId: string, continuityId: string, turnId: string): string {
  return `l1_${createHash("sha256")
    .update([accountId, continuityId, turnId].join("\0"), "utf8")
    .digest("hex")
    .slice(0, 40)}`;
}

function turnView(event: StoredCaptureEvent, ingested: boolean): L1TurnView {
  return {
    event_id: event.event_id,
    account_id: event.account_id,
    host: event.host,
    conversation_id: event.conversation_id,
    continuity_id: event.continuity_id,
    ...(event.turn_id ? { turn_id: event.turn_id } : {}),
    ...(event.previous_event_id ? { previous_event_id: event.previous_event_id } : {}),
    timestamp: event.timestamp,
    ...(event.project_hint ? { project_hint: event.project_hint } : {}),
    ...(event.user_text ? { user_text: event.user_text } : {}),
    ...(event.assistant_text ? { assistant_text: event.assistant_text } : {}),
    ...(event.reasoning_summary ? { reasoning_summary: event.reasoning_summary } : {}),
    ...(event.tool_summary ? { tool_summary: event.tool_summary } : {}),
    status: event.capture_status,
    ingested
  };
}
