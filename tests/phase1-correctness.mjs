import { createTestRoot, isolateTestEnvironment, testEnvironment } from "./test-isolation.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { addAccount, listAccounts, setAccountRole } from "../dist/auth.js";
import { FileProjectArchitectureSource } from "../dist/architecture-source.js";
import { closeCaptureIndexDb, isCaptureIngested, listCaptureEvents, readCaptureIngestIntentStatus } from "../dist/capture.js";
import { reconcileFrozenCaptureIngests } from "../dist/capture-recovery.js";
import { leaseDistillationJob, listDistillationJobs, setDistillationConfig } from "../dist/distillation-jobs.js";
import { EmbeddedMemoryCore } from "../dist/embedded-memory-core.js";
import { withFileMutationLock } from "../dist/file-mutation-lock.js";
import { MemoryCoreHttpError } from "../dist/local-memory-client.js";
import { handleMemoryControlAction } from "../dist/memory-control-actions.js";
import { createMemhubMcpServer } from "../dist/mcp.js";
import { JsonProjectRegistry, validateProjectId } from "../dist/project-registry.js";
import { createMemhubRuntime } from "../dist/runtime.js";
import { upsertL1Turn } from "../dist/turn-log.js";

const root = await createTestRoot("memhub-phase1-");
isolateTestEnvironment(join(root, "default-state"), join(root, "architecture"));
let core;
try {
  await testJobs();
  console.log("phase1 R03: PASS (pure strict reads, locked migration and backup)");
  await testProjectIds();
  console.log("phase1 R04: PASS (registry, Unicode, contained architecture targets)");
  await testAdminRace();
  console.log("phase1 R13: PASS (concurrent demotions and HTTP conflict)");
  await startCore();
  await testNormalIngest();
  console.log("phase1 R01: PASS (real Core commit/crash/recovery, serialization, privacy)");
  await testFactoryRoot();
  console.log("phase1 R17: PASS (library factory captures/jobs/registry/architecture/spool root)");
  await testRecoveryErrors();
  console.log("phase1 R18: PASS (bounded diagnostics and rate-limited scheduler logging)");
  console.log("memhub-phase1-correctness: ok");
} finally {
  if (core) await core.stop();
  closeCaptureIndexDb();
  await rm(root, { recursive: true, force: true });
}

async function testJobs() {
  const stateRoot = join(root, "jobs");
  const dir = join(stateRoot, "distillation");
  const path = join(dir, "jobs.json");
  await mkdir(dir, { recursive: true });
  assert.deepEqual(await listDistillationJobs(stateRoot), []);
  const legacyJob = (id) => ({
    job_id: id, account_id: "jobs-account", project_id: "memhub",
    status: "pending", reason: "manual", created_at: "2026-10-18T00:00:00.000Z",
    updated_at: "2026-10-18T00:00:00.000Z",
    evidence: [{ event_id: `event-${id}`, timestamp: "2026-10-18T00:00:00.000Z", user_text: "user", assistant_text: "assistant" }]
  });
  const v1 = { version: 1, jobs: [legacyJob("first"), legacyJob("second")] };
  const original = JSON.stringify(v1, null, 2) + "\n";
  await writeFile(path, original);
  const before = await stat(path);
  assert.equal((await listDistillationJobs(stateRoot)).length, 2);
  assert.equal(await readFile(path, "utf8"), original, "read must not cut over v1");
  assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await readdir(dir), ["jobs.json"]);

  let release;
  let locked;
  const acquired = new Promise((done) => { locked = done; });
  const holder = withFileMutationLock(path, async () => {
    locked();
    await new Promise((done) => { release = done; });
    v1.jobs.push(legacyJob("added-under-lock"));
    await writeFile(path, JSON.stringify(v1));
  });
  await acquired;
  const leases = ["worker-a", "worker-b"].map((harness) => leaseDistillationJob(stateRoot, "jobs-account", { harness }));
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal((await readdir(dir)).filter((name) => name.includes("v1-backup")).length, 0);
  release();
  await holder;
  const leased = await Promise.all(leases);
  assert.equal(new Set(leased.map((job) => job.job_id)).size, 2);
  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.equal(stored.version, 2);
  assert.deepEqual(stored.jobs.map((job) => job.job_id), ["first", "second", "added-under-lock"]);
  assert.equal(stored.jobs[0].evidence[0].user_text, "user");
  const backups = (await readdir(dir)).filter((name) => /^jobs\.json\.v1-backup-\d+$/.test(name));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(dir, backups[0]), "utf8")), v1, "backup must reflect the locked reread");
  await leaseDistillationJob(stateRoot, "jobs-account", { harness: "worker-c" });
  assert.equal((await readdir(dir)).filter((name) => name.includes("v1-backup")).length, 1);

  for (const invalid of ["{", "null", "[]", '{"version":2}', '{"version":2,"jobs":{}}',
    '{"jobs":[]}', '{"version":3,"jobs":[]}', '{"version":0,"jobs":[]}',
    '{"version":2,"jobs":[null]}', '{"version":2,"jobs":[{}]}', '{"version":1,"jobs":[{}]}']) {
    await writeFile(path, invalid);
    await assert.rejects(listDistillationJobs(stateRoot), /JSON|distillation job store/);
    await assert.rejects(leaseDistillationJob(stateRoot, "jobs-account", { harness: "invalid" }), /JSON|distillation job store/);
    assert.equal(await readFile(path, "utf8"), invalid, "invalid stores must remain intact");
  }
}

async function testProjectIds() {
  const registryPath = join(root, "ids", "project-registry.json");
  const registry = new JsonProjectRegistry(registryPath);
  const accountId = "ids-account";
  const managedRootDir = join(root, "ids", "managed");
  const source = new FileProjectArchitectureSource({ rootDir: join(root, "ids", "workspace"), managedRootDir });
  const hostile = [".", "..", "a/b", "a\\b", "CON", "prn.txt", "AUX", "NUL", "COM1", "LPT9", "x.", "x ", "\u0000", "a\n", "a\u007f", "x:stream"];
  for (const projectId of hostile) {
    assert.throws(() => validateProjectId(projectId), /projectId/);
    await assert.rejects(registry.create(accountId, { projectId, description: "bad" }), /projectId/);
    await assert.rejects(source.inspectProjectArchitecture({ accountId, projectId }), /projectId/);
    await assert.rejects(source.getProjectArchitecture({ accountId, projectId, query: "architecture" }), /projectId/);
  }
  const legitimate = ["alpha", "memhub", "LegacyWorkbench", "notesapp", "residual-net", "dropbox2", "media-lab", "profile", "chat_robot", "webtools", "navigator", "论文", "论文 merged"];
  for (const projectId of legitimate) {
    await registry.create(accountId, { projectId, description: "valid" });
    const doc = await source.inspectProjectArchitecture({ accountId, projectId });
    const accountRoot = join(managedRootDir, createHash("sha256").update(accountId).digest("hex"));
    const rel = relative(accountRoot, doc.path);
    assert.ok(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
    const result = await source.writeProjectArchitecture({ accountId, projectId, expectedPath: doc.path, expectedFingerprint: doc.fingerprint, content: "# Valid architecture" });
    assert.equal(result.after.exists, true);
    await assert.rejects(source.writeProjectArchitecture({ accountId, projectId,
      expectedPath: join(root, "outside-account", "ARCHITECTURE.md"),
      expectedFingerprint: result.after.fingerprint, content: "# Bad path" }), /target changed/);
  }
  await assert.rejects(stat(join(root, "outside-account")), { code: "ENOENT" }, "invalid expectedPath must not even create a lock directory");
  const validFile = JSON.parse(await readFile(registryPath, "utf8"));
  for (const projectId of hostile) {
    const corrupted = structuredClone(validFile);
    corrupted.projects[0].projectId = projectId;
    await writeFile(registryPath, JSON.stringify(corrupted));
    await assert.rejects(registry.update(accountId, projectId, { description: "bad update" }), /projectId/);
    await assert.rejects(registry.merge(accountId, "memhub", projectId), /projectId/);
  }
  await writeFile(registryPath, JSON.stringify(validFile));
  assert.equal((await registry.list(accountId)).length, legitimate.length);
}

async function testAdminRace() {
  const stateRoot = join(root, "admins");
  const admins = await Promise.all([addAccount(stateRoot, "first"), addAccount(stateRoot, "second")]);
  await Promise.all(admins.map((admin) => setAccountRole(stateRoot, admin.account_id, "admin")));
  const staleAccounts = await listAccounts(stateRoot);
  const results = await Promise.allSettled(admins.map((admin) => setAccountRole(stateRoot, admin.account_id, "user")));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.message, "cannot_demote_last_admin");
  const remaining = (await listAccounts(stateRoot)).filter((account) => account.role === "admin");
  assert.equal(remaining.length, 1);
  const request = Readable.from([JSON.stringify({ action: "set-account-role", id: remaining[0].account_id, role: "user" })]);
  request.headers = { "content-type": "application/json" };
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, writeHead(code) { this.code = code; return this; }, end(body) { this.body = JSON.parse(body); return this; } };
  await handleMemoryControlAction({ request, response, stateRoot, accounts: staleAccounts, selectedAccount: remaining[0], adminView: true });
  assert.equal(response.code, 409);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.deepEqual(response.body, { error: "cannot_demote_last_admin" });
  await setAccountRole(stateRoot, remaining[0].account_id, "admin");
}

async function startCore() {
  const probe = createServer();
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  const coreRoot = join(root, "core");
  await mkdir(coreRoot, { recursive: true });
  const configPath = join(coreRoot, "config.yaml");
  const dbPath = join(coreRoot, "memory.sqlite");
  await writeFile(configPath, JSON.stringify({
    memmyMemory: { version: 1, userId: "phase1-user", roleRouting: { summary: "follow", evolution: "follow" },
      storage: { mode: "local", backend: "sqlite", sqlitePath: dbPath, token: "phase1-test-token" },
      algorithm: { enableMemoryAdd: true, enableMemorySearch: true, enableQueryRewrite: false },
      agentAccess: { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false } },
    providers: {}, modelAssignments: { default: null, memorySummary: null, memoryEvolution: null, embedding: null }, modelPresets: {}, app: {}
  }));
  core = new EmbeddedMemoryCore({ stateRoot: coreRoot, configPath, dbPath, port });
  await core.start();
}

function runtimeAt(stateRoot, accountId) {
  return createMemhubRuntime({ controlRoot: stateRoot, accountId, memoryEndpoint: core.endpoint,
    memoryToken: "phase1-test-token", architectureRoot: join(root, "architecture") });
}

function turn(eventId, extra = {}) {
  return { event_id: eventId, host: "phase1", conversation_id: "phase1-conversation", continuity_id: "phase1-continuity",
    timestamp: "2026-10-18T00:00:00.000Z", project_hint: "memhub", user_text: "user", assistant_text: "assistant", capture_status: "complete", ...extra };
}

async function testNormalIngest() {
  const stateRoot = join(root, "normal-ingest");
  const accountId = "normal-account";
  const runtime = runtimeAt(stateRoot, accountId);
  await runtime.projects.create(accountId, { projectId: "memhub", description: "phase1" });
  const originalComplete = runtime.memoryClient.completeTurn.bind(runtime.memoryClient);
  const originalOpen = runtime.memoryClient.openSession.bind(runtime.memoryClient);
  runtime.memoryClient.openSession = async (request) => {
    const eventId = request.namespace.sessionKey.slice("event:".length);
    assert.equal(await readCaptureIngestIntentStatus(stateRoot, accountId, eventId), "matching", "intent must precede the first Core call");
    return originalOpen(request);
  };
  let calls = 0;
  let replayId;
  runtime.memoryClient.completeTurn = async (id, request) => {
    calls += 1;
    assert.equal(await readCaptureIngestIntentStatus(stateRoot, accountId, "crash-normal"), "matching", "intent must be durable before Core complete");
    assert.equal(await isCaptureIngested(stateRoot, accountId, "crash-normal"), false);
    if (replayId) assert.equal(request.requestId, replayId);
    replayId = request.requestId;
    const response = await originalComplete(id, request);
    if (calls === 1) throw new Error("simulated crash after successful Core call before marker");
    return response;
  };
  const input = { stateRoot, runtime, actorId: "test:normal", turn: turn("crash-normal") };
  await assert.rejects(upsertL1Turn(input), /simulated crash/);
  assert.equal(await isCaptureIngested(stateRoot, accountId, "crash-normal"), false);
  const report = await reconcileFrozenCaptureIngests({ stateRoot, runtime });
  assert.equal(report.recovered, 1);
  assert.equal(report.failed, 0);
  assert.equal(calls, 2);
  assert.equal(await isCaptureIngested(stateRoot, accountId, "crash-normal"), true);
  assert.equal((await upsertL1Turn(input)).turn.ingested, true);
  assert.equal((await reconcileFrozenCaptureIngests({ stateRoot, runtime })).recovered, 0);
  assert.equal(calls, 2, "marker must prevent further Core calls");
  const db = new Database(core.dbPath, { readonly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) AS count FROM raw_turns WHERE user_id = ?").get(runtime.userId).count, 1,
      "real Core must store exactly one turn after replay");
  } finally { db.close(); }

  let concurrentCalls = 0;
  runtime.memoryClient.completeTurn = async (...args) => {
    concurrentCalls += 1;
    assert.equal(await readCaptureIngestIntentStatus(stateRoot, accountId, "concurrent-normal"), "matching");
    return originalComplete(...args);
  };
  const concurrentInput = { ...input, turn: turn("concurrent-normal") };
  const concurrent = await Promise.all([upsertL1Turn(concurrentInput), upsertL1Turn(concurrentInput)]);
  assert.equal(concurrentCalls, 1);
  assert.ok(concurrent.every((result) => result.turn.ingested));
  const privateResult = await upsertL1Turn({ ...input, turn: turn("private-normal", {
    user_text: "<private>secret user</private>", assistant_text: "<no-memory>secret assistant</no-memory>" }) });
  assert.equal(privateResult.ingestion.excluded, true);
  assert.equal(privateResult.turn.ingested, true, "excluded captures retain their processed marker");
  assert.equal(concurrentCalls, 1);
  assert.equal((await upsertL1Turn({ ...input, turn: turn("open-normal", { capture_status: "open" }) })).turn.ingested, false);
}

async function testFactoryRoot() {
  const stateRoot = join(root, "factory-X");
  const otherRoot = join(root, "factory-Y");
  isolateTestEnvironment(otherRoot, join(root, "architecture"));
  const server = createMemhubMcpServer({ controlRoot: stateRoot, accountId: "factory-account", memoryEndpoint: core.endpoint,
    memoryToken: "phase1-test-token", architectureRoot: join(root, "architecture") });
  const client = new Client({ name: "phase1", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text);
    const data = JSON.parse(result.content[0].text);
    if (data.result_transport?.mode !== "chunked") return data;
    let text = data.result_chunk;
    let offset = data.result_transport.next_offset;
    while (offset !== null) {
      const next = JSON.parse((await client.callTool({ name: "memhub_result", arguments: { result_id: data.result_transport.result_id, offset } })).content[0].text);
      text += next.result_chunk;
      offset = next.result_transport.next_offset;
    }
    return JSON.parse(text);
  };
  try {
    const plan = await call("memmy_project_manage", { action: "plan", operation: "create", project: "memhub", description: "factory root" });
    await call("memmy_project_manage", { action: "execute", authorization_id: plan.authorization_id });
    assert.equal((await new JsonProjectRegistry(join(stateRoot, "project-registry.json")).list("factory-account"))[0].projectId, "memhub");
    await setDistillationConfig(stateRoot, { auto_enabled: true, turn_threshold: 2 });
    for (const eventId of ["factory-first", "factory-second"]) {
      await call("memmy_turn", { action: "commit", event_id: eventId, conversation_id: "factory-chat", project: "memhub", user_text: "user ".repeat(13_000), assistant_text: "assistant" });
    }
    assert.equal((await listCaptureEvents(stateRoot, "factory-account")).length, 2);
    assert.equal((await listDistillationJobs(stateRoot, "factory-account")).length, 1);
    const resumed = await call("memmy_turn", { action: "resume", conversation_id: "factory-chat" });
    assert.equal(resumed.turns.length, 2);
    await assert.rejects(readdir(join(stateRoot, "result-spool")), { code: "ENOENT" }, "readonly resume uses in-memory continuation without a spool");
    const architecture = await call("memmy_project", { action: "architecture_plan", project: "memhub", content: "# Factory architecture" });
    assert.ok(architecture.path.startsWith(join(stateRoot, "project-architecture") + sep));
    await assert.rejects(stat(otherRoot), { code: "ENOENT" }, "explicit controlRoot must own all default state paths");
  } finally {
    await client.close();
    await server.close();
    isolateTestEnvironment(join(root, "default-state"), join(root, "architecture"));
  }
}

async function testRecoveryErrors() {
  const stateRoot = join(root, "recovery-errors");
  const runtime = runtimeAt(stateRoot, "error-account");
  await runtime.projects.create(runtime.accountId, { projectId: "memhub", description: "diagnostics" });
  runtime.memoryClient.openSession = async () => { throw new MemoryCoreHttpError(503, "SECRET conversation and token must not be reported"); };
  for (let index = 0; index < 23; index += 1) {
    await assert.rejects(upsertL1Turn({ stateRoot, runtime, actorId: "test:errors", turn: turn(`failed-${index}-${"x".repeat(150)}`) }), /503/);
  }
  const report = await reconcileFrozenCaptureIngests({ stateRoot, runtime });
  assert.equal(report.failed, 23);
  assert.equal(report.errors.length, 20);
  assert.ok(report.errors.every((error) => error.event_id.length <= 128 && error.kind === "core_http_error"));
  assert.doesNotMatch(JSON.stringify(report), /SECRET|conversation|token/);
  const secondRuntime = { ...runtime, accountId: "second-error-account" };
  await runtime.projects.create(secondRuntime.accountId, { projectId: "memhub", description: "second account" });
  await assert.rejects(upsertL1Turn({ stateRoot, runtime: secondRuntime, actorId: "test:errors", turn: turn("second-failed") }), /503/);
  const unavailableCore = createServer((request, response) => {
    request.resume();
    response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "SECRET conversation and token" }));
  });
  await new Promise((done) => unavailableCore.listen(0, "127.0.0.1", done));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/mcp.js", import.meta.url)),
    "--state-root", stateRoot, "--http", "0", "--no-architecture", "--memory-url", `http://127.0.0.1:${unavailableCore.address().port}`],
    { env: testEnvironment(stateRoot, join(root, "architecture")), stdio: ["ignore", "ignore", "pipe"] });
  const exited = new Promise((done) => child.once("exit", done));
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    const deadline = Date.now() + 10_000;
    while (!stderr.includes("capture ingest recovery:") && Date.now() < deadline && child.exitCode === null) {
      await new Promise((done) => setTimeout(done, 25));
    }
    assert.match(stderr, /capture ingest recovery:/);
    await new Promise((done) => setTimeout(done, 150));
    const lines = stderr.split("\n").filter((line) => line.includes("capture ingest recovery:"));
    assert.equal(lines.length, 1, "same error classification across accounts must be rate limited");
    const diagnostic = JSON.parse(lines[0].split("capture ingest recovery: ")[1]);
    assert.equal(diagnostic.kind, "core_http_error");
    assert.equal(diagnostic.event_ids.length, 20);
    assert.equal(diagnostic.failed, 23);
    assert.doesNotMatch(stderr, /SECRET|conversation and token/);
  } finally {
    child.kill("SIGTERM");
    await exited;
    await new Promise((done) => unavailableCore.close(done));
  }
}
