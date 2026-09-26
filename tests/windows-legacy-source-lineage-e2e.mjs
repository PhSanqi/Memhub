// Repository-only provenance check. No Task Scheduler queries or mutation.
// The v0.2.2 release tag has the managed stack, while the preceding
// v0.2.2 release-candidate commit emitted the split legacy task family.
// Run in a repository with the actual historical objects, not a ZIP fixture.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const splitTaskCommit = "a00fba9281c83803381993b8b7fe083b0ced9e58";
const legacyOnly = process.argv.includes("--legacy-only");
function git(...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Historical Git evidence unavailable: git ${args.join(" ")}`);
  return result.stdout;
}
const splitId = git("rev-parse", splitTaskCommit + "^{commit}").trim();
assert.equal(splitId, splitTaskCommit, "Historical split-task source commit changed");
const tagId = legacyOnly ? null : git("rev-parse", "v0.2.2^{commit}").trim();
if (tagId) assert.notEqual(splitId, tagId, "Tagged v0.2.2 and split-task source must not be conflated");

for (const edition of ["server", "local"]) {
  const path = `editions/${edition}/windows/install.ps1`;
  const legacy = git("show", splitId + ":" + path);
  const tagged = tagId ? git("show", tagId + ":" + path) : null;
  const splitLaunchers = edition === "server"
    ? ["memory-server.cmd", "gateway-server.cmd"]
    : ["memory.cmd", "gateway.cmd", "bridge.cmd"];
  const splitTasks = edition === "server"
    ? ["Memhub-Server-Memory", "Memhub-Server"]
    : ["Memhub-Memory", "Memhub-Local", "Memhub-Bridge"];
  for (const name of splitLaunchers) {
    assert.ok(legacy.includes('"' + name + '"'),
      `${edition} historic installer missing split launcher ${name}`);
  }
  for (const name of splitTasks) {
    assert.ok(legacy.includes('Install-LogonTask "' + name + '"'),
      `${edition} historic installer missing split task ${name}`);
  }
  const stackTask = edition === "server" ? "Memhub-Server-Stack" : "Memhub-Local-Stack";
  const stackLauncher = edition === "server" ? "stack-server.cmd" : "stack-local.cmd";
  if (tagged) {
    assert.ok(tagged.includes('Install-LogonTask "' + stackTask + '"'),
      `${edition} tagged v0.2.2 must register the managed-stack task`);
    assert.ok(tagged.includes('"' + stackLauncher + '"'),
      `${edition} tagged v0.2.2 must use the managed-stack launcher`);
  }
  assert.ok(!legacy.includes('Install-LogonTask "' + stackTask + '"'),
    `${edition} split-task commit must not already be the managed-stack version`);
}
console.log(JSON.stringify({
  ok: true,
  legacy_layout: "split-task",
  legacy_source_commit: splitId,
  tag_v0_2_2_commit: tagId,
  tagged_revision_verified: Boolean(tagId),
  migration_source_is_tagged_release: tagId ? false : null,
  task_scheduler_touched: false
}));
