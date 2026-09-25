import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";

const processMutationTails = new Map<string, Promise<void>>();
const LOCK_TIMEOUT_MS = 15_000;
const RETRY_MS = 10;

interface LockOwner {
  token: string;
  pid: number;
  host: string;
  createdAt: string;
}

export async function withFileMutationLock<T>(targetPath: string, run: () => Promise<T>): Promise<T> {
  const key = resolve(targetPath);
  const previous = processMutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => { release = resolveLock; });
  processMutationTails.set(key, current);
  await previous;
  try {
    return await withCrossProcessLock(key, run);
  } finally {
    release();
    if (processMutationTails.get(key) === current) processMutationTails.delete(key);
  }
}

async function withCrossProcessLock<T>(targetPath: string, run: () => Promise<T>): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
  const owner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    createdAt: new Date().toISOString()
  };
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(owner) + "\n", "utf8");
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (!isLockContentionError(error)) throw error;
      // Serialize recovery as well as normal writes. Without a recovery
      // guard, two contenders can both observe a dead owner; the slower one
      // may unlink the faster contender's newly acquired live lock.
      if (await staleLockCanBeRemoved(lockPath) && await reclaimDeadLocalLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for state lock: ${targetPath}`);
      await delay(RETRY_MS);
    }
  }

  try {
    return await run();
  } finally {
    await releaseOwnedLock(lockPath, owner.token);
  }
}

async function reclaimDeadLocalLock(lockPath: string): Promise<boolean> {
  const guardPath = `${lockPath}.reclaim`;
  let guard;
  try {
    guard = await open(guardPath, "wx", 0o600);
  } catch (error) {
    if (isLockContentionError(error)) return false;
    throw error;
  }
  try {
    // Recheck only after acquiring the guard: the owner may have changed.
    if (!(await staleLockCanBeRemoved(lockPath))) return false;
    await unlink(lockPath).catch((error) => {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    });
    return true;
  } finally {
    await guard.close();
    await unlink(guardPath).catch((error) => {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    });
  }
}

function isLockContentionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "EEXIST") return true;
  return process.platform === "win32" && (code === "EPERM" || code === "EACCES");
}

async function staleLockCanBeRemoved(lockPath: string): Promise<boolean> {
  try {
    await stat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return true;
    throw error;
  }

  let owner: Partial<LockOwner> | undefined;
  try {
    owner = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockOwner>;
  } catch {
    // A malformed owner is not evidence that its writer is dead. In
    // particular, a writer can be between O_EXCL and writing its metadata.
    return false;
  }
  // Filesystems may be shared across hosts. Age alone must never authorize
  // deleting another host's live lock: there is no reliable remote PID check.
  if (owner.host !== hostname() || !owner.token || !Number.isInteger(owner.pid)) return false;
  if (owner.host === hostname() && Number.isInteger(owner.pid)) {
    try {
      process.kill(owner.pid!, 0);
      return false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ESRCH") return true;
      return false;
    }
  }
  return false;
}

async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockOwner>;
    if (owner.token !== token) return;
    await unlink(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
