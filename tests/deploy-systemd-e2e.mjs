import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function run(script) {
  const result = spawnSync("bash", [join(repo, script)], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      NODE: process.execPath,
      MEMHUB_BASE_PATH: "/custom-memhub",
      PATH: `${bin}:${process.env.PATH ?? ""}`
    }
  });
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
  console.log("memhub-deploy-systemd-e2e: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
