import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MemoryDb } from "../vendor/memory-core/src/storage/db.js";
import { MemoryService } from "../vendor/memory-core/src/service/memory-service.js";

// Several processes open the same WAL database. Each iteration reads before it
// writes, like one `POST /api/v1/memory/add` request: a deferred read-to-write
// upgrade returns SQLITE_BUSY immediately when another connection committed in
// between, while BEGIN IMMEDIATE waits on busy_timeout instead.
const scratch = "/tmp/p6mg";
const childScript = fileURLToPath(import.meta.url);
const children = 4;
const writesPerChild = 25;
const repeats = 5;

if (process.env.P6_MG_CHILD) {
  const path = process.env.P6_MG_CHILD;
  const index = Number(process.env.P6_MG_INDEX ?? 0);
  const writes = Number(process.env.P6_MG_WRITES ?? writesPerChild);
  const startAt = Number(process.env.P6_MG_START ?? 0);
  const db = new MemoryDb({ path });
  const service = new MemoryService({ db });
  const namespace = { userId: `p6mg-user-${index}`, tenantId: "p6mg", projectId: "p6mg" };
  try {
    while (Date.now() < startAt) {
      // Briefly spin so all children hit the database at the same moment.
    }
    for (let i = 0; i < writes; i++) {
      const before = service.repos.memories.count({ userId: namespace.userId });
      assert.equal(before, i, `child ${index} sees its own prior writes`);
      service.addMemory({
        layer: "L1",
        content: `p6mg child ${index} write ${i} ${process.pid} ${Date.now()}`,
        namespace,
        source: "p6mg-stress"
      });
      await new Promise((done) => setTimeout(done, (i + index) % 3));
    }
  } finally {
    db.close();
  }
} else {
  test("4 processes interleave read-then-write on one WAL database without SQLITE_BUSY", async () => {
    await mkdir(scratch, { recursive: true });
    for (let repeat = 0; repeat < repeats; repeat++) {
      const dir = await mkdtemp(join(scratch, `run-${repeat}-`));
      const path = join(dir, "memory.sqlite");
      const startAt = Date.now() + 500;
      const results = await Promise.all(
        Array.from({ length: children }, (_, index) => runChild(path, index, startAt, repeat))
      );
      for (const result of results) {
        assert.equal(result.code, 0,
          `repeat ${repeat} child ${result.index} exited ${result.code}: ${result.output}`);
        assert.doesNotMatch(result.output, /SQLITE_BUSY|database is locked/,
          `repeat ${repeat} child ${result.index} hit a lock error: ${result.output}`);
      }
      const db = new MemoryDb({ path });
      try {
        const count = Number(db.db.prepare("SELECT COUNT(*) AS count FROM memories").get().count);
        assert.equal(count, children * writesPerChild, `repeat ${repeat} final row count`);
        const busy = Number(db.db.pragma("busy_timeout", { simple: true }) ?? 0);
        assert.ok(busy > 0, "busy_timeout remains configured");
      } finally {
        db.close();
      }
    }
  });
}

function runChild(path, index, startAt, repeat) {
  return new Promise((resolve, reject) => {
    const logPath = join(scratch, `child-${repeat}-${index}.log`);
    const log = createWriteStream(logPath);
    const chunks = [];
    const child = spawn(process.execPath, [childScript], {
      env: {
        ...process.env,
        P6_MG_CHILD: path,
        P6_MG_INDEX: String(index),
        P6_MG_WRITES: String(writesPerChild),
        P6_MG_START: String(startAt)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk) => { chunks.push(chunk); log.write(chunk); });
    child.stderr.on("data", (chunk) => { chunks.push(chunk); log.write(chunk); });
    child.once("error", (error) => { log.end(); reject(error); });
    child.once("exit", (code) => {
      log.end();
      resolve({ index, code, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}
