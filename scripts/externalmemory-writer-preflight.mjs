#!/usr/bin/env node
import { readFile, readlink, readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNERS = new Set([
  "run_codex_continuity_lookahead.py",
  "run_dsh_chronological_batch.py"
]);
const scriptPath = fileURLToPath(import.meta.url);

/**
 * Observe a canonical writer without ever acquiring, unlinking, truncating,
 * or otherwise changing its flock file. An idle snapshot is NOT a lease:
 * the actual runner must still acquire the canonical kernel flock.
 */
export function assessExternalMemoryWriter(snapshot) {
  const { lockPresent, owner, holders, runners, scanComplete } = snapshot;
  const details = {
    owner_pid: owner?.pid ?? null,
    lock_holder_pids: holders,
    runner_pids: runners,
    scan_complete: scanComplete
  };
  const result = (status, reason) => ({
    status, reason, block_new_writer: status !== "idle",
    canonical_flock_still_required: true, ...details
  });
  if (!scanComplete) return result("unknown", "process or kernel lock inspection was incomplete");
  if (runners.length > 1) return result("overlap", "multiple canonical runners target the same run");
  if (!lockPresent) {
    return runners.length || holders.length
      ? result("unknown", "runner or kernel lock exists without canonical lock path")
      : result("idle", "no canonical owner, runner or kernel lock observed");
  }
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
      !Number.isSafeInteger(owner.started_at) || owner.started_at <= 0 ||
      owner.run_dir !== snapshot.runDir) {
    return result("unknown", "owner metadata is missing, malformed or targets another run");
  }
  if (holders.length === 1 && holders[0] === owner.pid &&
      runners.length === 1 && runners[0] === owner.pid) {
    return result("active", "owner PID, target run and kernel flock agree");
  }
  if (holders.length) return result("unknown", "kernel flock holder does not match verified owner");
  return runners.includes(owner.pid)
    ? result("unknown", "owner process exists but no kernel flock is held")
    : result("stale_or_unknown", "lock metadata remains without a verified live owner or kernel flock");
}

export async function inspectExternalMemoryWriter(runDirectory, procRoot = "/proc") {
  const runDir = resolve(runDirectory);
  const lockPath = join(runDir, ".continuity_advance.lock");
  const [lock, processes, locks] = await Promise.all([
    inspectLockFile(lockPath),
    inspectRunners(runDir, procRoot),
    readFile(join(procRoot, "locks"), "utf8")
  ]);
  const holders = lock.present && lock.stat
    ? parseLockHolders(locks, lock.stat)
    : [];
  return {
    run_dir: runDir,
    lock_path: lockPath,
    observed_at: new Date().toISOString(),
    ...assessExternalMemoryWriter({
      runDir, lockPresent: lock.present, owner: lock.owner, holders,
      runners: processes.runners, scanComplete: processes.complete
    })
  };
}

async function inspectLockFile(path) {
  try {
    const meta = await readFile(path, "utf8");
    const fileStat = await stat(path, { bigint: true });
    let owner;
    try { owner = JSON.parse(meta); } catch { owner = null; }
    return { present: true, stat: fileStat, owner };
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false, owner: null };
    throw error;
  }
}

async function inspectRunners(runDir, procRoot) {
  const runners = [];
  let complete = true;
  for (const item of await readdir(procRoot)) {
    if (!/^\d+$/.test(item)) continue;
    let args;
    try {
      args = (await readFile(join(procRoot, item, "cmdline"), "utf8"))
        .split("\0").filter(Boolean);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ESRCH") continue;
      complete = false;
      continue;
    }
    const scriptIndex = args.slice(0, 4).findIndex((arg) => RUNNERS.has(basename(arg)));
    if (scriptIndex === -1) continue;
    const runArg = args[scriptIndex + 1];
    if (!runArg || runArg.startsWith("-")) { complete = false; continue; }
    let cwd;
    try { cwd = await readlink(join(procRoot, item, "cwd")); }
    catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ESRCH") continue;
      complete = false;
      continue;
    }
    const target = isAbsolute(runArg) ? resolve(runArg) : resolve(cwd, runArg);
    if (target === runDir) runners.push(Number(item));
  }
  return { runners: runners.sort((a, b) => a - b), complete };
}

export function parseLockHolders(table, fileStat) {
  const dev = fileStat.dev;
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
  const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
  const holders = new Set();
  for (const line of table.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6 || !/^\d+:$/.test(fields[0]) ||
        !["FLOCK", "POSIX", "OFDLCK"].includes(fields[1])) continue;
    const parts = fields[5].split(":");
    if (parts.length !== 3) continue;
    try {
      if (BigInt(`0x${parts[0]}`) !== major ||
          BigInt(`0x${parts[1]}`) !== minor ||
          BigInt(parts[2]) !== fileStat.ino) continue;
      if (/^\d+$/.test(fields[4])) holders.add(Number(fields[4]));
    } catch { /* Ignore a malformed, unrelated proc row. */ }
  }
  return [...holders].sort((a, b) => a - b);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const runDir = process.argv[2];
  if (!runDir || process.argv.length !== 3) {
    console.error("usage: node scripts/externalmemory-writer-preflight.mjs <absolute-run-directory>");
    process.exitCode = 2;
  } else {
    try {
      const report = await inspectExternalMemoryWriter(runDir);
      console.log(JSON.stringify(report, null, 2));
      // Diagnostic contract: only verified idle is a nonblocking result.
      process.exitCode = report.block_new_writer ? 3 : 0;
    } catch (error) {
      console.error(JSON.stringify({ status: "unknown", block_new_writer: true,
        reason: error instanceof Error ? error.message : String(error) }));
      process.exitCode = 3;
    }
  }
}
