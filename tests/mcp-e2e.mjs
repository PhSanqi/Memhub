import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  retryDistillationJob,
  setDistillationConfig
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
const memoryIdempotency = new Map();
const memoryRecords = new Map();
const memoryById = new Map();
let memorySequence = 0;
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
    const idempotencyKey = typeof body.requestId === "string" && body.requestId
      ? `memory.add:${body.adapterId ?? ""}:${body.requestId}`
      : undefined;
    const serialized = JSON.stringify(body);
    if (idempotencyKey && memoryIdempotency.has(idempotencyKey)) {
      const previous = memoryIdempotency.get(idempotencyKey);
      if (previous.serialized !== serialized) {
        response.statusCode = 409;
        response.end(JSON.stringify({ error: "idempotency conflict" }));
        return;
      }
      response.end(JSON.stringify({ ...previous.response, duplicate: true }));
      return;
    }
    const memoryKey = [
      body.namespace?.tenantId ?? "",
      body.namespace?.projectId ?? "global",
      body.layer ?? "L1",
      body.sourceArtifactId ?? body.sourceSkillId ?? body.title ?? body.content
    ].join("\0");
    const prior = memoryRecords.get(memoryKey);
    const id = prior?.id ?? `memory-${++memorySequence}`;
    const record = {
      id,
      memoryLayer: body.layer ?? "L1",
      status: "activated",
      title: body.title,
      summary: String(body.content ?? "").split(/\r?\n/, 1)[0],
      body: body.content,
      tags: Array.isArray(body.tags) ? body.tags : [],
      namespace: body.namespace,
      version: (prior?.version ?? 0) + 1
    };
    memoryRecords.set(memoryKey, record);
    memoryById.set(id, record);
    const result = { id, status: "activated", memoryLayer: record.memoryLayer };
    if (idempotencyKey) memoryIdempotency.set(idempotencyKey, { serialized, response: result });
    response.end(JSON.stringify(result));
    return;
  }
  const viewerPath = (request.url ?? "").split("?")[0];
  const viewerUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const memoryGet = /^\/api\/v1\/memory\/([^/]+)$/.exec(viewerPath);
  if (request.method === "GET" && memoryGet) {
    const item = memoryById.get(decodeURIComponent(memoryGet[1]));
    if (!item) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    response.end(JSON.stringify(item));
    return;
  }
  if (request.method === "GET" && [
    "/api/v1/overview", "/api/v1/l1", "/api/v1/l2", "/api/v1/l3", "/api/v1/l4", "/api/v1/skills"
  ].includes(viewerPath)) {
    if (viewerPath === "/api/v1/overview") {
      response.end(JSON.stringify({ metrics: { memories: memoryById.size } }));
      return;
    }
    const layer = viewerPath === "/api/v1/skills" ? "Skill" : viewerPath.slice("/api/v1/".length).toUpperCase();
    const userId = viewerUrl.searchParams.get("userId");
    const projectId = viewerUrl.searchParams.get("projectId");
    const items = [...memoryById.values()]
      .filter((item) => item.memoryLayer === layer)
      .filter((item) => !userId || item.namespace?.userId === userId)
      .filter((item) => !projectId || item.namespace?.projectId === projectId);
    response.end(JSON.stringify({ items, total: items.length }));
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
    assert.equal(authenticated.headers.get("x-frame-options"), "DENY");
    assert.match(authenticated.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(authenticated.headers.get("referrer-policy"), "no-referrer");
    const authenticatedHtml = await authenticated.text();
    assertInlineScriptsParse(authenticatedHtml);
    assert.match(authenticatedHtml, /Local token \+ loopback Host/);
    assert.match(authenticatedHtml, /MEMORY CONTROL PLANE/);
    assert.match(authenticatedHtml, /id="refresh"/);
    assert.match(authenticatedHtml, /id="theme-toggle"/);
    assert.match(authenticatedHtml, /localStorage\.memhubTheme/);
    assert.match(authenticatedHtml, /localStorage\.memhubLang/);
    assert.match(authenticatedHtml, /data-theme="dark"/);
    assert.match(authenticatedHtml, /data-view="projects"/);
    assert.match(authenticatedHtml, /data-view="l1"/);
    assert.match(authenticatedHtml, /data-view="l2"/);
    assert.match(authenticatedHtml, /data-view="l3"/);
    assert.match(authenticatedHtml, /data-view="l4"/);
    assert.match(authenticatedHtml, /data-view="skills"/);
    assert.match(authenticatedHtml, /data-view="processing"/);
    assert.match(authenticatedHtml, /id="account-select"/);
    assert.match(authenticatedHtml, /id="memory-flow"/);
    assert.match(authenticatedHtml, /id="primary-action"/);
    assert.match(authenticatedHtml, /class="nav-group"/);
    assert.match(authenticatedHtml, /class="project-card"/);
    assert.match(authenticatedHtml, /class="policy-card"/);
    assert.match(authenticatedHtml, /create-project/);
    assert.match(authenticatedHtml, /set-distillation-config/);
    assert.doesNotMatch(authenticatedHtml, /data-view="captures"/);
    assert.doesNotMatch(authenticatedHtml, /data-view="episodes"/);
    assert.match(authenticatedHtml, /function renderOverview/);
    assert.match(authenticatedHtml, /class="site-header"/);
    assert.match(authenticatedHtml, /class="site-brand"/);
    assert.match(authenticatedHtml, /aria-live="polite"/);
    assert.match(authenticatedHtml, /role="dialog"/);
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
    assert.match(workspaceHtml, /data-en="My long-term memory"/);
    assert.match(workspaceHtml, /data-view="l1"/);
    assert.match(workspaceHtml, /data-view="l2"/);
    assert.match(workspaceHtml, /data-view="l3"/);
    assert.match(workspaceHtml, /data-view="l4"/);
    assert.match(workspaceHtml, /data-view="skills"/);
    assert.match(workspaceHtml, /data-view="processing"/);
    assert.doesNotMatch(workspaceHtml, /id="account-select"/);
    assert.doesNotMatch(workspaceHtml, /DEVICE ACCESS/);
    assert.doesNotMatch(workspaceHtml, /data-view="captures"/);
    assert.doesNotMatch(workspaceHtml, /data-view="episodes"/);
    assert.match(workspaceHtml, /class="admin-body memory-console-body"/);
    assert.match(workspaceHtml, /id="theme-toggle"/);
    assert.match(workspaceHtml, /id="lang"/);
    assert.match(workspaceHtml, /localStorage\.memhubTheme/);
    assert.match(workspaceHtml, /localStorage\.memhubLang/);
    assert.match(workspaceHtml, /data-theme="dark"/);
    assert.match(workspaceHtml, /class="site-header"/);
    assert.match(workspaceHtml, /class="site-brand"/);
    const projectView = await fetch(`http://127.0.0.1:${port}/memhub/admin/api?kind=projects`, { headers: { authorization } });
    assert.equal(projectView.status, 200);
    const projectPayload = await projectView.json();
    assert.equal(Array.isArray(projectPayload.items), true);
    const adminAction = async (body) => fetch(`http://127.0.0.1:${port}/memhub/admin/action`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const createAlpha = await adminAction({
      action: "create-project",
      project: "ui-alpha",
      name: "UI Alpha",
      description: "Project created by Control Plane E2E.",
      aliases: ["Alpha UI"]
    });
    assert.equal(createAlpha.status, 200);
    const createBeta = await adminAction({
      action: "create-project",
      project: "ui-beta",
      name: "UI Beta",
      description: "Merge target for Control Plane E2E.",
      aliases: []
    });
    assert.equal(createBeta.status, 200);
    const updateAlpha = await adminAction({
      action: "update-project",
      project: "ui-alpha",
      name: "UI Alpha Updated",
      description: "Updated through the Admin Control Plane.",
      aliases: ["Alpha UI", "Alpha Updated"]
    });
    assert.equal(updateAlpha.status, 200);
    const mergeAlpha = await adminAction({ action: "merge-project", project: "ui-alpha", target: "ui-beta" });
    assert.equal(mergeAlpha.status, 200);
    const createDelete = await adminAction({
      action: "create-project",
      project: "ui-delete",
      description: "Disposable Control Plane project.",
      aliases: []
    });
    assert.equal(createDelete.status, 200);
    const deleteProject = await adminAction({ action: "delete-project", project: "ui-delete" });
    assert.equal(deleteProject.status, 200);
    const projectsAfterMutations = await fetch(`http://127.0.0.1:${port}/memhub/admin/api?kind=projects`, { headers: { authorization } });
    const projectsAfterPayload = await projectsAfterMutations.json();
    const mergedTarget = projectsAfterPayload.items.find((item) => item.project_id === "ui-beta");
    assert.ok(mergedTarget);
    assert.ok(mergedTarget.aliases.includes("ui-alpha"));
    assert.equal(projectsAfterPayload.items.some((item) => item.project_id === "ui-alpha"), false);
    assert.equal(projectsAfterPayload.items.some((item) => item.project_id === "ui-delete"), false);
    const userProjectMutation = await fetch(`http://127.0.0.1:${port}/memhub/user/action`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ action: "create-project", project: "forbidden-user-project", description: "must fail" })
    });
    assert.equal(userProjectMutation.status, 403);
    const nonJsonAdminMutation = await fetch(`http://127.0.0.1:${port}/memhub/admin/action`, {
      method: "POST",
      headers: { authorization, "content-type": "text/plain" },
      body: JSON.stringify({ action: "set-distillation-config", auto_enabled: true })
    });
    assert.equal(nonJsonAdminMutation.status, 415);
    const processingBefore = await fetch(`http://127.0.0.1:${port}/memhub/admin/api?kind=processing`, { headers: { authorization } });
    assert.equal(processingBefore.status, 200);
    assert.deepEqual((await processingBefore.json()).config, { auto_enabled: false, turn_threshold: 8, idle_minutes: 30 });
    const updatePolicy = await adminAction({ action: "set-distillation-config", auto_enabled: true, turn_threshold: 12, idle_minutes: 45 });
    assert.equal(updatePolicy.status, 200);
    const processingAfter = await fetch(`http://127.0.0.1:${port}/memhub/admin/api?kind=processing`, { headers: { authorization } });
    assert.deepEqual((await processingAfter.json()).config, { auto_enabled: true, turn_threshold: 12, idle_minutes: 45 });
    const userOverview = await fetch(`http://127.0.0.1:${port}/memhub/user/api?kind=overview`, { headers: { authorization } });
    assert.equal(userOverview.status, 200);
    assert.equal((await userOverview.json()).account.account_id, account.account_id);
    const hiddenLegacyView = await fetch(`http://127.0.0.1:${port}/memhub/admin/api?kind=captures`, { headers: { authorization } });
    assert.equal(hiddenLegacyView.status, 400);
    const accountsView = await fetch(`http://127.0.0.1:${port}/memhub/admin/api?kind=accounts`, { headers: { authorization } });
    assert.equal(accountsView.status, 200);
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
    assert.match(adminHtml, /\/admin\/api/);
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
  const stateRoot = join(root, "stdio-state");
  const architectureDir = join(root, "normify-aide", "modules", "aide");
  await mkdir(architectureDir, { recursive: true });
  await writeFile(
    join(architectureDir, "core.md"),
    "# AIDE Core Architecture\n\nBroker routes work to the harness router. Current constraint: preserve explicit workspace ownership.\n"
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntry, "--account", "acct-test", "--memory-url", `http://127.0.0.1:${memoryPort}`, "--state-root", stateRoot, "--bindings", join(root, "stdio-bindings.json"), "--normify-root", root],
    env: { ...process.env },
    stderr: "pipe"
  });
  const client = new Client({ name: "memhub-stdio-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    await exerciseClient(client, "stdio-chat", stateRoot);
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
      await exerciseClient(client, "http-chat", stateRoot);
      const projects = JSON.parse((await client.callTool({ name: "memmy_project", arguments: { action: "list" } })).content[0].text);
      assert.ok(projects.projects.includes("aide"));
      assert.ok(!projects.projects.some((project) => /^ws_[a-f0-9]{32,}$/i.test(project)));
    } finally {
      await client.close();
    }

    const captureCountBaseline = await countCaptureEvents(stateRoot);
    const distillationCountBaseline = (await listDistillationJobs(stateRoot, "acct-test")).length;

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
    assert.equal(await countCaptureEvents(stateRoot), captureCountBaseline + 1);
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
    assert.equal(partialBody.ingestion.reason, "turn_not_complete:open");
    assert.equal(await countCaptureEvents(stateRoot), captureCountBaseline + 2);
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
    assert.equal(await countCaptureEvents(stateRoot), captureCountBaseline + 2);
    assert.equal(
      requests.filter((entry) => entry.url?.startsWith("/api/v1/turns/") && entry.url.endsWith("/complete")).length,
      completeBeforePartial + 1
    );

    assert.equal((await listDistillationJobs(stateRoot, "acct-test")).length, distillationCountBaseline);
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
        arguments: { action: "skip", job_id: queued.job.job_id, source_harness: "test-harness" }
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
    await failDistillationJob(stateRoot, "acct-test", retryLeased.job_id, "simulated commit failure", "retry-test");
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
    assert.equal(await countCaptureEvents(stateRoot), captureCountBaseline + 3);

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
        assert.deepEqual(bridgeTools.tools.map((tool) => tool.name).sort(), ["memhub_distill", "memmy_context", "memmy_project", "memmy_project_list", "memmy_project_manage", "memmy_turn"]);
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

    const capturesBeforeIndexRebuild = await listCaptureEvents(stateRoot, "acct-test");
    await rm(join(stateRoot, "capture-index.sqlite"), { force: true });
    const capturesAfterIndexRebuild = await listCaptureEvents(stateRoot, "acct-test");
    assert.equal(capturesAfterIndexRebuild.length, capturesBeforeIndexRebuild.length);
    assert.deepEqual(
      capturesAfterIndexRebuild.map((item) => item.event_id).sort(),
      capturesBeforeIndexRebuild.map((item) => item.event_id).sort()
    );

    const postCapture = (event) => fetch(`http://127.0.0.1:${port}/memhub/capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createdDevice.token}`
      },
      body: JSON.stringify(event)
    });
    const dirtyRecoveryId = "capture-index-dirty-recovery";
    const dirtyInitial = await postCapture({
      event_id: dirtyRecoveryId,
      host: "codex",
      conversation_id: "dirty-recovery",
      turn_id: "dirty-recovery-turn",
      timestamp: "2026-09-18T08:01:30.000Z",
      user_text: "Persist this partial turn before a simulated crash.",
      capture_status: "open"
    });
    assert.equal(dirtyInitial.status, 201);
    const accountKey = createHash("sha256").update("acct-test", "utf8").digest("hex");
    const dirtyEventKey = createHash("sha256").update(dirtyRecoveryId, "utf8").digest("hex");
    const dirtyRawPath = join(stateRoot, "captures", accountKey, `${dirtyEventKey}.json`);
    const dirtyRaw = JSON.parse(await readFile(dirtyRawPath, "utf8"));
    dirtyRaw.assistant_text = "Complete the turn in the authoritative raw file.";
    dirtyRaw.capture_status = "complete";
    dirtyRaw.project_hint = "aide";
    await writeFile(dirtyRawPath, JSON.stringify(dirtyRaw, null, 2) + "\n");
    const captureIndexDb = new Database(join(stateRoot, "capture-index.sqlite"));
    captureIndexDb.prepare("INSERT OR REPLACE INTO capture_index_dirty(account_id,event_id) VALUES (?,?)")
      .run("acct-test", dirtyRecoveryId);
    captureIndexDb.close();
    const dirtyRecovered = (await listCaptureEvents(stateRoot, "acct-test", { conversationId: "dirty-recovery" }))[0];
    assert.equal(dirtyRecovered.capture_status, "complete");
    assert.equal(dirtyRecovered.project_hint, "aide");

    const boundCaptureId = "capture-bound-project-backfill";
    const boundCapture = await postCapture({
      event_id: boundCaptureId,
      host: "codex",
      conversation_id: "http-chat",
      turn_id: "bound-project-turn",
      timestamp: "2026-09-18T08:02:00.000Z",
      user_text: "Use the conversation binding without sending project_hint.",
      assistant_text: "The raw L1 event should persist the resolved project."
    });
    assert.equal(boundCapture.status, 201);
    const storedBoundCapture = (await listCaptureEvents(stateRoot, "acct-test")).find((item) => item.event_id === boundCaptureId);
    assert.equal(storedBoundCapture.project_hint, "aide");

    await setDistillationConfig(stateRoot, { auto_enabled: true, turn_threshold: 2, idle_minutes: 30 });
    for (let index = 1; index <= 2; index += 1) {
      const response = await postCapture({
        event_id: `capture-unscoped-auto-${index}`,
        host: "codex",
        conversation_id: "unscoped-auto",
        turn_id: `unscoped-auto-${index}`,
        timestamp: `2026-09-18T08:03:0${index}.000Z`,
        user_text: `unscoped user ${index}`,
        assistant_text: `unscoped assistant ${index}`
      });
      assert.equal(response.status, 201);
    }
    assert.equal(
      (await listDistillationJobs(stateRoot, "acct-test")).filter((job) => job.conversation_id === "unscoped-auto").length,
      0
    );

    for (let index = 1; index <= 4; index += 1) {
      const response = await postCapture({
        event_id: `capture-threshold-${index}`,
        host: "codex",
        conversation_id: "threshold-auto",
        turn_id: `threshold-auto-${index}`,
        timestamp: `2026-09-18T08:04:0${index}.000Z`,
        project_hint: "aide",
        user_text: `threshold user ${index}`,
        assistant_text: `threshold assistant ${index}`
      });
      assert.equal(response.status, 201);
    }
    const thresholdJobs = (await listDistillationJobs(stateRoot, "acct-test"))
      .filter((job) => job.conversation_id === "threshold-auto")
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
    assert.equal(thresholdJobs.length, 2);
    assert.deepEqual(thresholdJobs[0].evidence_refs.sort(), ["l1:capture-threshold-1", "l1:capture-threshold-2"]);
    assert.deepEqual(thresholdJobs[1].evidence_refs.sort(), ["l1:capture-threshold-3", "l1:capture-threshold-4"]);
    await setDistillationConfig(stateRoot, { auto_enabled: false });
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

async function exerciseClient(client, conversationId, stateRoot) {
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["memhub_distill", "memmy_context", "memmy_project", "memmy_project_list", "memmy_project_manage", "memmy_turn"]);
  assert.match(listed.tools.find((tool) => tool.name === "memmy_context")?.description ?? "", /conversation_id.*不要伪造|不要伪造.*conversation_id/);
  assert.match(listed.tools.find((tool) => tool.name === "memmy_project")?.description ?? "", /action=current.*没有 conversation_id 时不会报错/);
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
  const currentWithoutConversation = JSON.parse((await client.callTool({
    name: "memmy_project",
    arguments: { action: "current" }
  })).content[0].text);
  assert.equal(currentWithoutConversation.project, null);
  assert.equal(currentWithoutConversation.binding_available, false);
  assert.equal(currentWithoutConversation.resolution_source, "conversation_id_unavailable");
  const currentExplicitWithoutConversation = JSON.parse((await client.callTool({
    name: "memmy_project",
    arguments: { action: "current", project: "AIDE" }
  })).content[0].text);
  assert.equal(currentExplicitWithoutConversation.project, "aide");
  assert.equal(currentExplicitWithoutConversation.binding_available, false);
  assert.equal(currentExplicitWithoutConversation.resolution_source, "explicit_project");
  assert.equal(currentExplicitWithoutConversation.persisted, false);
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
  const mergeTarget = `merge-target-${conversationId}`;
  const mergeSource = `merge-source-${conversationId}`;
  const deleteProject = `delete-${conversationId}`;
  for (const project of [mergeTarget, mergeSource, deleteProject]) {
    const plan = JSON.parse((await client.callTool({
      name: "memmy_project_manage",
      arguments: {
        action: "plan",
        operation: "create",
        project,
        description: `Temporary MCP project-management test project ${project}.`
      }
    })).content[0].text);
    assert.equal(JSON.parse((await client.callTool({
      name: "memmy_project_manage",
      arguments: { action: "execute", authorization_id: plan.authorization_id }
    })).content[0].text).ok, true);
  }
  const mergePlan = JSON.parse((await client.callTool({
    name: "memmy_project_manage",
    arguments: { action: "plan", operation: "merge", project: mergeSource, target: mergeTarget }
  })).content[0].text);
  assert.equal(JSON.parse((await client.callTool({
    name: "memmy_project_manage",
    arguments: { action: "execute", authorization_id: mergePlan.authorization_id }
  })).content[0].text).ok, true);
  const deletePlan = JSON.parse((await client.callTool({
    name: "memmy_project_manage",
    arguments: { action: "plan", operation: "delete", project: deleteProject }
  })).content[0].text);
  assert.equal(JSON.parse((await client.callTool({
    name: "memmy_project_manage",
    arguments: { action: "execute", authorization_id: deletePlan.authorization_id }
  })).content[0].text).ok, true);
  const historicalProjects = JSON.parse((await client.callTool({
    name: "memmy_project_list",
    arguments: { include_inactive: true }
  })).content[0].text).projects;
  assert.equal(historicalProjects.find((project) => project.project === mergeSource)?.state, "merged");
  assert.equal(historicalProjects.find((project) => project.project === mergeSource)?.mergedInto, mergeTarget);
  assert.equal(historicalProjects.find((project) => project.project === deleteProject)?.state, "deleted");
  await client.callTool({ name: "memmy_project", arguments: { action: "bind", conversation_id: conversationId, project: "aide" } });
  const context = await client.callTool({ name: "memmy_context", arguments: { query: "continue", conversation_id: conversationId } });
  const capsule = JSON.parse(context.content[0].text);
  assert.equal(capsule.resolvedProjectId, "aide");
  assert.equal(capsule.globalMemory.length, 1);
  assert.equal(capsule.projectMemory.length, 1);
  if (conversationId === "stdio-chat") {
    assert.ok(capsule.projectArchitecture.some((item) => /AIDE Core Architecture/.test(item.content)));
    const architecture = JSON.parse((await client.callTool({
      name: "memmy_project",
      arguments: { action: "architecture", project: "aide", query: "broker workspace ownership" }
    })).content[0].text);
    assert.equal(architecture.project, "aide");
    assert.ok(architecture.architecture.some((item) => /Broker routes work/.test(item.content)));
  }
  const openedTurn = JSON.parse((await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "open",
      conversation_id: conversationId,
      continuity_id: conversationId,
      turn_id: `source-${conversationId}`,
      user_text: "Keep this original user message in L1."
    }
  })).content[0].text);
  assert.equal(openedTurn.turn.status, "open");
  assert.equal(openedTurn.turn.project_hint, "aide");
  const l1EventId = openedTurn.turn.event_id;
  await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "checkpoint",
      event_id: l1EventId,
      conversation_id: conversationId,
      continuity_id: conversationId,
      turn_id: `source-${conversationId}`,
      reasoning_summary: "Validated the project binding and memory boundary."
    }
  });
  const committedTurn = JSON.parse((await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "commit",
      event_id: l1EventId,
      conversation_id: conversationId,
      continuity_id: conversationId,
      turn_id: `source-${conversationId}`,
      assistant_text: "Keep this original assistant final in L1."
    }
  })).content[0].text);
  assert.equal(committedTurn.turn.status, "complete");
  const resumed = JSON.parse((await client.callTool({
    name: "memmy_turn",
    arguments: { action: "resume", conversation_id: conversationId, continuity_id: conversationId }
  })).content[0].text);
  assert.equal(resumed.turns.at(-1).event_id, l1EventId);
  assert.equal(resumed.turns.at(-1).reasoning_summary, "Validated the project binding and memory boundary.");
  assert.equal(resumed.incomplete.length, 0);

  const continuityContext = JSON.parse((await client.callTool({
    name: "memmy_context",
    arguments: { query: "continue", conversation_id: conversationId, continuity_id: conversationId }
  })).content[0].text);
  assert.ok(continuityContext.recentSession.some((item) => item.id === l1EventId));

  const contractResult = await client.callTool({
    name: "memhub_distill",
    arguments: { inspect_contract: true }
  });
  const contractPayload = JSON.parse(contractResult.content[0].text);
  assert.equal(contractPayload.contract.version, "memhub-distill-v2");
  assert.equal(contractPayload.contract.executor, "connected_mcp_or_harness_model");

  const golden = await exerciseGoldenDistillationChain(client, stateRoot, conversationId, l1EventId);
  const writesBeforeDryRun = requests.filter((entry) => entry.url === "/api/v1/memory/add").length;
  const dryRun = await client.callTool({
    name: "memhub_distill",
    arguments: {
      kind: "l4",
      scope: "account",
      content: "Durable cross-project evidence-backed user profile candidate.",
      evidence_refs: [`l3:${golden.aideL3Id}`, `l3:${golden.betaL3Id}`],
      dry_run: true
    }
  });
  assert.equal(JSON.parse(dryRun.content[0].text).dryRun, true);
  assert.equal(requests.filter((entry) => entry.url === "/api/v1/memory/add").length, writesBeforeDryRun);

  const invalidDryRun = await client.callTool({
    name: "memhub_distill",
    arguments: {
      kind: "l3",
      scope: "project",
      project: "aide",
      content: "This must not validate against invented evidence.",
      evidence_refs: ["l2:not-a-real-memory"],
      dry_run: true
    }
  });
  assert.equal(invalidDryRun.isError, true);
  assert.match(invalidDryRun.content[0].text, /404|not_found|evidence/i);

  const otherAccountEvidenceId = `other-account-l2-${conversationId}`;
  memoryById.set(otherAccountEvidenceId, {
    id: otherAccountEvidenceId,
    memoryLayer: "L2",
    status: "activated",
    title: "Other account timeline",
    summary: "Must never be accepted as current-account evidence.",
    body: "Must never be accepted as current-account evidence.",
    tags: ["artifact:l2", "project:aide"],
    namespace: { tenantId: "acct-other", userId: "acct_other_user", projectId: "aide" },
    version: 1
  });
  const crossAccountEvidence = await client.callTool({
    name: "memhub_distill",
    arguments: {
      kind: "l3",
      scope: "project",
      project: "aide",
      content: "This must not validate against another account's L2.",
      evidence_refs: [`l2:${otherAccountEvidenceId}`],
      dry_run: true
    }
  });
  assert.equal(crossAccountEvidence.isError, true);
  assert.match(crossAccountEvidence.content[0].text, /current account scope/i);

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
      evidence_refs: ["l1:test-turn"],
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
  assert.ok(skillWrite.body.tags.includes("distill-contract:memhub-distill-v2"));
  assert.ok(skillWrite.body.tags.includes("evidence:l1:test-turn"));
  assert.ok(skillWrite.body.tags.includes(`source-conversation:${conversationId}`));
  assert.equal(typeof skillWrite.body.requestId, "string");

}

async function exerciseGoldenDistillationChain(client, stateRoot, conversationId, aideL1EventId) {
  const harnessA = `golden-a-${conversationId}`;
  const harnessB = `golden-b-${conversationId}`;
  const harnessGlobal = `golden-global-${conversationId}`;
  const parseTool = (result) => JSON.parse(result.content[0].text);

  const captures = await listCaptureEvents(stateRoot, "acct-test");
  const aideCapture = captures.find((item) => item.event_id === aideL1EventId);
  assert.ok(aideCapture);
  const aideQueued = await enqueueDistillationJob({
    stateRoot,
    accountId: "acct-test",
    projectId: "aide",
    conversationId,
    captures: [aideCapture],
    reason: "manual"
  });
  assert.equal(aideQueued.created, true);
  const aideNext = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: { action: "next", kind: "l2", scope: "project", project: "aide", source_harness: harnessA }
  }));
  assert.equal(aideNext.job.job_id, aideQueued.job.job_id);
  const wrongOwner = await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: aideNext.job.job_id,
      content: "This write must be rejected before reaching Memory Core.",
      source_harness: "wrong-harness"
    }
  });
  assert.equal(wrongOwner.isError, true);
  assert.match(wrongOwner.content[0].text, /leased by another harness/i);
  const aideL2V1 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: aideNext.job.job_id,
      content: "AIDE timeline v1: the project binding was validated before memory changes.",
      source_harness: harnessA
    }
  }));
  assert.equal(aideL2V1.kind, "l2");
  assert.equal(aideL2V1.next_layer_job.job.target, "l3");
  const aideL2Id = aideL2V1.memory.id;
  const aideL2WriteV1 = [...requests].reverse().find((entry) =>
    entry.url === "/api/v1/memory/add" && entry.body?.layer === "L2" && entry.body?.namespace?.projectId === "aide"
  );
  assert.ok(aideL2WriteV1);

  const aideL3Next = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: { action: "next", kind: "l3", scope: "project", project: "aide", source_harness: harnessA }
  }));
  const aideL3V1 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: aideL3Next.job.job_id,
      content: "Within AIDE, validate current state before changing deployment or routing configuration.",
      source_harness: harnessA
    }
  }));
  assert.equal(aideL3V1.kind, "l3");
  const aideL3Id = aideL3V1.memory.id;

  const betaProject = `beta-${conversationId}`;
  const createBetaPlan = parseTool(await client.callTool({
    name: "memmy_project_manage",
    arguments: {
      action: "plan",
      operation: "create",
      project: betaProject,
      name: `Beta ${conversationId}`,
      description: "Second project used to prove cross-project L4 evidence in the golden distillation test."
    }
  }));
  assert.equal(createBetaPlan.status, "awaiting_user_authorization");
  assert.equal(parseTool(await client.callTool({
    name: "memmy_project_manage",
    arguments: { action: "execute", authorization_id: createBetaPlan.authorization_id }
  })).ok, true);

  const betaConversation = `${conversationId}-beta`;
  await client.callTool({ name: "memmy_project", arguments: { action: "bind", conversation_id: betaConversation, project: betaProject } });
  const betaOpen = parseTool(await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "open",
      conversation_id: betaConversation,
      continuity_id: betaConversation,
      turn_id: `source-${betaConversation}`,
      user_text: "Keep the second project evidence isolated from AIDE."
    }
  }));
  const betaCommit = parseTool(await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "commit",
      event_id: betaOpen.turn.event_id,
      conversation_id: betaConversation,
      continuity_id: betaConversation,
      turn_id: `source-${betaConversation}`,
      assistant_text: "Second project evidence remains project-scoped until L4 aggregation."
    }
  }));
  assert.equal(betaCommit.turn.project_hint, betaProject);
  const betaCapture = (await listCaptureEvents(stateRoot, "acct-test")).find((item) => item.event_id === betaOpen.turn.event_id);
  assert.ok(betaCapture);
  const betaQueued = await enqueueDistillationJob({
    stateRoot,
    accountId: "acct-test",
    projectId: betaProject,
    conversationId: betaConversation,
    captures: [betaCapture],
    reason: "manual"
  });
  const betaL2Next = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: { action: "next", kind: "l2", scope: "project", project: betaProject, source_harness: harnessB }
  }));
  assert.equal(betaL2Next.job.job_id, betaQueued.job.job_id);
  const betaL2 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: betaL2Next.job.job_id,
      content: "Beta timeline v1: project evidence is isolated and only crosses projects at L4.",
      source_harness: harnessB
    }
  }));
  assert.equal(betaL2.next_layer_job.job.target, "l3");
  const betaL3Next = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: { action: "next", kind: "l3", scope: "project", project: betaProject, source_harness: harnessB }
  }));
  const betaL3 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: betaL3Next.job.job_id,
      content: "Within Beta, preserve explicit project isolation before cross-project synthesis.",
      source_harness: harnessB
    }
  }));
  assert.equal(betaL3.next_layer_job.job.target, "l4");
  const betaL3Id = betaL3.memory.id;

  const l4NextV1 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: { action: "next", kind: "l4", scope: "account", source_harness: harnessGlobal }
  }));
  assert.equal(l4NextV1.job.evidence.length, 2);
  assert.equal(new Set(l4NextV1.job.evidence.map((item) => item.project_id)).size, 2);
  const l4V1 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: l4NextV1.job.job_id,
      content: "Across projects, prefer explicit state validation and strict project isolation before shared conclusions.",
      source_harness: harnessGlobal
    }
  }));
  assert.equal(l4V1.kind, "l4");
  assert.equal(l4V1.project, null);
  const l4IdV1 = l4V1.memory.id;
  const l4WriteV1 = [...requests].reverse().find((entry) =>
    entry.url === "/api/v1/memory/add" && entry.body?.layer === "L4"
  );
  assert.ok(l4WriteV1);

  const aideOpenV2 = parseTool(await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "open",
      conversation_id: conversationId,
      continuity_id: conversationId,
      turn_id: `source-${conversationId}-v2`,
      user_text: "Update AIDE with a second durable decision."
    }
  }));
  await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "commit",
      event_id: aideOpenV2.turn.event_id,
      conversation_id: conversationId,
      continuity_id: conversationId,
      turn_id: `source-${conversationId}-v2`,
      assistant_text: "The second decision is now part of AIDE current truth."
    }
  });
  const aideCaptureV2 = (await listCaptureEvents(stateRoot, "acct-test")).find((item) => item.event_id === aideOpenV2.turn.event_id);
  assert.ok(aideCaptureV2);
  const aideQueuedV2 = await enqueueDistillationJob({
    stateRoot,
    accountId: "acct-test",
    projectId: "aide",
    conversationId,
    captures: [aideCaptureV2],
    reason: "manual"
  });
  const aideL2NextV2 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: { action: "next", kind: "l2", scope: "project", project: "aide", source_harness: harnessA }
  }));
  assert.equal(aideL2NextV2.job.job_id, aideQueuedV2.job.job_id);
  const aideL2V2 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: aideL2NextV2.job.job_id,
      content: "AIDE timeline v2: preserve the original validation decision and append the second durable decision as current truth.",
      source_harness: harnessA
    }
  }));
  assert.equal(aideL2V2.memory.id, aideL2Id);
  const aideL2Writes = requests.filter((entry) =>
    entry.url === "/api/v1/memory/add" && entry.body?.layer === "L2" && entry.body?.namespace?.projectId === "aide"
  );
  const aideL2WriteV2 = aideL2Writes.at(-1);
  assert.notEqual(aideL2WriteV1.body.requestId, aideL2WriteV2.body.requestId);

  const aideL3NextV2 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: { action: "next", kind: "l3", scope: "project", project: "aide", source_harness: harnessA }
  }));
  const aideL3V2 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: aideL3NextV2.job.job_id,
      content: "Within AIDE, validate current state first and preserve durable decisions as the project evolves.",
      source_harness: harnessA
    }
  }));
  assert.equal(aideL3V2.memory.id, aideL3Id);
  assert.equal(aideL3V2.next_layer_job.job.target, "l4");

  const l4NextV2 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: { action: "next", kind: "l4", scope: "account", source_harness: harnessGlobal }
  }));
  const l4V2 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: l4NextV2.job.job_id,
      content: "Across projects, prefer explicit state validation, durable current truth, and strict project isolation before cross-project synthesis.",
      source_harness: harnessGlobal
    }
  }));
  assert.equal(l4V2.memory.id, l4IdV1);
  const l4Writes = requests.filter((entry) => entry.url === "/api/v1/memory/add" && entry.body?.layer === "L4");
  const l4WriteV2 = l4Writes.at(-1);
  assert.notEqual(l4WriteV1.body.requestId, l4WriteV2.body.requestId);
  assert.equal(memoryById.get(l4IdV1).version >= 2, true);

  return { aideL3Id, betaL3Id };
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
