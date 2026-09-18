#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";

const dataRoot = resolve(process.env.PLUGIN_DATA || join(homedir(), ".memhub", "plugin-data", "openai"));
const bridgeUrl = process.env.MEMHUB_BRIDGE_CAPTURE_URL?.trim() || "http://127.0.0.1:17861/capture";

try {
  const input = JSON.parse(await readStdin());
  const event = captureEvent(input);
  if (event) {
    await enqueue(event);
    await flushOutbox();
  }
} catch (error) {
  // Capture must never block the Codex turn. Keep failures out of stdout,
  // because hook stdout has protocol semantics.
  process.stderr.write(`[memhub] capture hook: ${error instanceof Error ? error.message : String(error)}\n`);
}

process.stdout.write(JSON.stringify({ continue: true }) + "\n");

function captureEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const hook = text(input.hook_event_name);
  if (hook !== "UserPromptSubmit" && hook !== "Stop") return null;
  const session = text(input.session_id);
  const turn = text(input.turn_id);
  if (!session || !turn) return null;
  const user = hook === "UserPromptSubmit" ? text(input.prompt) : undefined;
  const assistant = hook === "Stop" ? text(input.last_assistant_message) : undefined;
  if (!user && !assistant) return null;
  const project = text(process.env.MEMHUB_PROJECT_ID);
  return {
    event_id: `codex:${session}:${turn}`,
    host: "codex",
    conversation_id: session,
    turn_id: turn,
    timestamp: new Date().toISOString(),
    ...(text(input.cwd) ? { workspace_path: text(input.cwd) } : {}),
    ...(project ? { project_hint: project } : {}),
    ...(user ? { user_text: user } : {}),
    ...(assistant ? { assistant_text: assistant } : {}),
    provenance: {
      adapter: "memhub-openai-hook",
      ...(text(input.model) ? { model: text(input.model) } : {})
    }
  };
}

async function enqueue(incoming) {
  const path = outboxPath(incoming.event_id);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let event = incoming;
  try {
    const existing = JSON.parse(await readFile(path, "utf8"));
    event = merge(existing, incoming);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await atomicWrite(path, event);
}

async function flushOutbox() {
  const dir = join(dataRoot, "outbox");
  let names;
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      const event = JSON.parse(await readFile(path, "utf8"));
      const response = await fetch(bridgeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(750)
      });
      if (!response.ok) break;
      await rm(path, { force: true });
    } catch {
      break;
    }
  }
}

function merge(existing, incoming) {
  for (const field of ["event_id", "host", "conversation_id", "turn_id"]) {
    if (existing[field] !== incoming[field]) throw new Error(`outbox conflict for ${field}`);
  }
  const merged = { ...existing };
  for (const field of ["workspace_path", "project_hint", "user_text", "assistant_text"]) {
    const next = incoming[field];
    if (next === undefined) continue;
    if (merged[field] === undefined) merged[field] = next;
    else if (merged[field] !== next) throw new Error(`outbox conflict for ${field}`);
  }
  merged.provenance = { ...(existing.provenance || {}), ...(incoming.provenance || {}) };
  return merged;
}

function outboxPath(eventId) {
  const key = createHash("sha256").update(eventId, "utf8").digest("hex");
  return join(dataRoot, "outbox", `${key}.json`);
}

async function atomicWrite(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw || "{}";
}

function text(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}
