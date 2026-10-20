import type Database from "better-sqlite3";
import {
  captureIsFullyExcludedFromMemory, listCaptureEvents, normalizeCaptureEvent,
  readCaptureProjectIndexPage, scheduleCaptureProjectBackfill,
  withCaptureIndexDb, withCaptureIndexMutation, withReadonlyCaptureIndex, type StoredCaptureEvent
} from "./capture.js";
import { canonicalWorkspaceProjectCandidate, resolveCaptureProjectSnapshot } from "./capture-project-resolution.js";
import type { JsonProjectRegistry } from "./project-registry.js";
import { utf8Prefix } from "./context-capsule.js";

interface Assignment {
  id: number;
  event_id: string;
  project_id: string | null;
  scope: "event" | "continuity";
  anchor_timestamp: string;
}

export interface CaptureAssignmentSnapshot {
  assignment: Assignment;
  hints: string[];
}

export function captureAssignmentSnapshot(db: Database.Database | null, event: Pick<StoredCaptureEvent,
  "account_id" | "event_id" | "continuity_id" | "timestamp">): CaptureAssignmentSnapshot | undefined {
  if (!db?.prepare("SELECT 1 FROM sqlite_master WHERE name='capture_project_assignments'").get()) return undefined;
  const direct = db.prepare(`SELECT * FROM capture_project_assignments
    WHERE account_id=? AND event_id=? AND scope='event' ORDER BY id DESC LIMIT 1`)
    .get(event.account_id, event.event_id) as Assignment | undefined;
  if (direct) return { assignment: direct, hints: [] };
  if (!event.continuity_id) return undefined;
  const binding = db.prepare(`SELECT * FROM capture_project_assignments
    WHERE account_id=? AND continuity_id=? AND scope='continuity' AND anchor_timestamp<=?
    ORDER BY id DESC LIMIT 1`).get(event.account_id, event.continuity_id, event.timestamp) as Assignment | undefined;
  if (!binding) return undefined;
  const hints = db.prepare(`SELECT DISTINCT project_hint FROM capture_index
    WHERE account_id=? AND continuity_id=? AND timestamp>=? AND timestamp<=?
    AND event_id<>? AND project_hint IS NOT NULL`).all(
    event.account_id, event.continuity_id, binding.anchor_timestamp, event.timestamp, binding.event_id
  ) as Array<{ project_hint: string }>;
  return { assignment: binding, hints: hints.map(row => row.project_hint) };
}

/** Append routing decisions only; frozen capture bytes and existing Core copies are never retagged. */
export async function assignCaptureProjects(input: {
  stateRoot: string; accountId: string; projects: JsonProjectRegistry; assignedBy: "host" | "admin";
  project?: unknown; keepGlobal?: unknown; continuityId?: unknown; eventIds?: unknown;
}): Promise<{ assigned: number; unchanged: number; continuity_bound: boolean }> {
  const account = input.accountId.trim();
  if (!account) throw new TypeError("account is required");
  if (input.keepGlobal !== undefined && typeof input.keepGlobal !== "boolean") throw new TypeError("keep_global must be boolean");
  const keepGlobal = input.keepGlobal === true;
  const project = typeof input.project === "string" ? input.project.trim() : "";
  if (keepGlobal === Boolean(project)) throw new TypeError("provide project or keep_global=true");
  const projectId = keepGlobal ? null : await input.projects.resolve(account, project);
  if (!keepGlobal && !projectId) throw new TypeError("unknown project for account");
  if (input.continuityId !== undefined && (typeof input.continuityId !== "string" || !input.continuityId.trim() || input.continuityId.length > 500)) {
    throw new TypeError("invalid continuity_id");
  }
  const continuity = typeof input.continuityId === "string" ? input.continuityId.trim() : undefined;
  if (input.eventIds !== undefined && (!Array.isArray(input.eventIds) || !input.eventIds.length || input.eventIds.length > 200 ||
      input.eventIds.some(id => typeof id !== "string" || !id.trim() || id.length > 200))) throw new TypeError("event_ids requires 1-200 ids");
  const ids = [...new Set((input.eventIds as string[] | undefined)?.map(id => id.trim()) ?? [])];
  if (!continuity && !ids.length) throw new TypeError("continuity_id or event_ids required");
  return withCaptureIndexMutation(input.stateRoot, async () => {
    const events = ids.length
      ? (await Promise.all(ids.map(eventId => listCaptureEvents(input.stateRoot, account, { eventId, limit: 1 })))).flat()
      : await listCaptureEvents(input.stateRoot, account, { continuityId: continuity, limit: 201 });
    if (!events.length || (ids.length && events.length !== ids.length) || events.some(event => event.account_id !== account || (continuity && event.continuity_id !== continuity))) {
      throw new TypeError("capture not found for account/continuity");
    }
    if (events.length > 200) throw new TypeError("continuity exceeds 200 captures; assign event_ids in batches");
    const affected = continuity
      ? await readCaptureProjectIndexPage(input.stateRoot, account, { continuityId: continuity, limit: 201 }) : events;
    if (affected.length > 200) throw new TypeError("continuity exceeds 200 captures; assign event_ids without continuity_id in batches");
    const anchor = [...affected].sort((a,b) => a.timestamp.localeCompare(b.timestamp) || a.event_id.localeCompare(b.event_id))[0]!;
    // Snapshot registry inputs before opening the synchronous SQLite transaction.
    const refs = await withCaptureIndexDb(input.stateRoot, db => affected.flatMap(event => {
      const snapshot = captureAssignmentSnapshot(db, event);
      return [event.project_hint?.trim(), canonicalWorkspaceProjectCandidate(event.workspace_path),
        snapshot?.assignment.project_id, ...(snapshot?.hints ?? [])];
    }));
    const resolved = new Map<string, string | null>();
    for (const ref of new Set(refs)) if (ref) resolved.set(ref, await input.projects.resolve(account, ref));
    if (projectId) resolved.set(projectId, projectId);
    return withCaptureIndexDb(input.stateRoot, db => {
      const now = new Date().toISOString();
      let assigned = 0;
      let unchanged = 0;
      const latest = db.prepare(`SELECT * FROM capture_project_assignments WHERE account_id=? AND
        ((scope='event' AND event_id=?) OR (scope='continuity' AND continuity_id=?)) AND scope=? ORDER BY id DESC LIMIT 1`);
      const insert = db.prepare(`INSERT INTO capture_project_assignments
        (account_id,event_id,continuity_id,project_id,assigned_by,assigned_at,supersedes,scope,anchor_timestamp)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      const append = (event: Pick<StoredCaptureEvent, "event_id" | "timestamp">, scope: "event" | "continuity") => {
        const prior = latest.get(account, event.event_id, continuity ?? null, scope) as Assignment | undefined;
        if (prior && prior.project_id === projectId && (scope === "event" || prior.anchor_timestamp === event.timestamp)) return false;
        insert.run(account, event.event_id, continuity ?? null, projectId, input.assignedBy, now, prior?.id ?? null, scope, event.timestamp);
        return true;
      };
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const event of events) {
          if (append(event, "event")) assigned++; else unchanged++;
        }
        if (continuity) append(anchor, "continuity");
        // Publish the binding and every affected derived row atomically.
        for (const event of affected) {
          const result = resolveCaptureProjectSnapshot(event, ref => resolved.get(ref) ?? null, captureAssignmentSnapshot(db, event));
          db.prepare("UPDATE capture_index SET resolved_project_id=?,keep_global=?,mtime_ms=MAX(mtime_ms,?) WHERE account_id=? AND event_id=?")
            .run(result.projectId ?? "", result.source === "keep_global" ? 1 : 0, Date.now(), account, event.event_id);
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return { assigned, unchanged, continuity_bound: Boolean(continuity) };
    });
  });
}

export function isSubstantiveProjectQuery(text: string): boolean {
  return text.trim().length >= 40 || /```|(?:^|\s)(?:[A-Za-z]:[\\/]|\.{0,2}\/)[^\s]+|[\w.-]+[\\/][\w.-]+/u.test(text);
}

export async function projectClarification(input: {
  stateRoot: string; accountId: string; projects: JsonProjectRegistry;
  text: string; candidate?: string | null; continuityId?: string; rateLimit?: boolean; now?: number;
}) {
  if (!input.text.trim()) return undefined;
  const safe = normalizeCaptureEvent({ event_id: "clarification", host: "host", conversation_id: "clarification",
    timestamp: new Date().toISOString(), user_text: input.text, capture_status: "open" });
  if (captureIsFullyExcludedFromMemory(safe) || !isSubstantiveProjectQuery(safe.user_text ?? "")) return undefined;
  const candidates = (await input.projects.suggest(input.accountId, safe.user_text!, 3)).map(p => ({
    project: p.projectId, name: p.name, similarity: Number(p.similarity.toFixed(2))
  }));
  const result = {
    status: "unresolved",
    ...(input.candidate ? { candidate: utf8Prefix(input.candidate, 80) } : {}),
    candidates,
    ask: candidates.length
      ? { zh: "属于哪个项目，还是保持全局？", en: "Which project, or keep global?" }
      : { zh: "保持全局？新建项目需用户批准 memmy_project_manage。", en: "Keep global? Create via memmy_project_manage with user approval." },
    how_to_answer: `memmy_turn action=assign project=<slug> continuity_id=${input.continuityId ?? "<id>"} (or keep_global=true)`
  };
  const bytes = () => Buffer.byteLength(JSON.stringify(result, null, 2).replace(/\n/g, "\n  "), "utf8");
  while (bytes() > 600 && candidates.length) candidates.pop();
  if (bytes() > 600) {
    result.how_to_answer = "memmy_turn action=assign project=<slug> continuity_id=<id> (or keep_global=true)";
  }
  if (input.rateLimit && input.continuityId) {
    const asked = await withCaptureIndexMutation(input.stateRoot, () => withCaptureIndexDb(input.stateRoot, db => {
      const now = input.now ?? Date.now();
      const prior = db.prepare("SELECT asked_at FROM capture_project_questions WHERE account_id=? AND continuity_id=?")
        .get(input.accountId, input.continuityId!) as { asked_at: number } | undefined;
      if (prior && now - prior.asked_at < 30 * 60_000) return false;
      db.prepare("INSERT OR REPLACE INTO capture_project_questions VALUES (?,?,?)").run(input.accountId, input.continuityId!, now);
      return true;
    }));
    if (!asked) return undefined;
  }
  return result;
}

const unassignedWhere = `account_id=? AND capture_status='complete' AND privacy_excluded=0 AND keep_global=0
  AND (resolved_project_id IS NULL OR resolved_project_id='')
  AND NOT EXISTS (SELECT 1 FROM capture_project_assignments a WHERE a.account_id=capture_index.account_id
    AND a.event_id=capture_index.event_id AND a.scope='event')`;
const unassignedGroupKey = "COALESCE('continuity:' || continuity_id, 'event:' || event_id)";

function unassignedSchemaReady(db: Database.Database): boolean {
  const columns = new Set((db.pragma("table_info(capture_index)") as Array<{ name: string }>).map(column => column.name));
  return ["resolved_project_id", "privacy_excluded", "keep_global", "user_preview"].every(column => columns.has(column));
}

export async function countUnassignedCaptures(stateRoot: string, accountId: string): Promise<number> {
  const count = await withReadonlyCaptureIndex(stateRoot, accountId, db => {
    if (!db || !unassignedSchemaReady(db)) return 0;
    return (db.prepare(`SELECT COUNT(*) AS count FROM capture_index WHERE ${unassignedWhere}`).get(accountId) as { count: number }).count;
  });
  scheduleCaptureProjectBackfill(stateRoot, accountId);
  return count;
}

export async function listUnassignedCaptures(input: {
  stateRoot: string; accountId: string; projects: JsonProjectRegistry; offset?: number; limit?: number;
}) {
  const offset = Number.isFinite(input.offset) ? Math.max(0, Math.trunc(input.offset!)) : 0;
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(50, Math.trunc(input.limit!))) : 20;
  const page = await withReadonlyCaptureIndex(input.stateRoot, input.accountId, db => {
    if (!db || !unassignedSchemaReady(db)) return { items: [], total: 0, unresolved_count: 0 };
    const stats = db.prepare(`SELECT COUNT(*) AS unresolved_count,COUNT(DISTINCT ${unassignedGroupKey}) AS total
      FROM capture_index WHERE ${unassignedWhere}`).get(input.accountId) as { unresolved_count: number; total: number };
    const groups = db.prepare(`SELECT ${unassignedGroupKey} AS group_key,continuity_id,MAX(timestamp) AS timestamp,COUNT(*) AS count
      FROM capture_index WHERE ${unassignedWhere} GROUP BY ${unassignedGroupKey} ORDER BY timestamp DESC,group_key
      LIMIT ? OFFSET ?`).all(input.accountId, limit, offset) as Array<{ group_key: string; continuity_id: string | null; timestamp: string; count: number }>;
    const events = db.prepare(`SELECT event_id,timestamp,user_preview AS first_user_line,project_hint AS candidate
      FROM capture_index WHERE ${unassignedWhere} AND ${unassignedGroupKey}=? ORDER BY timestamp DESC,event_id DESC LIMIT 200`);
    return { ...stats, items: groups.map(group => {
      const turns = events.all(input.accountId, group.group_key) as Array<{ event_id: string; timestamp: string; first_user_line: string; candidate: string | null }>;
      return { ...group, events: turns, first_user_line: turns[0]?.first_user_line ?? "", candidate: turns[0]?.candidate ?? null };
    }) };
  });
  scheduleCaptureProjectBackfill(input.stateRoot, input.accountId);
  const items = await Promise.all(page.items.map(async group => ({ ...group,
    candidates: (await input.projects.suggest(input.accountId, group.first_user_line || group.group_key, 3))
      .map(p => ({ project: p.projectId, name: p.name, similarity: p.similarity }))
  })));
  return { ...page, items, offset, limit, has_more: offset + limit < page.total };
}
