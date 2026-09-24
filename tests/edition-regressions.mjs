import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const pluginJson = JSON.parse(await readFile(new URL("../adapters/plugin/plugin.json", import.meta.url), "utf8"));
assert.equal(pluginJson.version, packageJson.version, "plugin and runtime release versions must stay aligned");
assert.equal(packageJson.version, "0.2.2", "release regression expects the v0.2.2 line");

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
const cloudflareGuide = await readFile(new URL("../docs/CLOUDFLARE_TUNNEL.md", import.meta.url), "utf8");
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
for (const [name, source] of [["README.md", readme], ["README.zh-CN.md", readmeZh], ["docs/CLOUDFLARE_TUNNEL.md", cloudflareGuide]]) {
  assert.match(source, /https:\/\/memhub\.sanqi\.org\//, name + ": canonical production route must be explicit");
  assert.match(source, /plugin\.sanqi\.org\/memhub/, name + ": retired route must be explicitly documented as retired");
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
  assert.match(windows, /Get-CimInstance Win32_Process/, "Windows reinstall must identify orphaned Memhub Node children");
  assert.match(windows, /Stop-Process -Id/, "Windows reinstall must terminate orphaned Memhub Node children");
  assert.match(windows, /--action stop/, "Windows reinstall must gracefully stop an existing stack before replacement");
  assert.doesNotMatch(windows, /Start-Sleep -Seconds 1/, "Windows dependencies must use readiness, not a fixed sleep");
  assert.equal((windows.match(/Install-LogonTask\s+"Memhub-/g) ?? []).length, 1, "one Windows stack task owns all child processes");
  const uninstall = await readFile(new URL(`../editions/${edition}/windows/uninstall.ps1`, import.meta.url), "utf8");
  assert.match(uninstall, /--action stop/, "Windows uninstall must request graceful stack shutdown before ending its task");
  assert.match(uninstall, /\$LASTEXITCODE -ne 0 -or \(Test-Path \$StackLock\)/,
    "Windows uninstall must refuse a task kill or data purge when graceful stop fails");
}

console.log("memhub-edition-regressions: ok");
