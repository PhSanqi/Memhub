import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { captureAssignmentSnapshot, type CaptureAssignmentSnapshot } from "./capture-project-assignments.js";
import { withFileMutationLock } from "./file-mutation-lock.js";
import { redactSecrets } from "./secret-redaction.js";
import { JsonProjectRegistry, normalizeProjectKey } from "./project-registry.js";
import { canonicalWorkspaceProjectCandidate, resolveCaptureProject } from "./capture-project-resolution.js";

export type CaptureSourceKind = "user_said" | "agent_inferred" | "tool_output" | "imported";

export interface CaptureSectionSourceKinds {
  user_text?: CaptureSourceKind;
  assistant_text?: CaptureSourceKind;
  reasoning_summary?: CaptureSourceKind;
  tool_summary?: CaptureSourceKind;
  content?: CaptureSourceKind;
}

export const TRUSTED_TURN_SOURCE_KINDS: Readonly<CaptureSectionSourceKinds> = Object.freeze({
  user_text: "user_said",
  assistant_text: "agent_inferred",
  reasoning_summary: "agent_inferred",
  tool_summary: "tool_output"
});

export interface MemhubCaptureEvent {
  event_id: string;
  host: string;
  host_version?: string;
  conversation_id: string;
  continuity_id: string;
  turn_id?: string;
  previous_event_id?: string;
  timestamp: string;
  workspace_id?: string;
  workspace_path?: string;
  project_hint?: string;
  user_text?: string;
  assistant_text?: string;
  reasoning_summary?: string;
  tool_summary?: string;
  capture_status: "open" | "partial" | "complete" | "truncated" | "failed";
  provenance?: Record<string, unknown>;
}

export interface CaptureRedactionSummary {
  count: number;
  kinds: string[];
}

export interface CapturePrivacySummary {
  excluded_sections: number;
  fully_excluded: boolean;
  markers: string[];
  redactions?: CaptureRedactionSummary;
}

export interface StoredCaptureEvent extends MemhubCaptureEvent {
  account_id: string;
  actor_id: string;
  received_at: string;
}

export interface CaptureActor {
  actor_id: string;
  account_id: string;
}

export interface CaptureIndexEntry {
  account_id: string;
  event_id: string;
  conversation_id: string;
  continuity_id: string;
  timestamp: string;
  project_hint?: string;
  capture_status: MemhubCaptureEvent["capture_status"];
  ingested: boolean;
}

export interface CaptureIndexStats {
  total: number;
  complete: number;
  incomplete: number;
  ingested: number;
  not_ingested: number;
}

export interface IdleCaptureGroup {
  account_id: string;
  conversation_id: string;
  project_id: string;
  latest_timestamp: string;
  complete_count: number;
}

export interface NormalizeCaptureOptions {
  /**
   * Redact inline secrets before the payload is persisted and hashed. Stored
   * captures are normalized with redaction disabled: legacy raw events must
   * keep the exact bytes their frozen ingest intent was computed from.
   */
  redact?: boolean;
}

export function normalizeCaptureEvent(
  value: unknown,
  options: NormalizeCaptureOptions = {}
): MemhubCaptureEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("capture event must be an object");
  const input = value as Record<string, unknown>;
  const redactSection = (text: string | undefined) =>
    options.redact === false || !text
      ? { text, count: 0, kinds: [] as string[] }
      : redactSecrets(text);
  const privateUser = stripNoMemorySections(optionalText(input.user_text, 300_000));
  const privateAssistant = stripNoMemorySections(optionalText(input.assistant_text, 300_000));
  const privateReasoning = stripNoMemorySections(optionalText(input.reasoning_summary, 100_000));
  const privateTool = stripNoMemorySections(optionalText(input.tool_summary, 100_000));
  const excludedSections = privateUser.excludedSections + privateAssistant.excludedSections +
    privateReasoning.excludedSections + privateTool.excludedSections;
  const normalizedProvenance = normalizeProvenance(input.provenance);
  const existingPrivacy = normalizedCapturePrivacy(normalizedProvenance?.memhub_privacy);
  const userRedaction = redactSection(privateUser.text);
  const assistantRedaction = redactSection(privateAssistant.text);
  const reasoningRedaction = redactSection(privateReasoning.text);
  const toolRedaction = redactSection(privateTool.text);
  const userText = userRedaction.text;
  const assistantText = assistantRedaction.text;
  const reasoningSummary = reasoningRedaction.text;
  const toolSummary = toolRedaction.text;
  const redactions = mergeRedactionCounts(
    existingPrivacy?.redactions,
    redactionSummary([userRedaction, assistantRedaction, reasoningRedaction, toolRedaction])
  );
  const remainingText = [userText, assistantText, reasoningSummary, toolSummary]
    .filter((item): item is string => Boolean(item?.trim()));
  const privacy: CapturePrivacySummary | undefined = excludedSections > 0
    ? {
        excluded_sections: Math.max(excludedSections, existingPrivacy?.excluded_sections ?? 0),
        fully_excluded: remainingText.length === 0,
        markers: ["private", "no-memory"],
        ...(redactions ? { redactions } : {})
      }
    : existingPrivacy
      ? {
          ...existingPrivacy,
          fully_excluded: existingPrivacy.fully_excluded && remainingText.length === 0,
          ...(redactions ? { redactions } : {})
        }
      : redactions
        ? { excluded_sections: 0, fully_excluded: false, markers: [], redactions }
        : undefined;
  const event: MemhubCaptureEvent = {
    event_id: requiredId(input.event_id, "event_id", 200),
    host: requiredId(input.host, "host", 100),
    conversation_id: requiredId(input.conversation_id, "conversation_id", 500),
    continuity_id: optionalText(input.continuity_id, 500) ?? requiredId(input.conversation_id, "conversation_id", 500),
    timestamp: normalizeTimestamp(input.timestamp),
    ...(optionalText(input.host_version, 200) ? { host_version: optionalText(input.host_version, 200) } : {}),
    ...(optionalText(input.turn_id, 500) ? { turn_id: optionalText(input.turn_id, 500) } : {}),
    ...(optionalText(input.previous_event_id, 500) ? { previous_event_id: optionalText(input.previous_event_id, 500) } : {}),
    ...(optionalText(input.workspace_id, 500) ? { workspace_id: optionalText(input.workspace_id, 500) } : {}),
    ...(optionalText(input.workspace_path, 4000) ? { workspace_path: optionalText(input.workspace_path, 4000) } : {}),
    ...(optionalText(input.project_hint, 500) ? { project_hint: optionalText(input.project_hint, 500) } : {}),
    ...(userText ? { user_text: userText } : {}),
    ...(assistantText ? { assistant_text: assistantText } : {}),
    ...(reasoningSummary ? { reasoning_summary: reasoningSummary } : {}),
    ...(toolSummary ? { tool_summary: toolSummary } : {}),
    capture_status: normalizeCaptureStatus(input.capture_status, userText, assistantText),
    ...(normalizedProvenance || privacy
      ? { provenance: { ...(normalizedProvenance ?? {}), ...(privacy ? { memhub_privacy: privacy } : {}) } }
      : {})
  };
  if (!event.user_text && !event.assistant_text && !event.reasoning_summary && !event.tool_summary && !privacy?.fully_excluded) {
    throw new TypeError("capture event requires user_text, assistant_text, reasoning_summary, or tool_summary");
  }
  return event;
}

/**
 * Counts the replacements performed on the four capture text fields. A
 * `redact: false` pass reports nothing because its text was left untouched.
 */
function redactionSummary(
  sections: Array<{ count: number; kinds: string[] }>
): CaptureRedactionSummary | undefined {
  let count = 0;
  const kinds = new Set<string>();
  for (const section of sections) {
    count += section.count;
    for (const kind of section.kinds) kinds.add(kind);
  }
  if (count === 0 || kinds.size === 0) return undefined;
  return { count, kinds: [...kinds] };
}

function mergeRedactionCounts(
  previous: CaptureRedactionSummary | undefined,
  next: CaptureRedactionSummary | undefined
): CaptureRedactionSummary | undefined {
  if (!previous) return next;
  if (!next) return previous;
  // A commit may resend text an earlier open already redacted; never inflate.
  return {
    count: Math.max(previous.count, next.count),
    kinds: [...new Set([...previous.kinds, ...next.kinds])]
  };
}

/**
 * Removes explicit user-authored no-memory spans before any capture payload is
 * written to disk or sent to Memory Core. An opening marker without a closing
 * marker is treated as private through end-of-field (fail closed).
 */
export function stripNoMemorySections(value: string | undefined): {
  text?: string;
  excludedSections: number;
} {
  if (!value) return { excludedSections: 0 };
  let text = value;
  let excludedSections = 0;
  for (const marker of ["private", "no-memory"]) {
    const closed = new RegExp(`<${marker}\\b[^>]*>[\\s\\S]*?<\\/${marker}\\s*>`, "gi");
    text = text.replace(closed, () => {
      excludedSections += 1;
      return "";
    });
    const open = new RegExp(`<${marker}\\b[^>]*>[\\s\\S]*$`, "gi");
    text = text.replace(open, () => {
      excludedSections += 1;
      return "";
    });
  }
  const normalized = text.replace(/\n{3,}/g, "\n\n").trim();
  return { ...(normalized ? { text: normalized } : {}), excludedSections };
}

export function captureIsFullyExcludedFromMemory(event: Pick<MemhubCaptureEvent, "provenance">): boolean {
  const privacy = event.provenance?.memhub_privacy;
  return Boolean(privacy && typeof privacy === "object" && !Array.isArray(privacy) &&
    (privacy as Record<string, unknown>).fully_excluded === true);
}

export async function storeCaptureEvent(
  stateRoot: string,
  actor: Pick<CaptureActor, "actor_id" | "account_id">,
  rawEvent: unknown
): Promise<{ created: boolean; updated: boolean; event: StoredCaptureEvent }> {
  return withCaptureIndexMutation(stateRoot, async () => {
    const event = normalizeCaptureEvent(rawEvent);
    const stored: StoredCaptureEvent = {
      ...event,
      account_id: actor.account_id,
      actor_id: actor.actor_id,
      received_at: new Date().toISOString()
    };
    const path = captureEventPath(stateRoot, actor.account_id, event.event_id);
    await ensureCaptureIndexUnlocked(stateRoot, actor.account_id);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const storedRecord = JSON.parse(await readFile(path, "utf8")) as unknown;
      const existing = normalizeStoredCapture(storedRecord);
      // Merge on the redacted view so a legacy raw event and a retried raw
      // commit compare equal. The raw record itself is still used for hashing.
      const existingRedacted = normalizeStoredCapture(storedRecord, { redact: true });
      if (existing.event_id !== event.event_id) throw new Error("capture event hash collision");
      if (existing.account_id !== actor.account_id) throw new Error("capture event account mismatch");
      if (existing.actor_id !== actor.actor_id) throw new Error("capture event actor mismatch");
      const merged = mergeCaptureEvent(existingRedacted, event);
      const alreadyIngested = await isCaptureIngested(stateRoot, actor.account_id, existing.event_id);
      if (!merged.updated) {
        await assertCaptureIngestIntent(path, existing);
        await upsertCaptureIndexUnlocked(stateRoot, existing, alreadyIngested);
        return { created: false, updated: false, event: existing };
      }
      // The Core request ID is tied to this event, so a changed payload after
      // ingestion cannot be replayed safely. Reject late enrichment instead of
      // letting the local capture diverge from durable Core evidence.
      if (alreadyIngested) {
        throw new Error("capture event already ingested; immutable event metadata cannot be changed");
      }
      const updated: StoredCaptureEvent = { ...existingRedacted, ...merged.event };
      assertCaptureCompleteness(updated);
      await assertCaptureIngestIntent(path, updated);
      await markCaptureIndexDirty(stateRoot, actor.account_id, event.event_id);
      await writeStoredCapture(path, updated);
      await upsertCaptureIndexUnlocked(stateRoot, updated);
      await clearCaptureIndexDirty(stateRoot, actor.account_id, event.event_id);
      return { created: false, updated: true, event: updated };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    assertCaptureCompleteness(stored);
    await markCaptureIndexDirty(stateRoot, actor.account_id, event.event_id);
    await writeStoredCapture(path, stored, true);
    await upsertCaptureIndexUnlocked(stateRoot, stored, false);
    await clearCaptureIndexDirty(stateRoot, actor.account_id, event.event_id);
    return { created: true, updated: false, event: stored };
  });
}

/**
 * Serialize same-event Core attempts and freeze the complete payload before
 * the first upstream write. Both the normal L1 turn path and explicit recovery
 * must use this entry point; a crash leaves a durable intent to fence
 * later enrichment against the original deterministic Core request ID.
 */
export async function withCaptureIngestAttempt<T extends { ingested: boolean }>(input: {
  stateRoot: string;
  accountId: string;
  eventId: string;
  expectedEvent: StoredCaptureEvent;
  ingest: (event: StoredCaptureEvent) => Promise<T>;
}): Promise<{ alreadyIngested: boolean; event: StoredCaptureEvent; result?: T }> {
  const { stateRoot, accountId, eventId } = input;
  const path = captureEventPath(stateRoot, accountId, eventId);
  return withFileMutationLock(`${path}.ingest-attempt`, async () => {
    const snapshot = await withCaptureIndexMutation(stateRoot, async () => {
      await ensureCaptureIndexUnlocked(stateRoot, accountId);
      const event = normalizeStoredCapture(JSON.parse(await readFile(path, "utf8")) as unknown);
      if (event.account_id !== accountId || event.event_id !== eventId ||
          capturePayloadHash(event) !== capturePayloadHash(input.expectedEvent)) {
        throw new Error("capture changed before ingestion; retry with current durable event");
      }
      const alreadyIngested = await isCaptureIngested(stateRoot, accountId, eventId);
      if (!alreadyIngested && event.capture_status === "complete") {
        assertCaptureCompleteness(event);
        const intent = `${path}.ingest-intent`;
        const hash = capturePayloadHash(event);
        try {
          const existing = (await readFile(intent, "utf8")).trim();
          if (existing !== hash) throw new Error("capture ingest intent/payload conflict; manual review required");
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
          // Exclusive create, with the index mutation lock held. If a crash
          // leaves a partial intent, later attempts fail closed.
          await writeFile(intent, hash + "\n", { flag: "wx", mode: 0o600 });
        }
      }
      return { event, alreadyIngested };
    });
    if (snapshot.alreadyIngested) return snapshot;
    const result = await input.ingest(snapshot.event);
    if (result.ingested) await markCaptureIngested(stateRoot, accountId, eventId);
    return { ...snapshot, result };
  });
}

async function assertCaptureIngestIntent(path: string, event: StoredCaptureEvent): Promise<void> {
  try {
    if ((await readFile(`${path}.ingest-intent`, "utf8")).trim() !== capturePayloadHash(event)) {
      throw new Error("capture ingestion already attempted; immutable event metadata cannot be changed");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}

/** Read-only classification of a pre-marker Core attempt; never creates or repairs an intent. */
export async function readCaptureIngestIntentStatus(
  stateRoot: string, accountId: string, eventId: string
): Promise<"absent" | "matching" | "conflict"> {
  const path = captureEventPath(stateRoot, accountId, eventId);
  const event = normalizeStoredCapture(JSON.parse(await readFile(path, "utf8")) as unknown);
  if (event.account_id !== accountId || event.event_id !== eventId || event.capture_status !== "complete") {
    throw new Error("capture audit index/event mismatch; repair separately");
  }
  let intent: string;
  try {
    intent = (await readFile(`${path}.ingest-intent`, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "absent";
    throw error;
  }
  if (!/^[0-9a-f]{64}$/.test(intent) || intent !== capturePayloadHash(event)) {
    return "conflict";
  }
  return "matching";
}

function capturePayloadHash(event: StoredCaptureEvent): string {
  // Deterministic across JSON key ordering and nested provenance objects.
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]));
    }
    return value;
  };
  const { ingested: _ingested, ...persistent } = event as StoredCaptureEvent & { ingested?: boolean };
  return createHash("sha256").update(JSON.stringify(canonical(persistent)), "utf8").digest("hex");
}

function assertCaptureCompleteness(event: MemhubCaptureEvent): void {
  if (event.capture_status === "complete" && (!event.user_text || !event.assistant_text) &&
      !captureIsFullyExcludedFromMemory(event)) {
    throw new TypeError("complete capture requires both user_text and assistant_text");
  }
}

export async function isCaptureIngested(stateRoot: string, accountId: string, eventId: string): Promise<boolean> {
  try {
    await readFile(`${captureEventPath(stateRoot, accountId, eventId)}.ingested`, "utf8");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

export async function captureIngestedAt(stateRoot: string, accountId: string, eventId: string): Promise<string | null> {
  try {
    const timestamp = (await readFile(`${captureEventPath(stateRoot, accountId, eventId)}.ingested`, "utf8")).trim();
    return Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

export async function markCaptureIngested(stateRoot: string, accountId: string, eventId: string): Promise<void> {
  await withCaptureIndexMutation(stateRoot, async () => {
    await ensureCaptureIndexUnlocked(stateRoot, accountId);
    await markCaptureIndexDirty(stateRoot, accountId, eventId);
    const path = `${captureEventPath(stateRoot, accountId, eventId)}.ingested`;
    // The marker is the durable ingestion cutover. Replays must not advance
    // its timestamp and incorrectly turn pre-cutover evidence into new work.
    try {
      await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
      try {
        await writeFile(temporary, new Date().toISOString() + "\n", { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    }
    await markCaptureIndexIngestedUnlocked(stateRoot, accountId, eventId);
    await clearCaptureIndexDirty(stateRoot, accountId, eventId);
  });
}

export async function countCaptureEvents(stateRoot: string): Promise<number> {
  return (await captureIndexStats(stateRoot)).total;
}

export async function captureIndexStats(
  stateRoot: string,
  accountIdRaw?: string,
  projectId?: string
): Promise<CaptureIndexStats> {
  return withReadonlyCaptureIndex(stateRoot, accountIdRaw?.trim(), (db) => {
    if (!db) return { total: 0, complete: 0, incomplete: 0, ingested: 0, not_ingested: 0 };
    const where: string[] = [];
    const params: string[] = [];
    if (accountIdRaw?.trim()) { where.push("account_id=?"); params.push(accountIdRaw.trim()); }
    if (projectId) { where.push("project_hint=?"); params.push(projectId); }
    const row = db.prepare(`SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN capture_status='complete' THEN 1 ELSE 0 END) AS complete,
        SUM(CASE WHEN capture_status<>'complete' THEN 1 ELSE 0 END) AS incomplete,
        SUM(CASE WHEN ingested=1 THEN 1 ELSE 0 END) AS ingested,
        SUM(CASE WHEN ingested=0 THEN 1 ELSE 0 END) AS not_ingested
      FROM capture_index${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`)
      .get(...params) as {
        total?: number;
        complete?: number | null;
        incomplete?: number | null;
        ingested?: number | null;
        not_ingested?: number | null;
      } | undefined;
    return {
      total: Number(row?.total ?? 0),
      complete: Number(row?.complete ?? 0),
      incomplete: Number(row?.incomplete ?? 0),
      ingested: Number(row?.ingested ?? 0),
      not_ingested: Number(row?.not_ingested ?? 0)
    };
  });
}

export async function listIdleCaptureGroups(stateRoot: string, cutoffIso: string): Promise<IdleCaptureGroup[]> {
  return withReadonlyCaptureIndex(stateRoot, undefined, (db) => {
    if (!db) return [];
    const rows = db.prepare(`SELECT
        account_id,
        conversation_id,
        project_hint AS project_id,
        MAX(timestamp) AS latest_timestamp,
        COUNT(*) AS complete_count
      FROM capture_index
      WHERE ingested=1 AND capture_status='complete' AND project_hint IS NOT NULL
      GROUP BY account_id, conversation_id, project_hint
      HAVING COUNT(*) >= 2 AND MAX(timestamp) <= ?
      ORDER BY latest_timestamp ASC`).all(cutoffIso) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      account_id: requiredId(row.account_id, "account_id", 500),
      conversation_id: requiredId(row.conversation_id, "conversation_id", 500),
      project_id: requiredId(row.project_id, "project_id", 500),
      latest_timestamp: normalizeTimestamp(row.latest_timestamp),
      complete_count: Number(row.complete_count ?? 0)
    }));
  });
}

export async function listCaptureEvents(
  stateRoot: string,
  accountIdRaw?: string,
  options: {
    eventId?: string;
    conversationId?: string;
    continuityId?: string;
    projectId?: string | null;
    ingested?: boolean;
    completeOnly?: boolean;
    limit?: number;
  } = {}
): Promise<Array<StoredCaptureEvent & { ingested: boolean }>> {
  const entries = await listCaptureIndexEntries(stateRoot, accountIdRaw, options);
  const results: Array<StoredCaptureEvent & { ingested: boolean }> = [];
  for (const entry of entries) {
    const event = normalizeStoredCapture(JSON.parse(await readFile(
      captureEventPath(stateRoot, entry.account_id, entry.event_id),
      "utf8"
    )) as unknown);
    results.push({ ...event, ingested: entry.ingested });
  }
  return results;
}

/**
 * A diagnostic-only snapshot. Like capture listing and stats,
 * this never creates or rebuilds the index, acquires its mutation lock, or
 * modifies the capture tree. A missing/dirty index is an explicit error:
 * silently rebuilding during a "read-only" production audit is unsafe.
 */
export async function readCaptureAuditSnapshot(stateRoot: string, accountId: string): Promise<{
  stats: CaptureIndexStats;
  completeUningested: CaptureIndexEntry[];
  ingestedComplete: Array<StoredCaptureEvent & { ingested: true }>;
}> {
  let entries: CaptureIndexEntry[];
  for (let attempt = 0; ; attempt += 1) {
    try {
      entries = await listCaptureIndexEntries(stateRoot, accountId);
      break;
    } catch (error) {
      // A writer may briefly expose its durable dirty sentinel. Retry reads
      // only; a persistent dirty/missing index still fails closed.
      if (attempt >= 9 || !(error instanceof Error) ||
          error.message !== "capture audit requires an existing clean index; repair separately before read-only audit") throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
  const stats: CaptureIndexStats = {
    total: entries.length,
    complete: entries.filter((entry) => entry.capture_status === "complete").length,
    incomplete: entries.filter((entry) => entry.capture_status !== "complete").length,
    ingested: entries.filter((entry) => entry.ingested).length,
    not_ingested: entries.filter((entry) => !entry.ingested).length
  };
  const completeUningested = entries.filter((entry) => entry.capture_status === "complete" && !entry.ingested);
  const ingestedComplete: Array<StoredCaptureEvent & { ingested: true }> = [];
  for (const entry of entries) {
    const markerExists = await isCaptureIngested(stateRoot, accountId, entry.event_id);
    if (markerExists !== entry.ingested) {
      throw new Error("capture audit index/marker mismatch; repair separately");
    }
    if (markerExists && !(await captureIngestedAt(stateRoot, accountId, entry.event_id))) {
      throw new Error("capture audit ingestion marker has invalid timestamp; manual repair required");
    }
    if (!entry.ingested || entry.capture_status !== "complete") continue;
    const event = normalizeStoredCapture(JSON.parse(await readFile(
      captureEventPath(stateRoot, accountId, entry.event_id), "utf8"
    )) as unknown);
    if (event.account_id !== accountId || event.event_id !== entry.event_id || event.capture_status !== "complete") {
      throw new Error("capture audit index/event mismatch; repair separately");
    }
    ingestedComplete.push({ ...event, ingested: true });
  }
  return { stats, completeUningested, ingestedComplete };
}

const captureReadSnapshots = new Map<string, { generation: string; db: Database.Database }>();

function captureReadGeneration(path: string): { key: string; walSize: number } {
  const db = statSync(path);
  let wal;
  try { wal = statSync(`${path}-wal`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return {
    key: `${db.ino}:${db.size}:${db.mtimeMs}:${db.ctimeMs}:${wal?.ino ?? 0}:${wal?.size ?? 0}:${wal?.mtimeMs ?? 0}:${wal?.ctimeMs ?? 0}`,
    walSize: wal?.size ?? 0
  };
}

async function openReadonlyCaptureIndex<T>(stateRoot: string, run: (db: Database.Database) => T): Promise<T> {
  const path = captureIndexPath(stateRoot);
  for (let attempt = 0; ; attempt += 1) {
    // Even a readonly SQLite connection writes WAL shared-memory read marks.
    // Mutators checkpoint under the existing lock; readers deserialize only a
    // stable checkpointed main file and never open disk-backed SQLite handles.
    const before = captureReadGeneration(path);
    const cached = captureReadSnapshots.get(path);
    if (before.walSize === 0 && cached?.generation === before.key) return run(cached.db);
    if (cached) { cached.db.close(); captureReadSnapshots.delete(path); }
    if (before.walSize === 0) {
      const bytes = readFileSync(path);
      const after = captureReadGeneration(path);
      if (before.key === after.key && after.walSize === 0) {
        if (bytes.subarray(0, 16).toString("binary") === "SQLite format 3\0") {
          bytes[18] = 1; bytes[19] = 1; // journal mode in the memory copy only
        }
        const db = new Database(bytes, { readonly: true, fileMustExist: true });
        captureReadSnapshots.set(path, { generation: after.key, db });
        return run(db);
      }
    }
    if (attempt >= 60) {
      throw new Error("capture audit requires an existing clean index; repair separately before read-only audit");
    }
    const delay = Math.min(40, 10 + Math.floor(attempt * 1.5));
    await new Promise((done) => setTimeout(done, delay));
  }
}

export async function withReadonlyCaptureIndex<T>(
  stateRoot: string, accountId: string | undefined, run: (db: Database.Database | null) => T
): Promise<T> {
  if (!existsSync(captureIndexPath(stateRoot))) {
    const path = captureIndexPath(stateRoot);
    captureReadSnapshots.get(path)?.db.close();
    captureReadSnapshots.delete(path);
    const captureRoot = accountId
      ? dirname(captureEventPath(stateRoot, accountId, "probe"))
      : join(resolve(stateRoot), "captures");
    const files = await readdir(captureRoot).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    if (files.length) throw new Error("capture audit requires an existing clean index; repair separately before read-only audit");
    return run(null);
  }
  {
    const knownHashes = await openReadonlyCaptureIndex(stateRoot, db => new Set((db.prepare("SELECT account_hash FROM capture_index_accounts").all() as Array<{ account_hash: string }>).map((row) => row.account_hash)));
    const captureRoot = join(resolve(stateRoot), "captures");
    const hashes = accountId ? [accountHash(accountId)] : await readdir(captureRoot).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
      throw error;
    });
    for (const hash of hashes) {
      if (!knownHashes.has(hash) && (await captureJsonFiles(join(captureRoot, hash))).length) {
        throw new Error("capture audit requires an existing clean index; repair separately before read-only audit");
      }
    }
    // Filesystem validation yields; reacquire the current image before using
    // SQLite synchronously so another reader may safely retire the old image.
    return openReadonlyCaptureIndex(stateRoot, current => current.transaction(() => {
      const dirty = accountId
        ? current.prepare("SELECT 1 FROM capture_index_dirty WHERE account_id=? LIMIT 1").get(accountId)
        : current.prepare("SELECT 1 FROM capture_index_dirty LIMIT 1").get();
      if (dirty) throw new Error("capture audit requires an existing clean index; repair separately before read-only audit");
      return run(current);
    })());
  }
}

export async function captureIndexWatermark(stateRoot: string, accountId: string): Promise<string> {
  return withReadonlyCaptureIndex(stateRoot, accountId, (db) => {
    if (!db) return "empty";
    // Legacy indexes stay readable without running schema migration on a read.
    // Until a mutator upgrades them, disable skips rather than infer a watermark.
    const columns = db.pragma("table_info(capture_index)") as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "mtime_ms")) return randomUUID();
    const row = db.prepare(`SELECT COUNT(*) AS count, MAX(mtime_ms) AS mtime, SUM(ingested) AS ingested
      FROM capture_index WHERE account_id=?`).get(accountId);
    return JSON.stringify(row);
  });
}

export async function listCaptureIndexEntries(
  stateRoot: string,
  accountIdRaw?: string,
  options: {
    eventId?: string;
    conversationId?: string;
    continuityId?: string;
    projectId?: string | null;
    ingested?: boolean;
    completeOnly?: boolean;
    limit?: number;
  } = {}
): Promise<CaptureIndexEntry[]> {
  return withReadonlyCaptureIndex(stateRoot, accountIdRaw?.trim(), (db) => {
    if (!db) return [];
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (accountIdRaw?.trim()) { where.push("account_id=?"); params.push(accountIdRaw.trim()); }
    if (options.eventId) { where.push("event_id=?"); params.push(options.eventId); }
    if (options.conversationId) { where.push("conversation_id=?"); params.push(options.conversationId); }
    if (options.continuityId) { where.push("continuity_id=?"); params.push(options.continuityId); }
    if (options.projectId !== undefined) {
      if (options.projectId === null) where.push("project_hint IS NULL");
      else { where.push("project_hint=?"); params.push(options.projectId); }
    }
    if (options.ingested !== undefined) { where.push("ingested=?"); params.push(options.ingested ? 1 : 0); }
    if (options.completeOnly) where.push("capture_status='complete'");
    const limit = options.limit === undefined
      ? undefined
      : Math.max(1, Math.min(10_000, Math.trunc(options.limit)));
    const sql = `SELECT account_id,event_id,conversation_id,continuity_id,timestamp,project_hint,capture_status,ingested
      FROM capture_index${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
      ORDER BY timestamp DESC${limit === undefined ? "" : " LIMIT ?"}`;
    const rows = db.prepare(sql).all(...params, ...(limit === undefined ? [] : [limit])) as Array<Record<string, unknown>>;
    return rows.map(captureIndexEntryFromRow);
  });
}

function normalizeStoredCapture(
  value: unknown,
  options: NormalizeCaptureOptions = {}
): StoredCaptureEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("stored capture is invalid");
  const record = value as Record<string, unknown>;
  const actorId = optionalText(record.actor_id, 200) ?? optionalText(record.device_id, 200);
  if (!actorId) throw new Error("stored capture actor_id is invalid");
  return {
    // Stored legacy payloads stay byte-faithful by default. The ingest intent
    // hash was frozen over those bytes and must still match on replay.
    ...normalizeCaptureEvent(record, { redact: options.redact ?? false }),
    account_id: requiredId(record.account_id, "account_id", 500),
    actor_id: requiredId(actorId, "actor_id", 200),
    received_at: normalizeTimestamp(record.received_at)
  };
}

function captureEventPath(stateRoot: string, accountId: string, eventId: string): string {
  const accountKey = createHash("sha256").update(accountId, "utf8").digest("hex");
  const eventKey = createHash("sha256").update(eventId, "utf8").digest("hex");
  return join(resolve(stateRoot), "captures", accountKey, `${eventKey}.json`);
}

function captureIndexPath(stateRoot: string): string {
  return join(resolve(stateRoot), "capture-index.sqlite");
}

const captureProjectRegistries = new Map<string, JsonProjectRegistry>();

function captureProjectRegistry(stateRoot: string): JsonProjectRegistry {
  const path = resolve(process.env.MEMHUB_PROJECT_REGISTRY ?? join(stateRoot, "project-registry.json"));
  let registry = captureProjectRegistries.get(path);
  if (!registry) { registry = new JsonProjectRegistry(path); captureProjectRegistries.set(path, registry); }
  return registry;
}

export function captureProjectLookup(stateRoot: string, accountId: string): (ref: string) => Promise<string | null> {
  const registry = captureProjectRegistry(stateRoot);
  return ref => registry.resolve(accountId, ref);
}

function captureIndexRoutingValues(event: StoredCaptureEvent): [string | null, string | null, string | null, number, string] {
  const safe = normalizeCaptureEvent(event);
  const workspace = canonicalWorkspaceProjectCandidate(event.workspace_path);
  return [event.project_hint ? normalizeProjectKey(event.project_hint) : null, event.workspace_path ?? null,
    workspace ? normalizeProjectKey(workspace) : null, captureIsFullyExcludedFromMemory(safe) ? 1 : 0,
    safe.user_text?.split(/\r?\n/)[0]?.slice(0, 200) ?? ""];
}

async function captureProjectRegistryRevision(stateRoot: string, accountId: string): Promise<string> {
  const projects = await captureProjectRegistry(stateRoot).list(accountId, { includeInactive: true });
  return createHash("sha256").update(JSON.stringify(projects.map(project => [
    project.projectId, project.name, project.aliases, project.state, project.mergedInto ?? null
  ]))).digest("hex");
}

export interface CaptureProjectIndexRow extends CaptureIndexEntry {
  workspace_path?: string;
  resolved_project_id: string | null;
  assignment_snapshot?: CaptureAssignmentSnapshot | null;
}

/** Only candidate rows for this project can enter the bounded file-read page. */
export async function readCaptureProjectIndexPage(stateRoot: string, accountId: string, options: {
  projectIds?: readonly string[]; continuityId?: string; conversationId?: string; completeOnly?: boolean;
  afterTimestamp?: string; offset?: number; limit: number; resolution?: "cached" | "pending";
  includeAssignments?: boolean; resolvedPendingIds?: readonly string[];
}): Promise<CaptureProjectIndexRow[]> {
  const projects = [...new Set(options.projectIds ?? [])];
  const refs = new Set(projects.map(normalizeProjectKey));
  const registeredRefs = new Set<string>();
  if (projects.length && options.resolution !== "cached") {
    const registry = captureProjectRegistry(stateRoot);
    for (const project of await registry.list(accountId, { includeInactive: true })) {
      const canonical = await registry.resolve(accountId, project.projectId);
      if (canonical) for (const ref of [project.projectId, project.name, ...project.aliases]) registeredRefs.add(normalizeProjectKey(ref));
      if (canonical && projects.includes(canonical)) {
        for (const ref of [project.projectId, project.name, ...project.aliases]) refs.add(normalizeProjectKey(ref));
      }
    }
  }
  return withReadonlyCaptureIndex(stateRoot, accountId, db => {
    if (!db) return [];
    const columns = new Set((db.pragma("table_info(capture_index)") as Array<{ name: string }>).map(c => c.name));
    const resolved = columns.has("resolved_project_id") ? "resolved_project_id" : "NULL";
    const workspace = columns.has("workspace_path") ? "workspace_path" : "NULL";
    const hintKey = columns.has("project_hint_key") ? "COALESCE(project_hint_key,capture_project_key(project_hint))" : "capture_project_key(project_hint)";
    const workspaceKey = columns.has("workspace_project_key") ? "workspace_project_key" : "NULL";
    db.function("capture_project_key", { deterministic: true }, (value: unknown) => typeof value === "string" ? normalizeProjectKey(value) : null);
    const where = ["account_id=?"];
    const params: Array<string | number> = [accountId];
    if (projects.length) {
      const keys = [...refs];
      const marks = keys.map(() => "?").join(",");
      const known = [...registeredRefs];
      const projectMarks = projects.map(() => "?").join(",");
      const pendingIds = options.resolvedPendingIds ?? [];
      const cached = `(${resolved} IN (${projectMarks})${pendingIds.length ? ` OR event_id IN (${pendingIds.map(() => "?").join(",")})` : ""})`;
      const unknownHint = known.length ? `(${hintKey} IS NULL OR ${hintKey} NOT IN (${known.map(() => "?").join(",")}))` : "1";
      let candidates = `${hintKey} IN (${marks}) OR (${unknownHint} AND ${workspaceKey} IN (${marks}))`;
      const pendingParams: Array<string | number> = [...keys, ...known, ...keys];
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='capture_project_assignments'").get()) {
        candidates += ` OR (SELECT project_id FROM capture_project_assignments a
          WHERE a.account_id=capture_index.account_id AND a.event_id=capture_index.event_id AND scope='event' ORDER BY id DESC LIMIT 1) IN (${projectMarks})
          OR (SELECT project_id FROM capture_project_assignments a WHERE a.account_id=capture_index.account_id
          AND a.continuity_id=capture_index.continuity_id AND scope='continuity' AND anchor_timestamp<=capture_index.timestamp ORDER BY id DESC LIMIT 1) IN (${projectMarks})`;
        pendingParams.push(...projects, ...projects);
      }
      const pending = `((${resolved} IS NULL OR ${resolved}='') AND (${candidates}))`;
      if (options.resolution === "cached") { where.push(cached); params.push(...projects, ...pendingIds); }
      else if (options.resolution === "pending") { where.push(pending); params.push(...pendingParams); }
      else { where.push(`(${cached} OR ${pending})`); params.push(...projects, ...pendingIds, ...pendingParams); }
    }
    if (options.continuityId) { where.push("continuity_id=?"); params.push(options.continuityId); }
    if (options.conversationId) { where.push("conversation_id=?"); params.push(options.conversationId); }
    if (options.completeOnly) where.push("capture_status='complete'");
    if (options.afterTimestamp) { where.push("timestamp>?"); params.push(options.afterTimestamp); }
    const rows = db.prepare(`SELECT account_id,event_id,conversation_id,continuity_id,timestamp,project_hint,
      capture_status,ingested,${workspace} AS workspace_path,${resolved} AS resolved_project_id
      FROM capture_index WHERE ${where.join(" AND ")} ORDER BY timestamp DESC,event_id DESC LIMIT ? OFFSET ?`)
      .all(...params, Math.max(1, Math.min(500, Math.trunc(options.limit))), Math.max(0, Math.trunc(options.offset ?? 0))) as Array<Record<string, unknown>>;
    return rows.map(row => ({ ...captureIndexEntryFromRow(row), workspace_path: optionalText(row.workspace_path, 4000),
      resolved_project_id: typeof row.resolved_project_id === "string" ? row.resolved_project_id : null,
      ...(options.includeAssignments ? { assignment_snapshot: captureAssignmentSnapshot(db, row as unknown as StoredCaptureEvent) ?? null } : {}) }));
  });
}

export async function readIndexedCaptureEvent(stateRoot: string, row: CaptureIndexEntry, redact = false): Promise<StoredCaptureEvent> {
  const event = normalizeStoredCapture(JSON.parse(await readFile(captureEventPath(stateRoot, row.account_id, row.event_id), "utf8")), { redact });
  if (event.account_id !== row.account_id || event.event_id !== row.event_id) throw new Error("capture index/event identity mismatch");
  return event;
}

const projectBackfills = new Map<string, { cancelled: boolean }>();

/** Migration progress survives restarts; a corrupt event never stops later batches. */
export function scheduleCaptureProjectBackfill(stateRoot: string, accountId: string): void {
  const key = `${resolve(stateRoot)}\0${accountId}`;
  if (projectBackfills.has(key) || !existsSync(captureIndexPath(stateRoot))) return;
  const task = { cancelled: false };
  projectBackfills.set(key, task);
  void new Promise<void>(done => setImmediate(done)).then(async () => {
    const revision = await captureProjectRegistryRevision(stateRoot, accountId);
    const pending = await withReadonlyCaptureIndex(stateRoot, accountId, db => {
      if (!db) return { needed: false };
      const columns = new Set((db.pragma("table_info(capture_index)") as Array<{name:string}>).map(c => c.name));
      if (!columns.has("resolved_project_id") || !columns.has("privacy_excluded") || !columns.has("resolved_revision")) return { needed: true, migrate: true };
      const hasProgress = db.prepare("SELECT 1 FROM sqlite_master WHERE name='capture_project_backfill'").get();
      const prior = (hasProgress ? db.prepare("SELECT registry_version,complete FROM capture_project_backfill WHERE account_id=?").get(accountId) : undefined) as { registry_version: string; complete: number } | undefined;
      return { needed: !prior || prior.registry_version !== revision || prior.complete === 0, migrate: false };
    });
    if (!pending.needed || task.cancelled) return;
    const progress = await withCaptureIndexMutation(stateRoot, async () => {
      if (task.cancelled) return undefined;
      return withCaptureIndexDb(stateRoot, db => {
        const prior = db.prepare("SELECT cursor,registry_version,complete FROM capture_project_backfill WHERE account_id=?")
          .get(accountId) as { cursor: string; registry_version: string; complete: number } | undefined;
        if (!prior || prior.registry_version !== revision || pending.migrate) {
          db.transaction(() => {
            db.prepare("INSERT OR REPLACE INTO capture_project_backfill VALUES (?, '', ?, 0)").run(accountId, revision);
          })();
          return { cursor: "", complete: 0 };
        }
        return prior;
      });
    });
    if (!progress || progress.complete || task.cancelled) return;
    const lookup = captureProjectLookup(stateRoot, accountId);
    let cursor = progress.cursor;
    while (!task.cancelled) {
      const ids = await withReadonlyCaptureIndex(stateRoot, accountId, db => db ? db.prepare(
        "SELECT event_id FROM capture_index WHERE account_id=? AND event_id>? AND (resolved_revision IS NOT ? OR resolved_project_id IS NULL OR privacy_excluded IS NULL) ORDER BY event_id LIMIT 100"
      ).all(accountId, cursor, revision) as Array<{ event_id: string }> : []);
      if (task.cancelled) return;
      if (!ids.length) {
        await withCaptureIndexMutation(stateRoot, async () => {
          if (!task.cancelled) await withCaptureIndexDb(stateRoot, db => {
            db.prepare("UPDATE capture_project_backfill SET complete=1 WHERE account_id=? AND registry_version=?").run(accountId, revision);
          });
        });
        return;
      }
      const events: StoredCaptureEvent[] = [];
      for (const { event_id } of ids) {
        if (task.cancelled) return;
        try { events.push(await readIndexedCaptureEvent(stateRoot, { account_id: accountId, event_id } as CaptureIndexEntry)); }
        catch { console.warn(`memhub: skipping capture project backfill ${event_id}`); }
        cursor = event_id;
      }
      await withCaptureIndexMutation(stateRoot, async () => {
        if (task.cancelled) return;
        await withCaptureIndexDb(stateRoot, async db => {
          for (const event of events) {
            try {
              const result = await resolveCaptureProject(event, lookup, stateRoot, db);
              db.prepare(`UPDATE capture_index SET resolved_project_id=?,keep_global=?,project_hint_key=?,workspace_path=?,
                workspace_project_key=?,privacy_excluded=?,user_preview=?,resolved_revision=?,mtime_ms=MAX(mtime_ms,?)
                WHERE account_id=? AND event_id=? AND (resolved_revision IS NOT ? OR resolved_project_id IS NULL OR privacy_excluded IS NULL)`)
                .run(result.projectId ?? "", result.source === "keep_global" ? 1 : 0, ...captureIndexRoutingValues(event), revision, Date.now(), accountId, event.event_id, revision);
            } catch { console.warn(`memhub: skipping capture project backfill ${event.event_id}`); }
          }
          db.prepare("UPDATE capture_project_backfill SET cursor=? WHERE account_id=? AND registry_version=?").run(cursor, accountId, revision);
        });
      });
      await new Promise<void>(done => setImmediate(done));
    }
  }).catch(() => { if (!task.cancelled) console.warn("memhub: capture project backfill failed"); })
    .finally(() => { if (projectBackfills.get(key) === task) projectBackfills.delete(key); });
}

// capture-index.sqlite is one database for all accounts in a state root;
// sharing its handle also reuses it for every (stateRoot, account) pair.
const captureIndexHandles = new Map<string, Database.Database>();

export function closeCaptureIndexDb(stateRoot?: string): void {
  for (const [key, task] of projectBackfills) {
    if (stateRoot === undefined || key.startsWith(resolve(stateRoot) + "\0")) { task.cancelled = true; projectBackfills.delete(key); }
  }
  if (stateRoot === undefined) {
    for (const { db } of captureReadSnapshots.values()) db.close();
    captureReadSnapshots.clear();
    for (const db of captureIndexHandles.values()) db.close();
    captureIndexHandles.clear();
    return;
  }
  const path = captureIndexPath(stateRoot);
  captureReadSnapshots.get(path)?.db.close();
  captureReadSnapshots.delete(path);
  captureIndexHandles.get(path)?.close();
  captureIndexHandles.delete(path);
}

export async function recoverCaptureIndex(stateRoot: string): Promise<void> {
  await withCaptureIndexMutation(stateRoot, async () => {
    const captureRoot = join(resolve(stateRoot), "captures");
    const hashes = await readdir(captureRoot).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
      throw error;
    });
    if (!existsSync(captureIndexPath(stateRoot)) && hashes.length === 0) return;
    const accounts = await withCaptureIndexDb(stateRoot, (db) =>
      new Set((db.prepare("SELECT account_id FROM capture_index_accounts UNION SELECT account_id FROM capture_index_dirty").all() as Array<{ account_id: string }>).map(row => row.account_id)));
    const knownHashes = new Set([...accounts].map(accountHash));
    for (const hash of hashes) {
      if (knownHashes.has(hash)) continue;
      const first = (await captureJsonFiles(join(captureRoot, hash)))[0];
      if (!first) continue;
      const event = normalizeStoredCapture(JSON.parse(await readFile(join(captureRoot, hash, first), "utf8")));
      if (accountHash(event.account_id) !== hash) throw new Error("capture account directory mismatch; manual repair required");
      accounts.add(event.account_id);
    }
    for (const account of accounts) await ensureCaptureIndexUnlocked(stateRoot, account);
  });
}

export async function withCaptureIndexDb<T>(stateRoot: string, run: (db: Database.Database) => T | Promise<T>): Promise<T> {
  const path = captureIndexPath(stateRoot);
  let db = captureIndexHandles.get(path);
  if (!db) {
    await mkdir(resolve(stateRoot), { recursive: true, mode: 0o700 });
    // Another caller may have opened the shared account index while mkdir yielded.
    db = captureIndexHandles.get(path);
  }
  if (!db) {
    db = new Database(path);
    try {
      db.pragma("journal_mode = WAL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS capture_index_accounts (
          account_id TEXT PRIMARY KEY,
          account_hash TEXT NOT NULL UNIQUE,
          rebuilt_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS capture_index (
          account_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          continuity_id TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          project_hint TEXT,
          capture_status TEXT NOT NULL CHECK (capture_status IN ('open','partial','complete','truncated','failed')),
          ingested INTEGER NOT NULL DEFAULT 0 CHECK (ingested IN (0,1)),
          PRIMARY KEY (account_id, event_id)
        );
        CREATE INDEX IF NOT EXISTS idx_capture_index_account_time ON capture_index(account_id, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_capture_index_conversation ON capture_index(account_id, conversation_id, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_capture_index_continuity ON capture_index(account_id, continuity_id, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_capture_index_project ON capture_index(account_id, project_hint, timestamp DESC);
        CREATE TABLE IF NOT EXISTS capture_index_dirty (
          account_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          PRIMARY KEY (account_id, event_id)
        );
      `);
      const columns = db.pragma("table_info(capture_index)") as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "mtime_ms")) {
        db.exec("ALTER TABLE capture_index ADD COLUMN mtime_ms REAL NOT NULL DEFAULT 0");
      }
      if (!columns.some((column) => column.name === "resolved_project_id")) {
        // NULL awaits lazy backfill; an empty string denotes resolved global scope.
        db.exec("ALTER TABLE capture_index ADD COLUMN resolved_project_id TEXT");
      }
      for (const [name, definition] of Object.entries({
        resolved_revision: "TEXT", project_hint_key: "TEXT", workspace_path: "TEXT", workspace_project_key: "TEXT",
        privacy_excluded: "INTEGER", user_preview: "TEXT", keep_global: "INTEGER NOT NULL DEFAULT 0"
      })) {
        if (!columns.some(column => column.name === name)) db.exec(`ALTER TABLE capture_index ADD COLUMN ${name} ${definition}`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_capture_resolved_project ON capture_index(account_id,resolved_project_id,timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_capture_unassigned ON capture_index(account_id,continuity_id,timestamp DESC)
          WHERE capture_status='complete' AND privacy_excluded=0 AND keep_global=0 AND (resolved_project_id IS NULL OR resolved_project_id='');
        CREATE TABLE IF NOT EXISTS capture_project_backfill (
          account_id TEXT PRIMARY KEY, cursor TEXT NOT NULL, registry_version TEXT NOT NULL, complete INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS capture_project_assignments (
          id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, event_id TEXT NOT NULL,
          continuity_id TEXT, project_id TEXT, assigned_by TEXT NOT NULL CHECK(assigned_by IN ('host','admin')),
          assigned_at TEXT NOT NULL, supersedes INTEGER, scope TEXT NOT NULL CHECK(scope IN ('event','continuity')),
          anchor_timestamp TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_capture_assignment_event ON capture_project_assignments(account_id,event_id,scope,id DESC);
        CREATE INDEX IF NOT EXISTS idx_capture_assignment_continuity ON capture_project_assignments(account_id,continuity_id,scope,id DESC);
        CREATE TABLE IF NOT EXISTS capture_project_questions (
          account_id TEXT NOT NULL, continuity_id TEXT NOT NULL, asked_at INTEGER NOT NULL,
          PRIMARY KEY(account_id,continuity_id)
        );`);
      captureIndexHandles.set(path, db);
    } catch (error) { db.close(); throw error; }
    await chmod(path, 0o600).catch(() => undefined);
  }
  return run(db);
}

async function markCaptureIndexDirty(stateRoot: string, accountId: string, eventId: string): Promise<void> {
  await withCaptureIndexDb(stateRoot, (db) => {
    db.prepare("INSERT OR REPLACE INTO capture_index_dirty(account_id,event_id) VALUES (?,?)").run(accountId, eventId);
  });
}

async function clearCaptureIndexDirty(stateRoot: string, accountId: string, eventId: string): Promise<void> {
  await withCaptureIndexDb(stateRoot, (db) => {
    db.prepare("DELETE FROM capture_index_dirty WHERE account_id=? AND event_id=?").run(accountId, eventId);
  });
}

async function ensureCaptureIndexUnlocked(stateRoot: string, accountId: string): Promise<void> {
  const needsRebuild = await withCaptureIndexDb(stateRoot, (db) => {
    const known = db.prepare("SELECT 1 FROM capture_index_accounts WHERE account_id=?").get(accountId);
    const dirty = db.prepare("SELECT 1 FROM capture_index_dirty WHERE account_id=? LIMIT 1").get(accountId);
    return !known || Boolean(dirty);
  });
  if (needsRebuild) await rebuildCaptureIndexUnlocked(stateRoot, accountId);
}

async function rebuildCaptureIndexUnlocked(stateRoot: string, accountId: string): Promise<void> {
  const captureDir = dirname(captureEventPath(stateRoot, accountId, "probe"));
  const entries: Array<CaptureIndexEntry & { mtimeMs: number; routing: ReturnType<typeof captureIndexRoutingValues> }> = [];
  for (const file of await captureJsonFiles(captureDir)) {
    const path = join(captureDir, file);
    const event = normalizeStoredCapture(JSON.parse(await readFile(path, "utf8")) as unknown);
    if (event.account_id !== accountId) continue;
    let ingested = false;
    try {
      await readFile(`${path}.ingested`, "utf8");
      ingested = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    const captureMtime = (await stat(path)).mtimeMs;
    const markerMtime = ingested ? (await stat(`${path}.ingested`)).mtimeMs : 0;
    entries.push({ ...captureIndexEntry(event, ingested), mtimeMs: Math.max(captureMtime, markerMtime), routing: captureIndexRoutingValues(event) });
  }
  await withCaptureIndexDb(stateRoot, (db) => {
    const transaction = db.transaction(() => {
      db.prepare("DELETE FROM capture_index WHERE account_id=?").run(accountId);
      const insert = db.prepare(`
        INSERT INTO capture_index (
          account_id,event_id,conversation_id,continuity_id,timestamp,project_hint,capture_status,ingested,mtime_ms,
          project_hint_key,workspace_path,workspace_project_key,privacy_excluded,user_preview
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const entry of entries) insert.run(...captureIndexSqlValues(entry), entry.mtimeMs, ...entry.routing);
      db.prepare("DELETE FROM capture_project_backfill WHERE account_id=?").run(accountId);
      db.prepare(`
        INSERT INTO capture_index_accounts(account_id,account_hash,rebuilt_at) VALUES (?,?,?)
        ON CONFLICT(account_id) DO UPDATE SET account_hash=excluded.account_hash, rebuilt_at=excluded.rebuilt_at
      `).run(accountId, accountHash(accountId), new Date().toISOString());
      db.prepare("DELETE FROM capture_index_dirty WHERE account_id=?").run(accountId);
    });
    transaction();
  });
}

async function upsertCaptureIndexUnlocked(stateRoot: string, event: StoredCaptureEvent, ingested?: boolean): Promise<void> {
  const mtimeMs = (await stat(captureEventPath(stateRoot, event.account_id, event.event_id))).mtimeMs;
  const registryRevision = await captureProjectRegistryRevision(stateRoot, event.account_id);
  await withCaptureIndexDb(stateRoot, async (db) => {
    const resolution = await resolveCaptureProject(event, captureProjectLookup(stateRoot, event.account_id), stateRoot, db);
    const prior = db.prepare("SELECT ingested FROM capture_index WHERE account_id=? AND event_id=?").get(
      event.account_id,
      event.event_id
    ) as { ingested?: number } | undefined;
    const entry = captureIndexEntry(event, ingested ?? prior?.ingested === 1);
    const transaction = db.transaction(() => {
      db.prepare(`
        INSERT INTO capture_index (
          account_id,event_id,conversation_id,continuity_id,timestamp,project_hint,capture_status,ingested,mtime_ms,resolved_project_id,
          keep_global,project_hint_key,workspace_path,workspace_project_key,privacy_excluded,user_preview,resolved_revision
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(account_id,event_id) DO UPDATE SET
          conversation_id=excluded.conversation_id,
          continuity_id=excluded.continuity_id,
          timestamp=excluded.timestamp,
          project_hint=excluded.project_hint,
          capture_status=excluded.capture_status,
          ingested=excluded.ingested,
          mtime_ms=excluded.mtime_ms,
          resolved_project_id=excluded.resolved_project_id,
          keep_global=excluded.keep_global,project_hint_key=excluded.project_hint_key,workspace_path=excluded.workspace_path,
          workspace_project_key=excluded.workspace_project_key,privacy_excluded=excluded.privacy_excluded,user_preview=excluded.user_preview,
          resolved_revision=excluded.resolved_revision
      `).run(...captureIndexSqlValues(entry), mtimeMs, resolution.projectId ?? "", resolution.source === "keep_global" ? 1 : 0,
        ...captureIndexRoutingValues(event), registryRevision);
      db.prepare(`
        INSERT INTO capture_index_accounts(account_id,account_hash,rebuilt_at) VALUES (?,?,?)
        ON CONFLICT(account_id) DO UPDATE SET account_hash=excluded.account_hash
      `).run(event.account_id, accountHash(event.account_id), new Date().toISOString());
      const pending = db.prepare("SELECT 1 FROM capture_index WHERE account_id=? AND (resolved_project_id IS NULL OR privacy_excluded IS NULL) LIMIT 1").get(event.account_id);
      db.prepare("INSERT OR IGNORE INTO capture_project_backfill VALUES (?, '', ?, ?)").run(event.account_id, registryRevision, pending ? 0 : 1);
    });
    transaction();
  });
}

async function markCaptureIndexIngestedUnlocked(stateRoot: string, accountId: string, eventId: string): Promise<void> {
  const mtimeMs = (await stat(`${captureEventPath(stateRoot, accountId, eventId)}.ingested`)).mtimeMs;
  await withCaptureIndexDb(stateRoot, (db) => {
    db.prepare("UPDATE capture_index SET ingested=1, mtime_ms=MAX(mtime_ms,?) WHERE account_id=? AND event_id=?").run(mtimeMs, accountId, eventId);
  });
}

async function captureJsonFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((file) => file.isFile() && file.name.endsWith(".json"))
      .map((file) => file.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
}

function captureIndexEntry(event: StoredCaptureEvent, ingested: boolean): CaptureIndexEntry {
  return {
    account_id: event.account_id,
    event_id: event.event_id,
    conversation_id: event.conversation_id,
    continuity_id: event.continuity_id,
    timestamp: event.timestamp,
    ...(event.project_hint ? { project_hint: event.project_hint } : {}),
    capture_status: event.capture_status,
    ingested
  };
}

function captureIndexSqlValues(entry: CaptureIndexEntry): [string, string, string, string, string, string | null, string, number] {
  return [
    entry.account_id,
    entry.event_id,
    entry.conversation_id,
    entry.continuity_id,
    entry.timestamp,
    entry.project_hint ?? null,
    entry.capture_status,
    entry.ingested ? 1 : 0
  ];
}

function captureIndexEntryFromRow(row: Record<string, unknown>): CaptureIndexEntry {
  const status = row.capture_status;
  if (!(status === "open" || status === "partial" || status === "complete" || status === "truncated" || status === "failed")) {
    throw new Error("capture index row invalid");
  }
  return {
    account_id: requiredId(row.account_id, "account_id", 500),
    event_id: requiredId(row.event_id, "event_id", 200),
    conversation_id: requiredId(row.conversation_id, "conversation_id", 500),
    continuity_id: row.continuity_id == null ? `event:${requiredId(row.event_id, "event_id", 200)}` : requiredId(row.continuity_id, "continuity_id", 500),
    timestamp: normalizeTimestamp(row.timestamp),
    ...(optionalText(row.project_hint, 500) ? { project_hint: optionalText(row.project_hint, 500) } : {}),
    capture_status: status,
    ingested: row.ingested === 1
  };
}

function accountHash(accountId: string): string {
  return createHash("sha256").update(accountId, "utf8").digest("hex");
}

export async function withCaptureIndexMutation<T>(stateRoot: string, run: () => Promise<T>): Promise<T> {
  return withFileMutationLock(captureIndexPath(stateRoot), async () => {
    const result = await run();
    // Keep WAL writer reuse while publishing a checkpointed read snapshot.
    // The same cross-process lock fences all capture writers. Read-only callers
    // never checkpoint, initialize sidecars, or mutate SQLite shared memory.
    const db = captureIndexHandles.get(captureIndexPath(stateRoot));
    if (db) {
      let checkpointBusy = true;
      for (let i = 0; i < 5; i += 1) {
        const checkpoint = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
        if (!checkpoint[0]?.busy) {
          checkpointBusy = false;
          break;
        }
        await new Promise((done) => setTimeout(done, 20));
      }
      if (checkpointBusy) throw new Error("capture index checkpoint busy; retry mutation");
    }
    return result;
  });
}

export function mergeCaptureEvent(
  existing: MemhubCaptureEvent,
  incoming: MemhubCaptureEvent
): { updated: boolean; event: MemhubCaptureEvent } {
  for (const field of ["event_id", "host", "conversation_id"] as const) {
    if (existing[field] !== incoming[field]) throw new Error(`capture event conflict for ${field}`);
  }
  let updated = false;
  const event: MemhubCaptureEvent = { ...existing };
  if (incoming.continuity_id !== existing.continuity_id) {
    if (existing.continuity_id !== existing.conversation_id) {
      throw new Error("capture event conflict for continuity_id");
    }
    event.continuity_id = incoming.continuity_id;
    updated = true;
  }
  for (const field of [
    "host_version",
    "turn_id",
    "previous_event_id",
    "workspace_id",
    "workspace_path",
    "project_hint",
    "user_text",
    "assistant_text"
  ] as const) {
    const current = existing[field];
    const next = incoming[field];
    if (next === undefined) continue;
    if (current === undefined) {
      event[field] = next;
      updated = true;
      continue;
    }
    if (current !== next) throw new Error(`capture event conflict for ${field}`);
  }
  for (const field of ["reasoning_summary", "tool_summary"] as const) {
    const current = existing[field];
    const next = incoming[field];
    if (next === undefined || current === next) continue;
    if (existing.capture_status === "complete") {
      throw new Error(`capture event conflict for ${field}`);
    }
    event[field] = next;
    updated = true;
  }
  const nextStatus = mergeCaptureStatus(existing.capture_status, incoming.capture_status);
  if (nextStatus !== existing.capture_status) {
    event.capture_status = nextStatus;
    updated = true;
  }
  if (
    event.user_text &&
    event.assistant_text &&
    event.capture_status !== "failed" &&
    event.capture_status !== "truncated" &&
    event.capture_status !== "complete"
  ) {
    event.capture_status = "complete";
    updated = true;
  }
  if (incoming.provenance) {
    const provenance = { ...(existing.provenance ?? {}) };
    for (const [key, next] of Object.entries(incoming.provenance)) {
      const current = provenance[key];
      if (current === undefined) {
        provenance[key] = next;
        updated = true;
      } else if (JSON.stringify(current) !== JSON.stringify(next)) {
        throw new Error(`capture event conflict for provenance.${key}`);
      }
    }
    event.provenance = provenance;
  }
  return { updated, event };
}

function normalizeCaptureStatus(
  value: unknown,
  userText: unknown,
  assistantText: unknown
): MemhubCaptureEvent["capture_status"] {
  if (value === "open" || value === "partial" || value === "complete" || value === "truncated" || value === "failed") {
    return value;
  }
  return optionalText(userText, 300_000) && optionalText(assistantText, 300_000) ? "complete" : "open";
}

function mergeCaptureStatus(
  current: MemhubCaptureEvent["capture_status"],
  incoming: MemhubCaptureEvent["capture_status"]
): MemhubCaptureEvent["capture_status"] {
  if (current === incoming) return current;
  if (incoming === "complete") return "complete";
  if (current === "complete") return current;
  if (incoming === "failed" || incoming === "truncated") return incoming;
  if (current === "failed" || current === "truncated") return current;
  return incoming === "partial" || current === "partial" ? "partial" : "open";
}

async function writeStoredCapture(path: string, event: StoredCaptureEvent, exclusive = false): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(event, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    if (exclusive) {
      try {
        await readFile(path, "utf8");
        throw Object.assign(new Error("capture event already exists"), { code: "EEXIST" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      }
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function requiredId(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f]/.test(normalized)) {
    throw new TypeError(`${field} is invalid`);
  }
  return normalized;
}

function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > max) throw new TypeError("capture field exceeds maximum length");
  return normalized;
}

function normalizeTimestamp(value: unknown): string {
  const raw = requiredId(value, "timestamp", 100);
  const millis = Date.parse(raw);
  if (!Number.isFinite(millis)) throw new TypeError("timestamp must be ISO-8601 compatible");
  return new Date(millis).toISOString();
}

function normalizeProvenance(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("provenance must be an object");
  const serialized = JSON.stringify(value);
  if (serialized.length > 100_000) throw new TypeError("provenance exceeds maximum size");
  return JSON.parse(serialized) as Record<string, unknown>;
}

function normalizedCapturePrivacy(value: unknown): CapturePrivacySummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const excludedSections = candidate.excluded_sections;
  const fullyExcluded = candidate.fully_excluded;
  const markers = Array.isArray(candidate.markers)
    ? candidate.markers.filter((item): item is string => typeof item === "string")
    : [];
  const redactions = normalizedRedactions(candidate.redactions);
  const hasExcludedSections = Number.isSafeInteger(excludedSections) && Number(excludedSections) >= 1 &&
    typeof fullyExcluded === "boolean" &&
    markers.some((marker) => marker === "private" || marker === "no-memory");
  // A redaction-only summary has no excluded sections; it still has to survive
  // normalization so a stored capture keeps its privacy evidence.
  if (!hasExcludedSections && !redactions) return undefined;
  return {
    excluded_sections: hasExcludedSections ? Number(excludedSections) : 0,
    fully_excluded: hasExcludedSections ? fullyExcluded === true : false,
    markers: hasExcludedSections ? [...new Set(markers)] : [],
    ...(redactions ? { redactions } : {})
  };
}

function normalizedRedactions(value: unknown): CaptureRedactionSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const count = candidate.count;
  const kinds = Array.isArray(candidate.kinds)
    ? candidate.kinds.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  if (!Number.isSafeInteger(count) || Number(count) < 1 || kinds.length === 0) return undefined;
  return { count: Number(count), kinds: [...new Set(kinds)] };
}

/** Read complete, privacy-safe evidence without mutating captures or their index. */
export async function listFreshCaptureEvidence(
  stateRoot: string,
  accountIdRaw: string,
  options: {
    projectIds?: readonly string[];
    continuityId?: string;
    afterTimestamp?: string;
    limit: number;
  }
): Promise<StoredCaptureEvent[]> {
  const accountId = requiredId(accountIdRaw, "accountId", 500);
  const projects = [...new Set((options.projectIds ?? []).map((id) => id.trim()).filter(Boolean))];
  const continuityId = options.continuityId?.trim();
  if (!projects.length && !continuityId) return [];
  const after = options.afterTimestamp ? normalizeTimestamp(options.afterTimestamp) : undefined;
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(4, Math.trunc(options.limit))) : 4;
  const page = { projectIds: projects, continuityId, completeOnly: true, afterTimestamp: after, limit: Math.min(64, limit * 8) };
  const lookup = captureProjectLookup(stateRoot, accountId);
  const entries = await readCaptureProjectIndexPage(stateRoot, accountId, { ...page, ...(projects.length ? { resolution: "cached" as const } : {}) });
  if (projects.length) {
    const pending = await readCaptureProjectIndexPage(stateRoot, accountId, { ...page, resolution: "pending" });
    for (const row of pending) {
      const resolution = await resolveCaptureProject(row, async ref =>
        await lookup(ref) ?? (row.project_hint === ref && projects.includes(ref) ? ref : null), stateRoot);
      if (resolution.projectId && projects.includes(resolution.projectId)) entries.push(row);
    }
    entries.sort((a,b) => b.timestamp.localeCompare(a.timestamp) || b.event_id.localeCompare(a.event_id));
    entries.splice(page.limit);
  }
  const events: StoredCaptureEvent[] = [];
  for (const entry of entries) {
    let event: StoredCaptureEvent;
    try {
      event = normalizeStoredCapture(JSON.parse(await readFile(
        captureEventPath(stateRoot, accountId, entry.event_id), "utf8"
      )), { redact: true });
    } catch {
      // A missing/corrupt capture file must never make memmy_context fail.
      // Log the index event id only; capture text is not touched here.
      console.warn(`memhub: skipping unreadable capture evidence ${entry.event_id}`);
      continue;
    }
    if (event.account_id !== accountId || event.event_id !== entry.event_id) {
      console.warn(`memhub: skipping capture evidence with mismatched identity ${entry.event_id}`);
      continue;
    }
    const resolution = projects.length ? await resolveCaptureProject(event, async ref =>
      await lookup(ref) ?? (event.project_hint === ref && projects.includes(ref) ? ref : null), stateRoot) : undefined;
    if (event.capture_status !== "complete" || captureIsFullyExcludedFromMemory(event) ||
        (projects.length && !projects.includes(resolution?.projectId ?? "")) ||
        (continuityId && event.continuity_id !== continuityId) ||
        (after && event.timestamp <= after) ||
        !(event.user_text?.trim() || event.assistant_text?.trim())) continue;
    events.push(event);
    if (events.length >= limit) break;
  }
  if (projects.length) scheduleCaptureProjectBackfill(stateRoot, accountId);
  return events;
}
