#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CHECK_ONLY = process.argv.includes("--check");
const WORKTREE = process.argv.includes("--worktree");
const REF = argumentValue("--ref") ?? "HEAD";
const ONLY = argumentValue("--only");
const OUTPUT_ROOT_ARG = argumentValue("--output-root");
const NODE_VERSION = "22.20.0";

const targets = [
  { id: "linux-x64-complete", os: "linux", arch: "x64", format: "tar.gz", nodeArchive: `node-v${NODE_VERSION}-linux-x64.tar.xz` },
  { id: "windows-x64-complete", os: "windows", arch: "x64", format: "zip", nodeArchive: `node-v${NODE_VERSION}-win-x64.zip` }
].filter((target) => !ONLY || target.os === ONLY || target.id === ONLY);
if (!targets.length) throw new Error(`unknown --only target: ${ONLY}`);

const commonPaths = [
  "LICENSE",
  "CHANGELOG.md",
  "README.md",
  "README.zh-CN.md",
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "src",
  "scripts",
  "deploy",
  "adapters",
  "docs",
  "vendor",
  "editions/README.md",
  "install-complete.sh",
  "install-complete.ps1"
];

const packageJson = JSON.parse(sourceText("package.json"));
const version = String(packageJson.version ?? "").trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid package version: ${version || "<empty>"}`);
const pluginJson = JSON.parse(sourceText("adapters/plugin/plugin.json"));
if (pluginJson.version !== version) throw new Error(`version mismatch: package=${version}, plugin=${pluginJson.version}`);

for (const path of [...commonPaths, "scripts/complete-runtime-smoke.cjs"]) assertSource(path);
for (const target of targets) {
  for (const edition of ["local", "server"]) {
    assertSource(`editions/${edition}/README.md`);
    assertSource(`editions/${edition}/README.zh-CN.md`);
    assertSource(`editions/${edition}/${target.os}`);
  }
}

if (CHECK_ONLY) {
  console.log(JSON.stringify({
    ok: true,
    version,
    nodeVersion: NODE_VERSION,
    targets: targets.map((target) => target.id),
    worktree: WORKTREE
  }, null, 2));
  process.exit(0);
}

const commit = WORKTREE ? gitText("rev-parse", "HEAD").trim() : gitText("rev-parse", `${REF}^{commit}`).trim();
const outputRoot = OUTPUT_ROOT_ARG ? resolve(ROOT, OUTPUT_ROOT_ARG) : resolve(ROOT, "release", `v${version}`);
await mkdir(outputRoot, { recursive: true });
const tempRoot = await mkdtemp(join(tmpdir(), "memhub-complete-"));

try {
  console.error(`[memhub] complete packaging: Node.js v${NODE_VERSION}`);

  // Build platform-independent Memhub dist once on Linux/host Node.
  const buildStage = join(tempRoot, "build-stage");
  await exportSource(buildStage, "linux");
  run("npm", ["ci", "--workspaces=false"], {
    cwd: buildStage,
    env: { ...process.env, ONNXRUNTIME_NODE_INSTALL_CUDA: "skip" }
  });
  run("npm", ["run", "build"], { cwd: buildStage });
  run("npm", ["prune", "--omit=dev", "--ignore-scripts", "--workspaces=false"], { cwd: buildStage });
  await rm(join(buildStage, "node_modules", ".bin"), { recursive: true, force: true });

  const completeAssets = [];
  for (const target of targets) {
    const rootName = `memhub-v${version}-${target.id}`;
    const stage = join(tempRoot, rootName);

    if (target.os === "linux") {
      await cp(buildStage, stage, { recursive: true });
      await installNodeRuntime(target, stage, tempRoot);
      run(join(stage, "runtime", "node", "bin", "node"), ["scripts/complete-runtime-smoke.cjs"], {
        cwd: stage,
        env: { ...process.env, PATH: "/usr/bin:/bin" }
      });
    } else {
      await exportSource(stage, "windows");
      await cp(join(buildStage, "dist"), join(stage, "dist"), { recursive: true });
      run("npm", ["ci", "--ignore-scripts", "--omit=dev", "--workspaces=false", "--os=win32", "--cpu=x64"], {
        cwd: stage,
        env: { ...process.env, ONNXRUNTIME_NODE_INSTALL_CUDA: "skip" }
      });
      await installWindowsBetterSqlite(stage);
      await rm(join(stage, "node_modules", ".bin"), { recursive: true, force: true });
      await installNodeRuntime(target, stage, tempRoot);
      await validateWindowsStage(stage);
    }

    const filename = `${rootName}.${target.format}`;
    const output = resolve(outputRoot, filename);
    if (target.os === "linux") {
      run("tar", ["-czf", output, "-C", tempRoot, rootName]);
    } else if (process.platform === "win32") {
      runPowerShell(
        "Compress-Archive -LiteralPath $args[0] -DestinationPath $args[1] -CompressionLevel Optimal -Force",
        [join(tempRoot, rootName), output]
      );
    } else {
      run("zip", ["-qr", output, rootName], { cwd: tempRoot });
    }
    const sha256 = await hashFile(output);
    completeAssets.push({ ...target, filename, sha256, nodeVersion: NODE_VERSION });
    console.error(`[memhub] complete asset ready: ${filename}`);

  }

  const result = { ok: true, version, commit, ref: WORKTREE ? "WORKTREE" : REF, nodeVersion: NODE_VERSION, completeAssets };
  await writeFile(resolve(outputRoot, "complete-assets.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
  await mergeReleaseMetadata(outputRoot, result);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function exportSource(destination, os) {
  await mkdir(destination, { recursive: true });
  const paths = [
    ...commonPaths,
    "editions/local/README.md",
    "editions/local/README.zh-CN.md",
    `editions/local/${os}`,
    "editions/server/README.md",
    "editions/server/README.zh-CN.md",
    `editions/server/${os}`
  ];
  if (WORKTREE) {
    for (const path of paths) {
      const source = resolve(ROOT, path);
      const target = resolve(destination, path);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, { recursive: true });
    }
    return;
  }
  const archive = join(tempRoot, `source-${os}-${Math.random().toString(16).slice(2)}.tar`);
  const result = spawnSync("git", ["archive", "--format=tar", `--output=${archive}`, REF, "--", ...paths], {
    cwd: ROOT,
    encoding: "utf8"
  });
  if (result.status !== 0) throw new Error(result.stderr || `git archive failed for ${os}`);
  run("tar", ["-xf", archive, "-C", destination]);
  await rm(archive, { force: true });
}

async function installNodeRuntime(target, stage, temp) {
  const baseUrl = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const sums = commandText("curl", ["-fsSL", `${baseUrl}/SHASUMS256.txt`]);
  const line = sums.split(/\r?\n/).find((entry) => entry.endsWith(`  ${target.nodeArchive}`));
  if (!line) throw new Error(`Node.js checksum missing for ${target.nodeArchive}`);
  const expected = line.split(/\s+/)[0].toLowerCase();
  const archive = join(temp, target.nodeArchive);
  run("curl", ["-fL", "--retry", "3", "--retry-delay", "1", `${baseUrl}/${target.nodeArchive}`, "-o", archive]);
  const actual = await hashFile(archive);
  if (actual !== expected) throw new Error(`Node.js checksum mismatch for ${target.nodeArchive}`);

  const extractRoot = join(temp, `node-${target.os}-${Math.random().toString(16).slice(2)}`);
  await mkdir(extractRoot, { recursive: true });
  if (target.os === "linux") run("tar", ["-xJf", archive, "-C", extractRoot]);
  else if (process.platform === "win32") {
    runPowerShell("Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force", [archive, extractRoot]);
  } else {
    run("unzip", ["-q", archive, "-d", extractRoot]);
  }
  const folder = target.os === "linux"
    ? `node-v${NODE_VERSION}-linux-x64`
    : `node-v${NODE_VERSION}-win-x64`;
  const runtimeRoot = join(stage, "runtime", "node");
  await mkdir(dirname(runtimeRoot), { recursive: true });
  await rename(join(extractRoot, folder), runtimeRoot);
}

async function installWindowsBetterSqlite(stage) {
  const cli = join(stage, "node_modules", "prebuild-install", "bin.js");
  const cwd = join(stage, "node_modules", "better-sqlite3");
  run(process.execPath, [cli, "--platform=win32", "--arch=x64", "--runtime=node", `--target=${NODE_VERSION}`], { cwd });
}

async function validateWindowsStage(stage) {
  const required = [
    "runtime/node/node.exe",
    "dist/mcp.js",
    "dist/bridge.js",
    "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    "node_modules/sqlite-vec-windows-x64/vec0.dll",
    "node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.4.node",
    "node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node",
    "node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll"
  ];
  for (const relative of required) await access(join(stage, relative));
  for (const relative of [
    "runtime/node/node.exe",
    "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    "node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node"
  ]) {
    await assertPe32PlusX64(join(stage, relative));
  }
}

async function assertPe32PlusX64(path) {
  const bytes = await readFile(path);
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new Error(`not a PE executable: ${path}`);
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 26 > bytes.length || bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error(`invalid PE header: ${path}`);
  }
  const machine = bytes.readUInt16LE(peOffset + 4);
  const optionalMagic = bytes.readUInt16LE(peOffset + 24);
  if (machine !== 0x8664 || optionalMagic !== 0x20b) {
    throw new Error(`expected PE32+ x86-64 binary: ${path}`);
  }
}

async function mergeReleaseMetadata(outputRoot, result) {
  const manifestPath = resolve(outputRoot, "release-manifest.json");
  const sumsPath = resolve(outputRoot, "SHA256SUMS.txt");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return;
  }
  if (manifest.version !== version) throw new Error(`release manifest version mismatch: ${manifest.version} != ${version}`);
  if (manifest.commit !== commit) throw new Error(`release manifest commit mismatch: ${manifest.commit} != ${commit}`);
  manifest.format = "memhub-release-v2";
  manifest.nodeVersion = NODE_VERSION;
  manifest.completeAssets = result.completeAssets;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  let existing = "";
  try { existing = await readFile(sumsPath, "utf8"); } catch {}
  const completeNames = new Set(result.completeAssets.map((asset) => asset.filename));
  const kept = existing.split(/\r?\n/).filter(Boolean).filter((line) => {
    const name = line.trim().split(/\s+/).at(-1);
    return !completeNames.has(name);
  });
  const added = result.completeAssets.map((asset) => `${asset.sha256}  ${asset.filename}`);
  await writeFile(sumsPath, [...kept, ...added].join("\n") + "\n", "utf8");
}

function sourceText(path) {
  if (CHECK_ONLY || WORKTREE) return readFileSyncCompat(resolve(ROOT, path));
  return gitText("show", `${REF}:${path}`);
}

function readFileSyncCompat(path) {
  const result = spawnSync(process.execPath, ["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1],'utf8'))", path], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `read failed: ${path}`);
  return result.stdout;
}

function assertSource(path) {
  if (CHECK_ONLY || WORKTREE) {
    if (!existsSync(resolve(ROOT, path))) throw new Error(`release path is missing: ${path}`);
    return;
  }
  gitText("cat-file", "-e", `${REF}:${path}`);
}

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function gitText(...args) {
  return commandText("git", args, { cwd: ROOT });
}

function commandText(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `${command} ${args.join(" ")} failed`);
  return result.stdout;
}

function run(command, args, options = {}) {
  const invocation = portableInvocation(command, args);
  console.error(`[memhub] ${command} ${args.join(" ")}`);
  const result = spawnSync(invocation.command, invocation.args, { ...options, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
}

function portableInvocation(command, args) {
  if (process.platform === "win32" && command === "npm") {
    const npmExecPath = process.env.npm_execpath?.trim();
    if (npmExecPath) return { command: process.execPath, args: [npmExecPath, ...args] };
  }
  return { command, args };
}

function runPowerShell(script, args = []) {
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, ...args]);
}

async function hashFile(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}
