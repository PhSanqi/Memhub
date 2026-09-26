import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { saveBridgeConfig } from "../dist/bridge.js";
import { createDevice, isCaptureIngested, listCaptureEvents, markCaptureIngested, readCaptureIngestIntentStatus, storeCaptureEvent } from "../dist/capture.js";
import { recoverCaptureIngest } from "../dist/capture-recovery.js";
import { listDistillationJobs, setDistillationConfig } from "../dist/distillation-jobs.js";
import { JsonProjectRegistry } from "../dist/project-registry.js";
import { createMemhubRuntime } from "../dist/runtime.js";
import { waitForService } from "../dist/service-readiness.js";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "memhub-real-stack-"));
const serverState = join(root, "server");
const memoryDir = join(root, "memory");
const entry = join(repo, "scripts", "run-stack.mjs");
const token = "stack-test-token";
let child;
let stderr = "";

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
async function preflight(mode, ports) {
  const probe = spawn(process.execPath, [entry, "--mode", mode, "--home", root,
    "--action", "preflight", "--core-port", String(ports[0]),
    "--gateway-port", String(ports[1]), "--bridge-port", String(ports[2])],
  { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let error = "";
  probe.stdout.on("data", (chunk) => { output += chunk.toString(); });
  probe.stderr.on("data", (chunk) => { error += chunk.toString(); });
  const code = await new Promise((done) => probe.once("exit", done));
  return { code, output, error };
}
async function waitFor(predicate, timeoutMs = 12_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("real stack condition timed out: " + stderr.slice(-500));
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}
function assertIntentionalCoreCrash(result, expectedCode, trace, marker) {
  assert.match(trace, marker, "the fixture must finish the intended durable step before crashing");
  // On Windows Node 24, process.exit() while an HTTP/SQLite handle is closing
  // may trigger the native UV_HANDLE_CLOSING fail-fast (0xC0000409). It is
  // still an intentionally ungraceful process loss, provided the precise
  // Core/marker-completed trace was already emitted.
  assert.ok(result.code === expectedCode || (
    process.platform === "win32" && result.code === 0xC0000409 &&
    trace.includes("UV_HANDLE_CLOSING")
  ), `intentional Core crash code unexpected: ${result.code}; ${trace}`);
}
async function requestStop(mode, ownedChild) {
  const exited = new Promise((done) => ownedChild.once("exit", (code, signal) => done({ code, signal })));
  const stopper = spawn(process.execPath, [entry, "--mode", mode, "--home", root, "--action", "stop"],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  stopper.stdout.on("data", (chunk) => { output += chunk.toString(); });
  const stopCode = await new Promise((done) => stopper.once("exit", done));
  assert.equal(stopCode, 0, `stop command failed: ${output}\n${stderr.slice(-900)}`);
  assert.equal(JSON.parse(output).stopped, true);
  const result = await exited;
  assert.equal(result.code, 0, `parent must exit normally: ${result.signal}\n${stderr.slice(-900)}`);
}
function stackEvents() {
  return stderr.split("\n").filter((line) => line.startsWith("{")).flatMap((line) => {
    try { const event = JSON.parse(line); return event.component === "memhub-stack" ? [event] : []; }
    catch { return []; }
  });
}
try {
  const [corePort, gatewayPort, bridgePort] = await Promise.all([freePort(), freePort(), freePort()]);
  const ports = [corePort, gatewayPort, bridgePort];
  assert.equal((await preflight("server", ports)).code, 0);
  const unrelated = createServer();
  await new Promise((done) => unrelated.listen(gatewayPort, "127.0.0.1", done));
  try {
    const blocked = await preflight("server", ports);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.error, /gateway port .*occupied or unavailable/);
    assert.equal(unrelated.listening, true, "preflight must not terminate unrelated listeners");
  } finally {
    await new Promise((done) => unrelated.close(done));
  }
  assert.equal((await preflight("server", ports)).code, 0);
  await mkdir(serverState, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(root, "memory-config.yaml"), JSON.stringify({
    memmyMemory: {
      version: 1, userId: "local-user", roleRouting: { summary: "follow", evolution: "follow" },
      storage: { mode: "local", backend: "sqlite", sqlitePath: join(memoryDir, "memory.sqlite"), endpoint: `http://127.0.0.1:${corePort}`, token },
      algorithm: { enableMemoryAdd: true, enableMemorySearch: true, enableQueryRewrite: false },
      agentAccess: { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false }
    },
    providers: {}, modelAssignments: { default: null, memorySummary: null, memoryEvolution: null, embedding: null, asr: null, imageGeneration: null },
    modelPresets: {}, app: {}
  }, null, 2) + "\n");
  await writeFile(join(root, "server.env"), [
    "MEMHUB_OWNER_ACCOUNT_ID=stack-smoke-account", "MEMHUB_OWNER_USER_ID=local-user",
    `MEMHUB_MEMORY_TOKEN=${token}`, `MEMHUB_MEMORY_URL=http://127.0.0.1:${corePort}`,
    `MEMHUB_STATE_ROOT=${serverState}`, `MEMHUB_BINDINGS=${join(root, "bindings.json")}`
  ].join("\n") + "\n");
  const { device: smokeDevice, token: captureToken } = await createDevice(serverState,
    "stack-smoke-account", "isolated-stack-capture");
  await new JsonProjectRegistry(join(root, "project-registry.json")).create(
    "stack-smoke-account", { projectId: "stack-smoke", description: "isolated real Core capture" }
  );
  await setDistillationConfig(serverState, { auto_enabled: true, turn_threshold: 2, idle_minutes: 30 });
  // Simulate a process crash after two Core-success markers but before
  // enqueue. They must be picked up by the new Gateway on startup, without
  // waiting a minute or requiring another incoming Capture.
  for (const eventId of ["stack-boot-reconcile-1", "stack-boot-reconcile-2"]) {
    await storeCaptureEvent(serverState, smokeDevice, {
      event_id: eventId, host: "smoke-harness", conversation_id: "stack-boot-reconcile",
      continuity_id: "stack-boot-reconcile", timestamp: new Date().toISOString(),
      project_hint: "stack-smoke", user_text: `boot user ${eventId}`,
      assistant_text: `boot assistant ${eventId}`, capture_status: "complete"
    });
    await markCaptureIngested(serverState, smokeDevice.account_id, eventId);
  }
  const ambiguousEvent = (await storeCaptureEvent(serverState, smokeDevice, {
    event_id: "stack-boot-unmarked-intent", host: "smoke-harness",
    conversation_id: "stack-boot-ambiguous", continuity_id: "stack-boot-ambiguous",
    timestamp: new Date().toISOString(), project_hint: "stack-smoke",
    user_text: "legacy ambiguous Core outcome", assistant_text: "no durable intent means manual review",
    capture_status: "complete"
  })).event;
  child = spawn(process.execPath, [entry, "--mode", "server", "--home", root,
    "--core-port", String(corePort), "--gateway-port", String(gatewayPort), "--bridge-port", String(bridgePort)],
  { cwd: repo, env: { ...process.env, MEMHUB_HOME: root }, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    await waitForService({ url: `http://127.0.0.1:${gatewayPort}/memhub/health`, kind: "gateway", timeoutMs: 30_000 });
  } catch (error) {
    console.error("stack startup trace:", stderr.slice(-6000));
    const coreHealth = await fetch(`http://127.0.0.1:${corePort}/health`).then((response) => response.text()).catch(() => "unreachable");
    console.error("core health payload:", coreHealth.slice(0, 2000));
    throw error;
  }
  // Exercise the *real* Memory Core behind the isolated HTTP Gateway. The
  // broader MCP E2E uses a fake Core to inject failures; this confirms that a
  // legitimate complete device capture reaches Core and survives replay.
  await waitFor(async () => (await listDistillationJobs(serverState, smokeDevice.account_id))
    .some((job) => job.conversation_id === "stack-boot-reconcile"));
  const bootJobs = (await listDistillationJobs(serverState, smokeDevice.account_id))
    .filter((job) => job.conversation_id === "stack-boot-reconcile");
  assert.equal(bootJobs.length, 1, "startup must reconcile the durable marker backlog exactly once");
  assert.deepEqual(bootJobs[0].evidence_refs.slice().sort(),
    ["l1:stack-boot-reconcile-1", "l1:stack-boot-reconcile-2"]);
  assert.equal(await isCaptureIngested(serverState, smokeDevice.account_id, ambiguousEvent.event_id), false,
    "legacy complete captures without a durable intent must remain manual-review cases");
  assert.equal((await listDistillationJobs(serverState, smokeDevice.account_id))
    .some((job) => job.evidence_refs.includes(`l1:${ambiguousEvent.event_id}`)), false,
    "only durable ingested markers may be replayed into L2 jobs");
  const capturePayload = {
    event_id: "stack-real-core-capture", host: "smoke-harness",
    conversation_id: "stack-real-core-chat", continuity_id: "stack-real-core-chat",
    timestamp: new Date().toISOString(), project_hint: "stack-smoke",
    user_text: "isolated Core capture user", assistant_text: "isolated Core capture assistant",
    capture_status: "complete"
  };
  const sendCapture = (event = capturePayload) => fetch(`http://127.0.0.1:${gatewayPort}/memhub/capture`, {
    method: "POST", headers: {
      "content-type": "application/json", authorization: `Bearer ${captureToken}`
    }, body: JSON.stringify(event)
  });
  const firstCapture = await sendCapture();
  const firstCaptureBody = await firstCapture.json();
  assert.equal(firstCapture.status, 201, JSON.stringify(firstCaptureBody));
  assert.equal(firstCaptureBody.ingestion.ingested, true);
  assert.equal(await isCaptureIngested(serverState, smokeDevice.account_id, capturePayload.event_id), true);
  const replayCapture = await sendCapture();
  const replayCaptureBody = await replayCapture.json();
  assert.ok([200, 201].includes(replayCapture.status), JSON.stringify(replayCaptureBody));
  assert.equal(replayCaptureBody.ingestion.ingested, true);
  assert.equal((await listCaptureEvents(serverState, smokeDevice.account_id, {
    eventId: capturePayload.event_id
  })).length, 1, "replayed device capture must not duplicate durable L1");
  const secondEvent = {
    ...capturePayload, event_id: "stack-real-core-capture-two",
    user_text: "isolated follow-up user", assistant_text: "isolated follow-up assistant"
  };
  const secondCapture = await sendCapture(secondEvent);
  const secondCaptureBody = await secondCapture.json();
  assert.equal(secondCapture.status, 201, JSON.stringify(secondCaptureBody));
  assert.equal(secondCaptureBody.ingestion.ingested, true);
  const jobsAfterCapture = await listDistillationJobs(serverState, smokeDevice.account_id);
  assert.deepEqual(jobsAfterCapture.filter((job) => job.conversation_id === "stack-real-core-chat").map((job) =>
    job.evidence_refs.slice().sort()), [[
    "l1:stack-real-core-capture", "l1:stack-real-core-capture-two"
  ]], "two live Core-ingested turns should produce one durable L2 queue item");
  const secondReplay = await sendCapture(secondEvent);
  assert.ok([200, 201].includes(secondReplay.status));
  assert.equal((await listDistillationJobs(serverState, smokeDevice.account_id)).length, jobsAfterCapture.length,
    "replayed HTTP capture must not enqueue duplicate L2 work");
  const offlineEvent = {
    ...capturePayload, event_id: "stack-real-core-offline-recovery",
    conversation_id: "stack-offline-chat", continuity_id: "stack-offline-chat",
    user_text: "durable offline capture", assistant_text: "recovered through real Core"
  };
  await storeCaptureEvent(serverState, smokeDevice, offlineEvent);
  const recoveryRuntime = createMemhubRuntime({
    accountId: smokeDevice.account_id, ownerAccountId: smokeDevice.account_id,
    ownerUserId: "local-user", memoryEndpoint: `http://127.0.0.1:${corePort}`,
    memoryToken: token, projectRegistryPath: join(root, "project-registry.json"),
    bindingsPath: join(root, "bindings.json")
  });
  const recoveryArgs = {
    stateRoot: serverState, runtime: recoveryRuntime, eventId: offlineEvent.event_id,
    projectId: "stack-smoke"
  };
  assert.equal((await recoverCaptureIngest({ ...recoveryArgs, dryRun: true })).already_ingested, false);
  assert.equal(await isCaptureIngested(serverState, smokeDevice.account_id, offlineEvent.event_id), false);
  const recoveredOffline = await recoverCaptureIngest({ ...recoveryArgs, dryRun: false });
  assert.equal(recoveredOffline.ingested, true);
  assert.equal(await isCaptureIngested(serverState, smokeDevice.account_id, offlineEvent.event_id), true);
  assert.equal((await recoverCaptureIngest({ ...recoveryArgs, dryRun: false })).already_ingested, true,
    "real Core redrive must be idempotent once the durable marker exists");
  // Real cross-process crash window: the child calls the *real* isolated
  // Memory Core, observes completeTurn success, then exits without unwinding
  // the per-event lock or writing .ingested. A new process must recover with
  // the original request ID and enqueue this L1 exactly once.
  const crashEvent = (await storeCaptureEvent(serverState, smokeDevice, {
    ...capturePayload, event_id: "stack-real-core-crash-before-marker",
    conversation_id: "stack-crash-replay-chat", continuity_id: "stack-crash-replay-chat",
    user_text: "Core commit before process crash", assistant_text: "retry the identical turn"
  })).event;
  const crashChild = spawn(process.execPath, [
    join(repo, "tests", "_capture-core-crash-child.mjs"), serverState,
    smokeDevice.account_id, crashEvent.event_id, `http://127.0.0.1:${corePort}`,
    token, join(root, "project-registry.json"), join(root, "bindings.json")
  ], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
  let crashTrace = "";
  crashChild.stderr.on("data", (chunk) => { crashTrace += chunk.toString(); });
  const crashExit = await new Promise((done) => crashChild.once("exit", (code, signal) => done({ code, signal })));
  assertIntentionalCoreCrash(crashExit, 73, crashTrace, /CORE_COMMITTED_BEFORE_MARKER/);
  const receiptLine = crashTrace.split("\n").find((line) => line.startsWith("CORE_COMMITTED_BEFORE_MARKER:"));
  assert.ok(receiptLine, crashTrace);
  const receipt = JSON.parse(receiptLine.slice("CORE_COMMITTED_BEFORE_MARKER:".length));
  assert.equal(await isCaptureIngested(serverState, smokeDevice.account_id, crashEvent.event_id), false);
  assert.equal(await readCaptureIngestIntentStatus(serverState, smokeDevice.account_id, crashEvent.event_id),
    "matching", "the crashed child must leave a valid immutable Core request intent");
  assert.equal((await listDistillationJobs(serverState, smokeDevice.account_id)).some((job) =>
    job.evidence_refs.includes(`l1:${crashEvent.event_id}`)), false);
  await assert.rejects(storeCaptureEvent(serverState, smokeDevice, {
    ...crashEvent, provenance: { late_change: "cannot rewrite a committed Core request" }
  }), /ingestion already attempted; immutable event metadata/);
  const originalCompleteTurn = recoveryRuntime.memoryClient.completeTurn.bind(recoveryRuntime.memoryClient);
  let replayedRequest;
  recoveryRuntime.memoryClient.completeTurn = async (turnId, request) => {
    replayedRequest = { turnId, requestId: request.requestId };
    return originalCompleteTurn(turnId, request);
  };
  const crashReplay = await recoverCaptureIngest({
    stateRoot: serverState, runtime: recoveryRuntime, eventId: crashEvent.event_id,
    projectId: "stack-smoke", dryRun: false
  });
  assert.equal(crashReplay.ingested, true);
  assert.equal(crashReplay.already_ingested, false);
  assert.deepEqual(replayedRequest, receipt,
    "a new process must reuse the exact Core turn and idempotency request IDs");
  assert.equal(await isCaptureIngested(serverState, smokeDevice.account_id, crashEvent.event_id), true);
  assert.equal((await recoverCaptureIngest({
    stateRoot: serverState, runtime: recoveryRuntime, eventId: crashEvent.event_id,
    projectId: "stack-smoke", dryRun: false
  })).already_ingested, true);
  const crashFollowup = await sendCapture({
    ...crashEvent, event_id: "stack-real-core-crash-followup",
    user_text: "second committed turn", assistant_text: "form one downstream L2 batch"
  });
  assert.equal(crashFollowup.status, 201, await crashFollowup.text());
  const crashJobs = (await listDistillationJobs(serverState, smokeDevice.account_id))
    .filter((job) => job.conversation_id === "stack-crash-replay-chat");
  assert.equal(crashJobs.length, 1);
  assert.deepEqual(crashJobs[0].evidence_refs.slice().sort(), [
    "l1:stack-real-core-crash-before-marker", "l1:stack-real-core-crash-followup"
  ]);
  // New-style frozen intents are safe to redrive automatically because the
  // payload and deterministic Core request IDs were durably fixed before the
  // first write. Crash two separate child processes after real Core commit,
  // leave both markers absent, then require Gateway restart reconciliation to
  // recover and batch them without operator intervention.
  const autoCrashIds = ["stack-auto-core-crash-1", "stack-auto-core-crash-2"];
  for (const eventId of autoCrashIds) {
    await storeCaptureEvent(serverState, smokeDevice, {
      ...capturePayload, event_id: eventId, conversation_id: "stack-auto-core-crash",
      continuity_id: "stack-auto-core-crash",
      user_text: `auto recover ${eventId}`, assistant_text: `same deterministic request ${eventId}`
    });
    const autoCrashChild = spawn(process.execPath, [
      join(repo, "tests", "_capture-core-crash-child.mjs"), serverState,
      smokeDevice.account_id, eventId, `http://127.0.0.1:${corePort}`,
      token, join(root, "project-registry.json"), join(root, "bindings.json")
    ], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
    let autoCrashTrace = "";
    autoCrashChild.stderr.on("data", (chunk) => { autoCrashTrace += chunk.toString(); });
    const autoCrashExit = await new Promise((done) =>
      autoCrashChild.once("exit", (code, signal) => done({ code, signal })));
    assertIntentionalCoreCrash(autoCrashExit, 73, autoCrashTrace, /CORE_COMMITTED_BEFORE_MARKER/);
    assert.equal(await isCaptureIngested(serverState, smokeDevice.account_id, eventId), false);
    assert.equal(await readCaptureIngestIntentStatus(serverState, smokeDevice.account_id, eventId), "matching");
  }
  assert.equal((await listDistillationJobs(serverState, smokeDevice.account_id))
    .some((job) => job.conversation_id === "stack-auto-core-crash"), false);
  // A separate real-process crash occurs after Core success and marker
  // persistence, but before the child can call discovery. The next Gateway
  // startup must reconcile both markers, regardless of whether its periodic
  // scanner happened to observe them just before restart.
  const markerIds = ["stack-marker-before-queue-1", "stack-marker-before-queue-2"];
  for (const eventId of markerIds) {
    await storeCaptureEvent(serverState, smokeDevice, {
      ...capturePayload, event_id: eventId, conversation_id: "stack-marker-before-queue",
      continuity_id: "stack-marker-before-queue",
      user_text: `Core committed ${eventId}`,
      assistant_text: `marker persisted ${eventId}`
    });
    const markerChild = spawn(process.execPath, [
      join(repo, "tests", "_capture-core-crash-child.mjs"), serverState,
      smokeDevice.account_id, eventId, `http://127.0.0.1:${corePort}`,
      token, join(root, "project-registry.json"), join(root, "bindings.json"),
      "after-marker"
    ], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
    let markerTrace = "";
    markerChild.stderr.on("data", (chunk) => { markerTrace += chunk.toString(); });
    const result = await new Promise((done) => markerChild.once("exit", (code, signal) => done({ code, signal })));
    assertIntentionalCoreCrash(result, 74, markerTrace, /CORE_AND_MARKER_COMMITTED_BEFORE_QUEUE/);
    assert.match(markerTrace, /CORE_AND_MARKER_COMMITTED_BEFORE_QUEUE/);
    assert.equal(await isCaptureIngested(serverState, smokeDevice.account_id, eventId), true);
  }
  const markerJobsBeforeRestart = (await listDistillationJobs(serverState, smokeDevice.account_id))
    .filter((job) => job.conversation_id === "stack-marker-before-queue").length;
  assert.ok(markerJobsBeforeRestart === 0 || markerJobsBeforeRestart === 1);
  const autoCrashJobsBeforeRestart = (await listDistillationJobs(serverState, smokeDevice.account_id))
    .filter((job) => job.conversation_id === "stack-auto-core-crash").length;
  assert.ok(autoCrashJobsBeforeRestart === 0 || autoCrashJobsBeforeRestart === 1);
  const jobsBeforeCoreRestart = (await listDistillationJobs(serverState, smokeDevice.account_id)).length;
  const first = JSON.parse(await readFile(join(root, ".server-stack.lock"), "utf8"));
  assert.equal(first.pid, child.pid);
  const ownerBlocked = await preflight("server", ports);
  assert.notEqual(ownerBlocked.code, 0);
  assert.match(ownerBlocked.error, /stack lock remains/);
  await assert.rejects(async () => {
    const duplicate = spawn(process.execPath, [entry, "--mode", "server", "--home", root,
      "--core-port", String(corePort), "--gateway-port", String(gatewayPort), "--bridge-port", String(bridgePort)],
    { cwd: repo, stdio: "ignore" });
    const code = await new Promise((done) => duplicate.once("exit", done));
    if (code !== 0) throw new Error("duplicate stack rejected");
  }, /duplicate stack rejected/);
  const status = spawn(process.execPath, [entry, "--mode", "server", "--home", root, "--action", "status"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  status.stdout.on("data", (chunk) => { output += chunk.toString(); });
  assert.equal(await new Promise((done) => status.once("exit", done)), 0);
  assert.equal(JSON.parse(output).running, true);

  // A real Core crash must restart the complete owned group in order.
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
  assert.equal(JSON.parse(await readFile(join(root, ".server-stack.lock"), "utf8")).pid, child.pid);
  await waitForService({ url: `http://127.0.0.1:${gatewayPort}/memhub/health`, kind: "gateway", timeoutMs: 10_000 });
  await waitFor(async () => (await Promise.all(autoCrashIds.map((eventId) =>
    isCaptureIngested(serverState, smokeDevice.account_id, eventId)))).every(Boolean));
  await waitFor(async () => (await listDistillationJobs(serverState, smokeDevice.account_id))
    .some((job) => job.conversation_id === "stack-auto-core-crash"));
  const autoCrashJobs = (await listDistillationJobs(serverState, smokeDevice.account_id))
    .filter((job) => job.conversation_id === "stack-auto-core-crash");
  assert.equal(autoCrashJobs.length, 1);
  assert.deepEqual(autoCrashJobs[0].evidence_refs.slice().sort(),
    autoCrashIds.map((id) => `l1:${id}`).sort());
  const replayAfterCoreRestart = await sendCapture(capturePayload);
  const replayAfterRestartBody = await replayAfterCoreRestart.json();
  assert.ok([200, 201].includes(replayAfterCoreRestart.status),
    JSON.stringify(replayAfterRestartBody));
  assert.equal(await isCaptureIngested(serverState, smokeDevice.account_id, capturePayload.event_id), true);
  await waitFor(async () => (await listDistillationJobs(serverState, smokeDevice.account_id))
    .some((job) => job.conversation_id === "stack-marker-before-queue"));
  const markerJobsAfterRestart = (await listDistillationJobs(serverState, smokeDevice.account_id))
    .filter((job) => job.conversation_id === "stack-marker-before-queue");
  assert.equal(markerJobsAfterRestart.length, 1);
  assert.deepEqual(markerJobsAfterRestart[0].evidence_refs.slice().sort(),
    markerIds.map((id) => `l1:${id}`));
  assert.equal((await listDistillationJobs(serverState, smokeDevice.account_id)).length,
    jobsBeforeCoreRestart + (markerJobsBeforeRestart === 0 ? 1 : 0) +
      (autoCrashJobsBeforeRestart === 0 ? 1 : 0),
    "restart must recover marker backlog without duplicating already-enqueued L2 evidence");
  assert.equal((await listDistillationJobs(serverState, smokeDevice.account_id))
    .filter((job) => job.conversation_id === "stack-boot-reconcile").length, 1,
  "a second Gateway startup must not repeat an already-enqueued durable marker batch");

  // The single root owns its children. Terminating it gracefully clears the
  // pid lock and releases the dedicated test ports.
  await requestStop("server", child);
  child = undefined;
  await waitFor(async () => {
    try { await readFile(join(root, ".server-stack.lock")); return false; }
    catch (error) { return error.code === "ENOENT"; }
  });
  for (const port of [corePort, gatewayPort]) {
    const server = createServer();
    await new Promise((done, reject) => server.once("error", reject).listen(port, "127.0.0.1", done));
    await new Promise((done) => server.close(done));
  }
  assert.equal(alive(first.pid), false);
  assert.equal((await preflight("server", ports)).code, 0);
  // An invalid or orphaned lock must fail closed. Never infer ownership from
  // the Node executable name/path and never reclaim a lock during install.
  const forgedLockPath = join(root, ".server-stack.lock");
  const forgedLock = JSON.stringify({ pid: 0, token: "unverified-owner", started_at: "2026-01-01T00:00:00.000Z" }) + "\n";
  await writeFile(forgedLockPath, forgedLock);
  try {
    const blocked = await preflight("server", ports);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.error, /stack lock remains/);
    assert.equal(await readFile(forgedLockPath, "utf8"), forgedLock);
    const stopper = spawn(process.execPath, [entry, "--mode", "server", "--home", root, "--action", "stop"],
      { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
    let stopError = "";
    stopper.stderr.on("data", (chunk) => { stopError += chunk.toString(); });
    assert.notEqual(await new Promise((done) => stopper.once("exit", done)), 0);
    assert.match(stopError, /without a verified live owner/);
    assert.equal(await readFile(forgedLockPath, "utf8"), forgedLock);
  } finally {
    await rm(forgedLockPath);
  }
  // Direct `serve` must not bypass installer preflight and silently unlink
  // a syntactically valid lock just because its PID appears dead.
  const validStaleLock = JSON.stringify({
    pid: 2147483646, token: "manual-review-required",
    started_at: "2026-01-01T00:00:00.000Z",
    entrypoint: entry, exec_path: process.execPath, home: root, mode: "server"
  }) + "\n";
  await writeFile(forgedLockPath, validStaleLock);
  try {
    const direct = spawn(process.execPath, [entry, "--mode", "server", "--home", root,
      "--core-port", String(corePort), "--gateway-port", String(gatewayPort),
      "--bridge-port", String(bridgePort)],
    { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
    let directError = "";
    direct.stderr.on("data", (part) => { directError += part.toString(); });
    assert.notEqual(await new Promise((done) => direct.once("exit", done)), 0);
    assert.match(directError, /refusing automatic takeover or stale-lock deletion/);
    assert.equal(await readFile(forgedLockPath, "utf8"), validStaleLock);
  } finally {
    await rm(forgedLockPath);
  }

  // Local edition owns the real third process, Bridge. A Bridge failure
  // triggers recovery of the complete Core -> Gateway -> Bridge group.
  stderr = "";
  await writeFile(join(root, "local.env"), (await readFile(join(root, "server.env"), "utf8")) +
    "MEMHUB_ACCOUNT_ID=stack-smoke-account\n");
  await saveBridgeConfig(root, {
    mcpEndpoint: `http://127.0.0.1:${gatewayPort}/memhub/mcp`,
    captureEndpoint: `http://127.0.0.1:${gatewayPort}/memhub/capture`,
    deviceToken: "mhdev_" + "a".repeat(32)
  });
  child = spawn(process.execPath, [entry, "--mode", "local", "--home", root,
    "--core-port", String(corePort), "--gateway-port", String(gatewayPort), "--bridge-port", String(bridgePort)],
  { cwd: repo, env: { ...process.env, MEMHUB_HOME: root }, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  await waitForService({ url: `http://127.0.0.1:${bridgePort}/health`, kind: "bridge", timeoutMs: 30_000 });
  await waitFor(() => stackEvents().some((event) => event.type === "ready" && event.service === "bridge"));
  const bridgeBefore = stackEvents().find((event) => event.type === "ready" && event.service === "bridge").pid;
  const localCoreBefore = stackEvents().find((event) => event.type === "ready" && event.service === "core").pid;
  const localGatewayBefore = stackEvents().find((event) => event.type === "ready" && event.service === "gateway").pid;
  assert.equal((await (await fetch(`http://127.0.0.1:${bridgePort}/status`)).json()).pending, 0);
  // A real Bridge must retain an offline capture after the Gateway rejects
  // its device token, then flush it exactly once after credentials recover.
  const bridgeCapture = {
    ...capturePayload,
    event_id: "stack-bridge-recover-after-auth-failure",
    conversation_id: "stack-bridge-recovery-chat",
    continuity_id: "stack-bridge-recovery-chat",
    user_text: "offline bridge evidence",
    assistant_text: "delivered after auth recovery"
  };
  const bridgePost = await fetch(`http://127.0.0.1:${bridgePort}/capture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bridgeCapture)
  });
  assert.equal(bridgePost.status, 202);
  const bridgeFail = await fetch(`http://127.0.0.1:${bridgePort}/flush`, { method: "POST" });
  const bridgeFailResult = await bridgeFail.json();
  assert.equal(bridgeFail.status, 200);
  assert.match(bridgeFailResult.stopped_on_error, /capture upload HTTP 403/);
  assert.equal(bridgeFailResult.pending, 1, "failed delivery must leave durable evidence in Bridge");
  assert.equal(await isCaptureIngested(serverState, smokeDevice.account_id, bridgeCapture.event_id), false);
  await saveBridgeConfig(root, {
    mcpEndpoint: `http://127.0.0.1:${gatewayPort}/memhub/mcp`,
    captureEndpoint: `http://127.0.0.1:${gatewayPort}/memhub/capture`,
    deviceToken: captureToken
  });
  const bridgeRecovered = await fetch(`http://127.0.0.1:${bridgePort}/flush`, { method: "POST" });
  const bridgeRecoveredResult = await bridgeRecovered.json();
  assert.equal(bridgeRecovered.status, 200);
  assert.equal(bridgeRecoveredResult.sent, 1, JSON.stringify(bridgeRecoveredResult));
  assert.equal(bridgeRecoveredResult.pending, 0);
  assert.equal(await isCaptureIngested(serverState, smokeDevice.account_id, bridgeCapture.event_id), true);
  assert.equal((await listCaptureEvents(serverState, smokeDevice.account_id, {
    eventId: bridgeCapture.event_id
  })).length, 1, "Bridge authentication recovery must preserve exactly one raw event");
  const bridgeReplay = await fetch(`http://127.0.0.1:${bridgePort}/capture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bridgeCapture)
  });
  assert.equal(bridgeReplay.status, 202);
  const bridgeReplayResult = await (await fetch(`http://127.0.0.1:${bridgePort}/flush`,
    { method: "POST" })).json();
  assert.equal(bridgeReplayResult.pending, 0);
  assert.equal((await listCaptureEvents(serverState, smokeDevice.account_id, {
    eventId: bridgeCapture.event_id
  })).length, 1, "replayed Bridge evidence must not duplicate Core-backed L1");
  process.kill(bridgeBefore, "SIGTERM");
  await waitFor(() => stackEvents().filter((event) => event.type === "ready" && event.service === "bridge").length >= 2, 20_000);
  assert.notEqual(stackEvents().filter((event) => event.type === "ready" && event.service === "bridge").at(-1).pid, bridgeBefore);
  assert.notEqual(stackEvents().filter((event) => event.type === "ready" && event.service === "core").at(-1).pid, localCoreBefore);
  assert.notEqual(stackEvents().filter((event) => event.type === "ready" && event.service === "gateway").at(-1).pid, localGatewayBefore);
  await requestStop("local", child);
  child = undefined;
  for (const port of [corePort, gatewayPort, bridgePort]) {
    const server = createServer();
    await new Promise((done, reject) => server.once("error", reject).listen(port, "127.0.0.1", done));
    await new Promise((done) => server.close(done));
  }
  console.log("memhub-stack-runtime-smoke: ok");
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  // Windows can release a SQLite handle shortly after its owned process
  // exits. Bounded retries keep this isolated smoke portable.
  await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 250 });
}
