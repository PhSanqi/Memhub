import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const hook = resolve(here, "../adapters/plugin/hooks/memhub-capture.mjs");
const dataRoot = await mkdtemp(join(tmpdir(), "memhub-openai-adapter-"));
const port = await freePort();
const env = {
  ...process.env,
  PLUGIN_DATA: dataRoot,
  MEMHUB_BRIDGE_CAPTURE_URL: `http://127.0.0.1:${port}/capture`,
  MEMHUB_PROJECT_ID: "aide"
};

try {
  const userResult = await runHook({
    session_id: "codex-session-1",
    turn_id: "codex-turn-1",
    cwd: "/workspace/aide",
    hook_event_name: "UserPromptSubmit",
    model: "gpt-test",
    prompt: "continue the implementation"
  }, env);
  assert.deepEqual(JSON.parse(userResult.stdout), { continue: true });
  assert.equal((await readdir(join(dataRoot, "outbox"))).filter((name) => name.endsWith(".json")).length, 1);

  const received = [];
  const bridge = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    received.push({ url: request.url, body: JSON.parse(raw || "{}") });
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: true }));
  });
  await new Promise((ready, reject) => {
    bridge.once("error", reject);
    bridge.listen(port, "127.0.0.1", ready);
  });
  try {
    const stopResult = await runHook({
      session_id: "codex-session-1",
      turn_id: "codex-turn-1",
      cwd: "/workspace/aide",
      hook_event_name: "Stop",
      model: "gpt-test",
      stop_hook_active: false,
      last_assistant_message: "implementation complete"
    }, env);
    assert.deepEqual(JSON.parse(stopResult.stdout), { continue: true });
  } finally {
    await new Promise((resolveClose) => bridge.close(resolveClose));
  }

  assert.equal(received.length, 1);
  assert.equal(received[0].url, "/capture");
  assert.equal(received[0].body.event_id, "codex:codex-session-1:codex-turn-1");
  assert.equal(received[0].body.conversation_id, "codex-session-1");
  assert.equal(received[0].body.turn_id, "codex-turn-1");
  assert.equal(received[0].body.user_text, "continue the implementation");
  assert.equal(received[0].body.assistant_text, "implementation complete");
  assert.equal(received[0].body.workspace_path, "/workspace/aide");
  assert.equal(received[0].body.project_hint, "aide");
  assert.equal((await readdir(join(dataRoot, "outbox"))).filter((name) => name.endsWith(".json")).length, 0);

  console.log("memhub-openai-adapter-e2e: ok");
} finally {
  await rm(dataRoot, { recursive: true, force: true });
}

function runHook(input, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [hook], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`hook exited ${code}: ${stderr}`));
      else resolveRun({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((ready, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", ready);
  });
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}
