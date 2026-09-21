#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CHECK_ONLY = process.argv.includes("--check");
const REF = argumentValue("--ref") ?? "HEAD";

const variants = [
  { id: "linux-local", os: "linux", edition: "local", format: "tar.gz" },
  { id: "linux-server", os: "linux", edition: "server", format: "tar.gz" },
  { id: "windows-local", os: "windows", edition: "local", format: "zip" },
  { id: "windows-server", os: "windows", edition: "server", format: "zip" }
];

const bootstrapPaths = ["install.sh", "install.ps1", "install-complete.sh", "install-complete.ps1"];

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
  "deploy",
  "adapters",
  "docs",
  "vendor",
  "editions/README.md"
];

const packageJson = CHECK_ONLY
  ? JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"))
  : JSON.parse(gitText("show", `${REF}:package.json`));
const version = String(packageJson.version ?? "").trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid package version: ${version || "<empty>"}`);

const pluginJson = CHECK_ONLY
  ? JSON.parse(await readFile(resolve(ROOT, "adapters/plugin/plugin.json"), "utf8"))
  : JSON.parse(gitText("show", `${REF}:adapters/plugin/plugin.json`));
if (pluginJson.version !== version) {
  throw new Error(`version mismatch: package=${version}, plugin=${pluginJson.version}`);
}

for (const variant of variants) {
  const installer = `editions/${variant.edition}/${variant.os}/install.${variant.os === "windows" ? "ps1" : "sh"}`;
  assertTracked(installer);
}
for (const path of bootstrapPaths) assertTracked(path);

if (CHECK_ONLY) {
  console.log(JSON.stringify({ ok: true, version, variants: variants.map((item) => item.id) }, null, 2));
  process.exit(0);
}

const commit = gitText("rev-parse", `${REF}^{commit}`).trim();
const outputRoot = resolve(ROOT, "release", `v${version}`);
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const assets = [];
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
  gitArchive({ ref: REF, format: variant.format, prefix: `${rootName}/`, output, paths });
  const digest = createHash("sha256").update(await readFile(output)).digest("hex");
  assets.push({ ...variant, filename, sha256: digest });
}

const bootstraps = [];
for (const filename of bootstrapPaths) {
  const output = resolve(outputRoot, filename);
  await writeFile(output, gitText("show", `${REF}:${filename}`), "utf8");
  const digest = createHash("sha256").update(await readFile(output)).digest("hex");
  bootstraps.push({ filename, sha256: digest });
}

await writeFile(
  resolve(outputRoot, "SHA256SUMS.txt"),
  [...assets, ...bootstraps].map((asset) => `${asset.sha256}  ${asset.filename}`).join("\n") + "\n",
  "utf8"
);
await writeFile(
  resolve(outputRoot, "release-manifest.json"),
  JSON.stringify({ format: "memhub-release-v1", version, commit, ref: REF, assets, bootstraps }, null, 2) + "\n",
  "utf8"
);

console.log(JSON.stringify({ ok: true, version, commit, outputRoot, assets, bootstraps }, null, 2));

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

function assertTracked(path) {
  if (CHECK_ONLY) {
    const result = spawnSync("git", ["ls-files", "--error-unmatch", path], { cwd: ROOT, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`release path is not tracked: ${path}`);
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

