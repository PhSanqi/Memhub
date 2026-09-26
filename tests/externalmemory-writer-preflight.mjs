import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessExternalMemoryWriter,
  inspectExternalMemoryWriter,
  parseLockHolders
} from "../scripts/externalmemory-writer-preflight.mjs";

const root = await mkdtemp(join(tmpdir(), "memhub-externalmemory-guard-"));
const run = join(root, "run");
const proc = join(root, "proc");
const lock = join(run, ".continuity_advance.lock");
const pid = 4242;
const procPid = join(proc, String(pid));
const owner = { pid, started_at: Math.floor(Date.now() / 1000), run_dir: run };

try {
  await mkdir(run);
  await mkdir(procPid, { recursive: true });
  await symlink(root, join(procPid, "cwd"));
  await writeFile(join(procPid, "cmdline"),
    ["python3", "scripts/run_codex_continuity_lookahead.py", "run", "--lookahead", "2", ""].join("\0"));
  const writeKernelLock = async () => {
    const s = await stat(lock, { bigint: true });
    const dev = s.dev;
    const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
    const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
    const row = `4: FLOCK ADVISORY WRITE ${pid} ${major.toString(16)}:${minor.toString(16)}:${s.ino} 0 EOF\n`;
    await writeFile(join(proc, "locks"), row);
    assert.deepEqual(parseLockHolders(row, s), [pid]);
  };
  await writeFile(lock, JSON.stringify(owner) + "\n");
  await writeKernelLock();
  const before = await stat(lock);
  const active = await inspectExternalMemoryWriter(run, proc);
  assert.equal(active.status, "active");
  assert.equal(active.block_new_writer, true);
  assert.deepEqual(active.runner_pids, [pid]);
  assert.equal(await readFile(lock, "utf8"), JSON.stringify(owner) + "\n");
  assert.equal((await stat(lock)).mtimeMs, before.mtimeMs,
    "diagnostic must not acquire, truncate or alter the canonical lock");

  await mkdir(join(proc, "4243"));
  await symlink(root, join(proc, "4243", "cwd"));
  await writeFile(join(proc, "4243", "cmdline"),
    "python3\0scripts/run_dsh_chronological_batch.py\0run\0");
  assert.equal((await inspectExternalMemoryWriter(run, proc)).status, "overlap",
    "a second canonical runner must be flagged even while the first holds flock");
  await rm(join(proc, "4243"), { recursive: true });

  await writeFile(join(proc, "locks"), "");
  assert.equal((await inspectExternalMemoryWriter(run, proc)).status, "unknown",
    "a PID in metadata without a kernel flock must not be treated as an active owner");
  await rm(procPid, { recursive: true });
  assert.equal((await inspectExternalMemoryWriter(run, proc)).status, "stale_or_unknown",
    "stale metadata is never permission to remove a lock");
  await rm(lock);
  assert.equal((await inspectExternalMemoryWriter(run, proc)).status, "idle");
  assert.equal((await inspectExternalMemoryWriter(run, proc)).canonical_flock_still_required, true);
  const hiddenRunner = assessExternalMemoryWriter({
    runDir: run, lockPresent: false, owner: null,
    holders: [], runners: [], scanComplete: false
  });
  assert.equal(hiddenRunner.status, "unknown", "incomplete process visibility must fail closed");
  const invalidOwner = assessExternalMemoryWriter({
    runDir: run, lockPresent: true,
    owner: { ...owner, run_dir: "/another-run" }, holders: [pid], runners: [pid],
    scanComplete: true
  });
  assert.equal(invalidOwner.status, "unknown");
  console.log("externalmemory-writer-preflight: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
