import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("memhub-windows-installer-credential-e2e: skipped (Windows-only PowerShell)");
  process.exit(0);
}

const root = await mkdtemp(join(tmpdir(), "memhub-win-installer-credentials-"));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
const powershell = (code) => spawnSync("powershell.exe", [
  "-NoProfile", "-NonInteractive", "-EncodedCommand",
  Buffer.from(code, "utf16le").toString("base64")
], { encoding: "utf8", timeout: 15_000, windowsHide: true });

try {
  for (const edition of ["local", "server"]) {
    const source = await readFile(new URL(`../editions/${edition}/windows/install.ps1`, import.meta.url), "utf8");
    const guardStart = source.indexOf(edition === "local"
      ? "# Resolve existing credentials before stopping"
      : "# Preserve the original Core token");
    const guardEnd = source.indexOf("$StackEntry = ", guardStart);
    const initializeStart = source.indexOf("if (-not $MemoryToken) {", guardEnd);
    const initializeEnd = source.indexOf("\n$Accounts =", initializeStart);
    assert.ok(guardStart >= 0 && guardEnd > guardStart && initializeEnd > initializeStart,
      edition + " installer credential extraction boundaries");
    assert.ok(guardEnd < source.indexOf("--action stop"),
      "credential validation must run before stopping a live owner");
    const guard = source.slice(guardStart, guardEnd);
    const initialize = source.slice(initializeStart, initializeEnd);
    const stateRoot = join(root, edition);
    const memoryDir = join(stateRoot, "memory");
    const configPath = join(stateRoot, "memory-config.yaml");
    await mkdir(memoryDir, { recursive: true });
    const invoke = () => powershell([
      '$ErrorActionPreference = "Stop"',
      `$StateRoot = ${quote(stateRoot)}`,
      `$MemoryDir = ${quote(memoryDir)}`,
      `$ConfigPath = ${quote(configPath)}`,
      `$Node = ${quote(process.execPath)}`,
      `$RepoRoot = ${quote(repoRoot)}`,
      guard,
      initialize,
      'Write-Output ("TOKEN=" + $MemoryToken)'
    ].join("\n"));
    const fresh = invoke();
    assert.equal(fresh.status, 0, edition + " first install: " + fresh.stderr);
    const config = JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/, ""));
    const firstToken = config.memmyMemory.storage.token;
    assert.match(firstToken, /^[0-9a-f]{64}$/i);
    assert.match(fresh.stdout, new RegExp("TOKEN=" + firstToken));
    config.modelPresets = { localCustom: { id: "do-not-overwrite" } };
    config.providers = { testProvider: { id: "stable-user-configuration" } };
    const customized = JSON.stringify(config, null, 2) + "\n";
    await writeFile(configPath, customized);
    const baseline = digest(await readFile(configPath));
    for (const phase of ["reinstall", "upgrade", "rollback"]) {
      const replay = invoke();
      assert.equal(replay.status, 0, edition + " " + phase + ": " + replay.stderr);
      assert.match(replay.stdout, new RegExp("TOKEN=" + firstToken));
      assert.equal(digest(await readFile(configPath)), baseline,
        edition + " " + phase + " must preserve the exact Memory config bytes");
    }

    // Memory Core rewrites JSON-compatible memory-config.yaml into YAML on
    // first launch. Reinstall must preserve this rewritten form byte for byte.
    const rewrittenYaml = [
      "app: {}",
      "providers:",
      "  userProvider:",
      "    protected: keep-on-upgrade",
      "memmyMemory:",
      "  userId: local-user",
      "  storage:",
      "    mode: local",
      `    token: ${firstToken}`,
      "    backend: sqlite",
      ""
    ].join("\n");
    await writeFile(configPath, rewrittenYaml);
    const yamlResult = invoke();
    assert.equal(yamlResult.status, 0, edition + " Core-rewritten YAML reinstall: " + yamlResult.stderr);
    assert.match(yamlResult.stdout, new RegExp("TOKEN=" + firstToken));
    assert.equal(await readFile(configPath, "utf8"), rewrittenYaml);

    const invalid = '{"memmyMemory":{"storage":{"token":""}}}\n';
    await writeFile(configPath, invalid);
    const missing = invoke();
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /missing its storage token/i);
    assert.equal(await readFile(configPath, "utf8"), invalid);

    const malformed = '{bad-json}\n';
    await writeFile(configPath, malformed);
    const badJson = invoke();
    assert.notEqual(badJson.status, 0);
    assert.match(badJson.stderr, /unreadable/i);
    assert.equal(await readFile(configPath, "utf8"), malformed);

    await rm(configPath);
    await writeFile(join(memoryDir, "memory.sqlite"), "protected simulated database");
    const orphan = invoke();
    assert.notEqual(orphan.status, 0);
    assert.match(orphan.stderr, /database has no config/i);
    await assert.rejects(readFile(configPath), { code: "ENOENT" });
    assert.equal(await readFile(join(memoryDir, "memory.sqlite"), "utf8"), "protected simulated database");
  }
  console.log("memhub-windows-installer-credential-e2e: ok (local + server)");
  const ownership = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    join(repoRoot, "tests", "windows-task-ownership-e2e.ps1")
  ], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.equal(ownership.status, 0,
    "Windows scheduled-task ownership regression: " + ownership.stderr + ownership.stdout);
  console.log(ownership.stdout.trim());
  const stackOwner = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    join(repoRoot, "tests", "windows-stack-owner-e2e.ps1")
  ], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.equal(stackOwner.status, 0,
    "Windows stack PID/start/path regression: " + stackOwner.stderr + stackOwner.stdout);
  console.log(stackOwner.stdout.trim());
  const legacyAudit = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    join(repoRoot, "tests", "windows-legacy-migration-audit-e2e.ps1")
  ], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.equal(legacyAudit.status, 0,
    "Windows legacy migration read-only audit: " + legacyAudit.stderr + legacyAudit.stdout);
  console.log(legacyAudit.stdout.trim());
  const stackRuntime = spawnSync(process.execPath, [
    join(repoRoot, "tests", "stack-runtime-smoke-windows.mjs")
  ], { encoding: "utf8", timeout: 90_000, windowsHide: true });
  assert.equal(stackRuntime.status, 0,
    "Windows real-stack owner isolation: " + stackRuntime.stderr + stackRuntime.stdout);
  console.log(stackRuntime.stdout.trim());
  const stopTimeout = spawnSync(process.execPath, [
    join(repoRoot, "tests", "windows-stack-stop-timeout-e2e.mjs")
  ], { encoding: "utf8", timeout: 40_000, windowsHide: true });
  assert.equal(stopTimeout.status, 0,
    "Windows bounded cooperative-stop timeout: " + stopTimeout.stderr + stopTimeout.stdout);
  console.log(stopTimeout.stdout.trim());
} finally {
  await rm(root, { recursive: true, force: true });
}
