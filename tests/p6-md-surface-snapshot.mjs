// P6-MD surface snapshot guard.
//
// Records the MCP tool surface (tools/list + representative success/error
// responses for every registered tool) and the HTTP authentication boundary,
// then fails when any of it changes. Run with P6_MD_UPDATE_SNAPSHOT=1 to
// regenerate from the current code; the fixture is meant to be reviewed and
// committed.
//
// The tool list is asserted exactly. Volatile identifiers (UUIDs, generated L1
// event ids, ISO timestamps, uptime) are normalized so the snapshot stays
// stable across runs without weakening the schema/description/behaviour check.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import Database from "better-sqlite3";
import { addAccount, ensureLocalAdminToken, setAccountRole } from "../dist/auth.js";
import { createMemhubMcpServer } from "../dist/mcp.js";
import { JsonProjectRegistry } from "../dist/project-registry.js";
import { JsonResultTransport } from "../dist/result-transport.js";
import { setDistillationConfig } from "../dist/distillation-jobs.js";
import { createTestRoot, testEnvironment } from "./test-isolation.mjs";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const mcpEntry = resolve(here, "../dist/mcp.js");
const fixturePath = resolve(here, "fixtures/p6-md-surface.json");
const updateSnapshot = process.env.P6_MD_UPDATE_SNAPSHOT === "1";
const ACCOUNT = "acct-surface";
const OTHER_ACCOUNT = "acct-surface-other";
const root = await createTestRoot("memhub-p6-md-");

// ---------------------------------------------------------------------------
// Deterministic fake Memory Core
// ---------------------------------------------------------------------------
const memoryById = new Map();
let memorySequence = 0;
const memoryIdempotency = new Map();

function seedSkill() {
  memoryById.set("skill-surface-1", {
    id: "skill-surface-1",
    memoryLayer: "Skill",
    status: "activated",
    title: "Surface snapshot procedure",
    body: "1. Read the snapshot.\n2. Compare the surface.\n3. Report differences.",
    tags: ["artifact:skill", "project:alpha", "reusable"],
    namespace: { tenantId: ACCOUNT, projectId: "alpha" },
    metadata: {
      info: { project_id: "alpha" },
      properties: { internal_info: {
        source_agent_id: "codex",
        source_skill_id: "surface-snapshot-procedure",
        source_skill_version: "1.0.0",
        source_namespace_tenant_id: ACCOUNT
      } }
    },
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z"
  });
}

function hit(id, snippet, tags) {
  return {
    id, kind: "memory", memoryLayer: "L4", status: "activated",
    snippet, score: 0.9, tags, source: "search",
    createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z"
  };
}

const memoryServer = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  response.setHeader("content-type", "application/json");
  const viewerPath = (request.url ?? "").split("?")[0];
  const viewerUrl = new URL(request.url ?? "/", "http://127.0.0.1");

  if (viewerPath === "/health") {
    response.end(JSON.stringify({
      ok: true, degraded: [],
      build: { vendorSha256: "surface-vendor-sha", memhubVersion: "1.0.0" }
    }));
    return;
  }
  if (request.url === "/api/v1/memory/search") {
    const project = body.namespace?.projectId;
    response.end(JSON.stringify({ hits: project
      ? [hit("global-surface", "Global surface memory.", ["global"]),
          hit("project-surface", `Project surface memory for ${project}.`, [`project:${project}`])]
      : [hit("global-surface", "Global surface memory.", ["global"])] }));
    return;
  }
  if (request.url === "/api/v1/memory/add") {
    const key = typeof body.requestId === "string" ? `memory.add:${body.requestId}` : undefined;
    if (key && memoryIdempotency.has(key)) {
      response.end(JSON.stringify({ ...memoryIdempotency.get(key), duplicate: true }));
      return;
    }
    const id = `memory-surface-${++memorySequence}`;
    memoryById.set(id, {
      id, memoryLayer: body.layer ?? "L1", status: "activated",
      title: body.title, summary: String(body.content ?? "").split(/\r?\n/, 1)[0], body: body.content,
      tags: Array.isArray(body.tags) ? body.tags : [], namespace: body.namespace,
      metadata: { info: { project_id: body.namespace?.projectId }, properties: { internal_info: {} } }
    });
    const result = { id, status: "activated", memoryLayer: body.layer ?? "L1" };
    if (key) memoryIdempotency.set(key, result);
    response.end(JSON.stringify(result));
    return;
  }
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
  if (request.method === "GET" && viewerPath === "/api/v1/raw-turns") {
    response.end(JSON.stringify({ items: [], page: 1, pageSize: 100, total: 0, totalPages: 1, hasNext: false, hasPrev: false }));
    return;
  }
  if (request.method === "GET" && ["/api/v1/l1", "/api/v1/l2", "/api/v1/l3", "/api/v1/l4", "/api/v1/skills"].includes(viewerPath)) {
    const layer = viewerPath === "/api/v1/skills" ? "Skill" : viewerPath.slice("/api/v1/".length).toUpperCase();
    const items = [...memoryById.values()].filter((item) => item.memoryLayer === layer);
    response.end(JSON.stringify({ items, total: items.length, hasNext: false }));
    return;
  }
  if (request.url === "/api/v1/sessions/open") {
    response.end(JSON.stringify({ sessionId: body.sessionId, projectId: body.projectId ?? null }));
    return;
  }
  if (request.url === "/api/v1/turns/start") {
    response.end(JSON.stringify({ turnId: body.turnId, sessionId: body.sessionId, status: "started" }));
    return;
  }
  if (request.url?.startsWith("/api/v1/turns/") && request.url.endsWith("/complete")) {
    response.end(JSON.stringify({ l1MemoryId: `l1-${body.sessionId}`, status: "captured" }));
    return;
  }
  response.statusCode = 404;
  response.end("{}");
});
await new Promise((ready) => memoryServer.listen(0, "127.0.0.1", ready));
const memoryEndpoint = `http://127.0.0.1:${memoryServer.address().port}`;

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------
function normalizeText(text) {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/l1_[0-9a-f]{32}/gi, "<l1-event>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<timestamp>")
    .replace(/("uptime_seconds"\s*:\s*)\d+/g, "$1<uptime>");
}

function normalizedJson(text) {
  const normalized = normalizeText(text);
  try {
    return JSON.parse(normalized);
  } catch {
    // Protocol-level argument validation errors are plain text, not JSON.
    return { raw_text: normalized };
  }
}

// ---------------------------------------------------------------------------
// In-process MCP surface capture
// ---------------------------------------------------------------------------
async function connectInProcess(options) {
  const server = createMemhubMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "p6-md-surface", version: "1.0.0" });
  await client.connect(clientTransport);
  return { server, client };
}

async function callJson(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((item) => item.text ?? "").join("");
  let raw;
  try { raw = JSON.parse(text); } catch { raw = undefined; }
  return { isError: result.isError === true, body: normalizedJson(text), raw, text: normalizeText(text) };
}

async function callError(client, name, args) {
  const result = await callJson(client, name, args);
  assert.equal(result.isError, true, `${name} should reject ${JSON.stringify(args)}`);
  return { isError: true, message: result.text };
}

async function captureToolSurface(client) {
  const listed = await client.listTools();
  const tools = normalizedJson(JSON.stringify(listed.tools));
  assert.equal(tools.length, 11, "the MCP surface must keep exactly 11 tools");

  const responses = {};
  const record = (name, kind, body) => {
    const entry = (responses[name] ??= {});
    (entry[kind] ??= []).push(body);
  };
  const success = (name, body) => record(name, "success", body);
  const failure = (name, body) => record(name, "error", body);

  // memmy_context — global recall only, deterministic fake Core hits.
  const context = await callJson(client, "memmy_context", { query: "surface snapshot context" });
  assert.equal(context.isError, false);
  success("memmy_context", {
    resolvedProjectId: context.body.resolvedProjectId,
    resolutionSource: context.body.resolutionSource,
    recallScope: context.body.recallScope,
    globalMemory: context.body.globalMemory.map((item) => ({
      id: item.id, layer: item.layer ?? item.memoryLayer, content: item.content
    })),
    projectMemory: context.body.projectMemory,
    reusableSkills: context.body.reusableSkills,
    retrievalDiagnostics: context.body.retrievalDiagnostics,
    projectCandidates: context.body.projectCandidates
  });
  failure("memmy_context", await callError(client, "memmy_context", {}));

  // memmy_turn — open + commit for a project-scoped turn.
  const opened = await callJson(client, "memmy_turn", {
    action: "open", project: "alpha", user_text: "Surface snapshot user turn."
  });
  assert.equal(opened.isError, false);
  success("memmy_turn.open", {
    action: opened.body.action, status: opened.body.status, project_id: opened.body.project_id,
    continuity_id: opened.body.continuity_id, ingested: opened.body.ingested,
    transport_conversation_id: opened.body.transport_conversation_id
  });
  const committed = await callJson(client, "memmy_turn", {
    action: "commit", event_id: opened.raw.event_id, assistant_text: "Surface snapshot assistant turn."
  });
  assert.equal(committed.isError, false, committed.text);
  success("memmy_turn.commit", {
    action: committed.body.action, status: committed.body.status, project_id: committed.body.project_id,
    ingested: committed.body.ingested, distillation: committed.body.distillation
  });
  failure("memmy_turn", await callError(client, "memmy_turn", { action: "commit", event_id: "missing" }));

  // memhub_memory — governed L4 plan plus an invalid evidence load.
  const memoryPlan = await callJson(client, "memhub_memory", {
    action: "plan", kind: "l4", content: "# Account profile\n\nSurface snapshot rule.", note: "snapshot"
  });
  assert.equal(memoryPlan.isError, false);
  success("memhub_memory", {
    status: memoryPlan.body.status, operation: memoryPlan.body.operation, kind: memoryPlan.body.kind,
    scope: memoryPlan.body.scope, proposed_content: memoryPlan.body.proposed_content,
    proposed_sha256: memoryPlan.body.proposed_sha256, contract: memoryPlan.body.contract
  });
  failure("memhub_memory", await callError(client, "memhub_memory", { action: "load", evidence_ref: "not-an-evidence-ref" }));

  // memhub_branch — list for a resolved project.
  const branchList = await callJson(client, "memhub_branch", { action: "list", project: "alpha" });
  assert.equal(branchList.isError, false);
  success("memhub_branch", branchList.body);
  failure("memhub_branch", await callError(client, "memhub_branch", { action: "create", project: "alpha" }));

  // memhub_skill — status of a deterministic Skill fixture.
  const skillStatus = await callJson(client, "memhub_skill", { action: "status", skill_id: "skill-surface-1" });
  assert.equal(skillStatus.isError, false);
  success("memhub_skill", skillStatus.body);
  failure("memhub_skill", await callError(client, "memhub_skill", { action: "status", skill_id: "skill-missing" }));

  // memhub_distill — contract discovery; unknown action must fail.
  const contract = await callJson(client, "memhub_distill", { inspect_contract: true });
  assert.equal(contract.isError, false);
  success("memhub_distill", contract.body);
  failure("memhub_distill", await callError(client, "memhub_distill", { action: "bogus" }));

  // memmy_project_list — read-only registry summary.
  const projectList = await callJson(client, "memmy_project_list", {});
  assert.equal(projectList.isError, false);
  success("memmy_project_list", projectList.body);

  // memhub_todo — account-wide list plus a missing-project write.
  const todoList = await callJson(client, "memhub_todo", { action: "list" });
  assert.equal(todoList.isError, false);
  success("memhub_todo", todoList.body);
  failure("memhub_todo", await callError(client, "memhub_todo", { action: "add", project: "missing-project", text: "x" }));

  // memmy_project_manage — plan only (no mutation) plus an invalid authorization.
  const managePlan = await callJson(client, "memmy_project_manage", {
    action: "plan", operation: "create", project: "beta", description: "Surface snapshot project."
  });
  assert.equal(managePlan.isError, false);
  success("memmy_project_manage", {
    status: managePlan.body.status, operation: managePlan.body.operation, payload: managePlan.body.payload,
    impact: managePlan.body.impact, instructions: managePlan.body.instructions
  });
  failure("memmy_project_manage", await callError(client, "memmy_project_manage", {
    action: "execute", authorization_id: "missing"
  }));

  // memmy_project — current project plus an unknown action.
  const current = await callJson(client, "memmy_project", { action: "current", project: "alpha" });
  assert.equal(current.isError, false);
  success("memmy_project", current.body);
  failure("memmy_project", await callError(client, "memmy_project", { action: "bogus" }));

  // memhub_result — continuation of a deterministic spooled result.
  const spool = new JsonResultTransport(root, ACCOUNT, 1_000);
  const envelope = spool.wrap({ blob: "s".repeat(20_000) }, { readOnly: true });
  const envelopeJson = JSON.parse(JSON.stringify(envelope));
  const read = await callJson(client, "memhub_result", {
    result_id: envelopeJson.result_transport.result_id, offset: 0, chunk_chars: 10_000
  });
  assert.equal(read.isError, false);
  success("memhub_result", {
    mode: read.body.result_transport.mode,
    offset: read.body.result_transport.offset,
    next_offset: read.body.result_transport.next_offset,
    total_chars: read.body.result_transport.total_chars,
    chunk_chars: read.body.result_transport.chunk_chars,
    complete: read.body.result_transport.complete,
    expires_in_seconds: read.body.result_transport.expires_in_seconds,
    chunk_sha256: createHash("sha256").update(read.body.result_chunk, "utf8").digest("hex")
  });
  failure("memhub_result", await callError(client, "memhub_result", { result_id: "missing", offset: 0 }));

  return { tools, responses };
}

// ---------------------------------------------------------------------------
// HTTP boundary capture
// ---------------------------------------------------------------------------
function rawHttp(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path, method, headers }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolvePromise({ status: response.statusCode, headers: response.headers, body: text }));
    });
    request.once("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function freePort() {
  const probe = createServer();
  await new Promise((ready) => probe.listen(0, "127.0.0.1", ready));
  const port = probe.address().port;
  await new Promise((close) => probe.close(close));
  return port;
}

async function captureHttpSurface() {
  const stateRoot = join(root, "http-state");
  const account = await addAccount(stateRoot, "surface-admin", "surface@example.com");
  await setAccountRole(stateRoot, account.account_id, "admin");
  const token = await ensureLocalAdminToken(stateRoot);
  const authorization = `Basic ${Buffer.from(`memhub:${token}`).toString("base64")}`;
  const port = await freePort();
  const child = spawn(process.execPath, [
    mcpEntry, "--http", String(port), "--account", account.account_id,
    "--memory-url", memoryEndpoint, "--state-root", stateRoot,
    "--public-host", "memhub.example.test"
  ], { env: testEnvironment(stateRoot, root), stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const deadline = Date.now() + 5_000;
    while (!stderr.includes("listening on http://127.0.0.1:") && Date.now() < deadline) {
      await new Promise((wait) => setTimeout(wait, 25));
    }
    assert.match(stderr, /listening on http:\/\/127\.0\.0\.1:/, `gateway must start: ${stderr}`);

    const health = await fetch(`http://127.0.0.1:${port}/memhub/health`);
    const healthBody = await health.json();
    const healthSurface = {
      status: health.status, ok: healthBody.ok, service: healthBody.service,
      degraded: healthBody.degraded, coreBuildMatches: healthBody.coreBuildMatches,
      cacheControl: health.headers.get("cache-control"),
      contentType: health.headers.get("content-type")
    };

    const hostRejected = await rawHttp(port, "/memhub/health", { headers: { host: "evil.example" } });
    const originRejected = await rawHttp(port, "/memhub/health", {
      headers: { host: `127.0.0.1:${port}`, origin: "http://evil.example" }
    });
    const remoteNoJwt = await rawHttp(port, "/mcp", {
      method: "POST",
      headers: { host: "memhub.example.test", "content-type": "application/json" },
      body: "{}"
    });
    const localAdminNoToken = await rawHttp(port, "/memhub/admin", { headers: { host: `127.0.0.1:${port}` } });
    const unknownAccount = await rawHttp(port, "/memhub/admin/api?kind=overview&account_id=missing-account", {
      headers: { host: `127.0.0.1:${port}`, authorization }
    });
    const forbiddenUserMutation = await fetch(`http://127.0.0.1:${port}/memhub/user/action`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ action: "create-project", project: "forbidden", description: "x" })
    });

    return {
      health: healthSurface,
      host_rejected: hostRejected.status,
      origin_rejected: originRejected.status,
      remote_without_jwt: {
        status: remoteNoJwt.status,
        body: normalizedJson(remoteNoJwt.body)
      },
      local_admin_without_token: {
        status: localAdminNoToken.status,
        wwwAuthenticate: localAdminNoToken.headers["www-authenticate"]
      },
      unknown_account_selection: {
        status: unknownAccount.status,
        body: normalizedJson(unknownAccount.body)
      },
      user_admin_action_forbidden: forbiddenUserMutation.status
    };
  } finally {
    child.kill("SIGTERM");
    await new Promise((exit) => { child.once("exit", exit); setTimeout(exit, 500); });
  }
}

// ---------------------------------------------------------------------------
// Library factory root check (R17)
// ---------------------------------------------------------------------------
async function assertFactoryRoot() {
  const factoryRoot = join(root, "factory-root");
  const registry = new JsonProjectRegistry(join(factoryRoot, "project-registry.json"));
  await registry.create(ACCOUNT, { projectId: "alpha", description: "Factory root fixture project." });
  await setDistillationConfig(factoryRoot, { auto_enabled: true, turn_threshold: 1 });
  const { server, client } = await connectInProcess({
    controlRoot: factoryRoot, accountId: ACCOUNT, memoryEndpoint, disableArchitecture: true
  });
  try {
    const opened = await callJson(client, "memmy_turn", {
      action: "open", project: "alpha", user_text: "Factory root user turn."
    });
    const committed = await callJson(client, "memmy_turn", {
      action: "commit", event_id: opened.raw.event_id, assistant_text: "Factory root assistant turn."
    });
    assert.equal(committed.raw.ingested, true);
    // The configured threshold is two turns; the second commit must queue L2.
    const secondOpen = await callJson(client, "memmy_turn", {
      action: "open", project: "alpha", user_text: "Factory root second user turn."
    });
    const secondCommit = await callJson(client, "memmy_turn", {
      action: "commit", event_id: secondOpen.raw.event_id, assistant_text: "Factory root second assistant turn."
    });
    assert.equal(secondCommit.raw.ingested, true);
    assert.equal(secondCommit.raw.distillation?.queued, true,
      `factory root must queue the threshold L2 job: ${JSON.stringify(secondCommit.raw)}`);
    const assigned = await callJson(client, "memmy_turn", {
      action: "assign", event_ids: [opened.raw.event_id], project: "alpha"
    });
    assert.equal(assigned.isError, false);

    const spool = new JsonResultTransport(factoryRoot, ACCOUNT, 1_000);
    const envelope = spool.wrap({ blob: "f".repeat(20_000) }, { readOnly: false });
    const resultId = envelope.result_transport.result_id;
    const read = await callJson(client, "memhub_result", { result_id: resultId, offset: 0, chunk_chars: 10_000 });
    assert.equal(read.isError, false);

    const spoolDir = join(factoryRoot, "result-spool");
    const indexDb = new Database(join(factoryRoot, "capture-index.sqlite"), { readonly: true });
    const assignmentRows = indexDb.prepare(
      "SELECT COUNT(*) AS count FROM capture_project_assignments WHERE account_id = ?"
    ).get(ACCOUNT).count;
    indexDb.close();
    assert.ok(assignmentRows > 0, "factory root must store capture assignments");
    const checks = {
      registry: existsSync(join(factoryRoot, "project-registry.json")),
      captureIndex: existsSync(join(factoryRoot, "capture-index.sqlite")),
      captures: existsSync(join(factoryRoot, "captures")),
      distillation: existsSync(join(factoryRoot, "distillation", "jobs.json")),
      assignments: assignmentRows > 0,
      spool: existsSync(spoolDir)
    };
    assert.deepEqual(checks, {
      registry: true, captureIndex: true, captures: true,
      distillation: true, assignments: true, spool: true
    });
    // Nothing may escape to the process working directory or the default root.
    assert.equal(existsSync(join(process.cwd(), "project-registry.json")), false);
  } finally {
    await client.close();
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// Cross-account isolation through the same factory
// ---------------------------------------------------------------------------
async function captureCrossAccount() {
  const { server, client } = await connectInProcess({
    controlRoot: root, accountId: OTHER_ACCOUNT, memoryEndpoint, disableArchitecture: true
  });
  try {
    const result = await callJson(client, "memhub_skill", { action: "status", skill_id: "skill-surface-1" });
    assert.equal(result.isError, true);
    return { memhub_skill_cross_account: { isError: true, message: result.text } };
  } finally {
    await client.close();
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
try {
  seedSkill();
  const registry = new JsonProjectRegistry(join(root, "project-registry.json"));
  await registry.create(ACCOUNT, {
    projectId: "alpha", name: "Alpha", description: "Surface snapshot fixture project.", aliases: ["alph"]
  });

  const { server, client } = await connectInProcess({
    controlRoot: root, accountId: ACCOUNT, memoryEndpoint, disableArchitecture: true
  });
  let surface;
  let crossAccount;
  try {
    surface = await captureToolSurface(client);
  } finally {
    await client.close();
    await server.close();
  }
  crossAccount = await captureCrossAccount();
  const http = await captureHttpSurface();
  await assertFactoryRoot();

  const snapshot = JSON.parse(JSON.stringify({
    generated_by: "tests/p6-md-surface-snapshot.mjs",
    note: "Generated from the unmodified mcp.ts surface before the P6-MD split. UUIDs, generated event ids, timestamps and uptime are normalized.",
    tools: surface.tools,
    responses: surface.responses,
    cross_account: crossAccount,
    http
  }));

  if (updateSnapshot) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(resolve(here, "fixtures"), { recursive: true });
    await writeFile(fixturePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    console.log(`p6-md-surface-snapshot: wrote ${fixturePath}`);
  } else {
    const expected = JSON.parse(await readFile(fixturePath, "utf8"));
    assert.deepEqual(snapshot, expected, "MCP/HTTP surface changed; inspect the diff before regenerating the fixture");
    console.log(`p6-md-surface-snapshot: ok (${snapshot.tools.length} tools)`);
  }
} finally {
  await new Promise((close) => memoryServer.close(close));
  await rm(root, { recursive: true, force: true });
}
