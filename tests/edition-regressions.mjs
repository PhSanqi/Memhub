import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const pluginJson = JSON.parse(await readFile(new URL("../adapters/plugin/plugin.json", import.meta.url), "utf8"));
assert.equal(pluginJson.version, packageJson.version, "plugin and runtime release versions must stay aligned");
assert.equal(packageJson.version, "0.2.6", "release regression expects the v0.2.6 line");

const editions = [
  {
    path: "editions/local/linux/install.sh",
    autoScan: "agentAccess: { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false }"
  },
  {
    path: "editions/server/linux/install.sh",
    autoScan: "agentAccess:{autoScanKnownAgents:false,watchFileChanges:false,autoInjectSkill:false}"
  },
  {
    path: "editions/local/windows/install.ps1",
    autoScan: 'agentAccess = @{ autoScanKnownAgents = $false; watchFileChanges = $false; autoInjectSkill = $false }'
  },
  {
    path: "editions/server/windows/install.ps1",
    autoScan: 'agentAccess = @{ autoScanKnownAgents = $false; watchFileChanges = $false; autoInjectSkill = $false }'
  }
];

for (const edition of editions) {
  const url = new URL("../" + edition.path, import.meta.url);
  try {
    await access(url);
  } catch {
    continue;
  }
  const source = await readFile(url, "utf8");
  assert.ok(source.includes(edition.autoScan), edition.path + ": AgentSource auto scan must be opt-in");
  assert.doesNotMatch(source, /normify/i, edition.path + ": retired Normify integration must not be installed");
}

const releaseScript = await readFile(new URL("../scripts/package-release.mjs", import.meta.url), "utf8");
for (const id of ["linux-local", "linux-server", "windows-local", "windows-server"]) {
  assert.match(releaseScript, new RegExp(`id: ["']${id}["']`), `release packaging must include ${id}`);
}
assert.match(releaseScript, /release-manifest\.json/, "release packaging must emit a commit-bound manifest");
assert.match(releaseScript, /SHA256SUMS\.txt/, "release packaging must emit checksums");

const deployInstaller = await readFile(new URL("../deploy/install-user-service.sh", import.meta.url), "utf8");
const deployUnit = await readFile(new URL("../deploy/memhub.service.in", import.meta.url), "utf8");
assert.doesNotMatch(deployInstaller, /vendor\/normify/i, "deploy installer must not require retired Normify vendor files");
assert.match(deployInstaller, /MEMHUB_BASE_PATH/, "deploy installer must preserve configured web base path");
assert.match(deployInstaller, /MEMHUB_HTTP_PATH/, "deploy installer must allow explicit MCP path override");
assert.match(deployInstaller, /MEMHUB_CAPTURE_PATH/, "deploy installer must allow explicit capture path override");
assert.match(deployUnit, /--architecture-root @ARCHITECTURE_ROOT@/, "deploy unit must use the architecture reader name");
assert.match(deployUnit, /--http-path @HTTP_PATH@/, "deploy unit must render the selected MCP path");
assert.match(deployUnit, /--capture-path @CAPTURE_PATH@/, "deploy unit must render the selected capture path");
assert.match(deployUnit, /ExecStartPre=.*wait-for-service.*--kind core/, "Gateway must wait for Core readiness");
assert.match(deployUnit, /ExecStartPost=.*wait-for-service.*--kind gateway/, "Gateway must report actual HTTP readiness");
assert.match(deployUnit, /@HEALTH_PATH@/, "health endpoint must follow the configured web base path");
const deployCoreUnit = await readFile(new URL("../deploy/memhub-core.service.in", import.meta.url), "utf8");
const deployBridgeUnit = await readFile(new URL("../deploy/memhub-bridge.service.in", import.meta.url), "utf8");
const deployTarget = await readFile(new URL("../deploy/memhub-stack.target.in", import.meta.url), "utf8");
const deployBridgeInstaller = await readFile(new URL("../deploy/install-bridge-user-service.sh", import.meta.url), "utf8");
const cloudflareGuide = await readFile(new URL("../docs/operations/cloudflare-tunnel.md", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const readmeZh = await readFile(new URL("../README.zh-CN.md", import.meta.url), "utf8");
assert.match(deployCoreUnit, /ExecStartPost=.*--kind core/);
assert.match(deployBridgeUnit, /ExecStartPost=.*--kind bridge/);
assert.match(deployBridgeUnit, /ExecStartPre=.*--kind gateway/, "Bridge must wait for the Gateway readiness endpoint");
assert.match(deployBridgeUnit, /Requires=memhub\.service/, "Bridge must depend on the Gateway service");
assert.match(deployBridgeUnit, /PartOf=memhub\.service memhub-stack\.target/, "Bridge restart/stop lifecycle must follow Gateway and stack target");
assert.match(deployBridgeUnit, /WantedBy=memhub-stack\.target/, "enabled Bridge must join the Memhub stack target");
assert.match(deployBridgeInstaller, /@HEALTH_PATH@/, "Bridge installer must render the configured Gateway health path");
assert.match(deployBridgeInstaller, /memhub-stack\.target is missing/, "Bridge installer must require the base Memhub stack first");
assert.match(deployTarget, /Requires=memhub-core\.service memhub\.service/);
for (const [name, source] of [["README.md", readme], ["README.zh-CN.md", readmeZh], ["docs/operations/cloudflare-tunnel.md", cloudflareGuide]]) {
  assert.match(source, /https:\/\/memhub\.sanqi\.org\//, name + ": canonical production route must be explicit");
}
assert.doesNotMatch(cloudflareGuide, /plugin\.sanqi\.org\/memhub/, "operations guide must not retain the retired production route");
assert.doesNotMatch(readme, /plugin\.sanqi\.org\/memhub/, "main README must not advertise the retired route");
assert.doesNotMatch(readmeZh, /plugin\.sanqi\.org\/memhub/, "Chinese README must not advertise the retired route");
const completePackager = await readFile(new URL("../scripts/package-complete-release.mjs", import.meta.url), "utf8");
const completeSmoke = await readFile(new URL("../scripts/complete-runtime-smoke.cjs", import.meta.url), "utf8");
const windowsTaskOwnership = await readFile(new URL("../scripts/windows-task-ownership.ps1", import.meta.url), "utf8");
const windowsStackOwner = await readFile(new URL("../scripts/windows-stack-owner.ps1", import.meta.url), "utf8");
const managedStack = await readFile(new URL("../scripts/run-stack.mjs", import.meta.url), "utf8");
assert.match(managedStack, /exactWindowsStackInvocation/, "direct Node stop must compare the full process invocation");
assert.match(managedStack, /GetOwnerSid/, "direct Node stop must verify the process principal");
assert.match(managedStack, /owner_verified: verified/, "status must report verified ownership rather than PID presence");
assert.doesNotMatch(managedStack, /commandLine\.includes\(normalize\(claimedEntrypoint\)\)/,
  "substring entrypoint matching is not proof of stack identity");
assert.match(windowsStackOwner, /Get-CimInstance -ClassName Win32_Process -Filter/, "stop guard must inspect one exact owner PID");
assert.match(windowsStackOwner, /CreationDate/, "stop guard must check actual OS process start time");
assert.match(windowsStackOwner, /ExecutablePath/, "stop guard must check the real Node executable");
assert.match(windowsStackOwner, /GetOwnerSid/, "stop guard must verify the process principal");
assert.match(windowsStackOwner, /partial identity metadata/, "cross-release owner must have a complete lock identity");
assert.match(windowsStackOwner, /Previous stack entrypoint is not a managed run-stack script/,
  "cross-release stop must not accept an arbitrary script as a previous managed owner");
assert.match(windowsStackOwner, /declaredHome, \$stateHome/,
  "cross-release stop must verify the exact StateRoot");
assert.match(windowsStackOwner, /CommandLine/, "stop guard must check exact stack argv");
assert.doesNotMatch(windowsStackOwner, /Stop-Process|Kill\(|Remove-Item/, "owner guard must not terminate or purge processes");
assert.match(windowsTaskOwnership, /Get-ScheduledTask -TaskPath/, "Task identity must come from Task Scheduler");
assert.match(windowsTaskOwnership, /WindowsIdentity/, "Task owner must match the current user");
assert.match(windowsTaskOwnership, /Legacy Memhub tasks/, "Legacy tasks must fail closed without an approved migration");
assert.match(windowsTaskOwnership, /Launcher = "memory\.cmd"/, "v0.2.2 Local Memory launcher must not be mistaken for Server");
assert.match(windowsTaskOwnership, /Launcher = "gateway\.cmd"/, "v0.2.2 Local Gateway launcher must not be mistaken for Server");
assert.match(windowsTaskOwnership, /Launcher = "bridge\.cmd"/, "v0.2.2 Local Bridge launcher must not be mistaken for Server");
const legacyAudit = await readFile(new URL("../scripts/windows-legacy-migration-audit.ps1", import.meta.url), "utf8");
const legacyPlan = await readFile(new URL("../scripts/windows-legacy-migration-plan.ps1", import.meta.url), "utf8");
const historicalRehearsal = await readFile(new URL("../tests/windows-historical-split-upgrade-failclosed-e2e.ps1", import.meta.url), "utf8");
assert.match(historicalRehearsal, /CompatTokenQuote/, "historical Node quoting adaptation must be explicit and test-only");
assert.match(historicalRehearsal, /Legacy Memhub tasks/, "real historical split-task rehearsal must refuse unauthorized migration");
assert.match(historicalRehearsal, /task_scheduler=shim/, "historical rehearsal must label the simulated scheduler");
assert.match(historicalRehearsal, /\.original/, "historical test must preserve original source before compatibility adjustment");
assert.match(legacyPlan, /ready_to_apply = \$false/, "legacy migration plan cannot grant approval");
assert.match(legacyPlan, /authorized_to_migrate = \$false/, "legacy migration plan must remain read-only");
assert.doesNotMatch(legacyPlan, /schtasks\.exe|Stop-Process|Remove-Item|Start-Process/,
  "legacy migration plan must not manipulate processes, tasks or StateRoot");
assert.match(legacyAudit, /inspection_only = \$true/, "legacy report must remain read-only");
assert.match(legacyAudit, /authorized_to_migrate = \$false/, "legacy report must not authorize migration");
assert.match(legacyAudit, /detected_task_layout = "split-task"/,
  "legacy audit must describe the observed task family rather than infer a version");
assert.match(legacyAudit, /installed_source_revision_verified = \$false/,
  "matching old task names must not imply verified historical package provenance");
assert.match(legacyAudit, /task_xml_sha256/, "legacy read-only evidence must include Task Scheduler XML digest");
assert.match(legacyAudit, /process_candidates_ambiguous/, "legacy read-only evidence must report duplicate process candidates");
assert.match(legacyAudit, /task_to_pid_verified = \$false/, "matching argv must never prove task-to-PID ownership");
assert.doesNotMatch(legacyAudit, /schtasks\.exe|Stop-Process|Remove-Item|Start-Process/, "legacy evidence collector must not mutate tasks/processes/state");
const windowsCredentials = await readFile(new URL("../scripts/windows-memory-credentials.ps1", import.meta.url), "utf8");
assert.match(windowsCredentials, /Resolve-MemhubMemoryToken/, "Windows reinstall must validate existing credentials");
assert.match(windowsCredentials, /RandomNumberGenerator/, "Windows Memory token must use a cryptographic RNG");
assert.match(completePackager, /"web-assets"/, "Complete archives must include the Web assets used by Gateway CLI and UI");
for (const asset of ["logo-mark.png", "logo-lockup.png"]) {
  assert.match(completeSmoke, new RegExp(`web-assets/${asset.replace(".", "\\.")}`), `Complete smoke must check ${asset}`);
}
for (const edition of ["local", "server"]) {
  const linux = await readFile(new URL(`../editions/${edition}/linux/install.sh`, import.meta.url), "utf8");
  const windows = await readFile(new URL(`../editions/${edition}/windows/install.ps1`, import.meta.url), "utf8");
  assert.match(linux, new RegExp(`memhub-${edition}-stack\\.target`));
  assert.match(linux, /ExecStartPost=.*wait-for-service.*--kind core/);
  assert.match(linux, /ExecStartPost=.*wait-for-service.*--kind gateway/);
  assert.match(linux, /StartLimitBurst=6/);
  assert.match(windows, /run-stack\.mjs/);
  assert.match(windows, /wait-for-service\.mjs/);
  assert.match(windows, /--action preflight/, "Windows reinstall must fail closed on occupied ports and unverified stack ownership");
  assert.doesNotMatch(windows, /Get-CimInstance Win32_Process|Stop-Process -Id/, "Windows reinstall must not kill processes by executable path");
  assert.ok(windows.indexOf("--action preflight") < windows.indexOf("$Config | ConvertTo-Json"),
    "reinstall preflight must reject occupied ports before rewriting Memory credentials");
  assert.match(windows, /--action stop/, "Windows reinstall must gracefully stop an existing stack before replacement");
  assert.match(windows, /Assert-MemhubInstallTaskSet/, "Windows reinstall must verify task action and principal before stopping a stack");
  assert.ok(windows.indexOf("Assert-MemhubInstallTaskSet") <
    windows.indexOf("New-Item -ItemType Directory"),
    "Windows legacy-task detection must precede even state-root creation or dependency installation");
  assert.match(windows, /Task Scheduler ownership changed during preparation/,
    "Windows installer must recheck exact task set after dependency and credential preparation");
  assert.match(windows, /Assert-MemhubStackProcessOwner/, "Windows reinstall must verify PID, creation time and executable before stop");
  assert.ok(windows.indexOf("Assert-MemhubStackProcessOwner") < windows.indexOf("--action stop"),
    "exact owner verification must happen before cooperative stop");
  assert.match(windows, /runtime\\node\\node\.exe/, "Complete installer must recognize its nested bundled Node runtime");
  assert.ok(windows.indexOf('runtime\\node\\node.exe') < windows.indexOf('$env:NODE'),
    "Complete installer must prefer the bundled ABI-compatible Node before environment overrides");
  assert.match(windows, /Remove-MemhubVerifiedStackTask/, "Windows reinstall must recheck ownership before deleting a task");
  assert.doesNotMatch(windows, /schtasks\.exe \/Create \/F/, "New tasks must not silently replace unverified registrations");
  assert.match(windows, /Resolve-MemhubMemoryToken/, "Windows installer must validate the existing Core token before stopping an owner");
  assert.ok(windows.indexOf("Resolve-MemhubMemoryToken") < windows.indexOf("--action stop"),
    "Credential validation must precede any stack stop");
  assert.match(windows, /\$Node\s*=\s*if\s*\(\$BundledNode\)/,
    "Both Windows installers must resolve the Node executable before launching the stack");
  assert.match(windows, /\$\{env:USERNAME\}:\(OI\)\(CI\)F/,
    "Windows ACL grant must use an unambiguous braced environment-variable reference");
  assert.doesNotMatch(windows, /\$Node -e/, "Windows PowerShell must not pass inline JavaScript through native argument quoting");
  assert.doesNotMatch(windows, /Start-Sleep -Seconds 1/, "Windows dependencies must use readiness, not a fixed sleep");
  assert.equal((windows.match(/Install-LogonTask\s+"Memhub-/g) ?? []).length, 1, "one Windows stack task owns all child processes");
  const uninstall = await readFile(new URL(`../editions/${edition}/windows/uninstall.ps1`, import.meta.url), "utf8");
  assert.match(uninstall, /Assert-MemhubStackProcessOwner/, "Uninstall must verify PID/start/path before stop");
  assert.match(uninstall, /Assert-MemhubInstallTaskSet/, "Uninstall must validate task ownership before stopping services");
  assert.match(uninstall, /runtime\\node\\node\.exe/, "Complete uninstall must use the bundled Node runtime");
  assert.match(uninstall, /Remove-MemhubVerifiedStackTask/, "Uninstall must not delete same-name foreign tasks");
  assert.match(uninstall, /--action stop/, "Windows uninstall must request graceful stack shutdown before ending its task");
  assert.match(uninstall, /\$LASTEXITCODE -ne 0 -or \(Test-Path \$StackLock\)/,
    "Windows uninstall must refuse a task kill or data purge when graceful stop fails");
}

if (process.platform === "linux") {
  // Exercise the real installer entrypoint before any state, credential or
  // systemd mutation. A static source assertion cannot prove this ordering.
  const sandbox = await mkdtemp(join(tmpdir(), "memhub-edition-fresh-only-"));
  const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const bin = join(sandbox, "bin");
  const systemctlMarker = join(sandbox, "systemctl-called");
  try {
    await mkdir(bin);
    const fakeSystemctl = join(bin, "systemctl");
    await writeFile(fakeSystemctl, `#!/bin/sh\nprintf called > "${systemctlMarker}"\nexit 0\n`);
    await chmod(fakeSystemctl, 0o755);
    for (const edition of ["local", "server"]) {
      const home = join(sandbox, edition);
      const state = join(home, "protected-state");
      const config = join(state, "memory-config.yaml");
      const envFile = join(state, `${edition}.env`);
      const database = join(state, "memory", "memory.sqlite");
      await mkdir(join(state, "memory"), { recursive: true });
      await writeFile(config, "protected-core-token-and-settings\n");
      await writeFile(envFile, "protected-gateway-token\n");
      await writeFile(database, "protected-database-bytes");
      const script = join(repo, "editions", edition, "linux", "install.sh");
      const run = (stateRoot) => spawnSync("bash", [script], {
        cwd: repo, encoding: "utf8",
        env: { ...process.env, HOME: home, MEMHUB_HOME: stateRoot,
          NODE: process.execPath, PATH: `${bin}:${process.env.PATH ?? ""}` }
      });
      const existing = run(state);
      assert.equal(existing.status, 2, `${edition}: existing state must fail before installer writes`);
      assert.match(existing.stderr, /Existing state root/);
      assert.equal(await readFile(config, "utf8"), "protected-core-token-and-settings\n");
      assert.equal(await readFile(envFile, "utf8"), "protected-gateway-token\n");
      assert.equal(await readFile(database, "utf8"), "protected-database-bytes");

      const unitDir = join(home, ".config", "systemd", "user");
      await mkdir(unitDir, { recursive: true });
      const foreignUnit = join(unitDir,
        edition === "local" ? "memhub-server.service" : "memhub-local.service");
      await writeFile(foreignUnit, "protected-existing-service\n");
      const cleanState = join(home, "not-created");
      const existingUnit = run(cleanState);
      assert.equal(existingUnit.status, 2, `${edition}: existing other-edition unit must fail closed`);
      assert.match(existingUnit.stderr, /Existing Memhub systemd unit/);
      assert.equal(await readFile(foreignUnit, "utf8"), "protected-existing-service\n");
      assert.equal(existsSync(cleanState), false, "refusal must not create a new state root");
      assert.equal(existsSync(systemctlMarker), false, "refusal must not call systemctl");
    }
    for (const edition of ["local", "server"]) {
      const home = join(sandbox, `fresh-${edition}`);
      const state = join(home, "fresh-state");
      await mkdir(home);
      const script = join(repo, "editions", edition, "linux", "install.sh");
      const env = { ...process.env, HOME: home, MEMHUB_HOME: state,
        NODE: process.execPath, PATH: `${bin}:${process.env.PATH ?? ""}` };
      const first = spawnSync("bash", [script], { cwd: repo, encoding: "utf8", env });
      assert.equal(first.status, 0, `${edition}: fresh disposable install failed:\n${first.stdout}\n${first.stderr}`);
      const config = join(state, "memory-config.yaml");
      const envFile = join(state, `${edition}.env`);
      const beforeConfig = await readFile(config, "utf8");
      const beforeEnv = await readFile(envFile, "utf8");
      assert.ok(JSON.parse(beforeConfig).memmyMemory.storage.token, "fresh install must create Core token");
      await rm(systemctlMarker, { force: true });
      const repeat = spawnSync("bash", [script], { cwd: repo, encoding: "utf8", env });
      assert.equal(repeat.status, 2, `${edition}: reinstall must not rotate existing token`);
      assert.equal(await readFile(config, "utf8"), beforeConfig);
      assert.equal(await readFile(envFile, "utf8"), beforeEnv);
      assert.equal(existsSync(systemctlMarker), false, "refused reinstall must not touch service lifecycle");
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

console.log("memhub-edition-regressions: ok");
