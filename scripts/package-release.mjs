#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CHECK_ONLY = process.argv.includes("--check");
const WORKTREE = process.argv.includes("--worktree");
const REF = argumentValue("--ref") ?? "HEAD";

const variants = [
  { id: "linux-local", os: "linux", edition: "local", format: "tar.gz" },
  { id: "linux-server", os: "linux", edition: "server", format: "tar.gz" },
  { id: "windows-local", os: "windows", edition: "local", format: "zip" },
  { id: "windows-server", os: "windows", edition: "server", format: "zip" }
];

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
  "tests",
  "web-assets",
  "deploy",
  "adapters",
  "docs",
  "vendor",
  "editions/README.md"
];

const packageJson = CHECK_ONLY || WORKTREE
  ? JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"))
  : JSON.parse(gitText("show", `${REF}:package.json`));
const version = String(packageJson.version ?? "").trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid package version: ${version || "<empty>"}`);

const pluginJson = CHECK_ONLY || WORKTREE
  ? JSON.parse(await readFile(resolve(ROOT, "adapters/plugin/plugin.json"), "utf8"))
  : JSON.parse(gitText("show", `${REF}:adapters/plugin/plugin.json`));
if (pluginJson.version !== version) {
  throw new Error(`version mismatch: package=${version}, plugin=${pluginJson.version}`);
}

for (const variant of variants) {
  const installer = `editions/${variant.edition}/${variant.os}/install.${variant.os === "windows" ? "ps1" : "sh"}`;
  assertTracked(installer);
}
for (const path of [
  "install-complete.sh",
  "install-complete.ps1",
  "scripts/package-complete-release.mjs",
  "scripts/package-all-release.mjs",
  "scripts/complete-runtime-smoke.cjs"
]) assertTracked(path);

if (CHECK_ONLY) {
  console.log(JSON.stringify({
    ok: true,
    version,
    variants: variants.map((item) => item.id),
    complete_variants: ["linux-x64-complete", "windows-x64-complete"],
    worktree: WORKTREE
  }, null, 2));
  process.exit(0);
}

const commit = WORKTREE ? gitText("rev-parse", "HEAD").trim() : gitText("rev-parse", `${REF}^{commit}`).trim();
const outputRoot = resolve(ROOT, "release", `v${version}`);
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
const tempRoot = WORKTREE ? await mkdtemp(join(tmpdir(), "memhub-release-")) : null;

const assets = [];
try {
  for (const variant of variants) {
    const rootName = `memhub-v${version}-${variant.id}`;
    const filename = `${rootName}.${variant.format}`;
    const output = resolve(outputRoot, filename);
    const paths = [
      ...commonPaths,
      `editions/${variant.edition}/README.md`,
      `editions/${variant.edition}/README.zh-CN.md`,
      `editions/${variant.edition}/${variant.os}`
    ];
    if (WORKTREE) {
      const stage = join(tempRoot, rootName);
      await mkdir(stage, { recursive: true });
      for (const path of paths) {
        const source = resolve(ROOT, path);
        const target = resolve(stage, path);
        await mkdir(dirname(target), { recursive: true });
        await cp(source, target, { recursive: true, force: true });
      }
      if (variant.format === "tar.gz") {
        run("tar", ["-czf", output, "-C", tempRoot, rootName]);
      } else {
        run("zip", ["-qr", output, rootName], { cwd: tempRoot });
      }
    } else {
      gitArchive({ ref: REF, format: variant.format, prefix: `${rootName}/`, output, paths });
    }
    const digest = createHash("sha256").update(await readFile(output)).digest("hex");
    assets.push({ ...variant, filename, sha256: digest });
  }
} finally {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}

await writeFile(
  resolve(outputRoot, "SHA256SUMS.txt"),
  assets.map((asset) => `${asset.sha256}  ${asset.filename}`).join("\n") + "\n",
  "utf8"
);
await writeFile(
  resolve(outputRoot, "release-manifest.json"),
  JSON.stringify({ format: "memhub-release-v1", version, commit, ref: WORKTREE ? "WORKTREE" : REF, assets }, null, 2) + "\n",
  "utf8"
);

console.log(JSON.stringify({ ok: true, version, commit, ref: WORKTREE ? "WORKTREE" : REF, outputRoot, assets }, null, 2));

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function gitText(...args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? ROOT, encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
}

function assertTracked(path) {
  if (CHECK_ONLY || WORKTREE) {
    const result = spawnSync(process.execPath, ["-e", "const fs=require('node:fs'); process.exit(fs.existsSync(process.argv[1])?0:1)", resolve(ROOT, path)], { cwd: ROOT, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`release path is missing from the working tree: ${path}`);
    return;
  }
  gitText("cat-file", "-e", `${REF}:${path}`);
}

function gitArchive({ ref, format, prefix, output, paths }) {
  const result = spawnSync("git", [
    "archive",
    `--format=${format}`,
    `--prefix=${prefix}`,
    `--output=${output}`,
    ref,
    "--",
    ...paths
  ], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git archive failed for ${output}`);
}

