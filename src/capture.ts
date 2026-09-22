import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { withFileMutationLock } from "./file-mutation-lock.js";

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

export interface StoredCaptureEvent extends MemhubCaptureEvent {
  account_id: string;
  device_id: string;
  received_at: string;
}

export interface DeviceRecord {
  device_id: string;
  account_id: string;
  name: string;
  token_hash: string;
  created_at: string;
  last_seen_at?: string;
  revoked_at?: string;
}

interface DeviceStore {
  version: 1;
  devices: DeviceRecord[];
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

export function normalizeCaptureEvent(value: unknown): MemhubCaptureEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("capture event must be an object");
  const input = value as Record<string, unknown>;
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
    ...(optionalText(input.user_text, 300_000) ? { user_text: optionalText(input.user_text, 300_000) } : {}),
    ...(optionalText(input.assistant_text, 300_000) ? { assistant_text: optionalText(input.assistant_text, 300_000) } : {}),
    ...(optionalText(input.reasoning_summary, 100_000) ? { reasoning_summary: optionalText(input.reasoning_summary, 100_000) } : {}),
    ...(optionalText(input.tool_summary, 100_000) ? { tool_summary: optionalText(input.tool_summary, 100_000) } : {}),
    capture_status: normalizeCaptureStatus(input.capture_status, input.user_text, input.assistant_text),
    ...(normalizeProvenance(input.provenance) ? { provenance: normalizeProvenance(input.provenance) } : {})
  };
  if (!event.user_text && !event.assistant_text && !event.reasoning_summary && !event.tool_summary) {
    throw new TypeError("capture event requires user_text, assistant_text, reasoning_summary, or tool_summary");
  }
  return event;
}

export async function createDevice(
  stateRoot: string,
  accountIdRaw: string,
  nameRaw: string
): Promise<{ device: Omit<DeviceRecord, "token_hash">; token: string }> {
  const accountId = requiredId(accountIdRaw, "accountId", 500);
  const name = requiredId(nameRaw, "name", 200);
  const token = `mhdev_${randomBytes(32).toString("base64url")}`;
  const device: DeviceRecord = {
    device_id: randomUUID(),
    account_id: accountId,
    name,
    token_hash: tokenHash(token),
    created_at: new Date().toISOString()
  };
  await withDeviceMutation(stateRoot, async () => {
    const store = await loadDevices(stateRoot);
    store.devices.push(device);
    await saveDevices(stateRoot, store);
  });
  const { token_hash: _tokenHash, ...publicDevice } = device;
  return { device: publicDevice, token };
}

export async function listDevices(stateRoot: string, accountIdRaw?: string): Promise<Array<Omit<DeviceRecord, "token_hash">>> {
  const accountId = accountIdRaw?.trim();
  const store = await loadDevices(stateRoot);
  return store.devices
    .filter((device) => !accountId || device.account_id === accountId)
    .map(({ token_hash: _tokenHash, ...device }) => device)
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
}

export async function revokeDevice(stateRoot: string, deviceIdRaw: string): Promise<boolean> {
  const deviceId = requiredId(deviceIdRaw, "deviceId", 200);
  return withDeviceMutation(stateRoot, async () => {
    const store = await loadDevices(stateRoot);
    const device = store.devices.find((item) => item.device_id === deviceId);
    if (!device || device.revoked_at) return false;
    device.revoked_at = new Date().toISOString();
    await saveDevices(stateRoot, store);
    return true;
  });
}

export async function authenticateDevice(stateRoot: string, tokenRaw: string): Promise<DeviceRecord | null> {
  const token = tokenRaw.trim();
  if (!token) return null;
  const hash = tokenHash(token);
  return withDeviceMutation(stateRoot, async () => {
    const store = await loadDevices(stateRoot);
    const expected = Buffer.from(hash, "hex");
    const device = store.devices.find((item) => {
      if (item.revoked_at || item.token_hash.length !== hash.length) return false;
      const actual = Buffer.from(item.token_hash, "hex");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    });
    if (!device) return null;
    device.last_seen_at = new Date().toISOString();
    await saveDevices(stateRoot, store);
    return { ...device };
  });
}

export async function storeCaptureEvent(
  stateRoot: string,
  device: Pick<DeviceRecord, "device_id" | "account_id">,
  rawEvent: unknown
): Promise<{ created: boolean; updated: boolean; event: StoredCaptureEvent }> {
  return withCaptureIndexMutation(stateRoot, async () => {
    const event = normalizeCaptureEvent(rawEvent);
    const stored: StoredCaptureEvent = {
      ...event,
      account_id: device.account_id,
      device_id: device.device_id,
      received_at: new Date().toISOString()
    };
    const path = captureEventPath(stateRoot, device.account_id, event.event_id);
    await ensureCaptureIndexUnlocked(stateRoot, device.account_id);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const existing = normalizeStoredCapture(JSON.parse(await readFile(path, "utf8")) as unknown);
      if (existing.event_id !== event.event_id) throw new Error("capture event hash collision");
      if (existing.account_id !== device.account_id) throw new Error("capture event account mismatch");
      if (existing.device_id !== device.device_id) throw new Error("capture event device mismatch");
      const merged = mergeCaptureEvent(existing, event);
      if (!merged.updated) {
        await upsertCaptureIndexUnlocked(stateRoot, existing, await isCaptureIngested(stateRoot, device.account_id, existing.event_id));
        return { created: false, updated: false, event: existing };
      }
      const updated: StoredCaptureEvent = { ...existing, ...merged.event };
      assertCaptureCompleteness(updated);
      await markCaptureIndexDirty(stateRoot, device.account_id, event.event_id);
      await writeStoredCapture(path, updated);
      await upsertCaptureIndexUnlocked(stateRoot, updated);
      await clearCaptureIndexDirty(stateRoot, device.account_id, event.event_id);
      return { created: false, updated: true, event: updated };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    assertCaptureCompleteness(stored);
    await markCaptureIndexDirty(stateRoot, device.account_id, event.event_id);
    await writeStoredCapture(path, stored, true);
    await upsertCaptureIndexUnlocked(stateRoot, stored, false);
    await clearCaptureIndexDirty(stateRoot, device.account_id, event.event_id);
    return { created: true, updated: false, event: stored };
  });
}

function assertCaptureCompleteness(event: MemhubCaptureEvent): void {
  if (event.capture_status === "complete" && (!event.user_text || !event.assistant_text)) {
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

export async function markCaptureIngested(stateRoot: string, accountId: string, eventId: string): Promise<void> {
  await withCaptureIndexMutation(stateRoot, async () => {
    await ensureCaptureIndexUnlocked(stateRoot, accountId);
    await markCaptureIndexDirty(stateRoot, accountId, eventId);
    const path = `${captureEventPath(stateRoot, accountId, eventId)}.ingested`;
    await writeFile(path, new Date().toISOString() + "\n", { mode: 0o600 });
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
  return withCaptureIndexMutation(stateRoot, async () => {
    const accountIds = accountIdRaw?.trim()
      ? [accountIdRaw.trim()]
      : await discoverCaptureAccountIds(stateRoot);
    for (const accountId of accountIds) await ensureCaptureIndexUnlocked(stateRoot, accountId);
    return withCaptureIndexDb(stateRoot, (db) => {
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
  });
}

export async function listIdleCaptureGroups(stateRoot: string, cutoffIso: string): Promise<IdleCaptureGroup[]> {
  return withCaptureIndexMutation(stateRoot, async () => {
    const accountIds = await discoverCaptureAccountIds(stateRoot);
    for (const accountId of accountIds) await ensureCaptureIndexUnlocked(stateRoot, accountId);
    return withCaptureIndexDb(stateRoot, (db) => {
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
  });
}

export async function listCaptureEvents(
  stateRoot: string,
  accountIdRaw?: string,
  options: {
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

export async function listCaptureIndexEntries(
  stateRoot: string,
  accountIdRaw?: string,
  options: {
    conversationId?: string;
    continuityId?: string;
    projectId?: string | null;
    ingested?: boolean;
    completeOnly?: boolean;
    limit?: number;
  } = {}
): Promise<CaptureIndexEntry[]> {
  return withCaptureIndexMutation(stateRoot, async () => {
    const accountIds = accountIdRaw?.trim()
      ? [accountIdRaw.trim()]
      : await discoverCaptureAccountIds(stateRoot);
    for (const accountId of accountIds) await ensureCaptureIndexUnlocked(stateRoot, accountId);
    return withCaptureIndexDb(stateRoot, (db) => {
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (accountIdRaw?.trim()) { where.push("account_id=?"); params.push(accountIdRaw.trim()); }
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
  });
}

function normalizeStoredCapture(value: unknown): StoredCaptureEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("stored capture is invalid");
  const record = value as Record<string, unknown>;
  return {
    ...normalizeCaptureEvent(record),
    account_id: requiredId(record.account_id, "account_id", 500),
    device_id: requiredId(record.device_id, "device_id", 200),
    received_at: normalizeTimestamp(record.received_at)
  };
}

function devicesPath(stateRoot: string): string {
  return join(resolve(stateRoot), "devices.json");
}

function captureEventPath(stateRoot: string, accountId: string, eventId: string): string {
  const accountKey = createHash("sha256").update(accountId, "utf8").digest("hex");
  const eventKey = createHash("sha256").update(eventId, "utf8").digest("hex");
  return join(resolve(stateRoot), "captures", accountKey, `${eventKey}.json`);
}

function captureIndexPath(stateRoot: string): string {
  return join(resolve(stateRoot), "capture-index.sqlite");
}

async function withCaptureIndexDb<T>(stateRoot: string, run: (db: Database.Database) => T | Promise<T>): Promise<T> {
  await mkdir(resolve(stateRoot), { recursive: true, mode: 0o700 });
  const path = captureIndexPath(stateRoot);
  const db = new Database(path);
  try {
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
    await chmod(path, 0o600).catch(() => undefined);
    return await run(db);
  } finally {
    db.close();
  }
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
  const entries: CaptureIndexEntry[] = [];
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
    entries.push(captureIndexEntry(event, ingested));
  }
  await withCaptureIndexDb(stateRoot, (db) => {
    const transaction = db.transaction(() => {
      db.prepare("DELETE FROM capture_index WHERE account_id=?").run(accountId);
      const insert = db.prepare(`
        INSERT INTO capture_index (
          account_id,event_id,conversation_id,continuity_id,timestamp,project_hint,capture_status,ingested
        ) VALUES (?,?,?,?,?,?,?,?)
      `);
      for (const entry of entries) insert.run(...captureIndexSqlValues(entry));
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
  await withCaptureIndexDb(stateRoot, (db) => {
    const prior = db.prepare("SELECT ingested FROM capture_index WHERE account_id=? AND event_id=?").get(
      event.account_id,
      event.event_id
    ) as { ingested?: number } | undefined;
    const entry = captureIndexEntry(event, ingested ?? prior?.ingested === 1);
    const transaction = db.transaction(() => {
      db.prepare(`
        INSERT INTO capture_index (
          account_id,event_id,conversation_id,continuity_id,timestamp,project_hint,capture_status,ingested
        ) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(account_id,event_id) DO UPDATE SET
          conversation_id=excluded.conversation_id,
          continuity_id=excluded.continuity_id,
          timestamp=excluded.timestamp,
          project_hint=excluded.project_hint,
          capture_status=excluded.capture_status,
          ingested=excluded.ingested
      `).run(...captureIndexSqlValues(entry));
      db.prepare(`
        INSERT INTO capture_index_accounts(account_id,account_hash,rebuilt_at) VALUES (?,?,?)
        ON CONFLICT(account_id) DO UPDATE SET account_hash=excluded.account_hash
      `).run(event.account_id, accountHash(event.account_id), new Date().toISOString());
    });
    transaction();
  });
}

async function markCaptureIndexIngestedUnlocked(stateRoot: string, accountId: string, eventId: string): Promise<void> {
  await withCaptureIndexDb(stateRoot, (db) => {
    db.prepare("UPDATE capture_index SET ingested=1 WHERE account_id=? AND event_id=?").run(accountId, eventId);
  });
}

async function discoverCaptureAccountIds(stateRoot: string): Promise<string[]> {
  const ids = new Set(await withCaptureIndexDb(stateRoot, (db) =>
    (db.prepare("SELECT account_id FROM capture_index_accounts").all() as Array<{ account_id: string }>).map((row) => row.account_id)
  ));
  const knownHashes = new Set([...ids].map(accountHash));
  const captureRoot = join(resolve(stateRoot), "captures");
  try {
    for (const dir of await readdir(captureRoot, { withFileTypes: true })) {
      if (!dir.isDirectory() || knownHashes.has(dir.name)) continue;
      const files = await captureJsonFiles(join(captureRoot, dir.name));
      if (files.length === 0) continue;
      const event = normalizeStoredCapture(JSON.parse(await readFile(join(captureRoot, dir.name, files[0]!), "utf8")) as unknown);
      ids.add(event.account_id);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  return [...ids].sort();
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
    continuity_id: requiredId(row.continuity_id, "continuity_id", 500),
    timestamp: normalizeTimestamp(row.timestamp),
    ...(optionalText(row.project_hint, 500) ? { project_hint: optionalText(row.project_hint, 500) } : {}),
    capture_status: status,
    ingested: row.ingested === 1
  };
}

function accountHash(accountId: string): string {
  return createHash("sha256").update(accountId, "utf8").digest("hex");
}

async function withCaptureIndexMutation<T>(stateRoot: string, run: () => Promise<T>): Promise<T> {
  return withFileMutationLock(captureIndexPath(stateRoot), run);
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

async function loadDevices(stateRoot: string): Promise<DeviceStore> {
  try {
    const raw = JSON.parse(await readFile(devicesPath(stateRoot), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("devices store invalid");
    const record = raw as { version?: unknown; devices?: unknown };
    if (record.version !== 1 || !Array.isArray(record.devices)) throw new Error("devices store invalid");
    return { version: 1, devices: record.devices.map(normalizeDeviceRecord) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { version: 1, devices: [] };
    throw error;
  }
}

async function saveDevices(stateRoot: string, store: DeviceStore): Promise<void> {
  const path = devicesPath(stateRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function normalizeDeviceRecord(value: unknown): DeviceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("device record invalid");
  const record = value as Record<string, unknown>;
  return {
    device_id: requiredId(record.device_id, "device_id", 200),
    account_id: requiredId(record.account_id, "account_id", 500),
    name: requiredId(record.name, "name", 200),
    token_hash: requiredHex(record.token_hash, "token_hash"),
    created_at: normalizeTimestamp(record.created_at),
    ...(optionalText(record.last_seen_at, 100) ? { last_seen_at: normalizeTimestamp(record.last_seen_at) } : {}),
    ...(optionalText(record.revoked_at, 100) ? { revoked_at: normalizeTimestamp(record.revoked_at) } : {})
  };
}

async function withDeviceMutation<T>(stateRoot: string, run: () => Promise<T>): Promise<T> {
  return withFileMutationLock(devicesPath(stateRoot), run);
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function requiredId(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f]/.test(normalized)) {
    throw new TypeError(`${field} is invalid`);
  }
  return normalized;
}

function requiredHex(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${field} is invalid`);
  return value;
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
