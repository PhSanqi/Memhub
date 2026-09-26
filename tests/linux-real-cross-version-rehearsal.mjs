#!/usr/bin/env node
// Manual, opt-in, disposable QA: use a separately built historical v0.2.2
// source archive to exercise old -> current -> old against real Core/Gateway.
// No production paths, systemctl, proxy, remote access or process scanning.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

if (process.platform !== "linux") {
  console.log("linux-real-cross-version-rehearsal: skipped (Linux only)");
  process.exit(0);
}
const old = process.argv[2];
if (!old || !isAbsolute(old)) {
  console.error("usage: node tests/linux-real-cross-version-rehearsal.mjs <absolute-built-v0.2.2-source>");
  process.exit(2);
}
const oldRoot = resolve(old);
const currentRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const version = (root) => JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
assert.equal(version(oldRoot), "0.2.2", "historical provenance must be v0.2.2");
assert.equal(version(currentRoot), "0.2.6", "candidate provenance must be v0.2.6");
const root = await mkdtemp(join(tmpdir(), "memhub-real-xver-"));
const state = join(root, "state");
const server = join(state, "server");
const memory = join(state, "memory");
const dbPath = join(memory, "memory.sqlite");
const config = join(state, "memory-config.yaml");
const envPath = join(state, "server.env");
const protectedMarker = join(state, "protected-user-marker.txt");
const bridgePath = join(state, "bridge.json");
const snapshot = join(root, "backup");
const token = createHash("sha256").update(root).digest("hex");
let coreChild = null;
let gatewayChild = null;
let traces = "";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const freePort = async () => {
  const s = createServer();
  await new Promise((done) => s.listen(0, "127.0.0.1", done));
  const p = s.address().port;
  await new Promise((done) => s.close(done));
  return p;
};
const [corePort, gatewayPort] = await Promise.all([freePort(), freePort()]);
const coreUrl = `http://127.0.0.1:${corePort}`;
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
const env = {
  ...process.env, MEMHUB_HOME: state, MEMHUB_BASE_PATH: "/",
  MEMHUB_OWNER_ACCOUNT_ID: "PLACEHOLDER", MEMHUB_OWNER_USER_ID: "local-user",
  MEMHUB_MEMORY_TOKEN: token, MEMHUB_MEMORY_URL: coreUrl,
  MEMHUB_STATE_ROOT: server, MEMHUB_BINDINGS: join(state, "bindings.json")
};
const waitHttp = async (url, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (response.status === 200) return;
    } catch {}
    if (coreChild && coreChild.exitCode !== null || gatewayChild && gatewayChild.exitCode !== null) {
      throw new Error("disposable runtime exited prematurely: " + traces.slice(-1500));
    }
    await sleep(125);
  }
  throw new Error("disposable service readiness failed: " + url + " " + traces.slice(-1500));
};
const start = async (repo, accountId) => {
  env.MEMHUB_OWNER_ACCOUNT_ID = accountId;
  traces = "";
  const child = (entry, args) => {
    const c = spawn(process.execPath, [join(repo, entry), ...args], {
      cwd: repo, env, stdio: ["ignore", "ignore", "pipe"]
    });
    c.stderr.on("data", (data) => { traces += data.toString(); });
    return c;
  };
  coreChild = child("vendor/memory-core/src/server/index.js",
    ["--config", config, "--host", "127.0.0.1", "--port", String(corePort), "--db", dbPath]);
  await waitHttp(coreUrl + "/health");
  gatewayChild = child("dist/mcp.js", ["--http", String(gatewayPort), "--http-path", "/mcp",
    "--capture-path", "/capture", "--state-root", server, "--memory-url", coreUrl]);
  await waitHttp(gatewayUrl + "/health");
};
const stopOne = async (child) => {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  const result = await Promise.race([exited.then(() => true), sleep(9000).then(() => false)]);
  assert.equal(result, true, "only the exact disposable child may be stopped; timed out");
};
const stop = async () => {
  await stopOne(gatewayChild);
  await stopOne(coreChild);
  gatewayChild = null;
  coreChild = null;
};
const cli = (repo, args) => {
  const outcome = spawnSync(process.execPath, [join(repo, "dist/mcp.js"), ...args], {
    cwd: repo, env, encoding: "utf8", timeout: 15000
  });
  assert.equal(outcome.status, 0, outcome.stderr);
  return JSON.parse(outcome.stdout);
};
const send = async (deviceToken, id, userText) => {
  const response = await fetch(gatewayUrl + "/capture", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({
      event_id: id, host: "isolated-cross-version", conversation_id: "isolated-xver",
      continuity_id: "isolated-xver", project_hint: null,
      timestamp: new Date().toISOString(), user_text: userText,
      assistant_text: "disposable QA only", capture_status: "complete"
    }), signal: AbortSignal.timeout(10000)
  });
  const body = await response.json().catch(() => ({}));
  assert.ok([200, 201].includes(response.status), JSON.stringify({ status: response.status, body, trace: traces.slice(-500) }));
  assert.equal(body?.ingestion?.ingested, true,
    "the historical and candidate Captures must actually commit to isolated Core");
  return body;
};
const verifyDb = async () => {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try { assert.equal(db.pragma("integrity_check", { simple: true }), "ok"); }
  finally { db.close(); }
};
const hashes = async (path, base = path, output = {}) => {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) await hashes(full, base, output);
    else if (entry.isFile()) output[relative(base, full)] =
      createHash("sha256").update(await readFile(full)).digest("hex");
    else throw new Error("unexpected symlink/special file in disposable evidence");
  }
  return output;
};
const backupDatabase = async (sourcePath, destPath) => {
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try { await db.backup(destPath); }
  finally { db.close(); }
  const backedUp = new Database(destPath);
  try {
    assert.equal(backedUp.pragma("integrity_check", { simple: true }), "ok");
    backedUp.pragma("wal_checkpoint(TRUNCATE)");
    backedUp.pragma("journal_mode = DELETE");
  } finally { backedUp.close(); }
};
try {
  await mkdir(server, { recursive: true });
  await mkdir(memory, { recursive: true });
  await writeFile(config, JSON.stringify({
    memmyMemory: { version: 1, userId: "local-user",
      roleRouting: { summary: "follow", evolution: "follow" },
      storage: { mode: "local", backend: "sqlite", sqlitePath: dbPath, endpoint: coreUrl, token },
      algorithm: { enableMemoryAdd: true, enableMemorySearch: true, enableQueryRewrite: false },
      agentAccess: { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false } },
    providers: {}, modelAssignments: { default: null, memorySummary: null, memoryEvolution: null,
      embedding: null, asr: null, imageGeneration: null }, modelPresets: {}, app: {}
  }, null, 2) + "\n", { mode: 0o600 });
  await writeFile(protectedMarker, "DO-NOT-LOSE-OR-ROTATE\n");
  const account = cli(oldRoot, ["account", "add", "xver-owner", "--state-root", server]);
  const accountId = account.account_id;
  const device = cli(oldRoot, ["device", "add", accountId, "xver-device", "--state-root", server]);
  const deviceToken = device.token;
  const { listCaptureEvents: oldCaptures } = await import(pathToFileURL(join(oldRoot, "dist", "capture.js")).href);
  const { listCaptureEvents: newCaptures } = await import(pathToFileURL(join(currentRoot, "dist", "capture.js")).href);
  env.MEMHUB_OWNER_ACCOUNT_ID = accountId;
  await writeFile(envPath, `MEMHUB_OWNER_ACCOUNT_ID=${accountId}\nMEMHUB_MEMORY_TOKEN=${token}\nMEMHUB_STATE_ROOT=${server}\n`, { mode: 0o600 });
  await writeFile(bridgePath, JSON.stringify({ device_token: deviceToken,
    mcp_endpoint: gatewayUrl + "/mcp", capture_endpoint: gatewayUrl + "/capture" }), { mode: 0o600 });

  await start(oldRoot, accountId);
  await send(deviceToken, "old-version-first", "pre-upgrade capture");
  await stop();
  await verifyDb();
  assert.equal((await oldCaptures(server, accountId)).filter((event) =>
    event.event_id === "old-version-first").length, 1);
  assert.equal(cli(oldRoot, ["account", "list", "--state-root", server])[0].account_id, accountId);

  // Frozen snapshot of the whole disposable state, with two separate SQLite
  // backups. This runs only AFTER both test-owned writers have exited.
  await cp(state, snapshot, { recursive: true });
  await backupDatabase(dbPath, join(snapshot, "memory", "memory.sqlite"));
  const captureIndex = join(server, "capture-index.sqlite");
  if ((await readdir(server)).includes("capture-index.sqlite")) {
    await backupDatabase(captureIndex, join(snapshot, "server", "capture-index.sqlite"));
  }
  for (const filename of ["memory.sqlite-wal", "memory.sqlite-shm", "memory.sqlite-journal"]) {
    await rm(join(snapshot, "memory", filename), { force: true });
  }
  for (const filename of ["capture-index.sqlite-wal", "capture-index.sqlite-shm", "capture-index.sqlite-journal"]) {
    await rm(join(snapshot, "server", filename), { force: true });
  }
  const expected = await hashes(snapshot);

  await start(currentRoot, accountId);
  assert.equal(cli(currentRoot, ["account", "list", "--state-root", server])[0].account_id, accountId);
  await send(deviceToken, "new-version-only", "candidate capture");
  await stop();
  await verifyDb();
  assert.equal((await newCaptures(server, accountId)).filter((event) =>
    event.event_id === "old-version-first").length, 1,
    "candidate must retain the historical L1 capture");
  assert.equal((await newCaptures(server, accountId)).filter((event) =>
    event.event_id === "new-version-only").length, 1);
  assert.equal((await readFile(protectedMarker, "utf8")), "DO-NOT-LOSE-OR-ROTATE\n");
  assert.equal(deviceToken, JSON.parse(await readFile(bridgePath, "utf8")).device_token);

  // Roll back only the temp state created above. No production root can be
  // passed to this script; root is always an owned mkdtemp directory.
  await rm(state, { recursive: true });
  await cp(snapshot, state, { recursive: true });
  assert.deepEqual(await hashes(state), expected, "rollback must restore entire protected state");
  assert.equal((await oldCaptures(server, accountId)).filter((event) =>
    event.event_id === "old-version-first").length, 1);
  assert.equal((await oldCaptures(server, accountId)).filter((event) =>
    event.event_id === "new-version-only").length, 0,
    "rollback must exclude candidate-only changes");
  await start(oldRoot, accountId);
  assert.equal(cli(oldRoot, ["account", "list", "--state-root", server])[0].account_id, accountId);
  await send(deviceToken, "old-version-after-rollback", "historical runtime after restoring snapshot");
  await stop();
  await verifyDb();
  console.log("linux-real-cross-version-rehearsal: ok (real v0.2.2 -> v0.2.6 -> restored v0.2.2, isolated Core/Gateway, credentials and state preserved)");
} finally {
  await stop().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
