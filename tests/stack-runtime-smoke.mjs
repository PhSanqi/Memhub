import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  isCaptureIngested,
  listCaptureEvents,
  markCaptureIngested,
  readCaptureIngestIntentStatus,
  storeCaptureEvent
} from "../dist/capture.js";
import { recoverCaptureIngest } from "../dist/capture-recovery.js";
import { listDistillationJobs, setDistillationConfig } from "../dist/distillation-jobs.js";
import { JsonProjectRegistry } from "../dist/project-registry.js";
import { createMemhubRuntime } from "../dist/runtime.js";
import { waitForService } from "../dist/service-readiness.js";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "memhub-real-stack-"));
const controlRoot = join(root, "server");
const memoryDir = join(root, "memory");
const entry = join(repo, "scripts", "run-stack.mjs");
const token = "stack-test-token";
const accountId = "stack-smoke-account";
const actor = { account_id: accountId, actor_id: "actor:stack-smoke", name: "smoke-harness" };
let child;
let stderr = "";

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function preflight(ports) {
  const probe = spawn(process.execPath, [entry, "--home", root, "--action", "preflight",
    "--core-port", String(ports[0]), "--gateway-port", String(ports[1])],
  { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let error = "";
  probe.stdout.on("data", (chunk) => { output += chunk.toString(); });
  probe.stderr.on("data", (chunk) => { error += chunk.toString(); });
  const code = await new Promise((done) => probe.once("exit", done));
  return { code, output, error };
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("real stack condition timed out: " + stderr.slice(-1200));
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

function assertIntentionalCoreCrash(result, expectedCode, trace, marker) {
  assert.match(trace, marker, "fixture must finish the intended durable step before crashing");
  assert.ok(result.code === expectedCode || (
    process.platform === "win32" && result.code === 0xC0000409 && trace.includes("UV_HANDLE_CLOSING")
  ), `intentional Core crash code unexpected: ${result.code}; ${trace}`);
}

async function requestStop(ownedChild) {
  const exited = new Promise((done) => ownedChild.once("exit", (code, signal) => done({ code, signal })));
  const stopper = spawn(process.execPath, [entry, "--home", root, "--action", "stop"],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  stopper.stdout.on("data", (chunk) => { output += chunk.toString(); });
  const stopCode = await new Promise((done) => stopper.once("exit", done));
  assert.equal(stopCode, 0, `stop command failed: ${output}\n${stderr.slice(-1200)}`);
  assert.equal(JSON.parse(output).stopped, true);
  const result = await exited;
  assert.equal(result.code, 0, `parent must exit normally: ${result.signal}\n${stderr.slice(-1200)}`);
}

function stackEvents() {
  return stderr.split("\n").filter((line) => line.startsWith("{")).flatMap((line) => {
    try {
      const event = JSON.parse(line);
      return event.component === "memhub-stack" ? [event] : [];
    } catch { return []; }
  });
}

try {
  const ports = await Promise.all([freePort(), freePort()]);
  const [corePort, gatewayPort] = ports;
  assert.equal((await preflight(ports)).code, 0);

  const unrelated = createServer();
  await new Promise((done) => unrelated.listen(gatewayPort, "127.0.0.1", done));
  try {
    const blocked = await preflight(ports);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.error, /gateway port .*occupied or unavailable/);
    assert.equal(unrelated.listening, true);
  } finally {
    await new Promise((done) => unrelated.close(done));
  }

  await mkdir(controlRoot, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(root, "memory-config.yaml"), JSON.stringify({
    memmyMemory: {
      version: 1,
      userId: "local-user",
      roleRouting: { summary: "follow", evolution: "follow" },
      storage: {
        mode: "local", backend: "sqlite", sqlitePath: join(memoryDir, "memory.sqlite"),
        endpoint: `http://127.0.0.1:${corePort}`, token
      },
      algorithm: { enableMemoryAdd: true, enableMemorySearch: true, enableQueryRewrite: false },
      agentAccess: { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false }
    },
    providers: {},
    modelAssignments: { default: null, memorySummary: null, memoryEvolution: null, embedding: null, asr: null, imageGeneration: null },
    modelPresets: {}, app: {}
  }, null, 2) + "\n");
  await writeFile(join(root, "memhub.env"), [
    `MEMHUB_ACCOUNT_ID=${accountId}`,
    `MEMHUB_OWNER_ACCOUNT_ID=${accountId}`,
    "MEMHUB_OWNER_USER_ID=local-user",
    `MEMHUB_MEMORY_TOKEN=${token}`,
    `MEMHUB_MEMORY_URL=http://127.0.0.1:${corePort}`,
    `MEMHUB_STATE_ROOT=${controlRoot}`,
    // A public host must not disable the same runtime's loopback MCP entry.
    "MEMHUB_PUBLIC_HOST=memhub.example.test"
  ].join("\n") + "\n");

  await new JsonProjectRegistry(join(controlRoot, "project-registry.json")).create(
    accountId, { projectId: "stack-smoke", description: "isolated real Core/MCP smoke" }
  );
  await setDistillationConfig(controlRoot, { auto_enabled: true, turn_threshold: 2, idle_minutes: 30 });

  const l2JobsClaiming = async (...eventIds) => {
    const wanted = new Set(eventIds.map((id) => `l1:${id}`));
    return (await listDistillationJobs(controlRoot, accountId)).filter((job) =>
      job.target === "l2" && job.evidence_refs.some((ref) => wanted.has(ref))
    );
  };
  const assertL1ClaimedExactlyOnce = async (eventIds) => {
    const jobs = await listDistillationJobs(controlRoot, accountId);
    for (const eventId of eventIds) {
      const ref = `l1:${eventId}`;
      assert.equal(jobs.filter((job) => job.target === "l2" && job.evidence_refs.includes(ref)).length, 1,
        `${ref} must be claimed by exactly one project-level L2 job`);
    }
  };

  // Marker-only backlog: a restarted Gateway must discover these without any
  // Bridge/device side channel.
  for (const eventId of ["stack-boot-reconcile-1", "stack-boot-reconcile-2"]) {
    await storeCaptureEvent(controlRoot, actor, {
      event_id: eventId, host: actor.name, conversation_id: "legacy-storage-key:boot",
      continuity_id: "legacy-storage-key:boot", timestamp: new Date().toISOString(),
      project_hint: "stack-smoke", user_text: `boot user ${eventId}`,
      assistant_text: `boot assistant ${eventId}`, capture_status: "complete"
    });
    await markCaptureIngested(controlRoot, accountId, eventId);
  }
  const ambiguousEvent = (await storeCaptureEvent(controlRoot, actor, {
    event_id: "stack-boot-unmarked-intent", host: actor.name,
    conversation_id: "legacy-storage-key:ambiguous", continuity_id: "legacy-storage-key:ambiguous",
    timestamp: new Date().toISOString(), project_hint: "stack-smoke",
    user_text: "ambiguous Core outcome", assistant_text: "no durable intent means manual review",
    capture_status: "complete"
  })).event;

  child = spawn(process.execPath, [entry, "--home", root,
    "--core-port", String(corePort), "--gateway-port", String(gatewayPort)],
  { cwd: repo, env: { ...process.env, MEMHUB_HOME: root }, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  await waitForService({ url: `http://127.0.0.1:${gatewayPort}/memhub/health`, kind: "gateway", timeoutMs: 30_000 });

  await waitFor(async () => (await listDistillationJobs(controlRoot, accountId))
    .some((job) => job.evidence_refs.includes("l1:stack-boot-reconcile-1")));
  const bootJobs = await l2JobsClaiming("stack-boot-reconcile-1", "stack-boot-reconcile-2");
  assert.equal(bootJobs.length, 1);
  assert.deepEqual(bootJobs[0].evidence_refs.slice().sort(),
    ["l1:stack-boot-reconcile-1", "l1:stack-boot-reconcile-2"]);
  assert.equal(await isCaptureIngested(controlRoot, accountId, ambiguousEvent.event_id), false);

  // Same public-host runtime must remain directly usable on loopback.
  const client = new Client({ name: "memhub-stack-direct", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`)));
  const directTurn = async (eventId, userText, assistantText) => {
    const opened = JSON.parse((await client.callTool({
      name: "memmy_turn",
      arguments: {
        action: "open", event_id: eventId, project: "stack-smoke", workspace_project: "stack-smoke",
        user_text: userText
      }
    })).content[0].text);
    assert.equal(opened.project_id, "stack-smoke");
    const committed = JSON.parse((await client.callTool({
      name: "memmy_turn",
      arguments: {
        action: "commit", event_id: eventId, project: "stack-smoke", workspace_project: "stack-smoke",
        assistant_text: assistantText
      }
    })).content[0].text);
    assert.equal(committed.turn.ingested, true);
    return committed;
  };
  try {
    await directTurn("stack-real-core-turn-1", "isolated Core user one", "isolated Core assistant one");
    await directTurn("stack-real-core-turn-2", "isolated Core user two", "isolated Core assistant two");
  } finally {
    await client.close();
  }
  assert.equal(await isCaptureIngested(controlRoot, accountId, "stack-real-core-turn-1"), true);
  assert.equal((await listCaptureEvents(controlRoot, accountId, { eventId: "stack-real-core-turn-1" })).length, 1);
  await assertL1ClaimedExactlyOnce(["stack-real-core-turn-1", "stack-real-core-turn-2"]);

  const recoveryRuntime = createMemhubRuntime({
    accountId, ownerAccountId: accountId, ownerUserId: "local-user",
    memoryEndpoint: `http://127.0.0.1:${corePort}`, memoryToken: token,
    controlRoot, projectRegistryPath: join(controlRoot, "project-registry.json")
  });

  const offlineEvent = {
    event_id: "stack-real-core-offline-recovery", host: actor.name,
    conversation_id: "legacy-storage-key:offline", continuity_id: "legacy-storage-key:offline",
    timestamp: new Date().toISOString(), project_hint: "stack-smoke",
    user_text: "durable offline L1", assistant_text: "recovered through real Core", capture_status: "complete"
  };
  await storeCaptureEvent(controlRoot, actor, offlineEvent);
  const recoveryArgs = { stateRoot: controlRoot, runtime: recoveryRuntime, eventId: offlineEvent.event_id, projectId: "stack-smoke" };
  assert.equal((await recoverCaptureIngest({ ...recoveryArgs, dryRun: true })).already_ingested, false);
  assert.equal((await recoverCaptureIngest({ ...recoveryArgs, dryRun: false })).ingested, true);
  assert.equal((await recoverCaptureIngest({ ...recoveryArgs, dryRun: false })).already_ingested, true);

  // Crash after Core commit but before local marker. Recovery must reuse the
  // same deterministic Core turn/request IDs and then mark/queue exactly once.
  const crashEvent = (await storeCaptureEvent(controlRoot, actor, {
    ...offlineEvent, event_id: "stack-real-core-crash-before-marker",
    conversation_id: "legacy-storage-key:crash", continuity_id: "legacy-storage-key:crash",
    user_text: "Core commit before process crash", assistant_text: "retry identical durable request"
  })).event;
  const crashChild = spawn(process.execPath, [
    join(repo, "tests", "_capture-core-crash-child.mjs"), controlRoot,
    accountId, crashEvent.event_id, `http://127.0.0.1:${corePort}`, token,
    join(controlRoot, "project-registry.json")
  ], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
  let crashTrace = "";
  crashChild.stderr.on("data", (chunk) => { crashTrace += chunk.toString(); });
  const crashExit = await new Promise((done) => crashChild.once("exit", (code, signal) => done({ code, signal })));
  assertIntentionalCoreCrash(crashExit, 73, crashTrace, /CORE_COMMITTED_BEFORE_MARKER/);
  const receiptLine = crashTrace.split("\n").find((line) => line.startsWith("CORE_COMMITTED_BEFORE_MARKER:"));
  assert.ok(receiptLine, crashTrace);
  const receipt = JSON.parse(receiptLine.slice("CORE_COMMITTED_BEFORE_MARKER:".length));
  assert.equal(await isCaptureIngested(controlRoot, accountId, crashEvent.event_id), false);
  assert.equal(await readCaptureIngestIntentStatus(controlRoot, accountId, crashEvent.event_id), "matching");
  const originalCompleteTurn = recoveryRuntime.memoryClient.completeTurn.bind(recoveryRuntime.memoryClient);
  let replayedRequest;
  recoveryRuntime.memoryClient.completeTurn = async (turnId, request) => {
    replayedRequest = { turnId, requestId: request.requestId };
    return originalCompleteTurn(turnId, request);
  };
  const crashReplay = await recoverCaptureIngest({
    stateRoot: controlRoot, runtime: recoveryRuntime, eventId: crashEvent.event_id,
    projectId: "stack-smoke", dryRun: false
  });
  assert.equal(crashReplay.ingested, true);
  assert.deepEqual(replayedRequest, receipt);
  assert.equal(await isCaptureIngested(controlRoot, accountId, crashEvent.event_id), true);

  // Frozen intents left by crashed workers are automatically reconciled when
  // the two-process stack restarts.
  const autoCrashIds = ["stack-auto-core-crash-1", "stack-auto-core-crash-2"];
  for (const eventId of autoCrashIds) {
    await storeCaptureEvent(controlRoot, actor, {
      ...offlineEvent, event_id: eventId,
      conversation_id: "legacy-storage-key:auto", continuity_id: "legacy-storage-key:auto",
      user_text: `auto recover ${eventId}`, assistant_text: `deterministic request ${eventId}`
    });
    const worker = spawn(process.execPath, [
      join(repo, "tests", "_capture-core-crash-child.mjs"), controlRoot,
      accountId, eventId, `http://127.0.0.1:${corePort}`, token,
      join(controlRoot, "project-registry.json")
    ], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
    let trace = "";
    worker.stderr.on("data", (chunk) => { trace += chunk.toString(); });
    const result = await new Promise((done) => worker.once("exit", (code, signal) => done({ code, signal })));
    assertIntentionalCoreCrash(result, 73, trace, /CORE_COMMITTED_BEFORE_MARKER/);
    assert.equal(await isCaptureIngested(controlRoot, accountId, eventId), false);
  }

  const markerIds = ["stack-marker-before-queue-1", "stack-marker-before-queue-2"];
  for (const eventId of markerIds) {
    await storeCaptureEvent(controlRoot, actor, {
      ...offlineEvent, event_id: eventId,
      conversation_id: "legacy-storage-key:marker", continuity_id: "legacy-storage-key:marker",
      user_text: `Core committed ${eventId}`, assistant_text: `marker persisted ${eventId}`
    });
    const worker = spawn(process.execPath, [
      join(repo, "tests", "_capture-core-crash-child.mjs"), controlRoot,
      accountId, eventId, `http://127.0.0.1:${corePort}`, token,
      join(controlRoot, "project-registry.json"), "after-marker"
    ], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
    let trace = "";
    worker.stderr.on("data", (chunk) => { trace += chunk.toString(); });
    const result = await new Promise((done) => worker.once("exit", (code, signal) => done({ code, signal })));
    assertIntentionalCoreCrash(result, 74, trace, /CORE_AND_MARKER_COMMITTED_BEFORE_QUEUE/);
    assert.equal(await isCaptureIngested(controlRoot, accountId, eventId), true);
  }

  const lockPath = join(root, ".memhub-stack.lock");
  const first = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(first.pid, child.pid);
  const ownerBlocked = await preflight(ports);
  assert.notEqual(ownerBlocked.code, 0);
  assert.match(ownerBlocked.error, /stack lock remains/);
  const duplicate = spawn(process.execPath, [entry, "--home", root,
    "--core-port", String(corePort), "--gateway-port", String(gatewayPort)],
  { cwd: repo, stdio: "ignore" });
  assert.notEqual(await new Promise((done) => duplicate.once("exit", done)), 0);

  const status = spawn(process.execPath, [entry, "--home", root, "--action", "status"],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  let statusOutput = "";
  status.stdout.on("data", (chunk) => { statusOutput += chunk.toString(); });
  assert.equal(await new Promise((done) => status.once("exit", done)), 0);
  assert.equal(JSON.parse(statusOutput).running, true);

  // Killing Core forces the owned two-process group through a clean restart.
  await waitFor(() => stackEvents().some((event) => event.type === "ready" && event.service === "gateway"));
  const originalCore = stackEvents().find((event) => event.type === "ready" && event.service === "core").pid;
  const originalGateway = stackEvents().find((event) => event.type === "ready" && event.service === "gateway").pid;
  process.kill(originalCore, "SIGTERM");
  await waitFor(() => stackEvents().filter((event) => event.type === "ready" && event.service === "gateway").length >= 2, 20_000);
  const recoveredCore = stackEvents().filter((event) => event.type === "ready" && event.service === "core").at(-1).pid;
  const recoveredGateway = stackEvents().filter((event) => event.type === "ready" && event.service === "gateway").at(-1).pid;
  assert.notEqual(recoveredCore, originalCore);
  assert.notEqual(recoveredGateway, originalGateway);
  assert.ok(stackEvents().some((event) => event.type === "restart_scheduled"));
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, child.pid);
  await waitForService({ url: `http://127.0.0.1:${gatewayPort}/memhub/health`, kind: "gateway", timeoutMs: 10_000 });
  await waitFor(async () => (await Promise.all(autoCrashIds.map((eventId) =>
    isCaptureIngested(controlRoot, accountId, eventId)))).every(Boolean));
  await waitFor(async () => {
    const jobs = await listDistillationJobs(controlRoot, accountId);
    return [...autoCrashIds, ...markerIds].every((eventId) =>
      jobs.some((job) => job.evidence_refs.includes(`l1:${eventId}`)));
  });
  await assertL1ClaimedExactlyOnce(autoCrashIds);
  await assertL1ClaimedExactlyOnce(markerIds);
  await assertL1ClaimedExactlyOnce(["stack-boot-reconcile-1", "stack-boot-reconcile-2"]);

  await requestStop(child);
  child = undefined;
  await waitFor(async () => {
    try { await readFile(lockPath); return false; }
    catch (error) { return error.code === "ENOENT"; }
  });
  for (const port of ports) {
    const server = createServer();
    await new Promise((done, reject) => server.once("error", reject).listen(port, "127.0.0.1", done));
    await new Promise((done) => server.close(done));
  }
  assert.equal(alive(first.pid), false);
  assert.equal((await preflight(ports)).code, 0);

  // Unknown/stale ownership always fails closed; no PID guessing or unlinking.
  const forgedLock = JSON.stringify({ pid: 0, token: "unverified-owner", started_at: "2026-01-01T00:00:00.000Z" }) + "\n";
  await writeFile(lockPath, forgedLock);
  try {
    const blocked = await preflight(ports);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.error, /stack lock remains/);
    const stopper = spawn(process.execPath, [entry, "--home", root, "--action", "stop"],
      { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
    let stopError = "";
    stopper.stderr.on("data", (chunk) => { stopError += chunk.toString(); });
    assert.notEqual(await new Promise((done) => stopper.once("exit", done)), 0);
    assert.match(stopError, /without a verified live owner/);
    assert.equal(await readFile(lockPath, "utf8"), forgedLock);
  } finally {
    await rm(lockPath);
  }

  const staleLock = JSON.stringify({
    pid: 2147483646, token: "manual-review-required",
    started_at: "2026-01-01T00:00:00.000Z",
    entrypoint: entry, exec_path: process.execPath, home: root
  }) + "\n";
  await writeFile(lockPath, staleLock);
  try {
    const direct = spawn(process.execPath, [entry, "--home", root,
      "--core-port", String(corePort), "--gateway-port", String(gatewayPort)],
    { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
    let directError = "";
    direct.stderr.on("data", (part) => { directError += part.toString(); });
    assert.notEqual(await new Promise((done) => direct.once("exit", done)), 0);
    assert.match(directError, /refusing automatic takeover or stale-lock deletion/);
    assert.equal(await readFile(lockPath, "utf8"), staleLock);
  } finally {
    await rm(lockPath);
  }

  console.log("memhub-stack-runtime-smoke: ok");
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 250 });
}
