import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface MemhubCaptureEvent {
  event_id: string;
  host: string;
  host_version?: string;
  conversation_id: string;
  turn_id?: string;
  timestamp: string;
  workspace_id?: string;
  workspace_path?: string;
  project_hint?: string;
  user_text?: string;
  assistant_text?: string;
  tool_summary?: string;
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

let deviceMutationTail = Promise.resolve();

export function normalizeCaptureEvent(value: unknown): MemhubCaptureEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("capture event must be an object");
  const input = value as Record<string, unknown>;
  const event: MemhubCaptureEvent = {
    event_id: requiredId(input.event_id, "event_id", 200),
    host: requiredId(input.host, "host", 100),
    conversation_id: requiredId(input.conversation_id, "conversation_id", 500),
    timestamp: normalizeTimestamp(input.timestamp),
    ...(optionalText(input.host_version, 200) ? { host_version: optionalText(input.host_version, 200) } : {}),
    ...(optionalText(input.turn_id, 500) ? { turn_id: optionalText(input.turn_id, 500) } : {}),
    ...(optionalText(input.workspace_id, 500) ? { workspace_id: optionalText(input.workspace_id, 500) } : {}),
    ...(optionalText(input.workspace_path, 4000) ? { workspace_path: optionalText(input.workspace_path, 4000) } : {}),
    ...(optionalText(input.project_hint, 500) ? { project_hint: optionalText(input.project_hint, 500) } : {}),
    ...(optionalText(input.user_text, 300_000) ? { user_text: optionalText(input.user_text, 300_000) } : {}),
    ...(optionalText(input.assistant_text, 300_000) ? { assistant_text: optionalText(input.assistant_text, 300_000) } : {}),
    ...(optionalText(input.tool_summary, 100_000) ? { tool_summary: optionalText(input.tool_summary, 100_000) } : {}),
    ...(normalizeProvenance(input.provenance) ? { provenance: normalizeProvenance(input.provenance) } : {})
  };
  if (!event.user_text && !event.assistant_text && !event.tool_summary) {
    throw new TypeError("capture event requires user_text, assistant_text, or tool_summary");
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
  await withDeviceMutation(async () => {
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
  return withDeviceMutation(async () => {
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
  return withDeviceMutation(async () => {
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
  const event = normalizeCaptureEvent(rawEvent);
  const stored: StoredCaptureEvent = {
    ...event,
    account_id: device.account_id,
    device_id: device.device_id,
    received_at: new Date().toISOString()
  };
  const path = captureEventPath(stateRoot, device.account_id, event.event_id);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const existing = normalizeStoredCapture(JSON.parse(await readFile(path, "utf8")) as unknown);
    if (existing.event_id !== event.event_id) throw new Error("capture event hash collision");
    if (existing.account_id !== device.account_id) throw new Error("capture event account mismatch");
    if (existing.device_id !== device.device_id) throw new Error("capture event device mismatch");
    const merged = mergeCaptureEvent(existing, event);
    if (!merged.updated) return { created: false, updated: false, event: existing };
    const updated: StoredCaptureEvent = { ...existing, ...merged.event };
    await writeStoredCapture(path, updated);
    return { created: false, updated: true, event: updated };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  await writeStoredCapture(path, stored, true);
  return { created: true, updated: false, event: stored };
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
  const path = `${captureEventPath(stateRoot, accountId, eventId)}.ingested`;
  await writeFile(path, new Date().toISOString() + "\n", { mode: 0o600 });
}

export async function countCaptureEvents(stateRoot: string): Promise<number> {
  const root = join(resolve(stateRoot), "captures");
  let count = 0;
  try {
    for (const account of await readdir(root, { withFileTypes: true })) {
      if (!account.isDirectory()) continue;
      for (const file of await readdir(join(root, account.name), { withFileTypes: true })) {
        if (file.isFile() && file.name.endsWith(".json")) count += 1;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  return count;
}

export async function listCaptureEvents(
  stateRoot: string,
  accountIdRaw?: string
): Promise<Array<StoredCaptureEvent & { ingested: boolean }>> {
  const root = join(resolve(stateRoot), "captures");
  const accountKey = accountIdRaw
    ? createHash("sha256").update(accountIdRaw.trim(), "utf8").digest("hex")
    : undefined;
  const results: Array<StoredCaptureEvent & { ingested: boolean }> = [];
  let accounts;
  try {
    accounts = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
  for (const account of accounts) {
    if (!account.isDirectory() || (accountKey && account.name !== accountKey)) continue;
    const dir = join(root, account.name);
    for (const file of await readdir(dir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const path = join(dir, file.name);
      const event = normalizeStoredCapture(JSON.parse(await readFile(path, "utf8")) as unknown);
      let ingested = false;
      try {
        await readFile(`${path}.ingested`, "utf8");
        ingested = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      }
      results.push({ ...event, ingested });
    }
  }
  return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
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

export function mergeCaptureEvent(
  existing: MemhubCaptureEvent,
  incoming: MemhubCaptureEvent
): { updated: boolean; event: MemhubCaptureEvent } {
  for (const field of ["event_id", "host", "conversation_id"] as const) {
    if (existing[field] !== incoming[field]) throw new Error(`capture event conflict for ${field}`);
  }
  let updated = false;
  const event: MemhubCaptureEvent = { ...existing };
  for (const field of [
    "host_version",
    "turn_id",
    "workspace_id",
    "workspace_path",
    "project_hint",
    "user_text",
    "assistant_text",
    "tool_summary"
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

async function withDeviceMutation<T>(run: () => Promise<T>): Promise<T> {
  const previous = deviceMutationTail;
  let release!: () => void;
  deviceMutationTail = new Promise<void>((resolveLock) => { release = resolveLock; });
  await previous;
  try { return await run(); } finally { release(); }
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
