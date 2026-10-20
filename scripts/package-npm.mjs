#!/usr/bin/env node

import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourcePackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const releaseRoot = join(root, "runtime-releases", "npm");
const stage = join(releaseRoot, `memhub-${sourcePackage.version}`);

run("npm", ["run", "build"], root);
await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, "bin"), { recursive: true });
await mkdir(join(stage, "scripts"), { recursive: true });

for (const directory of ["dist", "vendor", "web-assets"]) {
  await cp(join(root, directory), join(stage, directory), { recursive: true });
}
await cp(join(root, "bin", "memhub.mjs"), join(stage, "bin", "memhub.mjs"));
await cp(join(root, "scripts", "run-stack.mjs"), join(stage, "scripts", "run-stack.mjs"));
await cp(join(root, "distribution", "npm", "README.md"), join(stage, "README.md"));
await cp(join(root, "LICENSE"), join(stage, "LICENSE"));

// The packaged Control Plane is intentionally detached from maintainer identity.
// Runtime behavior remains unchanged; only maintainer/repository attribution links
// are stripped from the generated distribution artifact.
const stagedWebUi = join(stage, "dist", "web-ui.js");
const webUi = await readFile(stagedWebUi, "utf8");
await writeFile(stagedWebUi, webUi.replaceAll('<a href="https://github.com/PhSanqi/Memhub">GitHub</a>', ""));

const manifest = {
  name: "@phsanqi/memhub",
  version: sourcePackage.version,
  description: "Self-hosted, project-aware AI memory with provenance, temporal continuity and MCP integration.",
  license: "MIT",
  type: "module",
  bin: { memhub: "bin/memhub.mjs" },
  engines: { node: ">=20.9.0" },
  publishConfig: { access: "public" },
  dependencies: sourcePackage.dependencies
};
await writeFile(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

await privacyAudit(stage);

const packResult = run("npm", ["pack", "--json"], stage, true);
const parsed = JSON.parse(packResult.stdout);
const filename = parsed?.[0]?.filename;
if (!filename) throw new Error("npm pack did not return an artifact filename");
const artifact = join(stage, filename);
process.stdout.write(JSON.stringify({
  ok: true,
  package: manifest.name,
  version: manifest.version,
  stage,
  artifact,
  filename,
  size: parsed[0].size,
  unpackedSize: parsed[0].unpackedSize,
  files: parsed[0].entryCount
}, null, 2) + "\n");

async function privacyAudit(directory) {
  const forbidden = [
    { name: "maintainer repository link", pattern: /github\.com\/phsanqi/iu },
    { name: "private project domain", pattern: /sanqi\.org/iu },
    { name: "Linux user path", pattern: /\/home\/[A-Za-z0-9._-]+\//u },
    { name: "Windows user path", pattern: /[A-Za-z]:\\Users\\[^\\\s]+\\/iu },
    { name: "literal personal email", pattern: /[A-Za-z0-9._%+-]+@(gmail|outlook|icloud|qq|163)\.[A-Za-z]{2,}/iu }
  ];
  const textExtensions = new Set([".js", ".mjs", ".cjs", ".json", ".d.ts", ".txt", ".md", ".yaml", ".yml"]);
  const findings = [];
  for (const path of await walk(directory)) {
    if (!textExtensions.has(extname(path)) && !path.endsWith(".d.ts") && !path.endsWith("LICENSE")) continue;
    const info = await stat(path);
    if (info.size > 5 * 1024 * 1024) continue;
    const text = await readFile(path, "utf8");
    for (const rule of forbidden) {
      if (rule.pattern.test(text)) findings.push(`${rule.name}: ${relative(directory, path)}`);
    }
  }
  if (findings.length > 0) {
    throw new Error(`npm privacy audit failed:\n${[...new Set(findings)].map((item) => `- ${item}`).join("\n")}`);
  }
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ONNXRUNTIME_NODE_INSTALL_CUDA: "skip" },
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed${capture ? `: ${(result.stderr || result.stdout || "").trim()}` : ""}`);
  }
  return result;
}
