import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import Database from "better-sqlite3";
import { MemhubBridgeQueue, saveBridgeConfig } from "../dist/bridge.js";
import { addAccount, ensureLocalAdminToken, setAccountRole } from "../dist/auth.js";
import { createDevice, countCaptureEvents, listCaptureEvents } from "../dist/capture.js";
import { defaultMemoryUserId } from "../dist/memory-source.js";
import {
  enqueueDistillationJob,
  failDistillationJob,
  leaseDistillationJob,
  listDistillationJobs,
  retryDistillationJob
} from "../dist/distillation-jobs.js";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const mcpEntry = resolve(here, "../dist/mcp.js");
const bridgeEntry = resolve(here, "../dist/bridge.js");
const root = await mkdtemp(join(tmpdir(), "memhub-mcp-"));
const historyDbPath = join(root, "history.sqlite");
const historyDb = new Database(historyDbPath);

function assertInlineScriptsParse(html) {
  const open = "<scr" + "ipt>";
  const close = "</scr" + "ipt>";
  const scripts = html.split(open).slice(1).map((part) => part.split(close)[0]);
  assert.ok(scripts.length > 0, "expected at least one inline script");
  for (const script of scripts) {
    assert.doesNotThrow(() => new Function(script));
  }
}

historyDb.exec(`
  CREATE TABLE memories (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT, memory_value TEXT NOT NULL,
    memory_layer TEXT NOT NULL, tags_json TEXT NOT NULL DEFAULT '[]', info_json TEXT NOT NULL DEFAULT '{}',
    properties_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    deleted_at TEXT, status TEXT NOT NULL
  );
  CREATE TABLE user_memories (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, content TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL
  );
`);
const historyUserId = defaultMemoryUserId("acct-test");
const insertMemory = historyDb.prepare(`
  INSERT INTO memories (
    id, user_id, conversation_id, memory_value, memory_layer, tags_json, info_json, properties_json,
    created_at, updated_at, deleted_at, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'activated')
`);
insertMemory.run(
  "history-project-memory-1", historyUserId, "legacy-project-chat", "Project architecture decision from earlier history",
  "L1", JSON.stringify(["project:aide"]), JSON.stringify({ project_id: "aide" }), "{}",
  "2026-09-17T08:00:00.000Z", "2026-09-17T08:00:00.000Z"
);
insertMemory.run(
  "history-other-account", "acct_other_user", "other-chat", "DO NOT LEAK OTHER ACCOUNT MEMORY",
  "L1", "[]", "{}", "{}", "2026-09-17T09:00:00.000Z", "2026-09-17T09:00:00.000Z"
);
historyDb.close();
const requests = [];
const idempotency = new Map();
const memory = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  requests.push({ url: request.url, body });
  response.setHeader("content-type", "application/json");
  if (request.url === "/api/v1/memory/search") {
    const project = body.namespace?.projectId;
    response.end(JSON.stringify({ hits: project
      ? [hit("global", "global", ["global"]), hit("project", `project ${project}`, [`project:${project}`])]
      : [hit("global", "global", ["global"])] }));
    return;
  }
  if (request.url === "/api/v1/memory/add") {
    if (!acceptIdempotent(body, "memory.add", response)) return;
    response.end(JSON.stringify({ id: "new-memory", status: "activated" }));
    return;
  }
  const viewerPath = (request.url ?? "").split("?")[0];
  if (request.method === "GET" && [
    "/api/v1/overview", "/api/v1/memories", "/api/v1/episodes", "/api/v1/skills",
    "/api/v1/world-models", "/api/v1/policies", "/api/v1/traces"
  ].includes(viewerPath)) {
    response.end(JSON.stringify(viewerPath === "/api/v1/overview"
      ? { metrics: { memories: 1 } }
      : { items: [], total: 0 }));
    return;
  }
  if (request.url === "/api/v1/evolution/l3/lease") {
    const project = body.projectId ?? body.namespace?.projectId ?? null;
    response.end(JSON.stringify({
      job: {
        jobId: `external-l3-${project ?? "global"}`,
        batchId: `batch-${project ?? "global"}`,
        targetField: project ? "project_contract" : "general_rules_and_safety_constraints",
        userId: body.namespace?.userId,
        projectId: project,
        sessionId: `session-${project ?? "global"}`,
        scopeKey: `scope-${project ?? "global"}`,
        scopeSeq: 1,
        currentField: "",
        projectEnvironmentProfile: project ? "runtime: test" : "",
        rawTurns: [{ user_text: "durable evidence", assistant_text: "recorded" }],
        eligibleL1MemoryIds: ["l1-test"],
        expectedFieldHash: "field-hash",
        ...(project ? { expectedProfileHash: "profile-hash" } : {}),
        systemPrompt: "Return one valid JSON object.",
        dynamicInput: { current_field: "", raw_turns: [] },
        expectedSchema: project
          ? { reason: "string", op: "noop | create | update", project_contract: "string" }
          : { op: "noop | create | update", general_rules_and_safety_constraints: "string" },
        leasedUntil: "2099-01-01T00:00:00.000Z"
      },
      serverTime: "2026-09-18T00:00:00.000Z"
    }));
    return;
  }
  if (/^\/api\/v1\/evolution\/l3\/[^/]+\/submit$/.test(request.url ?? "")) {
    response.end(JSON.stringify({
      ok: true,
      jobId: request.url.split("/").at(-2),
      projectId: body.projectId ?? body.namespace?.projectId ?? null,
      targetField: body.projectId ? "project_contract" : "general_rules_and_safety_constraints",
      noChange: false,
      memoryId: "l3-memory-test"
    }));
    return;
  }
  if (request.url === "/api/v1/sessions/open") {
    if (!acceptIdempotent(body, "session.open", response)) return;
    response.end(JSON.stringify({
      sessionId: body.sessionId,
      projectId: body.projectId ?? body.namespace?.projectId ?? null
    }));
    return;
  }
  if (request.url === "/api/v1/turns/start") {
    response.end(JSON.stringify({
      turnId: body.turnId,
      sessionId: body.sessionId,
      status: "started"
    }));
    return;
  }
  if (request.url?.startsWith("/api/v1/turns/") && request.url.endsWith("/complete")) {
    if (!acceptIdempotent(body, "turn.complete", response)) return;
    response.end(JSON.stringify({ l1MemoryId: `l1-${body.sessionId}`, status: "captured" }));
    return;
  }
  response.statusCode = 404;
  response.end("{}");
});

await new Promise((ready, reject) => {
  memory.once("error", reject);
  memory.listen(0, "127.0.0.1", ready);
});
const memoryPort = memory.address().port;

try {
  await testStdio(memoryPort);
  await testHttp(memoryPort);
  await testLocalAdmin(memoryPort);
  await testRootBasePath(memoryPort);
  await testBridgeMcpProxy();
  console.log("memhub-mcp-e2e: ok");
} finally {
  await new Promise((resolveClose) => memory.close(resolveClose));
  await rm(root, { recursive: true, force: true });
}

async function testBridgeMcpProxy() {
  const upstreamPort = await freePort();
  const bridgePort = await freePort();
  const bridgeRoot = join(root, "bridge-proxy");
  const deviceToken = `mhdev_${"x".repeat(48)}`;
  const observed = [];
  const upstream = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    observed.push({ headers: request.headers, body: raw, method: request.method, url: request.url });
    response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "bridge-proxy-session" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
  });
  await new Promise((ready, reject) => {
    upstream.once("error", reject);
    upstream.listen(upstreamPort, "127.0.0.1", ready);
  });
  await saveBridgeConfig(bridgeRoot, {
    mcpEndpoint: `http://127.0.0.1:${upstreamPort}/mcp`,
    captureEndpoint: `http://127.0.0.1:${upstreamPort}/capture`,
    deviceToken,
    cloudflareAccessClientId: "test-service-id",
    cloudflareAccessClientSecret: "test-service-secret"
  });
  const child = spawn(process.execPath, [resolve(here, "../dist/bridge.js"), "serve", "--port", String(bridgePort)], {
    env: { ...process.env, MEMHUB_BRIDGE_HOME: bridgeRoot },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => { stderr += data; });
  try {
    const deadline = Date.now() + 5_000;
    while (!stderr.includes("[memhub-bridge] listening") && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    assert.match(stderr, /\[memhub-bridge\] listening/);
    const response = await fetch(`http://127.0.0.1:${bridgePort}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("mcp-session-id"), "bridge-proxy-session");
    assert.equal(observed.length, 1);
    assert.equal(observed[0].headers["x-memhub-device-token"], deviceToken);
    assert.equal(observed[0].headers["cf-access-client-id"], "test-service-id");
    assert.equal(observed[0].headers["cf-access-client-secret"], "test-service-secret");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => {
      child.once("exit", resolveExit);
      setTimeout(resolveExit, 500);
    });
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
}

async function testLocalAdmin(memoryPort) {
  const port = await freePort();
  const stateRoot = join(root, "local-admin");
  const account = await addAccount(stateRoot, "admin-test", "admin@example.com");
  await setAccountRole(stateRoot, account.account_id, "admin");
  const token = await ensureLocalAdminToken(stateRoot);
  const child = spawn(process.execPath, [
    mcpEntry,
    "--http", String(port),
    "--account", account.account_id,
    "--memory-url", `http://127.0.0.1:${memoryPort}`,
    "--state-root", stateRoot,
    "--bindings", join(root, "local-admin-bindings.json"),
    "--public-host", "memhub.example.test",
    "--no-normify"
  ], { env: { ...process.env, MEMHUB_MEMORY_DB: historyDbPath }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => { stderr += data; });
  try {
    const deadline = Date.now() + 5_000;
    while (!stderr.includes("listening on http://127.0.0.1:") && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    const anonymous = await fetch(`http://127.0.0.1:${port}/memhub/admin`);
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get("www-authenticate") ?? "", /Memhub local admin/);
    const authorization = `Basic ${Buffer.from(`memhub:${token}`).toString("base64")}`;
    const authenticated = await fetch(`http://127.0.0.1:${port}/memhub/admin`, { headers: { authorization } });
    assert.equal(authenticated.status, 200);
    const authenticatedHtml = await authenticated.text();
    assertInlineScriptsParse(authenticatedHtml);
    assert.match(authenticatedHtml, /Local token \+ loopback Host/);
    assert.match(authenticatedHtml, /MEMORY CONTROL PLANE/);
    assert.match(authenticatedHtml, /refreshButton\.id="refresh"/);
    assert.match(authenticatedHtml, /id="theme-toggle"/);
    assert.match(authenticatedHtml, /localStorage\.memhubTheme/);
    assert.match(authenticatedHtml, /localStorage\.memhubLang/);
    assert.match(authenticatedHtml, /data-theme="light"/);
    assert.match(authenticatedHtml, /data-view="projects"/);
    assert.match(authenticatedHtml, /function renderOverview/);
    assert.match(authenticatedHtml, /首屏不请求 Memory Core/);
    assert.match(authenticatedHtml, /class="site-header"/);
    assert.match(authenticatedHtml, /class="site-brand"/);
    assert.match(authenticatedHtml, /aria-live="polite"/);
    assert.match(authenticatedHtml, /role="dialog"/);
    assert.match(authenticatedHtml, /refreshButton\.disabled=true/);
    assert.match(authenticatedHtml, /prefers-reduced-motion:reduce/);
    const landing = await fetch(`http://127.0.0.1:${port}/memhub`);
    assert.equal(landing.status, 200);
    const landingHtml = await landing.text();
    assertInlineScriptsParse(landingHtml);
    assert.match(landingHtml, /PROJECT-AWARE LONG-TERM MEMORY/);
    assert.match(landingHtml, /FOUR RELEASE SURFACES/);
    assert.match(landingHtml, /github\.com\/PhSanqi\/Memhub/);
    assert.match(landingHtml, /id="theme-toggle"/);
    assert.match(landingHtml, /id="lang-toggle"/);
    assert.match(landingHtml, /data-zh="项目感知长期记忆"/);
    assert.match(landingHtml, /data-en="Memory that stays connected to the work\."/);
    assert.match(landingHtml, /data-theme="light"/);
    assert.match(landingHtml, /landing-brand site-brand/);
    assert.match(landingHtml, /prefers-reduced-motion:reduce/);
    const workspaceView = await fetch(`http://127.0.0.1:${port}/memhub/user`, { headers: { authorization } });
    assert.equal(workspaceView.status, 200);
    const workspaceHtml = await workspaceView.text();
    assertInlineScriptsParse(workspaceHtml);
    assert.match(workspaceHtml, /data-en="Workspace"/);
    assert.match(workspaceHtml, /data-en="ACCOUNT WORKSPACE"/);
    assert.match(workspaceHtml, /data-en="PROJECT MEMORY"/);
    assert.match(workspaceHtml, /data-en="DEVICE ACCESS"/);
    assert.match(workspaceHtml, /data-en="GOVERNANCE BOUNDARY"/);
    assert.match(workspaceHtml, /class="user-body"/);
    assert.match(workspaceHtml, /id="theme-toggle"/);
    assert.match(workspaceHtml, /id="lang-toggle"/);
    assert.match(workspaceHtml, /localStorage\.memhubTheme/);
    assert.match(workspaceHtml, /localStorage\.memhubLang/);
    assert.match(workspaceHtml, /data-theme="light"/);
    assert.match(workspaceHtml, /class="site-header"/);
    assert.match(workspaceHtml, /class="site-brand"/);
    const projectView = await fetch(`http://127.0.0.1:${port}/memhub/admin/api?kind=projects`, { headers: { authorization } });
    assert.equal(projectView.status, 200);
    const projectPayload = await projectView.json();
    assert.equal(Array.isArray(projectPayload.items), true);
    const tunnelLike = await fetch(`http://127.0.0.1:${port}/memhub/admin`, {
      headers: { authorization, "cf-ray": "test-ray" }
    });
    assert.equal(tunnelLike.status, 401);
    assert.match(await tunnelLike.text(), /Cloudflare Access authentication required/);
    const publicHostWithLocalToken = await rawHttp(port, "/memhub/admin", {
      authorization,
      host: "memhub.example.test"
    });
    assert.equal(publicHostWithLocalToken.status, 401);
    assert.match(publicHostWithLocalToken.body, /Cloudflare Access authentication required/);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => {
      child.once("exit", resolveExit);
      setTimeout(resolveExit, 500);
    });
  }
}

async function testRootBasePath(memoryPort) {
  const port = await freePort();
  const stateRoot = join(root, "root-base-path");
  const account = await addAccount(stateRoot, "root-admin", "root@example.com");
  await setAccountRole(stateRoot, account.account_id, "admin");
  const token = await ensureLocalAdminToken(stateRoot);
  const child = spawn(process.execPath, [
    mcpEntry,
    "--http", String(port),
    "--http-path", "/mcp",
    "--capture-path", "/capture",
    "--account", account.account_id,
    "--memory-url", `http://127.0.0.1:${memoryPort}`,
    "--state-root", stateRoot,
    "--bindings", join(root, "root-base-path-bindings.json"),
    "--no-normify"
  ], {
    env: { ...process.env, MEMHUB_BASE_PATH: "/", MEMHUB_MEMORY_DB: historyDbPath },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => { stderr += data; });
  try {
    const deadline = Date.now() + 5_000;
    while (!stderr.includes("listening on http://127.0.0.1:") && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    const landing = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(landing.status, 200);
    const landingHtml = await landing.text();
    assert.match(landingHtml, /href="\/user"/);
    assert.doesNotMatch(landingHtml, /\/memhub\//);
    const legacyLanding = await fetch(`http://127.0.0.1:${port}/memhub`);
    assert.equal(legacyLanding.status, 404);
    const authorization = `Basic ${Buffer.from(`memhub:${token}`).toString("base64")}`;
    const workspace = await fetch(`http://127.0.0.1:${port}/user`, { headers: { authorization } });
    assert.equal(workspace.status, 200);
    const workspaceHtml = await workspace.text();
    assert.match(workspaceHtml, /href="\/admin"/);
    assert.doesNotMatch(workspaceHtml, /\/memhub\//);
    const admin = await fetch(`http://127.0.0.1:${port}/admin`, { headers: { authorization } });
    assert.equal(admin.status, 200);
    const adminHtml = await admin.text();
    assert.match(adminHtml, /\/admin\/api\?kind=/);
    assert.match(adminHtml, /\/admin\/action/);
    assert.doesNotMatch(adminHtml, /\/memhub\//);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => {
      child.once("exit", resolveExit);
      setTimeout(resolveExit, 500);
    });
  }
}

function rawHttp(port, path, headers = {}) {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path, method: "GET", headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolvePromise({ status: response.statusCode, headers: response.headers, body }));
    });
    request.once("error", reject);
    request.end();
  });
}

async function testStdio(memoryPort) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntry, "--account", "acct-test", "--memory-url", `http://127.0.0.1:${memoryPort}`, "--bindings", join(root, "stdio-bindings.json"), "--no-normify"],
    env: { ...process.env },
    stderr: "pipe"
  });
  const client = new Client({ name: "memhub-stdio-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    await exerciseClient(client, "stdio-chat");
  } finally {
    await client.close();
  }
}

async function testHttp(memoryPort) {
  const port = await freePort();
  const stateRoot = join(root, "state");
  const createdDevice = await createDevice(stateRoot, "acct-test", "test-device");
  const child = spawn(process.execPath, [
    mcpEntry,
    "--http", String(port),
    "--account", "acct-test",
    "--memory-url", `http://127.0.0.1:${memoryPort}`,
    "--state-root", stateRoot,
    "--bindings", join(root, "http-bindings.json"),
    "--no-normify"
  ], { env: { ...process.env, MEMHUB_MEMORY_DB: historyDbPath }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => { stderr += data; });
  try {
    const deadline = Date.now() + 5_000;
    while (!stderr.includes("listening on http://127.0.0.1:") && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    assert.match(stderr, /listening on http:\/\/127\.0\.0\.1:/);
    const client = new Client({ name: "memhub-http-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    try {
      await client.connect(transport);
      await exerciseClient(client, "http-chat");
      const projects = JSON.parse((await client.callTool({ name: "memmy_project", arguments: { action: "list" } })).content[0].text);
      assert.ok(projects.projects.includes("aide"));
      assert.ok(!projects.projects.some((project) => /^ws_[a-f0-9]{32,}$/i.test(project)));
    } finally {
      await client.close();
    }

    const captureEvent = {
      event_id: "capture-http-1",
      host: "coworker",
      host_version: "test",
      conversation_id: "capture-conversation",
      turn_id: "turn-1",
      timestamp: "2026-09-18T08:00:00.000Z",
      project_hint: "aide",
      user_text: "continue implementation",
      assistant_text: "implemented capture protocol"
    };
    const direct = await fetch(`http://127.0.0.1:${port}/memhub/capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createdDevice.token}`
      },
      body: JSON.stringify(captureEvent)
    });
    assert.equal(direct.status, 201);
    const duplicate = await fetch(`http://127.0.0.1:${port}/memhub/capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createdDevice.token}`
      },
      body: JSON.stringify(captureEvent)
    });
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).duplicate, true);
    assert.equal(await countCaptureEvents(stateRoot), 1);
    assert.ok(requests.some((entry) => entry.url === "/api/v1/sessions/open"));
    assert.ok(requests.some((entry) => entry.url?.startsWith("/api/v1/turns/") && entry.url.endsWith("/complete")));

    const completeBeforePartial = requests.filter((entry) => entry.url?.startsWith("/api/v1/turns/") && entry.url.endsWith("/complete")).length;
    const partial = await fetch(`http://127.0.0.1:${port}/memhub/capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createdDevice.token}`
      },
      body: JSON.stringify({
        event_id: "capture-partial-1",
        host: "codex",
        conversation_id: "partial-conversation",
        turn_id: "partial-turn",
        timestamp: "2026-09-18T08:01:00.000Z",
        user_text: "user side only"
      })
    });
    assert.equal(partial.status, 201);
    const partialBody = await partial.json();
    assert.equal(partialBody.ingestion.ingested, false);
    assert.equal(partialBody.ingestion.reason, "incomplete_turn_requires_user_and_assistant_text");
    assert.equal(await countCaptureEvents(stateRoot), 2);
    assert.equal(
      requests.filter((entry) => entry.url?.startsWith("/api/v1/turns/") && entry.url.endsWith("/complete")).length,
      completeBeforePartial
    );

    const completedPartial = await fetch(`http://127.0.0.1:${port}/memhub/capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createdDevice.token}`
      },
      body: JSON.stringify({
        event_id: "capture-partial-1",
        host: "codex",
        conversation_id: "partial-conversation",
        turn_id: "partial-turn",
        timestamp: "2026-09-18T08:01:05.000Z",
        project_hint: "aide",
        assistant_text: "assistant side later"
      })
    });
    assert.equal(completedPartial.status, 200);
    const completedPartialBody = await completedPartial.json();
    assert.equal(completedPartialBody.updated, true);
    assert.equal(completedPartialBody.ingestion.ingested, true);
    assert.equal(completedPartialBody.ingestion.project_id, "aide");
    assert.equal(await countCaptureEvents(stateRoot), 2);
    assert.equal(
      requests.filter((entry) => entry.url?.startsWith("/api/v1/turns/") && entry.url.endsWith("/complete")).length,
      completeBeforePartial + 1
    );

    const historyClient = new Client({ name: "memhub-history-distill-test", version: "1.0.0" });
    const historyTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    try {
      await historyClient.connect(historyTransport);
      const started = JSON.parse((await historyClient.callTool({
        name: "memhub_history_distill",
        arguments: { action: "start", scope: "project", project: "aide", target: "memory", source_harness: "test-harness" }
      })).content[0].text);
      assert.equal(started.created, true);
      assert.ok(started.fresh_count >= 3);
      const firstNext = JSON.parse((await historyClient.callTool({
        name: "memhub_history_distill",
        arguments: { action: "next", run_id: started.run.run_id, source_harness: "test-harness" }
      })).content[0].text);
      assert.equal(firstNext.batch.target, "memory");
      assert.equal(firstNext.batch.continuation.prior_memory_document, undefined);
      assert.ok(firstNext.batch.evidence.some((item) => item.ref === "memory:history-project-memory-1"));
      assert.ok(firstNext.batch.evidence.some((item) => item.ref.startsWith("capture:")));
      const firstSubmit = JSON.parse((await historyClient.callTool({
        name: "memhub_history_distill",
        arguments: {
          action: "submit",
          run_id: started.run.run_id,
          batch_hash: firstNext.batch.batch_hash,
          source_harness: "test-harness",
          memory: historyMemoryDocument("Aide canonical history", "Cumulative project history after the first evidence batch.")
        }
      })).content[0].text);
      assert.equal(firstSubmit.ok, true);
      assert.equal(firstSubmit.run.status, "completed");

      const repeated = JSON.parse((await historyClient.callTool({
        name: "memhub_history_distill",
        arguments: { action: "start", scope: "project", project: "aide", target: "memory" }
      })).content[0].text);
      assert.equal(repeated.fresh_count, 0);
      assert.equal(repeated.run, null);

      const db = new Database(historyDbPath);
      db.prepare(`
        INSERT INTO memories (
          id, user_id, conversation_id, memory_value, memory_layer, tags_json, info_json, properties_json,
          created_at, updated_at, deleted_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'activated')
      `).run(
        "history-project-memory-2", historyUserId, "later-project-chat", "Later project decision that must extend prior canonical history",
        "L1", JSON.stringify(["project:aide"]), JSON.stringify({ project_id: "aide" }), "{}",
        "2026-09-18T09:00:00.000Z", "2026-09-18T09:00:00.000Z"
      );
      db.close();

      const continued = JSON.parse((await historyClient.callTool({
        name: "memhub_history_distill",
        arguments: { action: "start", scope: "project", project: "aide", target: "memory" }
      })).content[0].text);
      assert.equal(continued.fresh_count, 1);
      const continuedNext = JSON.parse((await historyClient.callTool({
        name: "memhub_history_distill",
        arguments: { action: "next", run_id: continued.run.run_id, source_harness: "test-harness" }
      })).content[0].text);
      assert.match(continuedNext.batch.continuation.prior_memory_document, /Cumulative project history after the first evidence batch/);
      assert.deepEqual(continuedNext.batch.evidence.map((item) => item.ref), ["memory:history-project-memory-2"]);
      const continuedSubmit = JSON.parse((await historyClient.callTool({
        name: "memhub_history_distill",
        arguments: {
          action: "submit",
          run_id: continued.run.run_id,
          batch_hash: continuedNext.batch.batch_hash,
          source_harness: "test-harness",
          memory: historyMemoryDocument("Aide canonical history", "Updated cumulative project history preserving prior truth and adding the later decision.")
        }
      })).content[0].text);
      assert.equal(continuedSubmit.run.status, "completed");

      const skillStarted = JSON.parse((await historyClient.callTool({
        name: "memhub_history_distill",
        arguments: { action: "start", scope: "project", project: "aide", target: "skill" }
      })).content[0].text);
      assert.ok(skillStarted.fresh_count >= 4);
      const skillNext = JSON.parse((await historyClient.callTool({
        name: "memhub_history_distill",
        arguments: { action: "next", run_id: skillStarted.run.run_id, source_harness: "test-harness" }
      })).content[0].text);
      const skillSubmit = JSON.parse((await historyClient.callTool({
        name: "memhub_history_distill",
        arguments: {
          action: "submit",
          run_id: skillStarted.run.run_id,
          batch_hash: skillNext.batch.batch_hash,
          source_harness: "test-harness",
          skills: [historySkillDocument("Verify capture ingestion")]
        }
      })).content[0].text);
      assert.equal(skillSubmit.ok, true);
      assert.equal(skillSubmit.skills.length, 1);
      const skillRepeated = JSON.parse((await historyClient.callTool({
        name: "memhub_history_distill",
        arguments: { action: "start", scope: "project", project: "aide", target: "skill" }
      })).content[0].text);
      assert.equal(skillRepeated.fresh_count, 0);

      const accountStarted = JSON.parse((await historyClient.callTool({
        name: "memhub_history_distill",
        arguments: { action: "start", scope: "account", target: "memory" }
      })).content[0].text);
      assert.equal(accountStarted.created, true);
      const accountNext = JSON.parse((await historyClient.callTool({
        name: "memhub_history_distill",
        arguments: { action: "next", run_id: accountStarted.run.run_id, source_harness: "test-harness" }
      })).content[0].text);
      assert.doesNotMatch(JSON.stringify(accountNext.batch.evidence), /DO NOT LEAK OTHER ACCOUNT MEMORY/);
      assert.ok(accountNext.batch.evidence.some((item) => item.ref === "memory:history-project-memory-1"));
    } finally {
      await historyClient.close();
    }

    assert.equal((await listDistillationJobs(stateRoot, "acct-test")).length, 0);
    const capturesForDistillation = await listCaptureEvents(stateRoot, "acct-test");
    const queued = await enqueueDistillationJob({
      stateRoot,
      accountId: "acct-test",
      projectId: "aide",
      conversationId: "partial-conversation",
      captures: capturesForDistillation.filter((item) => item.conversation_id === "partial-conversation" && item.ingested),
      reason: "manual"
    });
    assert.equal(queued.created, true);
    const distillClient = new Client({ name: "memhub-distill-job-test", version: "1.0.0" });
    const distillTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    try {
      await distillClient.connect(distillTransport);
      const next = await distillClient.callTool({
        name: "memhub_distill",
        arguments: { action: "next", scope: "project", project: "aide", source_harness: "test-harness" }
      });
      const nextPayload = JSON.parse(next.content[0].text);
      assert.equal(nextPayload.job.job_id, queued.job.job_id);
      assert.equal(nextPayload.job.evidence.length, 1);
      assert.equal(nextPayload.job.evidence[0].user_text, "user side only");
      const skipped = await distillClient.callTool({
        name: "memhub_distill",
        arguments: { action: "skip", job_id: queued.job.job_id }
      });
      assert.equal(JSON.parse(skipped.content[0].text).skipped, true);
    } finally {
      await distillClient.close();
    }
    const completedJob = (await listDistillationJobs(stateRoot, "acct-test")).find((item) => item.job_id === queued.job.job_id);
    assert.equal(completedJob.status, "completed");
    assert.equal(completedJob.result_kind, "noop");

    const retrySource = capturesForDistillation.filter((item) => item.conversation_id === "capture-conversation" && item.ingested);
    const retryQueued = await enqueueDistillationJob({
      stateRoot,
      accountId: "acct-test",
      projectId: "aide",
      conversationId: "capture-conversation",
      captures: retrySource,
      reason: "manual"
    });
    const retryLeased = await leaseDistillationJob(stateRoot, "acct-test", { projectId: "aide", harness: "retry-test" });
    assert.equal(retryLeased.job_id, retryQueued.job.job_id);
    assert.equal(retryLeased.attempts, 1);
    await failDistillationJob(stateRoot, "acct-test", retryLeased.job_id, "simulated commit failure");
    const failedJob = (await listDistillationJobs(stateRoot, "acct-test")).find((item) => item.job_id === retryLeased.job_id);
    assert.equal(failedJob.status, "failed");
    assert.match(failedJob.failure, /simulated commit failure/);
    const duplicateAfterFailure = await enqueueDistillationJob({
      stateRoot,
      accountId: "acct-test",
      projectId: "aide",
      conversationId: "capture-conversation",
      captures: retrySource,
      reason: "manual"
    });
    assert.equal(duplicateAfterFailure.created, false);
    assert.equal(duplicateAfterFailure.job.job_id, retryLeased.job_id);
    const retried = await retryDistillationJob(stateRoot, "acct-test", retryLeased.job_id);
    assert.equal(retried.status, "pending");
    assert.equal(retried.evidence_hash, retryLeased.evidence_hash);
    assert.equal(retried.failure, undefined);

    const bridgeRoot = join(root, "bridge");
    const queue = new MemhubBridgeQueue(bridgeRoot);
    await saveBridgeConfig(bridgeRoot, {
      captureEndpoint: "http://127.0.0.1:9/memhub/capture",
      deviceToken: createdDevice.token
    });
    await queue.enqueue({ ...captureEvent, event_id: "capture-queued-1", turn_id: "turn-2" });
    const offline = await queue.flush(await (await import("../dist/bridge.js")).loadBridgeConfig(bridgeRoot));
    assert.equal(offline.sent, 0);
    assert.equal(offline.pending, 1);
    assert.ok(offline.stopped_on_error);
    await saveBridgeConfig(bridgeRoot, {
      captureEndpoint: `http://127.0.0.1:${port}/memhub/capture`,
      deviceToken: createdDevice.token
    });
    const replay = await queue.flush(await (await import("../dist/bridge.js")).loadBridgeConfig(bridgeRoot));
    assert.equal(replay.sent, 1);
    assert.equal(replay.pending, 0);
    assert.equal(await countCaptureEvents(stateRoot), 3);

    await saveBridgeConfig(bridgeRoot, {
      mcpEndpoint: `http://127.0.0.1:${port}/mcp`,
      captureEndpoint: `http://127.0.0.1:${port}/memhub/capture`,
      deviceToken: createdDevice.token
    });
    const bridgePort = await freePort();
    const bridgeChild = spawn(process.execPath, [bridgeEntry, "serve", "--port", String(bridgePort)], {
      env: { ...process.env, MEMHUB_BRIDGE_HOME: bridgeRoot },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let bridgeStderr = "";
    bridgeChild.stderr.setEncoding("utf8");
    bridgeChild.stderr.on("data", (data) => { bridgeStderr += data; });
    try {
      const bridgeDeadline = Date.now() + 5_000;
      while (!bridgeStderr.includes("[memhub-bridge] listening") && Date.now() < bridgeDeadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      assert.match(bridgeStderr, /\[memhub-bridge\] listening/);
      const bridgeClient = new Client({ name: "memhub-bridge-mcp-test", version: "1.0.0" });
      const bridgeTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${bridgePort}/mcp`));
      try {
        await bridgeClient.connect(bridgeTransport);
        const bridgeTools = await bridgeClient.listTools();
        assert.deepEqual(bridgeTools.tools.map((tool) => tool.name).sort(), ["memhub_distill", "memhub_evolution", "memhub_history_distill", "memmy_context", "memmy_project", "memmy_project_list", "memmy_project_manage", "memmy_remember"]);
        const bridgeContext = await bridgeClient.callTool({
          name: "memmy_context",
          arguments: { query: "continue through local bridge", project: "aide", conversation_id: "bridge-proxy-chat" }
        });
        assert.equal(bridgeContext.isError, undefined);
        assert.equal(JSON.parse(bridgeContext.content[0].text).resolvedProjectId, "aide");
        const automaticContext = await fetch(`http://127.0.0.1:${bridgePort}/context`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "continue aide", conversation_id: "bridge-proxy-chat", project: "aide", limit: 12 })
        });
        assert.equal(automaticContext.status, 200);
        const automaticContextBody = await automaticContext.json();
        assert.equal(automaticContextBody.resolvedProjectId, "aide");
        assert.equal(automaticContextBody.recallScope, "global_and_project");
      } finally {
        await bridgeClient.close();
      }
    } finally {
      bridgeChild.kill("SIGTERM");
      await new Promise((resolveExit) => {
        bridgeChild.once("exit", resolveExit);
        setTimeout(resolveExit, 500);
      });
    }
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => {
      child.once("exit", resolveExit);
      setTimeout(resolveExit, 500);
    });
  }
}

function acceptIdempotent(body, operation, response) {
  if (typeof body.requestId !== "string" || !body.requestId) return true;
  const key = `${operation}:${body.adapterId ?? ""}:${body.requestId}`;
  const serialized = JSON.stringify(body);
  const previous = idempotency.get(key);
  if (previous !== undefined && previous !== serialized) {
    response.statusCode = 409;
    response.end(JSON.stringify({ error: "idempotency conflict" }));
    return false;
  }
  idempotency.set(key, serialized);
  return true;
}

function historyMemoryDocument(title, overview) {
  return {
    title,
    overview,
    who: ["Project owner and connected AI harnesses"],
    what: ["Memhub capture, memory and distillation lifecycle"],
    where: ["Project aide and its Memhub account-scoped storage"],
    when: ["Evidence spans the dated source turns supplied in this batch"],
    why: ["Preserve durable project context without reprocessing already distilled evidence"],
    how: ["Capture complete turns, preserve provenance, then update the cumulative canonical memory"],
    decisions: ["Use explicit project scope and stable evidence references"],
    constraints: ["Do not mix account or project scopes"],
    preferences: ["Prefer comprehensive evidence-grounded memory"],
    relationships: ["Raw captures feed project history distillation"],
    current_truth: ["The current document supersedes the previous canonical project-history document"],
    legacy: [],
    unknowns: [],
    provenance: ["Derived only from the supplied Memhub evidence refs"]
  };
}

function historySkillDocument(title) {
  return {
    title,
    purpose: "Reusable procedure for validating Memhub capture ingestion.",
    when_to_use: ["After changing capture or ingestion behavior"],
    prerequisites: ["Memhub services are running"],
    inputs: ["A complete captured user/assistant turn"],
    procedure: ["Submit the turn", "Verify raw capture state", "Verify Memory Core ingestion"],
    verification: ["Capture is marked ingested and the corresponding turn exists"],
    failure_modes: ["Partial turns remain pending", "Bridge failures stay queued"],
    boundaries: ["Do not treat capture as semantic distillation"],
    reusable_principles: ["Preserve raw evidence before semantic abstraction"],
    provenance: ["Derived from the supplied project-history evidence"]
  };
}

async function exerciseClient(client, conversationId) {
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["memhub_distill", "memhub_evolution", "memhub_history_distill", "memmy_context", "memmy_project", "memmy_project_list", "memmy_project_manage", "memmy_remember"]);
  assert.match(listed.tools.find((tool) => tool.name === "memmy_context")?.description ?? "", /先用本工具.*conversation_id.*memmy_project action=current/);
  assert.match(listed.tools.find((tool) => tool.name === "memmy_project")?.description ?? "", /先完成 memmy_context.*action=current/);
  assert.match(listed.tools.find((tool) => tool.name === "memmy_project_list")?.description ?? "", /description.*禁止盲目新建/);
  assert.match(listed.tools.find((tool) => tool.name === "memmy_project_manage")?.description ?? "", /action=plan.*明确授权.*action=execute/);
  let projectList = JSON.parse((await client.callTool({ name: "memmy_project_list", arguments: { query: "AIDE" } })).content[0].text);
  if (!projectList.projects.some((project) => project.project === "aide")) {
    const createPlan = JSON.parse((await client.callTool({
      name: "memmy_project_manage",
      arguments: {
        action: "plan",
        operation: "create",
        project: "aide",
        description: "AIDE project used by MCP integration tests."
      }
    })).content[0].text);
    assert.equal(createPlan.status, "awaiting_user_authorization");
    const createResult = JSON.parse((await client.callTool({
      name: "memmy_project_manage",
      arguments: { action: "execute", authorization_id: createPlan.authorization_id }
    })).content[0].text);
    assert.equal(createResult.ok, true);
    projectList = JSON.parse((await client.callTool({ name: "memmy_project_list", arguments: { query: "AIDE" } })).content[0].text);
  }
  assert.ok(projectList.projects.some((project) => project.project === "aide"));
  assert.equal(projectList.matches[0]?.project, "aide");
  const unresolved = JSON.parse((await client.callTool({
    name: "memmy_context",
    arguments: { query: "continue the AIDEE work", project: "aidee", conversation_id: conversationId + "-unknown" }
  })).content[0].text);
  assert.equal(unresolved.resolvedProjectId, null);
  assert.equal(unresolved.recallScope, "global_only");
  assert.ok(unresolved.projectCandidates.some((project) => project.project === "aide"));
  const updatePlanResult = await client.callTool({
    name: "memmy_project_manage",
    arguments: {
      action: "plan",
      operation: "update",
      project: "aide",
      description: "AIDE project used by MCP integration tests."
    }
  });
  const updatePlan = JSON.parse(updatePlanResult.content[0].text);
  assert.equal(updatePlan.status, "awaiting_user_authorization");
  const updateResult = await client.callTool({
    name: "memmy_project_manage",
    arguments: { action: "execute", authorization_id: updatePlan.authorization_id }
  });
  assert.equal(JSON.parse(updateResult.content[0].text).ok, true);
  const replayedAuthorization = await client.callTool({
    name: "memmy_project_manage",
    arguments: { action: "execute", authorization_id: updatePlan.authorization_id }
  });
  assert.match(replayedAuthorization.content[0].text, /invalid or already-used project authorization/);
  const updatedList = JSON.parse((await client.callTool({ name: "memmy_project_list", arguments: { query: "aide" } })).content[0].text);
  assert.match(updatedList.projects.find((project) => project.project === "aide")?.description ?? "", /integration tests/);
  await client.callTool({ name: "memmy_project", arguments: { action: "bind", conversation_id: conversationId, project: "aide" } });
  const context = await client.callTool({ name: "memmy_context", arguments: { query: "continue", conversation_id: conversationId } });
  const capsule = JSON.parse(context.content[0].text);
  assert.equal(capsule.resolvedProjectId, "aide");
  assert.equal(capsule.globalMemory.length, 1);
  assert.equal(capsule.projectMemory.length, 1);
  await client.callTool({ name: "memmy_remember", arguments: { content: "keep local", scope: "project", conversation_id: conversationId } });
  const lastWrite = [...requests].reverse().find((entry) => entry.url === "/api/v1/memory/add");
  assert.equal(lastWrite.body.namespace.projectId, "aide");
  assert.equal(lastWrite.body.namespace.tenantId, "acct-test");
  assert.equal(lastWrite.body.source, "memhub:local:local");

  const contractResult = await client.callTool({
    name: "memhub_distill",
    arguments: { inspect_contract: true }
  });
  const contractPayload = JSON.parse(contractResult.content[0].text);
  assert.equal(contractPayload.contract.version, "memhub-distill-v1");
  assert.equal(contractPayload.contract.executor, "connected_mcp_or_harness_model");

  const writesBeforeDryRun = requests.filter((entry) => entry.url === "/api/v1/memory/add").length;
  const dryRun = await client.callTool({
    name: "memhub_distill",
    arguments: {
      kind: "knowledge",
      scope: "global",
      content: "Durable evidence-backed knowledge.",
      evidence_refs: ["raw:dry-run"],
      dry_run: true
    }
  });
  assert.equal(JSON.parse(dryRun.content[0].text).dryRun, true);
  assert.equal(requests.filter((entry) => entry.url === "/api/v1/memory/add").length, writesBeforeDryRun);

  await client.callTool({
    name: "memhub_distill",
    arguments: {
      kind: "skill",
      scope: "project",
      conversation_id: conversationId,
      title: "AIDE reconnect workflow",
      content: "Use this when AIDE reconnect fails. Inspect state, repair the bridge, then verify reconnection.",
      source_harness: "codex",
      artifact_id: "aide-reconnect-v1",
      version: "1",
      evidence_refs: ["raw:test-turn"],
      source_conversations: [conversationId],
      confidence: 0.9
    }
  });
  const skillWrite = [...requests].reverse().find((entry) => entry.url === "/api/v1/memory/add");
  assert.equal(skillWrite.body.layer, "Skill");
  assert.equal(skillWrite.body.namespace.projectId, "aide");
  assert.equal(skillWrite.body.namespace.tenantId, "acct-test");
  assert.equal(skillWrite.body.sourceAgentId, "codex");
  assert.equal(skillWrite.body.sourceSkillId, "aide-reconnect-v1");
  assert.equal(skillWrite.body.sourceSkillVersion, "1");
  assert.ok(skillWrite.body.tags.includes("artifact:skill"));
  assert.ok(skillWrite.body.tags.includes("project:aide"));
  assert.ok(skillWrite.body.tags.includes("distill-contract:memhub-distill-v1"));
  assert.ok(skillWrite.body.tags.includes("evidence:raw:test-turn"));
  assert.ok(skillWrite.body.tags.includes(`source-conversation:${conversationId}`));
  assert.equal(typeof skillWrite.body.requestId, "string");

  const summaryArgs = {
    kind: "summary",
    scope: "global",
    title: `Cross-project working style ${conversationId}`,
    content: "Prefer one shared private memory service with project isolation.",
    source_harness: "codex",
    artifact_id: `working-style-${conversationId}`
  };
  await client.callTool({ name: "memhub_distill", arguments: summaryArgs });
  await client.callTool({ name: "memhub_distill", arguments: summaryArgs });
  const summaryWrites = requests.filter((entry) =>
    entry.url === "/api/v1/memory/add" &&
    entry.body?.sourceSkillId === undefined &&
    entry.body?.title === `Cross-project working style ${conversationId}`
  );
  assert.equal(summaryWrites.length, 2);
  assert.equal(summaryWrites.at(-1).body.layer, "L1");
  assert.equal(summaryWrites.at(-1).body.namespace.projectId, undefined);
  assert.ok(summaryWrites.at(-1).body.tags.includes("artifact:summary"));
  assert.equal(summaryWrites.at(-1).body.requestId, summaryWrites.at(-2).body.requestId);

  const nextEvolution = await client.callTool({
    name: "memhub_evolution",
    arguments: {
      action: "next",
      scope: "project",
      conversation_id: conversationId,
      lease_seconds: 120
    }
  });
  assert.equal(nextEvolution.isError, undefined);
  const evolutionEnvelope = JSON.parse(nextEvolution.content[0].text);
  const evolutionJob = evolutionEnvelope.result.job;
  assert.equal(evolutionEnvelope.project, "aide");
  assert.equal(evolutionJob.projectId, "aide");
  assert.equal(evolutionJob.targetField, "project_contract");
  assert.equal(evolutionJob.expectedFieldHash, "field-hash");
  assert.equal(evolutionJob.expectedProfileHash, "profile-hash");
  const leaseRequest = [...requests].reverse().find((entry) => entry.url === "/api/v1/evolution/l3/lease");
  assert.equal(leaseRequest.body.projectId, "aide");
  assert.equal(leaseRequest.body.namespace.projectId, "aide");
  assert.equal(leaseRequest.body.namespace.tenantId, "acct-test");

  const submitEvolution = await client.callTool({
    name: "memhub_evolution",
    arguments: {
      action: "submit",
      scope: "project",
      conversation_id: conversationId,
      job_id: evolutionJob.jobId,
      expected_field_hash: evolutionJob.expectedFieldHash,
      expected_profile_hash: evolutionJob.expectedProfileHash,
      candidate: {
        reason: "Durable project delivery rule.",
        op: "create",
        project_contract: "- Run project tests before commit."
      }
    }
  });
  assert.equal(submitEvolution.isError, undefined);
  const submitEnvelope = JSON.parse(submitEvolution.content[0].text);
  assert.equal(submitEnvelope.result.ok, true);
  assert.equal(submitEnvelope.result.projectId, "aide");
  const submitRequest = [...requests].reverse().find((entry) => /^\/api\/v1\/evolution\/l3\/[^/]+\/submit$/.test(entry.url ?? ""));
  assert.equal(submitRequest.body.projectId, "aide");
  assert.equal(submitRequest.body.namespace.projectId, "aide");
  assert.equal(submitRequest.body.expectedFieldHash, "field-hash");
  assert.equal(submitRequest.body.expectedProfileHash, "profile-hash");
  assert.equal(submitRequest.body.candidate.project_contract, "- Run project tests before commit.");
}

function hit(id, snippet, tags = []) {
  return { id, kind: "trace", memoryLayer: "L1", status: "activated", snippet, score: 0.9, tags, source: "search" };
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
