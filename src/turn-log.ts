import { createHash } from "node:crypto";
import {
  isCaptureIngested,
  listCaptureEvents,
  markCaptureIngested,
  normalizeCaptureEvent,
  storeCaptureEvent,
  type MemhubCaptureEvent,
  type StoredCaptureEvent
} from "./capture.js";
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
  actorName: string;
  bindConversation?: boolean;
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
    event_id: input.turn.event_id ?? stableTurnEventId(
      input.runtime.accountId,
      input.turn.continuity_id ?? input.turn.conversation_id,
      input.turn.turn_id ?? input.turn.timestamp ?? new Date().toISOString()
    ),
    timestamp: input.turn.timestamp ?? new Date().toISOString()
  });

  const knownProjects = await input.runtime.router.listProjects(input.runtime.accountId);
  if (event.project_hint && knownProjects.length > 0 && !knownProjects.includes(event.project_hint)) {
    throw new Error(`unknown project for account: ${event.project_hint}`);
  }

  let stored = await storeCaptureEvent(input.stateRoot, {
    account_id: input.runtime.accountId,
    device_id: input.actorId
  }, event);

  const bindConversation = input.bindConversation !== false;
  let projectId = stored.event.project_hint ??
    (bindConversation
      ? await input.runtime.router.currentProject(input.runtime.accountId, stored.event.conversation_id)
      : null);
  if (bindConversation && !stored.event.project_hint && projectId) {
    const tagged = await storeCaptureEvent(input.stateRoot, {
      account_id: input.runtime.accountId,
      device_id: input.actorId
    }, {
      ...event,
      project_hint: projectId
    });
    stored = {
      created: stored.created,
      updated: stored.updated || tagged.updated,
      event: tagged.event
    };
  }
  if (bindConversation && stored.event.project_hint) {
    await input.runtime.router.bindProject(
      input.runtime.accountId,
      stored.event.conversation_id,
      stored.event.project_hint
    );
    projectId = stored.event.project_hint;
  }

  let ingestion: unknown;
  if (
    stored.event.capture_status === "complete" &&
    !(await isCaptureIngested(input.stateRoot, input.runtime.accountId, stored.event.event_id))
  ) {
    const result = await ingestCaptureIntoMemory({
      event: stored.event,
      device: {
        account_id: input.runtime.accountId,
        device_id: input.actorId,
        name: input.actorName
      },
      runtime: input.runtime,
      projectId
    });
    ingestion = result;
    if (result.ingested) {
      await markCaptureIngested(input.stateRoot, input.runtime.accountId, stored.event.event_id);
    }
  }

  return {
    turn: turnView(stored.event, Boolean(ingestion) || await isCaptureIngested(
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
}): Promise<L1TurnView[]> {
  const items = await listCaptureEvents(input.stateRoot, input.accountId, {
    ...(input.continuityId ? { continuityId: input.continuityId } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    limit: Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)))
  });
  return items.map((item) => turnView(item, item.ingested));
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
