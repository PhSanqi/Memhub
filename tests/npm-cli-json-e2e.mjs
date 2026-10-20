#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = join(root, "bin", "memhub.mjs");
const home = await mkdtemp(join(tmpdir(), "memhub-cli-json-"));

try {
  for (const command of ["status", "stop"]) {
    const result = spawnSync(process.execPath, [cli, command, "--home", home, "--json"], {
      cwd: root,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const trimmed = result.stdout.trim();
    assert.ok(trimmed.startsWith("{") && trimmed.endsWith("}"), `${command} should emit one JSON object`);
    assert.doesNotThrow(() => JSON.parse(trimmed), `${command} output must be valid JSON`);
    assert.equal(trimmed.split(/\r?\n(?=\{)/).length, 1, `${command} emitted more than one JSON object`);
  }
  console.log("npm-cli-json-e2e: ok");
} finally {
  await rm(home, { recursive: true, force: true });
}
