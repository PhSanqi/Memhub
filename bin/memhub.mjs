#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveHome } from "../dist/state-root.mjs";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const stackEntry = join(packageRoot, "scripts", "run-stack.mjs");
const mcpEntry = join(packageRoot, "dist", "mcp.js");
const coreEntry = join(packageRoot, "vendor", "memory-core", "src", "server", "index.js");

const argv = process.argv.slice(2);
let command = argv[0] && !argv[0].startsWith("-") ? argv.shift() : "help";
if (consumeFlag(argv, "--help") || consumeFlag(argv, "-h")) command = "help";
if (consumeFlag(argv, "--version") || consumeFlag(argv, "-v")) command = "version";
const explicitHome = readValue(argv, ["--home", "--state-root"], undefined);
const home = resolve(explicitHome ?? resolveHome());
const corePort = readPort(argv, "--core-port", 18960);
const gatewayPort = readPort(argv, "--gateway-port", 3001);
const explicitUsername = readValue(argv, ["--username"], "");
const username = explicitUsername || "owner";
const edition = readEdition(argv, process.env.MEMHUB_EDITION ?? "local");
const publicHost = readPublicHost(argv, process.env.MEMHUB_PUBLIC_HOST ?? "");
const jsonOutput = consumeFlag(argv, "--json");
const accountAction = command === "account" ? argv.shift() : undefined;
const accountEmail = command === "account" && accountAction === "create" ? argv.shift() : undefined;

if (argv.length > 0) fail(`Unknown argument: ${argv[0]}`);
if (edition === "local" && publicHost) fail("--public-host is only valid with --edition server");

try {
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
  } else if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write(`${packageJson.version}\n`);
  } else if (command === "init") {
    const initialized = await initializeState(home, username, corePort, edition, publicHost);
    emit({ ok: true, command, home, edition, initialized }, `Memhub initialized at ${home} (${edition})`);
  } else if (command === "start" || command === "serve") {
    const initialized = await initializeState(home, username, corePort, edition, publicHost);
    if (initialized === "created") {
      process.stderr.write(`[memhub] initialized ${home} (${edition})\n`);
    }
    const result = runStack("serve", { home, corePort, gatewayPort, stdio: "inherit" });
    exitFrom(result);
  } else if (command === "status") {
    const result = runStack("status", { home, corePort, gatewayPort, stdio: "pipe" });
    const status = parseJsonOutput(result, "status");
    emit(status, status.running ? `Memhub is running (pid ${status.pid})` : "Memhub is not running");
  } else if (command === "stop") {
    const result = runStack("stop", { home, corePort, gatewayPort, stdio: "pipe" });
    const status = parseJsonOutput(result, "stop");
    emit(status, "Memhub stopped");
  } else if (command === "doctor") {
    const report = await doctor(home, corePort, gatewayPort);
    if (jsonOutput) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      for (const check of report.checks) {
        process.stdout.write(`${check.ok ? "[ok]" : "[!!]"} ${check.name}: ${check.detail}\n`);
      }
    }
    if (!report.ok) process.exitCode = 1;
  } else if (command === "endpoint") {
    const endpoint = await endpointInfo(home, gatewayPort);
    if (jsonOutput) {
      process.stdout.write(JSON.stringify(endpoint, null, 2) + "\n");
    } else {
      process.stdout.write(`Edition: ${endpoint.edition}\n`);
      process.stdout.write(`MCP: ${endpoint.mcp}\n`);
      process.stdout.write(`Auth: ${endpoint.auth}\n`);
      if (endpoint.origin_mcp !== endpoint.mcp) process.stdout.write(`Origin: ${endpoint.origin_mcp}\n`);
      if (endpoint.public_host_configured) {
        process.stdout.write("Note: public host is configured; Memhub does not provision the tunnel itself.\n");
      }
    }
  } else if (command === "account") {
    await accountCommand({ home, action: accountAction, email: accountEmail, username: explicitUsername, jsonOutput });
  } else {
    fail(`Unknown command: ${command}`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function printHelp() {
  process.stdout.write([
    `Memhub ${packageJson.version}`,
    "",
    "Usage:",
    "  memhub init [--edition local|server] [--home PATH] [--username NAME] [--public-host HOST]",
    "  memhub start [--edition local|server] [--home PATH] [--core-port PORT] [--gateway-port PORT] [--public-host HOST]",
    "  memhub status [--home PATH] [--json]",
    "  memhub stop [--home PATH] [--json]",
    "  memhub doctor [--home PATH] [--core-port PORT] [--gateway-port PORT] [--json]",
    "  memhub endpoint [--home PATH] [--gateway-port PORT] [--json]",
    "  memhub account create EMAIL [--username NAME] [--home PATH] [--json]",
    "  memhub account list [--home PATH] [--json]",
    "  memhub version",
    "",
    "Notes:",
    "  start auto-initializes a missing state root, then runs the single Memhub stack in the foreground.",
    "  local edition exposes MCP at http://127.0.0.1:3001/mcp for a local MCP host to connect.",
    "  server edition uses the same runtime; --public-host configures the authenticated public-host boundary.",
    "  endpoint reports the MCP URL from the initialized state. It does not create a Cloudflare tunnel.",
    "  account create/list are server-state wrappers around Memhub's existing account store; email is the bootstrap alias, not account_id.",
    "  User state is stored outside the npm package and is never removed by npm uninstall.",
    "  Default state root: ~/.memmy/memhub (existing legacy ~/.memhub data is used in place)",
    "  Default MCP endpoint after start: http://127.0.0.1:3001/mcp"
  ].join("\n") + "\n");
}

async function initializeState(stateRoot, accountName, memoryPort, selectedEdition, selectedPublicHost) {
  const configPath = join(stateRoot, "memory-config.yaml");
  const envPath = join(stateRoot, "memhub.env");
  const controlRoot = join(stateRoot, "server");
  if (existsSync(stateRoot)) {
    if (existsSync(configPath) && existsSync(envPath) && existsSync(controlRoot)) return "existing";
    throw new Error(`State root exists but is not a complete Memhub installation: ${stateRoot}`);
  }
  if (!existsSync(mcpEntry) || !existsSync(coreEntry) || !existsSync(stackEntry)) {
    throw new Error("Memhub package is incomplete; required runtime files are missing");
  }

  const parent = dirname(stateRoot);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporaryRoot = await mkdtemp(join(parent, ".memhub-init-"));
  const temporaryControl = join(temporaryRoot, "server");
  const temporaryMemory = join(temporaryRoot, "memory");
  const token = randomBytes(32).toString("hex");
  try {
    await mkdir(temporaryControl, { recursive: true, mode: 0o700 });
    await mkdir(temporaryMemory, { recursive: true, mode: 0o700 });
    const config = {
      memmyMemory: {
        version: 1,
        userId: "local-user",
        roleRouting: { summary: "follow", evolution: "follow" },
        storage: {
          mode: "local",
          backend: "sqlite",
          sqlitePath: join(stateRoot, "memory", "memory.sqlite"),
          endpoint: `http://127.0.0.1:${memoryPort}`,
          token
        },
        algorithm: { enableMemoryAdd: true, enableMemorySearch: true, enableQueryRewrite: false },
        agentAccess: { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false }
      },
      providers: {},
      modelAssignments: { default: null, memorySummary: null, memoryEvolution: null, embedding: null, asr: null, imageGeneration: null },
      modelPresets: {},
      app: {}
    };
    await writeFile(join(temporaryRoot, "memory-config.yaml"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });

    const accountResult = spawnSync(process.execPath, [mcpEntry, "account", "add", accountName, "--state-root", temporaryControl], {
      cwd: packageRoot,
      env: { ...process.env, MEMHUB_STATE_ROOT: temporaryControl },
      encoding: "utf8"
    });
    if (accountResult.error) throw accountResult.error;
    if (accountResult.status !== 0) {
      throw new Error(`Could not create local Memhub account: ${(accountResult.stderr || accountResult.stdout || "unknown error").trim()}`);
    }
    const account = JSON.parse(accountResult.stdout);
    if (!account?.account_id) throw new Error("Memhub account initialization returned no account_id");

    const envLines = [
      `MEMHUB_ACCOUNT_ID=${account.account_id}`,
      `MEMHUB_OWNER_ACCOUNT_ID=${account.account_id}`,
      "MEMHUB_OWNER_USER_ID=local-user",
      `MEMHUB_EDITION=${selectedEdition}`,
      `MEMHUB_MEMORY_TOKEN=${token}`,
      `MEMHUB_MEMORY_URL=http://127.0.0.1:${memoryPort}`,
      `MEMHUB_STATE_ROOT=${join(stateRoot, "server")}`
    ];
    if (selectedEdition === "server" && selectedPublicHost) {
      envLines.push(`MEMHUB_PUBLIC_HOST=${selectedPublicHost}`);
    }
    envLines.push("");
    await writeFile(join(temporaryRoot, "memhub.env"), envLines.join("\n"), { mode: 0o600 });

    await chmod(temporaryRoot, 0o700).catch(() => undefined);
    await rename(temporaryRoot, stateRoot);
    return "created";
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function runStack(action, { home: stateRoot, corePort: core, gatewayPort: gateway, stdio }) {
  return spawnSync(process.execPath, [
    stackEntry,
    "--home", stateRoot,
    "--action", action,
    "--core-port", String(core),
    "--gateway-port", String(gateway)
  ], {
    cwd: packageRoot,
    env: { ...process.env, MEMHUB_HOME: stateRoot },
    encoding: stdio === "pipe" ? "utf8" : undefined,
    stdio
  });
}

async function doctor(stateRoot, core, gateway) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  add("node", Number(process.versions.node.split(".")[0]) >= 20, process.version);
  for (const [name, path] of [["mcp runtime", mcpEntry], ["memory core", coreEntry], ["stack owner", stackEntry]]) {
    add(name, existsSync(path), existsSync(path) ? "present" : `missing: ${path}`);
  }
  const initialized = existsSync(join(stateRoot, "memory-config.yaml")) && existsSync(join(stateRoot, "memhub.env")) && existsSync(join(stateRoot, "server"));
  add("state", initialized, initialized ? stateRoot : `not initialized: ${stateRoot}`);

  const statusResult = runStack("status", { home: stateRoot, corePort: core, gatewayPort: gateway, stdio: "pipe" });
  let status = { running: false };
  if (statusResult.status === 0) {
    try { status = JSON.parse(statusResult.stdout || "{}"); } catch { /* report below */ }
  }
  add("stack", status.running === true, status.running ? `running pid=${status.pid}` : "not running");

  if (status.running) {
    const [coreHealth, gatewayHealth] = await Promise.all([
      health(`http://127.0.0.1:${core}/health`),
      health(`http://127.0.0.1:${gateway}/memhub/health`)
    ]);
    add("core health", coreHealth.ok, coreHealth.detail);
    add("gateway health", gatewayHealth.ok, gatewayHealth.detail);
  }
  return { ok: checks.every((check) => check.ok || (check.name === "stack" && !status.running)), home: stateRoot, version: packageJson.version, checks };
}

async function endpointInfo(stateRoot, gateway) {
  const envPath = join(stateRoot, "memhub.env");
  if (!existsSync(envPath)) throw new Error(`Memhub is not initialized: ${stateRoot}`);
  const configured = parseEnvFile(await readFile(envPath, "utf8"));
  const configuredEdition = configured.MEMHUB_EDITION === "server" ? "server" : "local";
  const configuredPublicHost = (configured.MEMHUB_PUBLIC_HOST ?? "").trim().toLowerCase();
  const originMcp = `http://127.0.0.1:${gateway}/mcp`;
  const publicMcp = configuredEdition === "server" && configuredPublicHost
    ? `https://${configuredPublicHost}/mcp`
    : null;
  return {
    ok: true,
    command: "endpoint",
    home: stateRoot,
    edition: configuredEdition,
    mcp: publicMcp ?? originMcp,
    origin_mcp: originMcp,
    public_host: configuredPublicHost || null,
    public_host_configured: Boolean(publicMcp),
    auth: publicMcp ? "cloudflare-access" : configuredEdition === "local" ? "local-owner" : "loopback-only"
  };
}

async function accountCommand({ home: stateRoot, action, email, username: requestedUsername, jsonOutput: asJson }) {
  const controlRoot = join(stateRoot, "server");
  if (!existsSync(join(stateRoot, "memhub.env")) || !existsSync(controlRoot)) {
    throw new Error(`Memhub is not initialized: ${stateRoot}`);
  }
  if (action === "list") {
    const result = runMcpAdmin(["account", "list", "--state-root", controlRoot]);
    const accounts = parseJsonOutput(result, "account list");
    if (asJson) {
      process.stdout.write(JSON.stringify(accounts, null, 2) + "\n");
      return;
    }
    if (!Array.isArray(accounts) || accounts.length === 0) {
      process.stdout.write("No Memhub accounts.\n");
      return;
    }
    for (const account of accounts) {
      const label = account.cloudflare_email || account.username;
      process.stdout.write(`${label}\t${account.account_id}\t${account.role ?? "user"}\n`);
    }
    return;
  }
  if (action === "create") {
    if (!email) throw new Error("memhub account create requires EMAIL");
    const normalizedEmail = email.trim().toLowerCase();
    const accountUsername = requestedUsername || usernameFromEmail(normalizedEmail);
    const result = runMcpAdmin(["account", "add", accountUsername, normalizedEmail, "--state-root", controlRoot]);
    const account = parseJsonOutput(result, "account create");
    const output = { ...account, email: normalizedEmail };
    if (asJson) process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    else process.stdout.write(`Created ${normalizedEmail} (${account.account_id})\n`);
    return;
  }
  throw new Error("memhub account supports create or list");
}

function runMcpAdmin(args) {
  const result = spawnSync(process.execPath, [mcpEntry, ...args], {
    cwd: packageRoot,
    env: { ...process.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Memhub account command failed").trim());
  }
  return result;
}

function usernameFromEmail(email) {
  const at = email.indexOf("@");
  const localPart = at > 0 ? email.slice(0, at) : "user";
  const stem = localPart
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 44) || "user";
  const digest = createHash("sha256").update(email, "utf8").digest("hex").slice(0, 10);
  return `${stem}-${digest}`.slice(0, 64);
}

function parseEnvFile(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
}

async function health(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return { ok: response.ok, detail: `${response.status} ${response.statusText}`.trim() };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function readValue(args, names, fallback) {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index < 0) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    args.splice(index, 2);
    return value;
  }
  return fallback;
}

function readPort(args, name, fallback) {
  const raw = readValue(args, [name], String(fallback));
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`${name} must be a TCP port`);
  return parsed;
}

function readEdition(args, fallback) {
  const value = readValue(args, ["--edition"], fallback).trim().toLowerCase();
  if (value !== "local" && value !== "server") throw new Error("--edition must be local or server");
  return value;
}

function readPublicHost(args, fallback) {
  const value = readValue(args, ["--public-host"], fallback).trim().toLowerCase();
  if (!value) return "";
  if (value.includes("/") || value.includes(":")) throw new Error("--public-host must be a hostname");
  return value;
}

function consumeFlag(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function parseJsonOutput(result, action) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Memhub ${action} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
  try { return JSON.parse(result.stdout || "{}"); }
  catch { throw new Error(`Memhub ${action} returned invalid output`); }
}

function exitFrom(result) {
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  process.exitCode = result.status ?? 1;
}

function emit(payload, text) {
  if (jsonOutput) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  else process.stdout.write(text + "\n");
}

function fail(message) {
  process.stderr.write(`[memhub] ${message}\n`);
  process.exitCode = 1;
}
