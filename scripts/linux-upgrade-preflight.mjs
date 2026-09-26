#!/usr/bin/env node
// Read-only evidence for the generic Linux systemd deployment. This is NOT an
// upgrade executor, a lock, a backup, or authorization to change production.
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const script = fileURLToPath(import.meta.url);
const names = ["memhub-core.service", "memhub.service", "memhub-bridge.service", "memhub-stack.target"];
const protectedEntries = [
  ["gateway_accounts", ".memmy/memhub/accounts.json", "file"],
  ["gateway_devices", ".memmy/memhub/devices.json", "file"],
  ["gateway_bindings", ".memmy/memhub/conversation-project-bindings.json", "file"],
  ["gateway_projects", ".memmy/memhub/project-registry.json", "file"],
  ["gateway_capture_index", ".memmy/memhub/capture-index.sqlite", "file"],
  ["gateway_captures", ".memmy/memhub/captures", "directory"],
  ["gateway_distillation", ".memmy/memhub/distillation", "directory"],
  ["bridge_queue", ".memhub/queue", "directory"]
];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const flag = (line, key) => {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...line.matchAll(new RegExp(`(?:^|\\s)${escaped}\\s+(?:"([^"]+)"|(\\S+))(?=\\s|$)`, "g"))];
  return matches.length === 1 ? (matches[0][1] ?? matches[0][2]) : null;
};
const value = (source, key) => {
  const lines = source.split(/\r?\n/).filter((line) => line.startsWith(`${key}=`));
  return lines.length === 1 ? lines[0].slice(key.length + 1).trim() : null;
};
const expand = (input, home) => input ? resolve(input.replaceAll("%h", home)) : null;
const hasUnits = (source, key, required) => {
  const setting = source && value(source, key);
  return setting !== null && required.every((unit) => setting.split(/\s+/).includes(unit));
};
const sourceRoot = (command, suffix) => {
  if (!command) return null;
  const hits = [...command.matchAll(new RegExp(`(?:^|\\s)(/\\S+)${suffix}(?=\\s|$)`, "g"))];
  return hits.length === 1 ? hits[0][1] : null;
};
const pathFromUrl = (input) => {
  try {
    const url = new URL(input);
    return ["http:", "https:"].includes(url.protocol) ? url.pathname : null;
  } catch { return null; }
};

export async function inspectLinuxUpgrade(home = homedir()) {
  const root = resolve(home);
  const unitDir = join(root, ".config", "systemd", "user");
  const blockers = [];
  const units = {};
  const evidence = {};
  const read = async (path, label) => {
    try {
      const item = await lstat(path);
      if (!item.isFile() || item.isSymbolicLink()) {
        blockers.push(`${label}:not_regular_file`);
        return null;
      }
      const content = await readFile(path, "utf8");
      evidence[label] = digest(content);
      return content;
    } catch {
      blockers.push(`${label}:missing_or_unreadable`);
      return null;
    }
  };
  const checkEntry = async (path, label, kind) => {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() ||
          (kind === "file" ? !info.isFile() : !info.isDirectory())) {
        blockers.push(`${label}:unexpected_type_or_symlink`);
        return false;
      }
      return true;
    } catch {
      blockers.push(`${label}:missing_or_unreadable`);
      return false;
    }
  };
  const treeChecks = {
    gateway_state: await checkEntry(join(root, ".memmy", "memhub"), "gateway_state", "directory"),
    bridge_state: await checkEntry(join(root, ".memhub"), "bridge_state", "directory")
  };
  for (const [label, relative, kind] of protectedEntries) {
    treeChecks[label] = await checkEntry(join(root, relative), label, kind);
  }
  for (const name of names) units[name] = await read(join(unitDir, name), name);
  const env = await read(join(root, ".memmy", "memhub", "memhub.env"), "gateway_env");
  const config = await read(join(root, ".memmy", "config.yaml"), "core_config");
  const bridge = await read(join(root, ".memhub", "bridge.json"), "bridge_config");
  const coreUnit = units["memhub-core.service"];
  const gatewayUnit = units["memhub.service"];
  const bridgeUnit = units["memhub-bridge.service"];
  const stackTarget = units["memhub-stack.target"];
  const coreStart = coreUnit && value(coreUnit, "ExecStart");
  const gatewayStart = gatewayUnit && value(gatewayUnit, "ExecStart");
  const bridgeStart = bridgeUnit && value(bridgeUnit, "ExecStart");
  if (coreUnit && !coreStart) blockers.push("core_unit:ambiguous_exec");
  if (gatewayUnit && !gatewayStart) blockers.push("gateway_unit:ambiguous_exec");
  if (bridgeUnit && !bridgeStart) blockers.push("bridge_unit:ambiguous_exec");
  if (stackTarget && !hasUnits(stackTarget, "Requires", ["memhub-core.service", "memhub.service"])) {
    blockers.push("stack_target:missing_dependencies");
  }
  if (gatewayUnit && !hasUnits(gatewayUnit, "Requires", ["memhub-core.service"])) {
    blockers.push("gateway_unit:missing_core_dependency");
  }
  if (gatewayUnit && value(gatewayUnit, "EnvironmentFile") !== "-%h/.memmy/memhub/memhub.env") {
    blockers.push("gateway_unit:unexpected_environment_file");
  }
  if (bridgeUnit && !hasUnits(bridgeUnit, "Requires", ["memhub.service"])) {
    blockers.push("bridge_unit:missing_gateway_dependency");
  }
  const coreConfigPath = coreStart && expand(flag(coreStart, "--config"), root);
  const coreDbPath = coreStart && expand(flag(coreStart, "--db"), root);
  const gatewayRoot = gatewayStart && expand(flag(gatewayStart, "--state-root"), root);
  const httpPath = gatewayStart && flag(gatewayStart, "--http-path");
  const capturePath = gatewayStart && flag(gatewayStart, "--capture-path");
  const bridgeHome = bridgeUnit && value(bridgeUnit, "Environment");
  if (coreStart && !coreStart.includes("/vendor/memory-core/src/server/index.js ")) blockers.push("core_unit:unexpected_invocation");
  if (gatewayStart && !gatewayStart.includes("/dist/mcp.js ")) blockers.push("gateway_unit:unexpected_invocation");
  if (coreStart && coreConfigPath !== join(root, ".memmy", "config.yaml")) blockers.push("core_unit:unexpected_config_path");
  if (coreStart && !coreDbPath) blockers.push("core_unit:missing_database_path");
  if (gatewayStart && gatewayRoot !== join(root, ".memmy", "memhub")) blockers.push("gateway_unit:unexpected_state_root");
  if (bridgeUnit && bridgeHome !== '"MEMHUB_BRIDGE_HOME=%h/.memhub"') blockers.push("bridge_unit:unexpected_home");
  if (bridgeStart && !bridgeStart.includes("/dist/bridge.js serve ")) blockers.push("bridge_unit:unexpected_invocation");
  const roots = [sourceRoot(coreStart, "/vendor/memory-core/src/server/index\\.js"),
    sourceRoot(gatewayStart, "/dist/mcp\\.js"), sourceRoot(bridgeStart, "/dist/bridge\\.js")];
  if (roots.some((item) => !item) || new Set(roots).size !== 1) blockers.push("source:unit_roots_mismatch");
  if (gatewayStart && (!httpPath?.startsWith("/") || !capturePath?.startsWith("/") ||
      httpPath === capturePath)) blockers.push("gateway_unit:invalid_routes");
  const parsedEnv = {};
  if (env !== null) {
    for (const key of ["MEMHUB_MEMORY_TOKEN", "MEMHUB_OWNER_ACCOUNT_ID", "MEMHUB_BASE_PATH"]) {
      const lines = env.split(/\r?\n/).filter((line) => line.startsWith(`${key}=`));
      if (lines.length !== 1 || !lines[0].slice(key.length + 1).trim()) {
        blockers.push(`gateway_env:${key.toLowerCase()}_missing_or_duplicate`);
      } else parsedEnv[key] = lines[0].slice(key.length + 1).trim();
    }
  }
  let coreToken = null;
  let storageDb = null;
  if (config !== null) {
    try {
      const parsed = YAML.parse(config);
      coreToken = parsed?.memmyMemory?.storage?.token;
      storageDb = parsed?.memmyMemory?.storage?.sqlitePath;
    } catch { blockers.push("core_config:invalid_yaml"); }
    if (typeof coreToken !== "string" || !coreToken) blockers.push("core_config:missing_token");
    if (typeof storageDb !== "string" || !storageDb) blockers.push("core_config:missing_database");
  }
  if (coreToken && parsedEnv.MEMHUB_MEMORY_TOKEN && coreToken !== parsedEnv.MEMHUB_MEMORY_TOKEN) {
    blockers.push("credential:core_gateway_mismatch");
  }
  if (coreDbPath && storageDb && coreDbPath !== resolve(storageDb)) blockers.push("database:unit_config_mismatch");
  if (coreDbPath) {
    await checkEntry(coreDbPath, "database", "file");
  }
  const sqliteSidecars = {};
  if (coreDbPath) {
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const label = suffix.slice(1);
      try {
        const info = await lstat(coreDbPath + suffix);
        if (!info.isFile() || info.isSymbolicLink()) blockers.push(`database_${label}:unexpected_type_or_symlink`);
        sqliteSidecars[label] = true;
      } catch (error) {
        if (error?.code === "ENOENT") sqliteSidecars[label] = false;
        else blockers.push(`database_${label}:unreadable`);
      }
    }
  }
  const captureIndexPath = join(root, ".memmy", "memhub", "capture-index.sqlite");
  const captureIndexSidecars = {};
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const label = suffix.slice(1);
    try {
      const info = await lstat(captureIndexPath + suffix);
      if (!info.isFile() || info.isSymbolicLink()) {
        blockers.push(`capture_index_${label}:unexpected_type_or_symlink`);
      }
      captureIndexSidecars[label] = true;
    } catch (error) {
      if (error?.code === "ENOENT") captureIndexSidecars[label] = false;
      else blockers.push(`capture_index_${label}:unreadable`);
    }
  }
  let bridgeData;
  if (bridge !== null) {
    try { bridgeData = JSON.parse(bridge); }
    catch { blockers.push("bridge_config:invalid_json"); }
    if (bridgeData) {
      if (typeof bridgeData.device_token !== "string" || !bridgeData.device_token) {
        blockers.push("bridge_config:missing_device_token");
      }
      if (!pathFromUrl(bridgeData.mcp_endpoint) || !pathFromUrl(bridgeData.capture_endpoint)) {
        blockers.push("bridge_config:invalid_endpoint");
      } else if (pathFromUrl(bridgeData.mcp_endpoint) !== httpPath ||
          pathFromUrl(bridgeData.capture_endpoint) !== capturePath) {
        blockers.push("routing:bridge_gateway_mismatch");
      }
    }
  }
  // Source cannot prove a running process, ownership or an on-disk backup.
  // Never include tokens, env values, raw YAML/JSON or Bridge hostnames.
  return {
    format: "memhub-linux-generic-upgrade-readonly-v1",
    layout: "generic-systemd",
    evidence_sha256: evidence,
    routes: { gateway_mcp: httpPath ?? null, gateway_capture: capturePath ?? null,
      bridge_mcp_path: bridgeData ? pathFromUrl(bridgeData.mcp_endpoint) : null,
      bridge_capture_path: bridgeData ? pathFromUrl(bridgeData.capture_endpoint) : null },
    checks: { unit_files: names.length, gateway_core_token_match: Boolean(coreToken && parsedEnv.MEMHUB_MEMORY_TOKEN && coreToken === parsedEnv.MEMHUB_MEMORY_TOKEN),
      database_file_present: Boolean(coreDbPath && !blockers.some((entry) => entry.startsWith("database:"))),
      bridge_device_token_present: Boolean(bridgeData?.device_token),
      protected_entry_presence: treeChecks },
    backup_scope: {
      whole_trees: [".memmy/memhub", ".memhub"],
      separate_config: ".memmy/config.yaml",
      sqlite_database: ".memmy/memory-service/memory.sqlite",
      capture_index_database: ".memmy/memhub/capture-index.sqlite",
      sqlite_sidecars_observed: sqliteSidecars,
      capture_index_sidecars_observed: captureIndexSidecars,
      sqlite_consistent_backup_required: true,
      file_trees_require_writer_quiescence: true,
      includes_user_systemd_units: true
    },
    blockers,
    evidence_complete: blockers.length === 0,
    authorized_to_migrate: false,
    production_runtime_verified: false,
    bridge_endpoint_host_verified: false,
    backup_verified: false,
    requires_fresh_evidence_at_execution: true
  };
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const args = process.argv.slice(2);
  const home = args.length === 0 ? homedir() :
    args.length === 2 && args[0] === "--home" && isAbsolute(args[1]) ? args[1] : null;
  if (!home) {
    console.error("usage: node scripts/linux-upgrade-preflight.mjs [--home <absolute-home>]");
    process.exitCode = 2;
  } else {
    try {
      const result = await inspectLinuxUpgrade(home);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.evidence_complete ? 0 : 3;
    } catch {
      // Never serialize YAML parser errors or secrets from untrusted config.
      console.log(JSON.stringify({ evidence_complete: false, authorized_to_migrate: false,
        blockers: ["inspection:unexpected_error"] }));
      process.exitCode = 3;
    }
  }
}
