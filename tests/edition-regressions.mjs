import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const editions = [
  {
    path: "editions/local/linux/install.sh",
    autoScan: "agentAccess: { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false }",
    normify: "--normify-root $REPO_ROOT/.."
  },
  {
    path: "editions/server/linux/install.sh",
    autoScan: "agentAccess:{autoScanKnownAgents:false,watchFileChanges:false,autoInjectSkill:false}",
    normify: "--normify-root $REPO_ROOT/.."
  },
  {
    path: "editions/local/windows/install.ps1",
    autoScan: 'agentAccess = @{ autoScanKnownAgents = $false; watchFileChanges = $false; autoInjectSkill = $false }',
    normify: '--normify-root "$NormifyRoot"'
  },
  {
    path: "editions/server/windows/install.ps1",
    autoScan: 'agentAccess = @{ autoScanKnownAgents = $false; watchFileChanges = $false; autoInjectSkill = $false }',
    normify: '--normify-root "$NormifyRoot"'
  }
];

for (const edition of editions) {
  const source = await readFile(new URL("../" + edition.path, import.meta.url), "utf8");
  assert.ok(source.includes(edition.autoScan), edition.path + ": AgentSource auto scan must be opt-in");
  assert.ok(source.includes(edition.normify), edition.path + ": Normify workspace root must be explicit");
}

console.log("memhub-edition-regressions: ok");
