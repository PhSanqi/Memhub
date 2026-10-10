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
const state = join(home, ".memmy", "memhub");
const envPath = join(state, "memhub.env");
const corePath = join(home, ".memmy", "config.yaml");
const databasePath = join(home, ".memmy", "memory-service", "memory.sqlite");
const unit = (name) => join(unitDir, name);
const token = "private-core-token-not-for-reports";
const gatewayUnit = `[Unit]\nRequires=memhub-core.service\n[Service]\nEnvironmentFile=-%h/.memmy/memhub/memhub.env\nExecStart=/usr/bin/node /qa/dist/mcp.js --http 3001 --http-path /mcp --state-root %h/.memmy/memhub --memory-url http://127.0.0.1:18960\n`;
const coreUnit = `[Service]\nExecStart=/usr/bin/node /qa/vendor/memory-core/src/server/index.js --config %h/.memmy/config.yaml --db %h/.memmy/memory-service/memory.sqlite\n`;
const targetUnit = `[Unit]\nRequires=memhub-core.service memhub.service\nAfter=memhub-core.service memhub.service\n`;
const files = [unit("memhub.service"), unit("memhub-core.service"), unit("memhub-stack.target"), envPath, corePath, databasePath];

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
  await mkdir(state, { recursive: true });
  await mkdir(join(home, ".memmy", "memory-service"), { recursive: true });
  await mkdir(join(state, "captures"));
  await mkdir(join(state, "distillation"));
  await writeFile(join(state, "accounts.json"), "{}\n");
  await writeFile(join(state, "project-registry.json"), "{}\n");
  await writeFile(join(state, "capture-index.sqlite"), "fixture-index");
  await writeFile(unit("memhub.service"), gatewayUnit);
  await writeFile(unit("memhub-core.service"), coreUnit);
  await writeFile(unit("memhub-stack.target"), targetUnit);
  await writeFile(envPath, `MEMHUB_OWNER_ACCOUNT_ID=account-id\nMEMHUB_MEMORY_TOKEN=${token}\n`);
  await writeFile(corePath, `memmyMemory:\n  storage:\n    token: ${token}\n    sqlitePath: ${databasePath}\n`);
  await writeFile(databasePath, "protected-test-database");

  const before = await snapshot();
  const valid = await inspectLinuxUpgrade(home);
  assert.equal(valid.evidence_complete, true, JSON.stringify(valid.blockers));
  assert.deepEqual(valid.blockers, []);
  assert.equal(valid.layout, "core-plus-single-mcp-runtime");
  assert.deepEqual(valid.routes, { local_mcp: "/mcp", remote_transport: "cloudflare-to-same-mcp-runtime" });
  assert.equal(valid.checks.no_legacy_units, true);
  assert.equal(valid.checks.gateway_core_token_match, true);
  assert.ok(Object.values(valid.checks.protected_entry_presence).every(Boolean));
  assert.deepEqual(valid.backup_scope.whole_trees, [".memmy/memhub"]);
  assert.equal(valid.backup_scope.l1_index_database, ".memmy/memhub/capture-index.sqlite");
  assert.equal(valid.backup_scope.sqlite_consistent_backup_required, true);
  assert.equal(valid.authorized_to_migrate, false);
  assert.equal(valid.production_runtime_verified, false);
  assert.equal(valid.backup_verified, false);
  await assertUnchanged(before);

  const cli = spawnSync(process.execPath, [join(repo, "scripts/linux-upgrade-preflight.mjs"), home], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).evidence_complete, true);
  assert.doesNotMatch(cli.stdout, /private-core-token/);

  const rejects = async (path, changed, reason) => {
    const original = await readFile(path);
    await writeFile(path, changed);
    try {
      const outcome = await inspectLinuxUpgrade(home);
      assert.equal(outcome.evidence_complete, false, reason);
      assert.ok(outcome.blockers.includes(reason), JSON.stringify(outcome.blockers));
      assert.equal(outcome.authorized_to_migrate, false);
    } finally {
      await writeFile(path, original);
    }
  };

  await rejects(envPath, `MEMHUB_OWNER_ACCOUNT_ID=account-id\nMEMHUB_MEMORY_TOKEN=wrong\n`,
    "credential:core_gateway_mismatch");
  await rejects(envPath, `MEMHUB_OWNER_ACCOUNT_ID=account-id\nMEMHUB_MEMORY_TOKEN=${token}\nMEMHUB_MEMORY_TOKEN=${token}\n`,
    "gateway_env:memhub_memory_token_missing_or_duplicate");
  await rejects(unit("memhub.service"), gatewayUnit.replace("--state-root %h/.memmy/memhub", "--state-root %h/foreign"),
    "gateway_unit:unexpected_state_root");
  await rejects(unit("memhub.service"), gatewayUnit.replace("EnvironmentFile=-%h/.memmy/memhub/memhub.env", "EnvironmentFile=-%h/foreign.env"),
    "gateway_unit:unexpected_environment_file");
  await rejects(unit("memhub-core.service"), coreUnit.replace("--db %h/.memmy/memory-service/memory.sqlite", ""),
    "core_unit:missing_database_path");
  await rejects(unit("memhub-stack.target"), "[Unit]\nRequires=memhub-core.service\n",
    "stack_target:missing_dependencies");
  await rejects(unit("memhub.service"), gatewayUnit.replace("/qa/dist/mcp.js", "/other/dist/mcp.js"),
    "source:unit_roots_mismatch");

  // Legacy units are blockers only; current topology never depends on them.
  await writeFile(unit("memhub-bridge.service"), "[Service]\nExecStart=/old/dist/bridge.js serve --port 17861\n");
  const legacy = await inspectLinuxUpgrade(home);
  assert.ok(legacy.blockers.includes("legacy_unit_present:memhub-bridge.service"));
  assert.equal(legacy.evidence_complete, false);
  await rm(unit("memhub-bridge.service"));

  await rm(join(state, "accounts.json"));
  assert.ok((await inspectLinuxUpgrade(home)).blockers.includes("gateway_accounts:missing_or_unreadable"));
  await writeFile(join(state, "accounts.json"), "{}\n");

  await writeFile(databasePath + "-wal", "fixture-wal");
  assert.equal((await inspectLinuxUpgrade(home)).backup_scope.sqlite_sidecars_observed.memory.wal, true);
  await rm(databasePath + "-wal");
  const l1Wal = join(state, "capture-index.sqlite-wal");
  await writeFile(l1Wal, "fixture-l1-wal");
  assert.equal((await inspectLinuxUpgrade(home)).backup_scope.sqlite_sidecars_observed.l1_index.wal, true);
  await rm(l1Wal);

  await rm(databasePath);
  assert.ok((await inspectLinuxUpgrade(home)).blockers.includes("database:missing_or_unreadable"));
  await writeFile(databasePath, "protected-test-database");

  await rm(unit("memhub.service"));
  await symlink(join(home, "missing-unit"), unit("memhub.service"));
  assert.ok((await inspectLinuxUpgrade(home)).blockers.includes("memhub.service:not_regular_file"));
  await rm(unit("memhub.service"));
  await writeFile(unit("memhub.service"), gatewayUnit);
  assert.equal((await inspectLinuxUpgrade(home)).evidence_complete, true);

  console.log("linux-upgrade-preflight: ok");
} finally {
  await rm(home, { recursive: true, force: true });
}
