import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { saveBridgeConfig } from "../dist/bridge.js";
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
  const first = JSON.parse(await readFile(join(root, ".server-stack.lock"), "utf8"));
  assert.equal(first.pid, child.pid);
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
  await rm(root, { recursive: true, force: true });
}
