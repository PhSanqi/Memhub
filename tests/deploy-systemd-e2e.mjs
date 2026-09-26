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

function invoke(script, targetHome = home, basePath = "/custom-memhub") {
  const result = spawnSync("bash", [join(repo, script)], {
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
  return result;
}
function run(script) {
  const result = invoke(script);
  assert.equal(result.status, 0, `${script} failed:\n${result.stdout}\n${result.stderr}`);
}

try {
  run("deploy/install-user-service.sh");
  run("deploy/install-bridge-user-service.sh");

  const unitDir = join(home, ".config", "systemd", "user");
  const gateway = await readFile(join(unitDir, "memhub.service"), "utf8");
  const bridge = await readFile(join(unitDir, "memhub-bridge.service"), "utf8");
  const target = await readFile(join(unitDir, "memhub-stack.target"), "utf8");
  const calls = await readFile(systemctlLog, "utf8");

  assert.match(gateway, /--http-path \/custom-memhub\/mcp/);
  assert.match(gateway, /--capture-path \/custom-memhub\/capture/);
  assert.match(gateway, /wait-for-service\.mjs --url http:\/\/127\.0\.0\.1:3001\/custom-memhub\/health --kind gateway/);
  assert.match(bridge, /ExecStartPre=.*127\.0\.0\.1:3001\/custom-memhub\/health --kind gateway/);
  assert.match(bridge, /Requires=memhub\.service/);
  assert.match(bridge, /PartOf=memhub\.service memhub-stack\.target/);
  assert.match(bridge, /WantedBy=memhub-stack\.target/);
  assert.match(target, /Requires=memhub-core\.service memhub\.service/);
  assert.match(calls, /--user daemon-reload/);

  // A changed environment must not rewrite installed routing, Gateway/Core
  // ownership or Bridge health dependencies through the fresh-install path.
  const installedCore = await readFile(join(unitDir, "memhub-core.service"), "utf8");
  for (const script of ["deploy/install-user-service.sh", "deploy/install-bridge-user-service.sh"]) {
    const refused = invoke(script, home, "/different-route");
    assert.equal(refused.status, 2, `${script}: repeat install must fail closed`);
    assert.match(refused.stderr, /Existing .*systemd unit/);
  }
  assert.equal(await readFile(join(unitDir, "memhub.service"), "utf8"), gateway);
  assert.equal(await readFile(join(unitDir, "memhub-core.service"), "utf8"), installedCore);
  assert.equal(await readFile(join(unitDir, "memhub-bridge.service"), "utf8"), bridge);
  assert.equal(await readFile(systemctlLog, "utf8"), calls, "refusal must not reload running services");

  // A partial or dangling unit is also owned state, even when no StateRoot
  // exists; do not create directories or change a different edition's unit.
  const partialHome = join(root, "partial");
  const partialUnitDir = join(partialHome, ".config", "systemd", "user");
  await mkdir(partialUnitDir, { recursive: true });
  const existing = join(partialUnitDir, "memhub-server.service");
  await writeFile(existing, "protected-server-unit\n");
  const partial = invoke("deploy/install-user-service.sh", partialHome);
  assert.equal(partial.status, 2);
  assert.match(partial.stderr, /memhub-server\.service/);
  assert.equal(await readFile(existing, "utf8"), "protected-server-unit\n");
  assert.equal(existsSync(join(partialHome, ".memmy")), false, "refusal must not create state");
  await writeFile(join(partialUnitDir, "memhub-stack.target"), "protected-target\n");
  const dangling = join(partialUnitDir, "memhub-bridge.service");
  await symlink(join(root, "nonexistent"), dangling);
  const bridgeRefused = invoke("deploy/install-bridge-user-service.sh", partialHome);
  assert.equal(bridgeRefused.status, 2);
  assert.match(bridgeRefused.stderr, /Existing Bridge systemd unit/);
  assert.equal(existsSync(join(partialHome, ".memhub")), false, "refusal must not create Bridge state");
  assert.equal(await readFile(join(partialUnitDir, "memhub-stack.target"), "utf8"), "protected-target\n");
  assert.equal(await readFile(systemctlLog, "utf8"), calls);

  console.log("memhub-deploy-systemd-e2e: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
