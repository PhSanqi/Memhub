import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectLinuxUpgrade } from "../scripts/linux-upgrade-preflight.mjs";

if (process.platform !== "linux") {
  console.log("linux-upgrade-preflight: skipped (linux only)");
  process.exit(0);
}

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const home = await mkdtemp(join(tmpdir(), "memhub-linux-upgrade-audit-"));
const unitDir = join(home, ".config", "systemd", "user");
const envPath = join(home, ".memmy", "memhub", "memhub.env");
const corePath = join(home, ".memmy", "config.yaml");
const bridgePath = join(home, ".memhub", "bridge.json");
const databasePath = join(home, ".memmy", "memory-service", "memory.sqlite");
const unit = (name) => join(unitDir, name);
const token = "private-core-token-not-for-reports";
const bridgeToken = "private-bridge-device-token-not-for-reports";
const gatewayUnit = `[Service]
Requires=memhub-core.service
EnvironmentFile=-%h/.memmy/memhub/memhub.env
ExecStart=/usr/bin/node /qa/dist/mcp.js --http 3001 --http-path /mcp --capture-path /capture --state-root %h/.memmy/memhub --memory-url http://127.0.0.1:18960
`;
const coreUnit = `[Service]
ExecStart=/usr/bin/node /qa/vendor/memory-core/src/server/index.js --config %h/.memmy/config.yaml --db %h/.memmy/memory-service/memory.sqlite
`;
const bridgeUnit = `[Service]
Requires=memhub.service
Environment="MEMHUB_BRIDGE_HOME=%h/.memhub"
ExecStart=/usr/bin/node /qa/dist/bridge.js serve --port 17861
`;
const bridgeConfig = {
  device_token: bridgeToken,
  mcp_endpoint: "https://private.example.test/mcp",
  capture_endpoint: "https://private.example.test/capture"
};
const files = [
  unit("memhub.service"), unit("memhub-core.service"),
  unit("memhub-bridge.service"), unit("memhub-stack.target"),
  envPath, corePath, bridgePath, databasePath
];
const snapshot = async () => Promise.all(files.map(async (path) => {
  const info = await stat(path);
  return { path, content: await readFile(path), mtime: info.mtimeMs };
}));
const assertUnchanged = async (before) => {
  for (const entry of before) {
    assert.deepEqual(await readFile(entry.path), entry.content);
    assert.equal((await stat(entry.path)).mtimeMs, entry.mtime);
  }
};
try {
  await mkdir(unitDir, { recursive: true });
  await mkdir(join(home, ".memmy", "memhub"), { recursive: true });
  await mkdir(join(home, ".memhub"), { recursive: true });
  await mkdir(join(home, ".memmy", "memory-service"), { recursive: true });
  await mkdir(join(home, ".memmy", "memhub", "captures"));
  await mkdir(join(home, ".memmy", "memhub", "distillation"));
  await mkdir(join(home, ".memhub", "queue"));
  for (const name of ["accounts.json", "devices.json", "conversation-project-bindings.json",
      "project-registry.json", "capture-index.sqlite"]) {
    await writeFile(join(home, ".memmy", "memhub", name), name.endsWith(".json") ? "{}" : "fixture-index");
  }
  await writeFile(unit("memhub.service"), gatewayUnit);
  await writeFile(unit("memhub-core.service"), coreUnit);
  await writeFile(unit("memhub-bridge.service"), bridgeUnit);
  await writeFile(unit("memhub-stack.target"), "[Unit]\nRequires=memhub-core.service memhub.service\n");
  await writeFile(envPath, `MEMHUB_OWNER_ACCOUNT_ID=account-id\nMEMHUB_MEMORY_TOKEN=${token}\nMEMHUB_BASE_PATH=/\n`);
  await writeFile(corePath, `memmyMemory:\n  storage:\n    token: ${token}\n    sqlitePath: ${databasePath}\n`);
  await writeFile(bridgePath, JSON.stringify(bridgeConfig));
  await writeFile(databasePath, "protected-test-database");

  const before = await snapshot();
  const valid = await inspectLinuxUpgrade(home);
  assert.equal(valid.evidence_complete, true);
  assert.deepEqual(valid.blockers, []);
  assert.equal(valid.authorized_to_migrate, false);
  assert.equal(valid.production_runtime_verified, false);
  assert.equal(valid.backup_verified, false);
  assert.deepEqual([valid.routes.gateway_mcp, valid.routes.gateway_capture], ["/mcp", "/capture"]);
  assert.deepEqual([valid.routes.bridge_mcp_path, valid.routes.bridge_capture_path], ["/mcp", "/capture"]);
  assert.equal(valid.checks.gateway_core_token_match, true);
  assert.ok(Object.values(valid.checks.protected_entry_presence).every(Boolean));
  assert.deepEqual(valid.backup_scope.whole_trees, [".memmy/memhub", ".memhub"]);
  assert.equal(valid.backup_scope.sqlite_consistent_backup_required, true);
  assert.equal(valid.backup_scope.capture_index_database, ".memmy/memhub/capture-index.sqlite");
  const cli = spawnSync(process.execPath, [join(repo, "scripts/linux-upgrade-preflight.mjs"), "--home", home], {
    encoding: "utf8"
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).evidence_complete, true);
  assert.doesNotMatch(cli.stdout, /private-core-token|private-bridge-device-token|private\.example\.test/);
  await assertUnchanged(before);

  const rejects = async (path, changed, reason) => {
    const original = await readFile(path);
    await writeFile(path, changed);
    try {
      const outcome = await inspectLinuxUpgrade(home);
      assert.equal(outcome.evidence_complete, false, reason);
      assert.ok(outcome.blockers.includes(reason), JSON.stringify(outcome.blockers));
      assert.equal(outcome.authorized_to_migrate, false);
    } finally { await writeFile(path, original); }
  };
  await rejects(envPath, `MEMHUB_OWNER_ACCOUNT_ID=account-id\nMEMHUB_MEMORY_TOKEN=wrong\nMEMHUB_BASE_PATH=/\n`,
    "credential:core_gateway_mismatch");
  await rejects(envPath, `MEMHUB_OWNER_ACCOUNT_ID=account-id\nMEMHUB_MEMORY_TOKEN=${token}\nMEMHUB_MEMORY_TOKEN=${token}\nMEMHUB_BASE_PATH=/\n`,
    "gateway_env:memhub_memory_token_missing_or_duplicate");
  await rejects(bridgePath, JSON.stringify({ ...bridgeConfig, capture_endpoint: "https://private.example.test/wrong" }),
    "routing:bridge_gateway_mismatch");
  await rejects(unit("memhub.service"), gatewayUnit.replace("--state-root %h/.memmy/memhub", "--state-root %h/foreign"),
    "gateway_unit:unexpected_state_root");
  await rejects(unit("memhub.service"), gatewayUnit.replace("EnvironmentFile=-%h/.memmy/memhub/memhub.env", "EnvironmentFile=-%h/foreign.env"),
    "gateway_unit:unexpected_environment_file");
  await rejects(unit("memhub-core.service"), coreUnit.replace("--db %h/.memmy/memory-service/memory.sqlite", ""),
    "core_unit:missing_database_path");
  await rejects(unit("memhub-stack.target"), "[Unit]\nRequires=memhub-core.service\n",
    "stack_target:missing_dependencies");
  await rejects(unit("memhub-bridge.service"), bridgeUnit.replace("Requires=memhub.service", "Requires=foreign.service"),
    "bridge_unit:missing_gateway_dependency");
  await rejects(unit("memhub-bridge.service"), bridgeUnit.replace("/qa/dist/bridge.js", "/another-build/dist/bridge.js"),
    "source:unit_roots_mismatch");
  await rm(join(home, ".memmy", "memhub", "accounts.json"));
  assert.ok((await inspectLinuxUpgrade(home)).blockers.includes("gateway_accounts:missing_or_unreadable"));
  await writeFile(join(home, ".memmy", "memhub", "accounts.json"), "{}");
  await writeFile(databasePath + "-wal", "fixture-wal");
  assert.equal((await inspectLinuxUpgrade(home)).backup_scope.sqlite_sidecars_observed.wal, true);
  await rm(databasePath + "-wal");
  const captureWal = join(home, ".memmy", "memhub", "capture-index.sqlite-wal");
  await writeFile(captureWal, "fixture-capture-wal");
  assert.equal((await inspectLinuxUpgrade(home)).backup_scope.capture_index_sidecars_observed.wal, true);
  await rm(captureWal);
  await rm(databasePath);
  assert.ok((await inspectLinuxUpgrade(home)).blockers.includes("database:missing_or_unreadable"));
  await writeFile(databasePath, "protected-test-database");
  await rm(unit("memhub.service"));
  await symlink(join(home, "missing-unit"), unit("memhub.service"));
  const linked = await inspectLinuxUpgrade(home);
  assert.ok(linked.blockers.includes("memhub.service:not_regular_file"));
  await rm(unit("memhub.service"));
  await writeFile(unit("memhub.service"), gatewayUnit);
  assert.equal((await inspectLinuxUpgrade(home)).evidence_complete, true);
  console.log("linux-upgrade-preflight: ok");
} finally {
  await rm(home, { recursive: true, force: true });
}
