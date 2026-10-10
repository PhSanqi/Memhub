#!/usr/bin/env node
// Read-only evidence for the canonical Linux systemd deployment. This script
// never stops services, writes state, creates a backup or authorizes upgrade.
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const currentUnits = ["memhub-core.service", "memhub.service", "memhub-stack.target"];
const legacyUnits = [
  "memhub-bridge.service", "memhub-local.service", "memhub-server.service",
  "memhub-local-stack.target", "memhub-server-stack.target"
];
const protectedEntries = [
  ["gateway_accounts", ".memmy/memhub/accounts.json", "file"],
  ["gateway_projects", ".memmy/memhub/project-registry.json", "file"],
  ["gateway_capture_index", ".memmy/memhub/capture-index.sqlite", "file"],
  ["gateway_captures", ".memmy/memhub/captures", "directory"],
  ["gateway_distillation", ".memmy/memhub/distillation", "directory"]
];

const digest = (value) => createHash("sha256").update(value).digest("hex");
const value = (source, key) => {
  const lines = source.split(/\r?\n/).filter((line) => line.startsWith(`${key}=`));
  return lines.length === 1 ? lines[0].slice(key.length + 1).trim() : null;
};
const flag = (line, key) => {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...line.matchAll(new RegExp(`(?:^|\\s)${escaped}\\s+(?:"([^"]+)"|(\\S+))(?=\\s|$)`, "g"))];
  return matches.length === 1 ? (matches[0][1] ?? matches[0][2]) : null;
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

export async function inspectLinuxUpgrade(home = homedir()) {
  const root = resolve(home);
  const unitDir = join(root, ".config", "systemd", "user");
  const blockers = [];
  const evidence = {};
  const units = {};

  const readRegular = async (path, label, required = true) => {
    try {
      const item = await lstat(path);
      if (!item.isFile() || item.isSymbolicLink()) {
        blockers.push(`${label}:not_regular_file`);
        return null;
      }
      const content = await readFile(path, "utf8");
      evidence[label] = digest(content);
      return content;
    } catch (error) {
      if (required || error?.code !== "ENOENT") blockers.push(`${label}:missing_or_unreadable`);
      return null;
    }
  };
  const checkEntry = async (path, label, kind) => {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || (kind === "file" ? !info.isFile() : !info.isDirectory())) {
        blockers.push(`${label}:unexpected_type_or_symlink`);
        return false;
      }
      return true;
    } catch {
      blockers.push(`${label}:missing_or_unreadable`);
      return false;
    }
  };

  for (const name of currentUnits) units[name] = await readRegular(join(unitDir, name), name);
  for (const name of legacyUnits) {
    try {
      await lstat(join(unitDir, name));
      blockers.push(`legacy_unit_present:${name}`);
    } catch (error) {
      if (error?.code !== "ENOENT") blockers.push(`legacy_unit_unreadable:${name}`);
    }
  }

  const env = await readRegular(join(root, ".memmy", "memhub", "memhub.env"), "gateway_env");
  const config = await readRegular(join(root, ".memmy", "config.yaml"), "core_config");
  const coreUnit = units["memhub-core.service"];
  const gatewayUnit = units["memhub.service"];
  const stackTarget = units["memhub-stack.target"];
  const coreStart = coreUnit && value(coreUnit, "ExecStart");
  const gatewayStart = gatewayUnit && value(gatewayUnit, "ExecStart");
  if (coreUnit && !coreStart) blockers.push("core_unit:ambiguous_exec");
  if (gatewayUnit && !gatewayStart) blockers.push("gateway_unit:ambiguous_exec");
  if (stackTarget && !hasUnits(stackTarget, "Requires", ["memhub-core.service", "memhub.service"])) {
    blockers.push("stack_target:missing_dependencies");
  }
  if (gatewayUnit && !hasUnits(gatewayUnit, "Requires", ["memhub-core.service"])) {
    blockers.push("gateway_unit:missing_core_dependency");
  }
  if (gatewayUnit && value(gatewayUnit, "EnvironmentFile") !== "-%h/.memmy/memhub/memhub.env") {
    blockers.push("gateway_unit:unexpected_environment_file");
  }

  const coreConfigPath = coreStart && expand(flag(coreStart, "--config"), root);
  const coreDbPath = coreStart && expand(flag(coreStart, "--db"), root);
  const gatewayRoot = gatewayStart && expand(flag(gatewayStart, "--state-root"), root);
  const httpPath = gatewayStart && flag(gatewayStart, "--http-path");
  if (coreStart && !coreStart.includes("/vendor/memory-core/src/server/index.js ")) blockers.push("core_unit:unexpected_invocation");
  if (gatewayStart && !gatewayStart.includes("/dist/mcp.js ")) blockers.push("gateway_unit:unexpected_invocation");
  if (coreStart && coreConfigPath !== join(root, ".memmy", "config.yaml")) blockers.push("core_unit:unexpected_config_path");
  if (coreStart && !coreDbPath) blockers.push("core_unit:missing_database_path");
  if (gatewayStart && gatewayRoot !== join(root, ".memmy", "memhub")) blockers.push("gateway_unit:unexpected_state_root");
  if (gatewayStart && !httpPath?.startsWith("/")) blockers.push("gateway_unit:invalid_mcp_route");
  const roots = [
    sourceRoot(coreStart, "/vendor/memory-core/src/server/index\\.js"),
    sourceRoot(gatewayStart, "/dist/mcp\\.js")
  ];
  if (roots.some((item) => !item) || new Set(roots).size !== 1) blockers.push("source:unit_roots_mismatch");

  const parsedEnv = {};
  if (env !== null) {
    for (const key of ["MEMHUB_MEMORY_TOKEN", "MEMHUB_OWNER_ACCOUNT_ID"]) {
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

  const treeChecks = {
    gateway_state: await checkEntry(join(root, ".memmy", "memhub"), "gateway_state", "directory")
  };
  for (const [label, relative, kind] of protectedEntries) {
    treeChecks[label] = await checkEntry(join(root, relative), label, kind);
  }
  if (coreDbPath) treeChecks.database = await checkEntry(coreDbPath, "database", "file");

  const sqliteSidecars = {};
  for (const [label, path] of [
    ["memory", coreDbPath],
    ["l1_index", join(root, ".memmy", "memhub", "capture-index.sqlite")]
  ]) {
    if (!path) continue;
    sqliteSidecars[label] = {};
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try {
        const info = await lstat(path + suffix);
        sqliteSidecars[label][suffix.slice(1)] = info.isFile() && !info.isSymbolicLink();
      } catch (error) {
        sqliteSidecars[label][suffix.slice(1)] = false;
        if (error?.code !== "ENOENT") blockers.push(`${label}_${suffix.slice(1)}:unreadable`);
      }
    }
  }

  return {
    format: "memhub-linux-upgrade-readonly-v2",
    layout: "core-plus-single-mcp-runtime",
    evidence_sha256: evidence,
    routes: { local_mcp: httpPath ?? null, remote_transport: "cloudflare-to-same-mcp-runtime" },
    checks: {
      unit_files: currentUnits.length,
      no_legacy_units: !blockers.some((item) => item.startsWith("legacy_unit_")),
      gateway_core_token_match: Boolean(coreToken && parsedEnv.MEMHUB_MEMORY_TOKEN && coreToken === parsedEnv.MEMHUB_MEMORY_TOKEN),
      protected_entry_presence: treeChecks
    },
    backup_scope: {
      whole_trees: [".memmy/memhub"],
      separate_config: ".memmy/config.yaml",
      sqlite_database: ".memmy/memory-service/memory.sqlite",
      l1_index_database: ".memmy/memhub/capture-index.sqlite",
      sqlite_sidecars_observed: sqliteSidecars,
      sqlite_consistent_backup_required: true,
      file_trees_require_writer_quiescence: true,
      includes_user_systemd_units: true
    },
    blockers,
    evidence_complete: blockers.length === 0,
    authorized_to_migrate: false,
    production_runtime_verified: false,
    backup_verified: false,
    requires_fresh_evidence_at_execution: true
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  inspectLinuxUpgrade(process.argv[2]).then((report) => {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (!report.evidence_complete) process.exitCode = 2;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
