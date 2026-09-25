import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationLock } from "../dist/file-mutation-lock.js";

const root = await mkdtemp(join(tmpdir(), "memhub-lock-safety-"));
const target = join(root, "state.json");
const lock = `${target}.lock`;
try {
  const foreign = { token: "foreign-owner", pid: 999999999, host: "another-host", createdAt: "2020-01-01T00:00:00.000Z" };
  await writeFile(lock, JSON.stringify(foreign));
  let entered = false;
  await assert.rejects(
    withFileMutationLock(target, async () => { entered = true; }),
    /timed out waiting for state lock/,
    "a foreign-host lock must not be reclaimed based on age or an unverifiable PID"
  );
  assert.equal(entered, false);
  assert.deepEqual(JSON.parse(await readFile(lock, "utf8")), foreign);

  await rm(lock);
  await writeFile(lock, JSON.stringify({ ...foreign, token: "dead-local-owner", host: hostname() }));
  assert.equal(await withFileMutationLock(target, async () => "recovered"), "recovered");
  await assert.rejects(readFile(lock), { code: "ENOENT" });

  // Competing processes must not remove each other's newly acquired lock
  // while reclaiming the same dead owner.
  await writeFile(lock, JSON.stringify({ ...foreign, token: "dead-local-owner", host: hostname() }));
  const events = join(root, "events.txt");
  const moduleUrl = new URL("../dist/file-mutation-lock.js", import.meta.url).href;
  const worker = `import {appendFile} from 'node:fs/promises'; import {withFileMutationLock} from ${JSON.stringify(moduleUrl)}; await withFileMutationLock(process.argv[1], async()=>{await appendFile(process.argv[2], 'start '+process.pid+'\\n');await new Promise(r=>setTimeout(r,150));await appendFile(process.argv[2], 'end '+process.pid+'\\n')});`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", worker, target, events], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`lock worker exited ${code}: ${stderr}`)));
  });
  await Promise.all([run(), run()]);
  const lines = (await readFile(events, "utf8")).trim().split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^start /);
  assert.equal(lines[1], lines[0].replace("start ", "end "));
  assert.match(lines[2], /^start /);
  assert.equal(lines[3], lines[2].replace("start ", "end "));
  console.log("file-mutation-lock-e2e: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
