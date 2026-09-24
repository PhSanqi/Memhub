import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";

const processMutationTails = new Map<string, Promise<void>>();
const LOCK_TIMEOUT_MS = 15_000;
const STALE_LOCK_MS = 300_000;
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
      if (await staleLockCanBeRemoved(lockPath)) {
        await unlink(lockPath).catch((unlinkError) => {
          if ((unlinkError as NodeJS.ErrnoException)?.code !== "ENOENT") throw unlinkError;
        });
        continue;
      }
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

function isLockContentionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "EEXIST") return true;
  return process.platform === "win32" && (code === "EPERM" || code === "EACCES");
}

async function staleLockCanBeRemoved(lockPath: string): Promise<boolean> {
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return true;
    throw error;
  }

  let owner: Partial<LockOwner> | undefined;
  try {
    owner = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockOwner>;
  } catch {
    return Date.now() - lockStat.mtimeMs >= STALE_LOCK_MS;
  }
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
  return Date.now() - lockStat.mtimeMs >= STALE_LOCK_MS;
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
