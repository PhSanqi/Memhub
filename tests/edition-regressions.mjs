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
  assert.match(source, /runtime[\\/]node/, edition.path + ": Complete packages must prefer the bundled Node runtime");
  if (edition.path.endsWith(".sh")) {
    assert.match(source, /systemctl --user restart/, edition.path + ": reinstall must restart services onto the new runtime");
  } else {
    assert.doesNotMatch(source, /\$Node -e .*randomBytes/, edition.path + ": Windows token generation must not depend on native node -e quoting");
    assert.match(source, /RandomNumberGenerator/, edition.path + ": Windows token generation must use PowerShell/.NET crypto");
    assert.match(source, /\$\(\$env:USERNAME\):\(OI\)\(CI\)F/, edition.path + ": Windows ACL grant must preserve the username");
    assert.match(source, /cmd\.exe \/c ["']?schtasks\.exe \/End/, edition.path + ": missing prior scheduled tasks must be ignored idempotently");
    assert.match(source, /schtasks\.exe \/End/, edition.path + ": reinstall must stop an existing scheduled task before replacement");
    assert.match(source, /Failed to start scheduled task/, edition.path + ": scheduled-task restart failures must be surfaced");
  }
}

const releaseScript = await readFile(new URL("../scripts/package-release.mjs", import.meta.url), "utf8");
for (const id of ["linux-local", "linux-server", "windows-local", "windows-server"]) {
  assert.match(releaseScript, new RegExp(`id: ["']${id}["']`), `release packaging must include ${id}`);
}
assert.match(releaseScript, /release-manifest\.json/, "release packaging must emit a commit-bound manifest");
assert.match(releaseScript, /SHA256SUMS\.txt/, "release packaging must emit checksums");
assert.match(releaseScript, /install\.sh/, "release packaging must publish the Linux bootstrap installer");
assert.match(releaseScript, /install\.ps1/, "release packaging must publish the Windows bootstrap installer");
assert.match(releaseScript, /install-complete\.sh/, "release packaging must publish the Linux Complete bootstrap installer");
assert.match(releaseScript, /install-complete\.ps1/, "release packaging must publish the Windows Complete bootstrap installer");

const linuxBootstrap = await readFile(new URL("../install.sh", import.meta.url), "utf8");
const windowsBootstrap = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
assert.match(linuxBootstrap, /releases\/latest/, "Linux bootstrap must resolve the latest stable release");
assert.match(linuxBootstrap, /SHA256SUMS\.txt/, "Linux bootstrap must verify release checksums");
assert.match(linuxBootstrap, /--edition local\|server/, "Linux bootstrap must support Local and Server editions");
assert.match(windowsBootstrap, /releases\/latest/, "Windows bootstrap must resolve the latest stable release");
assert.match(windowsBootstrap, /SHA256SUMS\.txt/, "Windows bootstrap must verify release checksums");
assert.match(windowsBootstrap, /ValidateSet\("local", "server"\)/, "Windows bootstrap must support Local and Server editions");

const completeReleaseScript = await readFile(new URL("../scripts/package-complete-release.mjs", import.meta.url), "utf8");
assert.match(completeReleaseScript, /linux-complete/, "Complete packaging must include Linux Complete");
assert.match(completeReleaseScript, /windows-complete/, "Complete packaging must include Windows Complete");
assert.match(completeReleaseScript, /22\.20\.0/, "Complete packaging must pin the bundled Node version");
assert.match(completeReleaseScript, /SHASUMS256\.txt/, "Complete packaging must verify the official Node checksum");
assert.match(completeReleaseScript, /better_sqlite3\.node/, "Windows Complete validation must require better-sqlite3 native runtime");
assert.match(completeReleaseScript, /sqlite-vec-windows-x64/, "Windows Complete validation must require sqlite-vec native runtime");
assert.match(completeReleaseScript, /onnxruntime_binding\.node/, "Windows Complete validation must require ONNX Runtime native binding");
assert.match(completeReleaseScript, /memhub-release-v2/, "Complete packaging must merge into the formal release manifest");
assert.match(completeReleaseScript, /SHA256SUMS\.txt/, "Complete packaging must merge Complete assets into formal checksums");

const linuxCompleteBootstrap = await readFile(new URL("../install-complete.sh", import.meta.url), "utf8");
const windowsCompleteBootstrap = await readFile(new URL("../install-complete.ps1", import.meta.url), "utf8");
assert.match(linuxCompleteBootstrap, /linux-complete\.tar\.gz/, "Linux Complete bootstrap must download the Complete asset");
assert.match(linuxCompleteBootstrap, /runtime\/node\/bin\/node/, "Linux Complete bootstrap must use bundled Node");
assert.match(windowsCompleteBootstrap, /windows-complete\.zip/, "Windows Complete bootstrap must download the Complete asset");
assert.match(windowsCompleteBootstrap, /runtime\\node\\node\.exe/, "Windows Complete bootstrap must use bundled Node");

const deployInstaller = await readFile(new URL("../deploy/install-user-service.sh", import.meta.url), "utf8");
const deployUnit = await readFile(new URL("../deploy/memhub.service.in", import.meta.url), "utf8");
assert.doesNotMatch(deployInstaller, /vendor\/normify/i, "deploy installer must not require retired Normify vendor files");
assert.match(deployInstaller, /MEMHUB_BASE_PATH/, "deploy installer must preserve configured web base path");
assert.match(deployInstaller, /MEMHUB_HTTP_PATH/, "deploy installer must allow explicit MCP path override");
assert.match(deployInstaller, /MEMHUB_CAPTURE_PATH/, "deploy installer must allow explicit capture path override");
assert.match(deployUnit, /--architecture-root @ARCHITECTURE_ROOT@/, "deploy unit must use the architecture reader name");
assert.match(deployUnit, /--http-path @HTTP_PATH@/, "deploy unit must render the selected MCP path");
assert.match(deployUnit, /--capture-path @CAPTURE_PATH@/, "deploy unit must render the selected capture path");

console.log("memhub-edition-regressions: ok");
