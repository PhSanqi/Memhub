import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { MemhubBridgeQueue, saveBridgeConfig } from "../dist/bridge.js";
import { createDevice, countCaptureEvents } from "../dist/capture.js";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const mcpEntry = resolve(here, "../dist/mcp.js");
const bridgeEntry = resolve(here, "../dist/bridge.js");
const root = await mkdtemp(join(tmpdir(), "memhub-mcp-"));
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
      ? [hit("global", "global"), hit("project", `project ${project}`)]
      : [hit("global", "global")] }));
    return;
  }
  if (request.url === "/api/v1/memory/add") {
    if (!acceptIdempotent(body, "memory.add", response)) return;
    response.end(JSON.stringify({ id: "new-memory", status: "activated" }));
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
  ], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
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
        assert.deepEqual(bridgeTools.tools.map((tool) => tool.name).sort(), ["memhub_distill", "memhub_evolution", "memmy_context", "memmy_project", "memmy_remember"]);
        const bridgeContext = await bridgeClient.callTool({
          name: "memmy_context",
          arguments: { query: "continue through local bridge", project: "aide", conversation_id: "bridge-proxy-chat" }
        });
        assert.equal(bridgeContext.isError, undefined);
        assert.equal(JSON.parse(bridgeContext.content[0].text).resolvedProjectId, "aide");
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

async function exerciseClient(client, conversationId) {
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["memhub_distill", "memhub_evolution", "memmy_context", "memmy_project", "memmy_remember"]);
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

function hit(id, snippet) {
  return { id, kind: "trace", memoryLayer: "L1", status: "activated", snippet, score: 0.9, tags: [], source: "search" };
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
