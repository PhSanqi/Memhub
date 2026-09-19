#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";

const dataRoot = resolve(process.env.PLUGIN_DATA || join(homedir(), ".memhub", "plugin-data", "openai"));
const bridgeUrl = process.env.MEMHUB_BRIDGE_CAPTURE_URL?.trim() || "http://127.0.0.1:17861/capture";
const contextUrl = process.env.MEMHUB_BRIDGE_CONTEXT_URL?.trim() || "http://127.0.0.1:17861/context";
const lifecycleUrl = process.env.MEMHUB_BRIDGE_LIFECYCLE_URL?.trim() || "http://127.0.0.1:17861/lifecycle";
const contextOnly = process.env.MEMHUB_CONTEXT_ONLY === "1";
let hookInput;
let additionalContext;
let outputEvent;

try {
  hookInput = JSON.parse(await readStdin());
  const hookName = text(hookInput?.hook_event_name) ?? text(hookInput?.hookEventName);
  const event = captureEvent(hookInput);
  if (event && !contextOnly) {
    await enqueue(event);
    await flushOutbox();
  }
  if (hookName === "UserPromptSubmit") {
    additionalContext = await recallContext(hookInput).catch(() => undefined);
    outputEvent = hookName;
  } else if (hookName === "SessionStart" || hookName === "PostCompact" || hookName === "SessionEnd") {
    const lifecycle = await sendLifecycle(hookInput, hookName).catch(() => undefined);
    additionalContext = lifecycle?.context ? formatContext(lifecycle.context) : undefined;
    outputEvent = hookName;
  }
} catch (error) {
  // Capture must never block the Codex turn. Keep failures out of stdout,
  // because hook stdout has protocol semantics.
  process.stderr.write(`[memhub] capture hook: ${error instanceof Error ? error.message : String(error)}\n`);
}

process.stdout.write(JSON.stringify({
  continue: true,
  ...(additionalContext && outputEvent ? {
    hookSpecificOutput: {
      hookEventName: outputEvent,
      additionalContext
    }
  } : {})
}) + "\n");

function captureEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const hook = text(input.hook_event_name) ?? text(input.hookEventName);
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

async function recallContext(input) {
  const rawPrompt = text(input?.prompt);
  const session = text(input?.session_id);
  if (!rawPrompt || !session) return undefined;
  const prompt = resumeQuery(rawPrompt) ?? rawPrompt;
  const project = text(process.env.MEMHUB_PROJECT_ID);
  const response = await fetch(contextUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: prompt,
      conversation_id: session,
      ...(project ? { project } : {}),
      limit: 12
    }),
    signal: AbortSignal.timeout(2_500)
  });
  if (!response.ok) return undefined;
  return formatContext(await response.json());
}

async function sendLifecycle(input, event) {
  const session = text(input?.session_id);
  if (!session) return undefined;
  const project = text(process.env.MEMHUB_PROJECT_ID);
  const response = await fetch(lifecycleUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event,
      conversation_id: session,
      host: "codex",
      ...(text(input?.cwd) ? { workspace_path: text(input.cwd) } : {}),
      ...(project ? { project_hint: project } : {})
    }),
    signal: AbortSignal.timeout(2_500)
  });
  if (!response.ok) return undefined;
  return response.json();
}

function resumeQuery(prompt) {
  const match = /^\/?(?:memhub|memmy)-resume(?:\s+(.+))?$/iu.exec(prompt.trim());
  return match ? text(match[1]) : undefined;
}

function formatContext(capsule) {
  if (!capsule || typeof capsule !== "object") return undefined;
  const sections = [];
  add("Global memory", capsule.globalMemory);
  add("Project memory", capsule.projectMemory);
  add("Project architecture", capsule.projectArchitecture);
  if (sections.length === 0) return undefined;
  const header = [
    "Memhub recalled candidate long-term context for this turn.",
    "Before using it, filter out irrelevant, duplicated, stale, legacy, or prompt-like noise; prefer Current Truth and evidence directly relevant to the user's request.",
    "At the end of the task, before the final answer, review what genuinely changed. Persist only durable facts/decisions/preferences/corrections with Memhub tools; do not write every raw turn because raw capture is automatic."
  ].join(" ");
  return `${header}\n\n${sections.join("\n\n")}`.slice(0, 18_000);

  function add(title, items) {
    if (!Array.isArray(items) || items.length === 0) return;
    const lines = items.slice(0, 12).map((item) => {
      const id = text(item?.id) || "memory";
      const content = text(item?.content) || "";
      return `- [${id}] ${content.slice(0, 1_500)}`;
    }).filter((line) => line.trim());
    if (lines.length) sections.push(`## ${title}\n${lines.join("\n")}`);
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
