#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ManagedProcessStack } from "../dist/process-stack.js";

const stackEntrypoint = resolve(fileURLToPath(import.meta.url));
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const value = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  if (i < 0) return fallback;
  if (!process.argv[i + 1] || process.argv[i + 1].startsWith("--")) throw new Error(`${flag} requires a value`);
  return process.argv[i + 1];
};
const mode = value("--mode", "local");
if (mode !== "local" && mode !== "server") throw new Error("--mode must be local or server");
const port = (flag, fallback) => {
  const parsed = Number(value(flag, String(fallback)));
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`${flag} must be a TCP port`);
  return parsed;
};
const corePort = port("--core-port", 18960);
const gatewayPort = port("--gateway-port", 3001);
const bridgePort = port("--bridge-port", 17861);
if (new Set([corePort, gatewayPort, bridgePort]).size !== 3) throw new Error("Memhub stack ports must be distinct");
const home = resolve(value("--home", process.env.MEMHUB_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? repoRoot, ".memhub")));
const action = value("--action", "serve");
const lockPath = join(home, `.${mode}-stack.lock`);
const stopRequestPath = `${lockPath}.stop`;

if (action === "preflight") {
  if (existsSync(lockPath)) throw new Error("Memhub stack lock remains; refusing to replace an unverified owner");
  for (const [name, port] of [["core", corePort], ["gateway", gatewayPort], ["bridge", bridgePort]]) {
    if (mode === "server" && name === "bridge") continue;
    await new Promise((resolveProbe, rejectProbe) => {
      const probe = createServer();
      probe.once("error", (error) => {
        rejectProbe(new Error(`Memhub ${name} port ${port} is occupied or unavailable; refusing to stop unrelated processes: ${error.message}`));
      });
      probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => probe.close(resolveProbe));
    });
  }
  console.log(JSON.stringify({ mode, ready_to_install: true }));
  process.exit(0);
}

if (action === "status") {
  try {
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    const verified = await verifyOwnerIdentity(lock);
    console.log(JSON.stringify({
      mode, running: verified, pid: lock.pid, started_at: lock.started_at,
      owner_verified: verified
    }, null, 2));
  } catch {
    console.log(JSON.stringify({ mode, running: false }, null, 2));
  }
  process.exit(0);
}
if (action === "stop") {
  let owner;
  try { owner = JSON.parse(await readFile(lockPath, "utf8")); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    console.log(JSON.stringify({ mode, stopped: true, running: false }));
    process.exit(0);
  }
  if (!(await verifyOwnerIdentity(owner))) {
    throw new Error("cannot gracefully stop a stack without a verified live owner");
  }
  await writeStopRequest(stopRequestPath, owner);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const current = JSON.parse(await readFile(lockPath, "utf8"));
      if (current.token !== owner.token) break;
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  const current = await readFile(lockPath, "utf8").catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (current && JSON.parse(current).token === owner.token) throw new Error("stack graceful stop timed out");
  console.log(JSON.stringify({ mode, stopped: true, running: false }));
  process.exit(0);
}
if (action !== "serve") throw new Error("--action must be serve, status, stop or preflight");

const envPath = join(home, mode === "local" ? "local.env" : "server.env");
const configPath = join(home, "memory-config.yaml");
const dbPath = join(home, "memory", "memory.sqlite");
const stateRoot = join(home, "server");
const coreEntry = join(repoRoot, "vendor", "memory-core", "src", "server", "index.js");
const gatewayEntry = join(repoRoot, "dist", "mcp.js");
const bridgeEntry = join(repoRoot, "dist", "bridge.js");
const required = [envPath, configPath, coreEntry, gatewayEntry, ...(mode === "local" ? [bridgeEntry, join(home, "bridge.json")] : [])];
for (const path of required) {
  if (!existsSync(path)) throw new Error(`Memhub stack preflight: missing ${path}`);
}
const env = Object.fromEntries((await readFile(envPath, "utf8")).replace(/^\uFEFF/, "").split(/\r?\n/)
  .filter((line) => line && !line.trimStart().startsWith("#"))
  .map((line) => {
    const index = line.indexOf("=");
    if (index <= 0 || !/^MEMHUB_[A-Z0-9_]+$/.test(line.slice(0, index))) {
      throw new Error("invalid Memhub environment file");
    }
    return [line.slice(0, index), line.slice(index + 1)];
  }));
const coreUrl = `http://127.0.0.1:${corePort}/health`;
const gatewayUrl = `http://127.0.0.1:${gatewayPort}/memhub/health`;
const services = [
  {
    name: "core", kind: "core", entrypoint: coreEntry, cwd: repoRoot,
    args: ["--config", configPath, "--host", "127.0.0.1", "--port", String(corePort), "--db", dbPath],
    healthUrl: coreUrl
  },
  {
    name: "gateway", kind: "gateway", entrypoint: gatewayEntry, cwd: repoRoot,
    args: ["--http", String(gatewayPort), "--http-path", "/memhub/mcp", "--capture-path", "/memhub/capture", "--state-root", stateRoot,
      "--memory-url", `http://127.0.0.1:${corePort}`, ...(env.MEMHUB_PUBLIC_HOST ? ["--public-host", env.MEMHUB_PUBLIC_HOST] : [])],
    healthUrl: gatewayUrl, env: { ...env, MEMHUB_MEMORY_URL: `http://127.0.0.1:${corePort}` }
  },
  ...(mode === "local" ? [{
    name: "bridge", kind: "bridge", entrypoint: bridgeEntry, cwd: repoRoot,
    args: ["serve", "--port", String(bridgePort)], healthUrl: `http://127.0.0.1:${bridgePort}/health`,
    env: { MEMHUB_BRIDGE_HOME: home }
  }] : [])
];

await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
const token = randomUUID();
await acquireLock(lockPath, {
  pid: process.pid,
  token,
  started_at: new Date().toISOString(),
  entrypoint: stackEntrypoint,
  exec_path: resolve(process.execPath),
  home,
  mode
});
let stack;
let closing = false;
let exitCode = 0;
const lifecycleAbort = new AbortController();
let stopWatcher;
let stopRequestChecking = false;
let finish;
const finished = new Promise((resolveFinish) => { finish = resolveFinish; });
const emit = (event) => {
  console.error(JSON.stringify({ component: "memhub-stack", mode, ...event, timestamp: new Date().toISOString() }));
  if (event.type === "fatal") void shutdown(1);
};
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  lifecycleAbort.abort();
  if (stopWatcher) clearInterval(stopWatcher);
  exitCode = code;
  await stack?.stop();
  await releaseLock(lockPath, token);
  await clearOwnStopRequest(stopRequestPath, token);
  finish();
}
async function checkStopRequest() {
  if (closing || stopRequestChecking) return;
  stopRequestChecking = true;
  try {
    const request = JSON.parse(await readFile(stopRequestPath, "utf8"));
    if (request.token === token && request.pid === process.pid) await shutdown();
  } catch (error) {
    if (error?.code !== "ENOENT") console.error(JSON.stringify({ component: "memhub-stack", type: "stop_request_error", reason: error?.message }));
  } finally { stopRequestChecking = false; }
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
stopWatcher = setInterval(() => { void checkStopRequest(); }, 250);
try {
  stack = new ManagedProcessStack({ services, onEvent: emit });
  await stack.startWithRetry({ attempts: 5, signal: lifecycleAbort.signal });
  console.error(JSON.stringify({ component: "memhub-stack", mode, type: "stack_ready", pids: stack.status.pids }));
  await finished;
} catch (error) {
  if (closing && lifecycleAbort.signal.aborted) {
    await finished;
  } else {
    console.error(JSON.stringify({ component: "memhub-stack", mode, type: "startup_failed", error: error instanceof Error ? error.message : String(error) }));
    exitCode = 1;
    if (stopWatcher) clearInterval(stopWatcher);
    await stack?.stop();
    await releaseLock(lockPath, token);
    await clearOwnStopRequest(stopRequestPath, token);
  }
}
process.exitCode = exitCode;

async function writeStopRequest(path, owner) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: owner.pid, token: owner.token }) + "\n"); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => undefined); }
}

async function clearOwnStopRequest(path, expectedToken) {
  try {
    const request = JSON.parse(await readFile(path, "utf8"));
    if (request.token === expectedToken) await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") console.error(JSON.stringify({ component: "memhub-stack", type: "stop_cleanup_failed", reason: error?.message }));
  }
}

function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

async function acquireLock(path, owner) {
  try {
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(owner) + "\n"); }
    finally { await handle.close(); }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    // EEXIST is authoritative: no PID check can safely establish that a
    // stale-looking lock is ours to unlink (PID reuse and concurrent owner
    // replacement are both possible). Never auto-reclaim during serve.
    throw new Error("Memhub stack lock exists; refusing automatic takeover or stale-lock deletion");
  }
}

async function verifyOwnerIdentity(owner) {
  // During an in-place or side-by-side package upgrade, the new installer
  // must be able to ask the *previous* verified run-stack process to stop.
  // Never execute owner.entrypoint: verify the live process and send only the
  // authenticated stop request. Legacy locks without identity remain unsafe.
  const claimedEntrypoint = typeof owner?.entrypoint === "string"
    ? resolve(owner.entrypoint)
    : "";
  const priorWindowsEntrypoint = process.platform === "win32" &&
    basename(claimedEntrypoint).toLowerCase() === "run-stack.mjs" &&
    basename(dirname(claimedEntrypoint)).toLowerCase() === "scripts";
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
      typeof owner.token !== "string" || !owner.token ||
      typeof owner.started_at !== "string" || !Number.isFinite(Date.parse(owner.started_at)) ||
      !(claimedEntrypoint === stackEntrypoint || priorWindowsEntrypoint) ||
      typeof owner.exec_path !== "string" ||
      typeof owner.home !== "string" || resolve(owner.home) !== home ||
      owner.mode !== mode || !isAlive(owner.pid)) {
    return false;
  }
  if (process.platform !== "win32") return true;
  const identity = inspectWindowsProcess(owner.pid);
  if (!identity || !identity.ownerMatches) return false;
  const normalize = (value) => String(value ?? "").replaceAll("\\", "/").toLowerCase();
  if (normalize(resolve(identity.executablePath)) !== normalize(resolve(owner.exec_path)) ||
      !exactWindowsStackInvocation(identity.commandLine, owner.exec_path, claimedEntrypoint, home, mode)) {
    return false;
  }
  const processStarted = Date.parse(identity.startedAt);
  const lockStarted = Date.parse(owner.started_at);
  const lag = (lockStarted - processStarted) / 1000;
  return Number.isFinite(lag) && lag >= -2 && lag <= 30;
}

function exactWindowsStackInvocation(commandLine, nodePath, scriptPath, stateHome, edition) {
  // Require exact argv, including release entrypoint and state root, not
  // arbitrary substrings in a different Node process's command line.
  const normalize = (value) => String(value ?? "").replaceAll("\\", "/").toLowerCase();
  const escape = (value) => value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
  const command = normalize(commandLine);
  const pattern = new RegExp(
    '^\\s*"?' + escape(normalize(nodePath)) +
    '"?\\s+"?' + escape(normalize(scriptPath)) +
    '"?\\s+--mode\\s+' + edition +
    '\\s+--home\\s+"?' + escape(normalize(stateHome)) +
    '"?(?<extra>(?:\\s+--(?:core|gateway|bridge)-port\\s+[0-9]{1,5}){0,3})\\s*$'
  );
  const match = command.match(pattern);
  if (!match) return false;
  const ports = [...(match.groups?.extra ?? "").matchAll(/--(core|gateway|bridge)-port\s+(\d{1,5})/g)];
  return new Set(ports.map((port) => port[1])).size === ports.length &&
    ports.every((port) => Number(port[2]) >= 1 && Number(port[2]) <= 65535);
}

function inspectWindowsProcess(pid) {
  const command = [
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    'if ($null -eq $p) { exit 3 }',
    '$owner=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop',
    'if ($owner.ReturnValue -ne 0) { exit 4 }',
    '$record=[pscustomobject]@{ startedAt=$p.CreationDate.ToUniversalTime().ToString("o"); executablePath=[string]$p.ExecutablePath; commandLine=[string]$p.CommandLine; ownerMatches=($owner.Sid -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) }',
    '[Console]::Out.Write(($record | ConvertTo-Json -Compress))'
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000
  });
  if (result.status !== 0 || !result.stdout) return null;
  try {
    const record = JSON.parse(result.stdout.trim());
    if (!record.startedAt || !record.executablePath || !record.commandLine ||
        record.ownerMatches !== true) return null;
    return record;
  } catch { return null; }
}

async function releaseLock(path, expectedToken) {
  try {
    const owner = JSON.parse(await readFile(path, "utf8"));
    if (owner.token === expectedToken) await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") console.error(JSON.stringify({ component: "memhub-stack", type: "lock_cleanup_failed", reason: error?.message }));
  }
}
