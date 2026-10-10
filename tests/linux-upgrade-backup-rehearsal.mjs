import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import Database from "better-sqlite3";

if (process.platform !== "linux") {
  console.log("linux-upgrade-backup-rehearsal: skipped (linux only)");
  process.exit(0);
}

// This test deliberately uses ONLY an invented temporary HOME. It exercises
// a consistent two-SQLite snapshot and a protected-file rollback. It is not
// an installer, live backup command, or actual cross-version upgrade.
const sandbox = await mkdtemp(join(tmpdir(), "memhub-linux-backup-rehearsal-"));
const source = join(sandbox, "source");
const snapshot = join(sandbox, "snapshot");
const restored = join(sandbox, "restored");
const rel = {
  core: ".memmy/memory-service/memory.sqlite",
  capture: ".memmy/memhub/capture-index.sqlite",
  config: ".memmy/config.yaml",
  env: ".memmy/memhub/memhub.env",
  captureEvent: ".memmy/memhub/captures/event.json",
  job: ".memmy/memhub/distillation/jobs.json",
  unit: ".config/systemd/user/memhub.service"
};
const at = (home, key) => join(home, rel[key]);
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
let core;
let capture;

const listHashes = async (dir, root = dir, output = {}) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await listHashes(full, root, output);
    else {
      assert.equal(entry.isFile(), true, "backup must not include symlinks or special files");
      output[relative(root, full)] = hash(await readFile(full));
    }
  }
  return output;
};

const checkSqlite = (home, key, expected, seal = false) => {
  const db = new Database(at(home, key), { readonly: !seal, fileMustExist: true });
  try {
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(db.prepare("SELECT marker FROM evidence ORDER BY marker").all(),
      expected.map((marker) => ({ marker })));
    if (seal) {
      db.pragma("wal_checkpoint(TRUNCATE)");
      assert.equal(db.pragma("journal_mode = DELETE", { simple: true }), "delete");
    }
  } finally { db.close(); }
};

try {
  for (const name of [".memmy/memory-service", ".memmy/memhub/captures",
    ".memmy/memhub/distillation", ".config/systemd/user"]) {
    await mkdir(join(source, name), { recursive: true });
  }
  await writeFile(at(source, "config"), "private-core-config-v1\n", { mode: 0o600 });
  await writeFile(at(source, "env"), "private-gateway-token-v1\n", { mode: 0o600 });
  await writeFile(at(source, "captureEvent"), '{"capture":"before-upgrade"}\n');
  await writeFile(at(source, "job"), '{"pending":"before-upgrade"}\n');
  await writeFile(at(source, "unit"), "ExecStart=/old-version/dist/mcp.js --http-path /mcp\n");
  core = new Database(at(source, "core"));
  capture = new Database(at(source, "capture"));
  for (const db of [core, capture]) {
    assert.equal(db.pragma("journal_mode = WAL", { simple: true }), "wal");
    db.exec("CREATE TABLE evidence (marker TEXT PRIMARY KEY)");
  }
  core.prepare("INSERT INTO evidence (marker) VALUES (?)").run("core-before-upgrade");
  capture.prepare("INSERT INTO evidence (marker) VALUES (?)").run("capture-before-upgrade");
  // Both engines remain open with committed rows in WAL. Copying only the
  // main .sqlite files would NOT establish a complete snapshot.
  for (const key of ["core", "capture"]) {
    assert.ok((await readFile(at(source, key) + "-wal")).length > 0);
  }

  const excludedCapture = new Set(["capture-index.sqlite", "capture-index.sqlite-wal",
    "capture-index.sqlite-shm", "capture-index.sqlite-journal"]);
  await mkdir(join(snapshot, ".memmy"), { recursive: true });
  await cp(join(source, ".memmy/memhub"), join(snapshot, ".memmy/memhub"), {
    recursive: true,
    filter: (path) => !excludedCapture.has(basename(path))
  });
  await cp(join(source, ".config"), join(snapshot, ".config"), { recursive: true });
  await cp(at(source, "config"), at(snapshot, "config"));
  await mkdir(join(snapshot, ".memmy/memory-service"), { recursive: true });
  await core.backup(at(snapshot, "core"));
  await capture.backup(at(snapshot, "capture"));

  // Validate SQLite consistency before sealing the byte-level manifest:
  // opening a WAL-mode database can update its journal/checkpoint metadata.
  checkSqlite(snapshot, "core", ["core-before-upgrade"], true);
  checkSqlite(snapshot, "capture", ["capture-before-upgrade"], true);
  const baseline = await listHashes(snapshot);
  assert.ok(Object.keys(baseline).includes(rel.core));
  assert.ok(Object.keys(baseline).includes(rel.capture));
  assert.equal(Object.keys(baseline).some((name) => /\.sqlite-(wal|shm)$/.test(name)), false);

  // Model a candidate that changes BOTH databases, credentials, unit route
  // and queue/capture records, then roll back from a verified snapshot.
  await cp(snapshot, restored, { recursive: true });
  for (const key of ["core", "capture"]) {
    const db = new Database(at(restored, key));
    db.prepare("INSERT INTO evidence (marker) VALUES (?)").run("candidate-only");
    db.close();
  }
  await writeFile(at(restored, "config"), "rotated-token");
  await writeFile(at(restored, "env"), "rotated-token");
  await writeFile(at(restored, "captureEvent"), '{"capture":"candidate-only"}');
  await writeFile(at(restored, "unit"), "ExecStart=/new-version/dist/mcp.js --http-path /memhub/mcp\n");
  assert.notDeepEqual(await listHashes(restored), baseline);

  // Snapshot verification is an explicit gate. A damaged backup must not be
  // used for rollback, even when the candidate tree needs recovery.
  const corrupt = join(sandbox, "corrupt");
  await cp(snapshot, corrupt, { recursive: true });
  await writeFile(at(corrupt, "env"), "tampered-backup");
  assert.notDeepEqual(await listHashes(corrupt), baseline);
  await rm(corrupt, { recursive: true });

  assert.deepEqual(await listHashes(snapshot), baseline);
  await rm(restored, { recursive: true });
  await cp(snapshot, restored, { recursive: true });
  assert.deepEqual(await listHashes(restored), baseline,
    "rollback must restore units, credentials, complete Memhub state and both SQLite databases");
  checkSqlite(restored, "core", ["core-before-upgrade"]);
  checkSqlite(restored, "capture", ["capture-before-upgrade"]);
  checkSqlite(source, "core", ["core-before-upgrade"]);
  checkSqlite(source, "capture", ["capture-before-upgrade"]);
  console.log("linux-upgrade-backup-rehearsal: ok (disposable fixture, two WAL databases, protected trees, rollback)");
} finally {
  core?.close();
  capture?.close();
  await rm(sandbox, { recursive: true, force: true });
}
