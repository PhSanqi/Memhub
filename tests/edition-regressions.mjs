import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveControlRoot, resolveCoreState, resolveHome } from "../src/state-root.mjs";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const packageLock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
assert.equal(packageJson.version, packageLock.version);
assert.equal(packageJson.version, packageLock.packages?.[""]?.version);
for (const unusedDependency of ["fast-xml-parser", "smol-toml", "ignore"]) {
  assert.equal(packageJson.dependencies?.[unusedDependency], undefined);
}
assert.equal(packageJson.dependencies?.typescript, undefined);
assert.ok(packageJson.devDependencies?.typescript);

const commonLinux = await readFile(new URL("../editions/common/linux/install.sh", import.meta.url), "utf8");
const commonWindows = await readFile(new URL("../editions/common/windows/install.ps1", import.meta.url), "utf8");
for (const [name, source] of [["linux", commonLinux], ["windows", commonWindows]]) {
  assert.match(source, /memhub\.env/, `${name}: one environment file`);
  assert.doesNotMatch(source, /MEMHUB_BINDINGS|conversation-project-bindings/, `${name}: no conversation binding store`);
  assert.doesNotMatch(source, /capture-path|dist[\\/]bridge|MEMHUB_BRIDGE/, `${name}: no active Bridge/capture side channel`);
  assert.match(source, /MEMHUB_PUBLIC_HOST/, `${name}: remote exposure is configuration, not another runtime`);
}
assert.match(commonLinux, /memhub-core\.service/);
assert.match(commonLinux, /memhub\.service/);
assert.match(commonLinux, /memhub-stack\.target/);
assert.doesNotMatch(commonLinux, /cat > .*memhub-local\.service|cat > .*memhub-server\.service/);
assert.match(commonWindows, /Memhub-Stack/);
assert.match(commonWindows, /stack\.cmd/);
assert.match(commonWindows, /run-stack\.mjs/);
assert.doesNotMatch(commonWindows, /--mode|stack-local\.cmd|stack-server\.cmd/);

for (const edition of ["local", "server"]) {
  const linux = await readFile(new URL(`../editions/${edition}/linux/install.sh`, import.meta.url), "utf8");
  const windows = await readFile(new URL(`../editions/${edition}/windows/install.ps1`, import.meta.url), "utf8");
  assert.match(linux, /common\/linux\/install\.sh/);
  assert.match(windows, /common\\windows\\install\.ps1/);
  assert.doesNotMatch(linux, /ExecStart=|memhub-(?:local|server)\.service/);
  assert.doesNotMatch(windows, /Install-LogonTask|run-stack\.mjs/,
    `${edition}/windows wrapper must not duplicate installer implementation`);
}

const releaseScript = await readFile(new URL("../scripts/package-release.mjs", import.meta.url), "utf8");
for (const id of ["linux-local", "linux-server", "windows-local", "windows-server"]) {
  assert.match(releaseScript, new RegExp(`id: ["']${id}["']`));
}
assert.match(releaseScript, /release-manifest\.json/);
assert.match(releaseScript, /SHA256SUMS\.txt/);
assert.match(releaseScript, /--output-root/);
assert.match(releaseScript, /releaseOnly:\s*true/);
const releaseCommonPaths = releaseScript.match(/const commonPaths = \[(.*?)\];/s)?.[1] ?? "";
assert.match(releaseCommonPaths, /["']src["']/);
assert.doesNotMatch(releaseCommonPaths, /["']tests["']/);

const completePackager = await readFile(new URL("../scripts/package-complete-release.mjs", import.meta.url), "utf8");
const completeSmoke = await readFile(new URL("../scripts/complete-runtime-smoke.cjs", import.meta.url), "utf8");
assert.doesNotMatch(completePackager, /dist\/bridge\.js/);
assert.doesNotMatch(completeSmoke, /dist\/bridge\.js/);
for (const asset of ["logo-mark.png", "logo-lockup.png"]) {
  assert.match(completeSmoke, new RegExp(`web-assets/${asset.replace(".", "\\.")}`));
}

const deployInstaller = await readFile(new URL("../deploy/install-user-service.sh", import.meta.url), "utf8");
const deployUnit = await readFile(new URL("../deploy/memhub.service.in", import.meta.url), "utf8");
const deployCoreUnit = await readFile(new URL("../deploy/memhub-core.service.in", import.meta.url), "utf8");
const deployTarget = await readFile(new URL("../deploy/memhub-stack.target.in", import.meta.url), "utf8");
assert.match(deployInstaller, /MEMHUB_BASE_PATH/);
assert.match(deployInstaller, /MEMHUB_HTTP_PATH/);
assert.doesNotMatch(deployInstaller, /MEMHUB_CAPTURE_PATH|install-bridge/);
assert.match(deployUnit, /--http-path @HTTP_PATH@/);
assert.doesNotMatch(deployUnit, /capture-path|bridge/);
assert.match(deployUnit, /--architecture-root @ARCHITECTURE_ROOT@/);
assert.match(deployUnit, /ExecStartPre=.*--kind core/);
assert.match(deployUnit, /ExecStartPost=.*--kind gateway/);
assert.match(deployCoreUnit, /ExecStartPost=.*--kind core/);
assert.match(deployTarget, /Requires=memhub-core\.service memhub\.service/);
assert.equal(existsSync(resolve(fileURLToPath(new URL("../deploy/memhub-bridge.service.in", import.meta.url)))), false);
assert.equal(existsSync(resolve(fileURLToPath(new URL("../deploy/install-bridge-user-service.sh", import.meta.url)))), false);

// P4: two shared roots — install home and gateway control root.
{
  const sandbox = await mkdtemp(join(tmpdir(), "memhub-state-root-"));
  try {
    const home = join(sandbox, "home");
    await mkdir(home);
    const defaultRoot = join(home, ".memmy", "memhub");

    // Home: default and existing unified root.
    assert.equal(resolveHome({ env: {}, homeDir: home }), defaultRoot);
    await mkdir(defaultRoot, { recursive: true });
    assert.equal(resolveHome({ env: {}, homeDir: home }), defaultRoot);

    // Home precedence: explicit --home > MEMHUB_HOME. MEMHUB_STATE_ROOT names
    // the gateway control root and never affects the home.
    assert.equal(resolveHome({ env: { MEMHUB_HOME: join(sandbox, "home-env") }, homeDir: home }), join(sandbox, "home-env"));
    assert.equal(
      resolveHome({ explicit: join(sandbox, "explicit"), env: { MEMHUB_HOME: join(sandbox, "home-env") }, homeDir: home }),
      join(sandbox, "explicit")
    );
    assert.equal(
      resolveHome({ env: { MEMHUB_STATE_ROOT: join(sandbox, "control-env") }, homeDir: home }),
      defaultRoot,
      "MEMHUB_STATE_ROOT is not a home alias"
    );

    // Control root: explicit --state-root > MEMHUB_STATE_ROOT
    // > <home>/server when it holds accounts.json > flat <home>.
    assert.equal(resolveControlRoot({ env: {}, homeDir: home }), defaultRoot,
      "flat home when server/accounts.json does not exist");
    const editionRoot = join(sandbox, "edition");
    await mkdir(join(editionRoot, "server"), { recursive: true });
    await writeFile(join(editionRoot, "server", "accounts.json"), "[]\n");
    assert.equal(
      resolveControlRoot({ env: { MEMHUB_HOME: editionRoot }, homeDir: home }),
      join(editionRoot, "server"),
      "an existing <home>/server/accounts.json keeps the edition layout"
    );
    // Edition environment: MEMHUB_HOME=<home>, MEMHUB_STATE_ROOT=<home>/server.
    // The historically different values are legal and must not raise.
    const editionEnv = { HOME: editionRoot, MEMHUB_HOME: editionRoot, MEMHUB_STATE_ROOT: join(editionRoot, "server") };
    assert.equal(resolveHome({ env: editionEnv }), editionRoot);
    assert.equal(resolveControlRoot({ env: editionEnv }), join(editionRoot, "server"));
    assert.equal(
      resolveControlRoot({ env: { MEMHUB_STATE_ROOT: join(sandbox, "control-env") }, homeDir: home }),
      join(sandbox, "control-env")
    );
    assert.equal(
      resolveControlRoot({ explicit: join(sandbox, "control-explicit"), env: editionEnv }),
      join(sandbox, "control-explicit")
    );

    // Production flat layout: only --state-root ~/.memmy/memhub; MEMHUB_HOME
    // unset. Both roots resolve to the same flat directory.
    assert.equal(resolveControlRoot({ explicit: defaultRoot, env: {} }), defaultRoot);
    assert.equal(resolveHome({ env: {}, homeDir: home }), defaultRoot);
    assert.equal(resolveControlRoot({ env: { MEMHUB_HOME: defaultRoot }, homeDir: home }), defaultRoot);

    // Windows uses USERPROFILE for the home and honors MEMHUB_STATE_ROOT for
    // the control root.
    assert.equal(
      resolveHome({ env: { USERPROFILE: "C:\\Users\\owner", HOME: "/wrong" }, platform: "win32" }),
      "C:\\Users\\owner\\.memmy\\memhub"
    );
    assert.equal(
      resolveControlRoot({ env: { USERPROFILE: "C:\\Users\\owner", MEMHUB_STATE_ROOT: "C:\\Users\\owner\\data" }, platform: "win32" }),
      "C:\\Users\\owner\\data"
    );

    // Legacy ~/.memhub is adopted in place for the home only when it holds
    // real state, and the warning is printed once.
    const legacyHome = join(sandbox, "legacy-env");
    await mkdir(legacyHome);
    const legacyRoot = join(legacyHome, ".memhub");
    await mkdir(legacyRoot);
    const warnings = [];
    assert.equal(resolveHome({ env: {}, homeDir: legacyHome, warn: (message) => warnings.push(message) }), defaultRootOf(legacyHome));
    assert.equal(resolveHome({ env: {}, homeDir: legacyHome, warn: (message) => warnings.push(message) }), defaultRootOf(legacyHome));
    assert.equal(warnings.length, 0, "an empty ~/.memhub is not adopted");
    await writeFile(join(legacyRoot, "memhub.env"), "MEMHUB_MEMORY_TOKEN=test\n");
    assert.equal(resolveHome({ env: {}, homeDir: legacyHome, warn: (message) => warnings.push(message) }), legacyRoot);
    assert.equal(resolveHome({ env: {}, homeDir: legacyHome, warn: (message) => warnings.push(message) }), legacyRoot);
    assert.equal(warnings.length, 1, "legacy adoption warns exactly once");
    assert.equal(resolveControlRoot({ env: {}, homeDir: legacyHome, warn: () => {} }), legacyRoot,
      "a flat legacy home is also the control root");

    const accountsHome = join(sandbox, "legacy-accounts");
    await mkdir(join(accountsHome, ".memhub"), { recursive: true });
    await writeFile(join(accountsHome, ".memhub", "accounts.json"), "[]\n");
    assert.equal(resolveHome({ env: {}, homeDir: accountsHome, warn: () => {} }), join(accountsHome, ".memhub"));

    // Core defaults to <home>/core and adopts legacy ~/.memhub/core in place.
    // It follows the home, never MEMHUB_STATE_ROOT.
    const coreHome = join(sandbox, "core-home");
    await mkdir(coreHome);
    assert.equal(
      resolveCoreState({ env: {}, homeDir: coreHome }).dbPath,
      join(coreHome, ".memmy", "memhub", "core", "memory.sqlite")
    );
    const editionCore = resolveCoreState({
      env: { MEMHUB_HOME: editionRoot, MEMHUB_STATE_ROOT: join(editionRoot, "server") },
      homeDir: home
    });
    assert.equal(editionCore.stateRoot, editionRoot);
    assert.equal(editionCore.dbPath, join(editionRoot, "core", "memory.sqlite"),
      "core paths follow the home, not MEMHUB_STATE_ROOT");
    const legacyCore = join(coreHome, ".memhub", "core");
    await mkdir(legacyCore, { recursive: true });
    await writeFile(join(legacyCore, "memory.sqlite"), "");
    assert.equal(resolveCoreState({ env: {}, homeDir: coreHome }).dbPath, join(legacyCore, "memory.sqlite"));
    await mkdir(join(coreHome, ".memmy", "memhub", "core"), { recursive: true });
    await writeFile(join(coreHome, ".memmy", "memhub", "core", "memory.sqlite"), "");
    assert.equal(
      resolveCoreState({ env: {}, homeDir: coreHome }).dbPath,
      join(coreHome, ".memmy", "memhub", "core", "memory.sqlite"),
      "an existing unified core database wins over the legacy one"
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

function defaultRootOf(home) {
  return join(home, ".memmy", "memhub");
}

const managedStack = await readFile(new URL("../scripts/run-stack.mjs", import.meta.url), "utf8");
const windowsTaskOwnership = await readFile(new URL("../scripts/windows-task-ownership.ps1", import.meta.url), "utf8");
const windowsStackOwner = await readFile(new URL("../scripts/windows-stack-owner.ps1", import.meta.url), "utf8");
assert.match(managedStack, /\.memhub-stack\.lock/);
assert.match(managedStack, /memhub\.env/);
assert.doesNotMatch(managedStack, /--mode|bridge-port|capture-path|local\.env|server\.env/);
assert.match(managedStack, /exactWindowsStackInvocation/);
assert.match(managedStack, /GetOwnerSid/);
assert.match(managedStack, /owner_verified: verified/);
assert.match(windowsStackOwner, /Get-CimInstance -ClassName Win32_Process -Filter/);
assert.match(windowsStackOwner, /CreationDate/);
assert.match(windowsStackOwner, /ExecutablePath/);
assert.match(windowsStackOwner, /GetOwnerSid/);
assert.doesNotMatch(windowsStackOwner, /\$Mode|--mode/);
assert.doesNotMatch(windowsStackOwner, /Stop-Process|Kill\(|Remove-Item/);
assert.match(windowsTaskOwnership, /Memhub-Stack/);
assert.match(windowsTaskOwnership, /Legacy Memhub tasks/);
assert.match(windowsTaskOwnership, /Memhub-Bridge/,
  "old Bridge task may exist only as a migration blocker");

// Common Windows installer owns all non-historical lifecycle logic.
assert.match(commonWindows, /Assert-MemhubInstallTaskSet/);
assert.match(commonWindows, /Assert-MemhubStackProcessOwner/);
assert.match(commonWindows, /Resolve-MemhubMemoryToken/);
assert.match(commonWindows, /--action preflight/);
assert.match(commonWindows, /--action stop/);
assert.match(commonWindows, /Remove-MemhubVerifiedStackTask/);
assert.match(commonWindows, /runtime\\node\\node\.exe/);
assert.ok(commonWindows.indexOf("Assert-MemhubInstallTaskSet") < commonWindows.indexOf("New-Item -ItemType Directory"));
assert.ok(commonWindows.indexOf("Resolve-MemhubMemoryToken") < commonWindows.indexOf("--action stop"));
assert.ok(commonWindows.indexOf("Assert-MemhubStackProcessOwner") < commonWindows.indexOf("--action stop"));
assert.equal((commonWindows.match(/Install-LogonTask\s+"Memhub-/g) ?? []).length, 1);

if (process.platform === "linux") {
  const sandbox = await mkdtemp(join(tmpdir(), "memhub-edition-fresh-only-"));
  const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const bin = join(sandbox, "bin");
  const systemctlMarker = join(sandbox, "systemctl-called");
  try {
    await mkdir(bin);
    const fakeSystemctl = join(bin, "systemctl");
    await writeFile(fakeSystemctl, `#!/bin/sh\nprintf called >> "${systemctlMarker}"\nexit 0\n`);
    await chmod(fakeSystemctl, 0o755);

    for (const edition of ["local", "server"]) {
      const home = join(sandbox, `protected-${edition}`);
      const state = join(home, "protected-state");
      await mkdir(join(state, "memory"), { recursive: true });
      await writeFile(join(state, "memory-config.yaml"), "protected-settings\n");
      await writeFile(join(state, "memhub.env"), "protected-env\n");
      await writeFile(join(state, "memory", "memory.sqlite"), "protected-db");
      const script = join(repo, "editions", edition, "linux", "install.sh");
      const run = (stateRoot) => spawnSync("bash", [script], {
        cwd: repo, encoding: "utf8",
        env: { ...process.env, HOME: home, MEMHUB_HOME: stateRoot, NODE: process.execPath,
          PATH: `${bin}:${process.env.PATH ?? ""}` }
      });
      const existing = run(state);
      assert.equal(existing.status, 2);
      assert.match(existing.stderr, /Existing state root/);
      assert.equal(await readFile(join(state, "memory-config.yaml"), "utf8"), "protected-settings\n");

      const unitDir = join(home, ".config", "systemd", "user");
      await mkdir(unitDir, { recursive: true });
      const oldUnit = join(unitDir, edition === "local" ? "memhub-server.service" : "memhub-local.service");
      await writeFile(oldUnit, "legacy-needs-migration\n");
      const cleanState = join(home, "not-created");
      const blocked = run(cleanState);
      assert.equal(blocked.status, 2);
      assert.match(blocked.stderr, /Existing Memhub systemd unit/);
      assert.equal(existsSync(cleanState), false);
    }

    // P0: production Linux uses the flat layout (gateway control files
    // directly in ~/.memmy/memhub). Rendering on such a home must keep the
    // gateway on the flat root and keep the existing Memmy core paths.
    {
      const home = join(sandbox, "flat-render-home");
      const state = join(home, ".memmy", "memhub");
      const coreHome = join(home, ".memmy");
      const coreConfig = join(coreHome, "config.yaml");
      const coreDb = join(coreHome, "memory-service", "memory.sqlite");
      await mkdir(state, { recursive: true });
      await mkdir(join(coreHome, "memory-service"), { recursive: true });
      await writeFile(join(state, "accounts.json"), "[]\n");
      await writeFile(join(state, "project-registry.json"), "{}\n");
      await writeFile(coreConfig, "memmyMemory: {}\n");
      await writeFile(coreDb, "");
      const renderDir = join(home, "rendered-units");
      const env = { ...process.env, HOME: home, NODE: process.execPath, PATH: `${bin}:${process.env.PATH ?? ""}` };
      delete env.MEMHUB_HOME;
      delete env.MEMHUB_STATE_ROOT;
      const rendered = spawnSync("bash", [
        join(repo, "deploy/install-user-service.sh"),
        "--render-only", renderDir
      ], { cwd: repo, encoding: "utf8", env });
      assert.equal(rendered.status, 0, rendered.stdout + rendered.stderr);
      const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const gateway = await readFile(join(renderDir, "memhub.service"), "utf8");
      const core = await readFile(join(renderDir, "memhub-core.service"), "utf8");
      assert.match(gateway, new RegExp(`--state-root ${escape(state)}(?=\\s)`),
        "flat production root stays flat");
      assert.doesNotMatch(gateway, new RegExp(`--state-root ${escape(state)}/server`));
      assert.match(gateway, new RegExp(`Environment="MEMHUB_HOME=${escape(state)}"`));
      assert.match(core, new RegExp(`--config ${escape(coreConfig)}(?=\\s)`),
        "existing production core config path is preserved");
      assert.match(core, new RegExp(`--db ${escape(coreDb)}(?=\\s)`),
        "existing production core database path is preserved");
      assert.match(core, new RegExp(`Environment="MEMMY_HOME=${escape(coreHome)}"`));
    }

    for (const edition of ["local", "server"]) {
      const home = join(sandbox, `fresh-${edition}`);
      const state = join(home, "fresh-state");
      await mkdir(home);
      const script = join(repo, "editions", edition, "linux", "install.sh");
      const env = { ...process.env, HOME: home, MEMHUB_HOME: state, NODE: process.execPath,
        PATH: `${bin}:${process.env.PATH ?? ""}` };
      const first = spawnSync("bash", [script], { cwd: repo, encoding: "utf8", env });
      assert.equal(first.status, 0, `${edition}: ${first.stdout}\n${first.stderr}`);
      const config = join(state, "memory-config.yaml");
      const envFile = join(state, "memhub.env");
      const beforeConfig = await readFile(config, "utf8");
      const beforeEnv = await readFile(envFile, "utf8");
      assert.ok(JSON.parse(beforeConfig).memmyMemory.storage.token);

      // P4: both installer entrypoints render identical unit text from the
      // one generator (render into a temp dir; systemd is never touched).
      const renderDir = join(home, "rendered-units");
      const rendered = spawnSync("bash", [
        join(repo, "deploy/install-user-service.sh"),
        "--render-only", renderDir,
        "--home", state,
        "--core-config", config,
        "--core-db", join(state, "memory", "memory.sqlite"),
        "--http-path", "/mcp"
      ], { cwd: repo, encoding: "utf8", env });
      assert.equal(rendered.status, 0, `${edition} render: ${rendered.stdout}\n${rendered.stderr}`);
      for (const unit of ["memhub.service", "memhub-core.service", "memhub-stack.target"]) {
        assert.equal(
          await readFile(join(home, ".config", "systemd", "user", unit), "utf8"),
          await readFile(join(renderDir, unit), "utf8"),
          `${edition}: ${unit} text must be identical via both entrypoints`
        );
        const text = await readFile(join(renderDir, unit), "utf8");
        if (unit === "memhub.service" || unit === "memhub-core.service") {
          assert.match(text, new RegExp(`Environment="MEMHUB_HOME=${state.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
        }
      }
      assert.match(await readFile(join(renderDir, "memhub.service"), "utf8"), /--state-root .*\/server/);

      const repeat = spawnSync("bash", [script], { cwd: repo, encoding: "utf8", env });
      assert.equal(repeat.status, 2);
      assert.equal(await readFile(config, "utf8"), beforeConfig);
      assert.equal(await readFile(envFile, "utf8"), beforeEnv);
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

console.log("memhub-edition-regressions: ok");
