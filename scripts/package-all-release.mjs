#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

run("scripts/package-release.mjs", args);
run("scripts/package-complete-release.mjs", args);

function run(script, forwarded) {
  const result = spawnSync(process.execPath, [resolve(root, script), ...forwarded], {
    cwd: root,
    stdio: "inherit"
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
