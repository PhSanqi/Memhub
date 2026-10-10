import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") {
  console.log("memhub-deploy-systemd-e2e: skipped (linux only)");
  process.exit(0);
}

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "memhub-deploy-systemd-"));
const home = join(root, "home");
const bin = join(root, "bin");
await mkdir(home, { recursive: true });
await mkdir(bin, { recursive: true });
const systemctlLog = join(root, "systemctl.log");
const fakeSystemctl = join(bin, "systemctl");
await writeFile(fakeSystemctl, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}\nexit 0\n`, "utf8");
await chmod(fakeSystemctl, 0o755);

function invoke(targetHome = home, basePath = "/custom-memhub") {
  return spawnSync("bash", [join(repo, "deploy/install-user-service.sh")], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: targetHome,
      NODE: process.execPath,
      MEMHUB_BASE_PATH: basePath,
      PATH: `${bin}:${process.env.PATH ?? ""}`
    }
  });
}

try {
  const installed = invoke();
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);

  const unitDir = join(home, ".config", "systemd", "user");
  const gateway = await readFile(join(unitDir, "memhub.service"), "utf8");
  const core = await readFile(join(unitDir, "memhub-core.service"), "utf8");
  const target = await readFile(join(unitDir, "memhub-stack.target"), "utf8");
  const calls = await readFile(systemctlLog, "utf8");

  assert.match(gateway, /--http-path \/custom-memhub\/mcp/);
  assert.doesNotMatch(gateway, /capture-path|bridge/);
  assert.match(gateway, /--state-root %h\/\.memmy\/memhub/);
  assert.match(gateway, /wait-for-service\.mjs --url http:\/\/127\.0\.0\.1:3001\/custom-memhub\/health --kind gateway/);
  assert.match(gateway, /Requires=memhub-core\.service/);
  assert.match(target, /Requires=memhub-core\.service memhub\.service/);
  assert.match(core, /PartOf=memhub-stack\.target/);
  assert.equal(existsSync(join(unitDir, "memhub-bridge.service")), false);
  assert.equal(existsSync(join(unitDir, "memhub-local.service")), false);
  assert.equal(existsSync(join(unitDir, "memhub-server.service")), false);
  assert.match(calls, /--user daemon-reload/);

  // Fresh-install entry is fail-closed: existing current or legacy units are
  // never silently replaced by a repeat install.
  const refused = invoke(home, "/different-route");
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /Existing Memhub systemd unit/);
  assert.equal(await readFile(join(unitDir, "memhub.service"), "utf8"), gateway);
  assert.equal(await readFile(join(unitDir, "memhub-core.service"), "utf8"), core);
  assert.equal(await readFile(systemctlLog, "utf8"), calls);

  const partialHome = join(root, "partial");
  const partialUnitDir = join(partialHome, ".config", "systemd", "user");
  await mkdir(partialUnitDir, { recursive: true });
  const legacy = join(partialUnitDir, "memhub-server.service");
  await writeFile(legacy, "legacy-unit-needs-reviewed-migration\n");
  const legacyRefused = invoke(partialHome);
  assert.equal(legacyRefused.status, 2);
  assert.match(legacyRefused.stderr, /memhub-server\.service/);
  assert.equal(existsSync(join(partialHome, ".memmy")), false);
  assert.equal(await readFile(legacy, "utf8"), "legacy-unit-needs-reviewed-migration\n");

  await rm(legacy);
  const dangling = join(partialUnitDir, "memhub-bridge.service");
  await symlink(join(root, "nonexistent"), dangling);
  const danglingRefused = invoke(partialHome);
  assert.equal(danglingRefused.status, 2);
  assert.match(danglingRefused.stderr, /memhub-bridge\.service/);
  assert.equal(existsSync(join(partialHome, ".memmy")), false);

  console.log("memhub-deploy-systemd-e2e: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
