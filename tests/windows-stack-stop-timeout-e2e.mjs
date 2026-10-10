import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("memhub-windows-stack-stop-timeout-e2e: skipped (Windows-only)");
  process.exit(0);
}

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const candidate = join(repo, "scripts", "run-stack.mjs");
const root = await mkdtemp(join(tmpdir(), "memhub-stop-timeout-"));
const priorScripts = join(root, "previous-release", "scripts");
const priorEntry = join(priorScripts, "run-stack.mjs");
const lock = join(root, ".memhub-stack.lock");
const stopFile = lock + ".stop";
let owner;
try {
  await mkdir(priorScripts, { recursive: true });
  await writeFile(priorEntry, "setInterval(() => {}, 1000);\n");
  const startedAt = new Date().toISOString();
  owner = spawn(process.execPath, [priorEntry, "--home", root], {
    windowsHide: true, stdio: "ignore"
  });
  await new Promise((done) => setTimeout(done, 300));
  const token = "timeout-owner-" + process.pid;
  const original = JSON.stringify({
    pid: owner.pid, token, started_at: startedAt,
    entrypoint: priorEntry, exec_path: process.execPath, home: root
  }) + "\n";
  await writeFile(lock, original);
  const before = Date.now();
  const stopper = spawn(process.execPath, [
    candidate, "--home", root, "--action", "stop"
  ], { cwd: repo, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let error = "";
  stopper.stderr.on("data", (chunk) => { error += chunk.toString(); });
  const code = await new Promise((done) => stopper.once("exit", done));
  const elapsed = Date.now() - before;
  assert.notEqual(code, 0);
  assert.match(error, /stack graceful stop timed out/);
  assert.ok(elapsed >= 19_000 && elapsed < 30_000,
    `cooperative stop timeout was not bounded as expected: ${elapsed}ms`);
  assert.equal(owner.exitCode, null, "timeout path must not force-kill verified owner");
  assert.equal(await readFile(lock, "utf8"), original, "timeout path must preserve owner lock");
  const request = JSON.parse(await readFile(stopFile, "utf8"));
  assert.equal(request.pid, owner.pid);
  assert.equal(request.token, token);
  console.log(`memhub-windows-stack-stop-timeout-e2e: ok elapsed_ms=${elapsed} owner_survived=true`);
} finally {
  if (owner && owner.exitCode === null) owner.kill();
  await rm(root, { recursive: true, force: true });
}
