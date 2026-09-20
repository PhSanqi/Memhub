import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const pluginJson = JSON.parse(await readFile(new URL("../adapters/plugin/plugin.json", import.meta.url), "utf8"));
assert.equal(pluginJson.version, packageJson.version, "plugin and runtime release versions must stay aligned");
assert.equal(packageJson.version, "0.2.0", "release regression expects the v0.2.0 line");

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
  const source = await readFile(new URL("../" + edition.path, import.meta.url), "utf8");
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

console.log("memhub-edition-regressions: ok");
