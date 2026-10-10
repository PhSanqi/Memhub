import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { waitForService } from "../dist/service-readiness.js";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "memhub-real-stack-"));
const serverState = join(root, "server");
const memoryDir = join(root, "memory");
const entry = join(repo, "scripts", "run-stack.mjs");
const token = "stack-test-token";
let child;
let otherChild;
let stderr = "";

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
async function waitFor(predicate, timeoutMs = 12_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("real stack condition timed out: " + stderr.slice(-500));
}
async function cleanUpIsolatedOwner(home, owner) {
  if (!owner || owner.exitCode !== null || owner.signalCode !== null) return;
  const exited = new Promise((done) => owner.once("exit", done));
  const stopper = spawn(process.execPath, [entry, "--home", home,
    "--action", "stop"], { cwd: repo, stdio: "ignore" });
  const code = await new Promise((done) => stopper.once("exit", done));
  if (code === 0) await exited;
  else owner.kill("SIGTERM");
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}
function stackEvents() {
  return stderr.split("\n").filter((line) => line.startsWith("{")).flatMap((line) => {
    try { const event = JSON.parse(line); return event.component === "memhub-stack" ? [event] : []; }
    catch { return []; }
  });
}
try {
  const [corePort, gatewayPort] = await Promise.all([freePort(), freePort()]);
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
  // Core may rewrite the first instance's initial JSON config as YAML.
  // Preserve the source fixture before launching either process.
  const initialMemoryConfig = JSON.parse(await readFile(join(root, "memory-config.yaml"), "utf8"));
  await writeFile(join(root, "memhub.env"), [
    "MEMHUB_OWNER_ACCOUNT_ID=stack-smoke-account", "MEMHUB_OWNER_USER_ID=local-user",
    `MEMHUB_MEMORY_TOKEN=${token}`, `MEMHUB_MEMORY_URL=http://127.0.0.1:${corePort}`,
    `MEMHUB_STATE_ROOT=${serverState}`
  ].join("\n") + "\n");
  child = spawn(process.execPath, [entry, "--home", root,
    "--core-port", String(corePort), "--gateway-port", String(gatewayPort)],
  { cwd: repo, env: { ...process.env, MEMHUB_HOME: root }, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  await waitForService({ url: `http://127.0.0.1:${gatewayPort}/memhub/health`, kind: "gateway", timeoutMs: 30_000 });
  const first = JSON.parse(await readFile(join(root, ".memhub-stack.lock"), "utf8"));
  assert.equal(first.pid, child.pid);
  await assert.rejects(async () => {
    const duplicate = spawn(process.execPath, [entry, "--home", root,
      "--core-port", String(corePort), "--gateway-port", String(gatewayPort)],
    { cwd: repo, stdio: "ignore" });
    const code = await new Promise((done) => duplicate.once("exit", done));
    if (code !== 0) throw new Error("duplicate stack rejected");
  }, /duplicate stack rejected/);
  const status = spawn(process.execPath, [entry, "--home", root, "--action", "status"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
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
  assert.equal(JSON.parse(await readFile(join(root, ".memhub-stack.lock"), "utf8")).pid, child.pid);
  await waitForService({ url: `http://127.0.0.1:${gatewayPort}/memhub/health`, kind: "gateway", timeoutMs: 10_000 });

  // Two independent stacks use the same run-stack.mjs entrypoint. Stopping
  // the first must never match/kill the unrelated second instance by path.
  const otherHome = join(root, "other-instance");
  const otherCorePort = await freePort();
  const otherGatewayPort = await freePort();
  const otherMemoryDir = join(otherHome, "memory");
  const otherState = join(otherHome, "server");
  await mkdir(otherMemoryDir, { recursive: true });
  await mkdir(otherState, { recursive: true });
  const otherConfig = structuredClone(initialMemoryConfig);
  otherConfig.memmyMemory.storage.sqlitePath = join(otherMemoryDir, "memory.sqlite");
  otherConfig.memmyMemory.storage.endpoint = `http://127.0.0.1:${otherCorePort}`;
  await writeFile(join(otherHome, "memory-config.yaml"), JSON.stringify(otherConfig) + "\n");
  await writeFile(join(otherHome, "memhub.env"), [
    "MEMHUB_OWNER_ACCOUNT_ID=other-stack-account", "MEMHUB_OWNER_USER_ID=local-user",
    `MEMHUB_MEMORY_TOKEN=${token}`,
    `MEMHUB_MEMORY_URL=http://127.0.0.1:${otherCorePort}`,
    `MEMHUB_STATE_ROOT=${otherState}`
  ].join("\n") + "\n");
  otherChild = spawn(process.execPath, [entry, "--home", otherHome,
    "--core-port", String(otherCorePort), "--gateway-port", String(otherGatewayPort)],
  { cwd: repo, env: { ...process.env, MEMHUB_HOME: otherHome }, stdio: ["ignore", "ignore", "pipe"] });
  let otherStderr = "";
  otherChild.stderr.on("data", (chunk) => { otherStderr += chunk.toString(); });
  await waitForService({ url: `http://127.0.0.1:${otherGatewayPort}/memhub/health`,
    kind: "gateway", timeoutMs: 30_000 });
  assert.equal(JSON.parse(await readFile(join(otherHome, ".memhub-stack.lock"), "utf8")).pid, otherChild.pid);
  // The second StateRoot is nested under the first: substring matching of
  // --home would have treated the second stack as the first stack's owner.
  const firstLockPath = join(root, ".memhub-stack.lock");
  const firstLockBytes = await readFile(firstLockPath);
  const otherLock = JSON.parse(await readFile(join(otherHome, ".memhub-stack.lock"), "utf8"));
  await writeFile(firstLockPath, JSON.stringify({
    ...first, pid: otherChild.pid, token: "forged-prefix-owner",
    started_at: otherLock.started_at, exec_path: otherLock.exec_path,
    entrypoint: otherLock.entrypoint, home: root
  }) + "\n");
  try {
    const prefixStatus = spawn(process.execPath, [
      entry, "--home", root, "--action", "status"
    ], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    let prefixOutput = "";
    prefixStatus.stdout.on("data", (chunk) => { prefixOutput += chunk.toString(); });
    assert.equal(await new Promise((done) => prefixStatus.once("exit", done)), 0);
    assert.equal(JSON.parse(prefixOutput).owner_verified, false,
      "nested StateRoot prefix is not exact process ownership");
    const prefixStop = spawn(process.execPath, [
      entry, "--home", root, "--action", "stop"
    ], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
    let prefixError = "";
    prefixStop.stderr.on("data", (chunk) => { prefixError += chunk.toString(); });
    assert.notEqual(await new Promise((done) => prefixStop.once("exit", done)), 0);
    assert.match(prefixError, /verified live owner/);
    assert.equal(alive(child.pid), true);
    assert.equal(alive(otherChild.pid), true);
  } finally {
    await writeFile(firstLockPath, firstLockBytes);
  }

  // The single root owns only its own children. Graceful stop releases the
  // first lock and dedicated ports while leaving the other root running.
  // Windows Node treats SIGTERM as a forced process termination. Exercise
  // the managed stack's authenticated stop request instead, so its children
  // and owner lock are released by the owner itself.
  // The owner belongs to the previous package path. A candidate installed in
  // another release directory must verify that exact live owner and request
  // graceful shutdown without executing any path read from the lock.
  const newRelease = join(root, "candidate-release");
  const newEntry = join(newRelease, "scripts", "run-stack.mjs");
  await mkdir(join(newRelease, "scripts"), { recursive: true });
  await cp(join(repo, "dist"), join(newRelease, "dist"), { recursive: true });
  await cp(entry, newEntry);
  const crossReleaseStatus = spawn(process.execPath, [
    newEntry, "--home", root, "--action", "status"
  ], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  let crossStatusOutput = "";
  crossReleaseStatus.stdout.on("data", (chunk) => { crossStatusOutput += chunk.toString(); });
  assert.equal(await new Promise((done) => crossReleaseStatus.once("exit", done)), 0);
  assert.equal(JSON.parse(crossStatusOutput).owner_verified, true,
    "new release must verify previous release owner using live process identity");
  const stopper = spawn(process.execPath, [newEntry, "--home", root,
    "--action", "stop"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  let stopError = "";
  stopper.stderr.on("data", (chunk) => { stopError += chunk.toString(); });
  const ownerExit = new Promise((done) => child.once("exit", done));
  const stopCode = await new Promise((done) => stopper.once("exit", done));
  assert.equal(stopCode, 0, stopError);
  const code = await ownerExit;
  assert.equal(code, 0, stderr.slice(-1600));
  child = undefined;
  await waitFor(async () => {
    try { await readFile(join(root, ".memhub-stack.lock")); return false; }
    catch (error) { return error.code === "ENOENT"; }
  });
  for (const port of [corePort, gatewayPort]) {
    const server = createServer();
    await new Promise((done, reject) => server.once("error", reject).listen(port, "127.0.0.1", done));
    await new Promise((done) => server.close(done));
  }
  assert.equal(alive(first.pid), false);
  assert.equal(alive(otherChild.pid), true, "unrelated same-entrypoint stack must survive the first stop");
  assert.equal((await fetch(`http://127.0.0.1:${otherGatewayPort}/memhub/health`)).status, 200);
  const otherExit = new Promise((done) => otherChild.once("exit", done));
  const otherStopper = spawn(process.execPath, [entry, "--home", otherHome,
    "--action", "stop"], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
  let otherStopError = "";
  otherStopper.stderr.on("data", (chunk) => { otherStopError += chunk.toString(); });
  assert.equal(await new Promise((done) => otherStopper.once("exit", done)), 0, otherStopError);
  assert.equal(await otherExit, 0, otherStderr.slice(-1200));
  otherChild = undefined;

  // A stale lock whose PID has been reused by an unrelated live Node process
  // must fail closed. PID + token alone are insufficient; start time and the
  // actual run-stack entrypoint/home/mode must all match before stop is sent.
  const unrelatedOwner = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    cwd: repo, stdio: "ignore", windowsHide: true
  });
  const forgedLockPath = join(root, ".memhub-stack.lock");
  try {
    await writeFile(forgedLockPath, JSON.stringify({
      pid: unrelatedOwner.pid,
      token: "forged-live-owner",
      started_at: new Date().toISOString(),
      entrypoint: entry,
      exec_path: process.execPath,
      home: root
    }) + "\n");
    const forgedStatus = spawn(process.execPath, [
      entry, "--home", root, "--action", "status"
    ], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    let forgedOutput = "";
    forgedStatus.stdout.on("data", (chunk) => { forgedOutput += chunk.toString(); });
    assert.equal(await new Promise((done) => forgedStatus.once("exit", done)), 0);
    assert.equal(JSON.parse(forgedOutput).running, false);
    const forgedStop = spawn(process.execPath, [
      entry, "--home", root, "--action", "stop"
    ], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
    let forgedError = "";
    forgedStop.stderr.on("data", (chunk) => { forgedError += chunk.toString(); });
    assert.notEqual(await new Promise((done) => forgedStop.once("exit", done)), 0);
    assert.match(forgedError, /verified live owner/);
    assert.equal(alive(unrelatedOwner.pid), true,
      "PID reuse / forged owner must never terminate an unrelated process");
    assert.equal(JSON.parse(await readFile(forgedLockPath, "utf8")).token, "forged-live-owner",
      "failed identity verification must not rewrite or delete the lock");
  } finally {
    unrelatedOwner.kill();
    await rm(forgedLockPath, { force: true });
  }

  // A dead/stale owner remains an installer-level fail-closed condition: the
  // stop command cannot authenticate it and must leave the lock untouched.
  const staleLock = {
    pid: 2147483646,
    token: "stale-owner",
    started_at: "2026-01-01T00:00:00.000Z",
    entrypoint: entry,
    exec_path: process.execPath,
    home: root
  };
  await writeFile(forgedLockPath, JSON.stringify(staleLock) + "\n");
  const staleStop = spawn(process.execPath, [
    entry, "--home", root, "--action", "stop"
  ], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
  assert.notEqual(await new Promise((done) => staleStop.once("exit", done)), 0);
  assert.equal(JSON.parse(await readFile(forgedLockPath, "utf8")).token, "stale-owner");
  const staleBytes = await readFile(forgedLockPath);
  const directServe = spawn(process.execPath, [
    entry, "--home", root,
    "--core-port", String(corePort), "--gateway-port", String(gatewayPort)
  ], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
  let directError = "";
  directServe.stderr.on("data", (part) => { directError += part.toString(); });
  assert.notEqual(await new Promise((done) => directServe.once("exit", done)), 0);
  assert.match(directError, /refusing automatic takeover or stale-lock deletion/);
  assert.deepEqual(await readFile(forgedLockPath), staleBytes,
    "direct serve must not reclaim a stale-looking lock");
  await rm(forgedLockPath, { force: true });

  console.log("memhub-stack-runtime-smoke: ok");
} finally {
  // On Windows SQLite files remain locked briefly after their owner exits.
  // Do not forcibly terminate the owner before asking it to stop children.
  await cleanUpIsolatedOwner(root, child);
  await cleanUpIsolatedOwner(join(root, "other-instance"), otherChild);
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
}
