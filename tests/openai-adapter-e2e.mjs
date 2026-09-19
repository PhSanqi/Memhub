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
  MEMHUB_BRIDGE_CONTEXT_URL: `http://127.0.0.1:${port}/context`,
  MEMHUB_BRIDGE_LIFECYCLE_URL: `http://127.0.0.1:${port}/lifecycle`,
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
    if (request.url === "/context") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        resolvedProjectId: "aide",
        recallScope: "global_and_project",
        globalMemory: [{ id: "g1", content: "durable global preference" }],
        projectMemory: [{ id: "p1", content: "current aide project decision" }],
        projectArchitecture: []
      }));
      return;
    }
    if (request.url === "/lifecycle") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        event: received.at(-1).body.event,
        context: received.at(-1).body.event === "SessionEnd" ? undefined : {
          resolvedProjectId: "aide",
          recallScope: "global_and_project",
          globalMemory: [{ id: "g2", content: "session durable context" }],
          projectMemory: [],
          projectArchitecture: []
        }
      }));
      return;
    }
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: true }));
  });
  await new Promise((ready, reject) => {
    bridge.once("error", reject);
    bridge.listen(port, "127.0.0.1", ready);
  });
  try {
    const contextResult = await runHook({
      session_id: "codex-session-context",
      turn_id: "codex-turn-context",
      cwd: "/workspace/aide",
      hook_event_name: "UserPromptSubmit",
      model: "gpt-test",
      prompt: "continue with prior decisions"
    }, { ...env, MEMHUB_CONTEXT_ONLY: "1" });
    const contextOutput = JSON.parse(contextResult.stdout);
    assert.equal(contextOutput.continue, true);
    assert.equal(contextOutput.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(contextOutput.hookSpecificOutput.additionalContext, /durable global preference/);
    assert.match(contextOutput.hookSpecificOutput.additionalContext, /current aide project decision/);

    const sessionStart = JSON.parse((await runHook({
      session_id: "codex-session-lifecycle",
      cwd: "/workspace/aide",
      hook_event_name: "SessionStart"
    }, env)).stdout);
    assert.equal(sessionStart.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(sessionStart.hookSpecificOutput.additionalContext, /session durable context/);

    const postCompact = JSON.parse((await runHook({
      session_id: "codex-session-lifecycle",
      cwd: "/workspace/aide",
      hook_event_name: "PostCompact"
    }, env)).stdout);
    assert.equal(postCompact.hookSpecificOutput.hookEventName, "PostCompact");
    assert.match(postCompact.hookSpecificOutput.additionalContext, /session durable context/);

    assert.deepEqual(JSON.parse((await runHook({
      session_id: "codex-session-lifecycle",
      cwd: "/workspace/aide",
      hook_event_name: "SessionEnd"
    }, env)).stdout), { continue: true });

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

  const captureRequests = received.filter((item) => item.url === "/capture");
  assert.equal(captureRequests.length, 1);
  assert.equal(captureRequests[0].body.event_id, "codex:codex-session-1:codex-turn-1");
  assert.equal(captureRequests[0].body.conversation_id, "codex-session-1");
  assert.equal(captureRequests[0].body.turn_id, "codex-turn-1");
  assert.equal(captureRequests[0].body.user_text, "continue the implementation");
  assert.equal(captureRequests[0].body.assistant_text, "implementation complete");
  assert.equal(captureRequests[0].body.workspace_path, "/workspace/aide");
  assert.equal(captureRequests[0].body.project_hint, "aide");
  const lifecycleRequests = received.filter((item) => item.url === "/lifecycle");
  assert.deepEqual(lifecycleRequests.map((item) => item.body.event), ["SessionStart", "PostCompact", "SessionEnd"]);
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
