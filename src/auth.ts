import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const VERSION = 1;

export interface MemhubAccountRecord {
  account_id: string;
  created_at: string;
  role?: "user" | "admin";
  cloudflare?: {
    email: string;
    sub?: string;
  };
}

interface AccountStore {
  version: 1;
  accounts: Record<string, MemhubAccountRecord>;
}

export interface MemhubAccountSummary {
  username: string;
  account_id: string;
  created_at: string;
  cloudflare_email?: string;
  role: "user" | "admin";
}

let mutationTail = Promise.resolve();

export async function hasAccounts(stateRoot: string): Promise<boolean> {
  return Object.keys((await load(stateRoot)).accounts).length > 0;
}

export async function listAccounts(stateRoot: string): Promise<MemhubAccountSummary[]> {
  const data = await load(stateRoot);
  return Object.entries(data.accounts)
    .map(([username, record]) => ({
      username,
      account_id: record.account_id,
      created_at: record.created_at,
      role: record.role === "admin" ? "admin" as const : "user" as const,
      ...(record.cloudflare ? { cloudflare_email: record.cloudflare.email } : {})
    }))
    .sort((left, right) => left.username.localeCompare(right.username));
}

export async function setAccountRole(
  stateRoot: string,
  accountRefRaw: string,
  role: "user" | "admin"
): Promise<void> {
  const accountRef = accountRefRaw.trim();
  if (!accountRef) throw new Error("account reference is required");
  await withMutationLock(async () => {
    const data = await load(stateRoot);
    const entry = Object.entries(data.accounts).find(([username, record]) =>
      username === accountRef || record.account_id === accountRef || record.cloudflare?.email === accountRef.toLowerCase()
    );
    if (!entry) throw new Error(`账号不存在：${accountRef}`);
    entry[1].role = role;
    await save(stateRoot, data);
  });
}

export async function addAccount(
  stateRoot: string,
  usernameRaw: string,
  emailRaw?: string
): Promise<{ username: string; account_id: string }> {
  const username = usernameOf(usernameRaw);
  const email = emailRaw === undefined ? undefined : emailOf(emailRaw);
  return withMutationLock(async () => {
    const data = await load(stateRoot);
    if (data.accounts[username]) throw new Error(`账号已存在：${username}`);
    if (email) assertEmailAvailable(data, email);
    const accountId = randomUUID();
    data.accounts[username] = {
      account_id: accountId,
      created_at: new Date().toISOString(),
      ...(email ? { cloudflare: { email } } : {})
    };
    await save(stateRoot, data);
    return { username, account_id: accountId };
  });
}

export async function bindCloudflareEmail(stateRoot: string, usernameRaw: string, emailRaw: string): Promise<void> {
  const username = usernameOf(usernameRaw);
  const email = emailOf(emailRaw);
  await withMutationLock(async () => {
    const data = await load(stateRoot);
    const record = data.accounts[username];
    if (!record) throw new Error(`账号不存在：${username}`);
    assertEmailAvailable(data, email, username);
    if (record.cloudflare?.email === email) return;
    record.cloudflare = { email, ...(record.cloudflare?.sub ? { sub: record.cloudflare.sub } : {}) };
    await save(stateRoot, data);
  });
}

export async function deleteAccount(stateRoot: string, usernameRaw: string): Promise<void> {
  const username = usernameOf(usernameRaw);
  await withMutationLock(async () => {
    const data = await load(stateRoot);
    if (!data.accounts[username]) throw new Error(`账号不存在：${username}`);
    delete data.accounts[username];
    await save(stateRoot, data);
  });
}

export async function resolveCloudflareAccount(
  stateRoot: string,
  identity: { sub: string; email: string },
  options: { allowJit?: boolean } = {}
): Promise<{ username: string; account_id: string; created: boolean }> {
  const sub = identity.sub.trim();
  const email = emailOf(identity.email);
  if (!sub || sub.length > 512) throw new Error("Cloudflare sub 无效");

  return withMutationLock(async () => {
    const data = await load(stateRoot);
    const entries = Object.entries(data.accounts);
    const bySub = entries.find(([, record]) => record.cloudflare?.sub === sub);
    if (bySub) {
      const [username, record] = bySub;
      if (record.cloudflare!.email !== email) {
        assertEmailAvailable(data, email, username);
        record.cloudflare!.email = email;
        await save(stateRoot, data);
      }
      return { username, account_id: record.account_id, created: false };
    }

    const byEmail = entries.find(([, record]) => record.cloudflare?.email === email);
    if (byEmail) {
      const [username, record] = byEmail;
      record.cloudflare = { email, sub };
      await save(stateRoot, data);
      return { username, account_id: record.account_id, created: false };
    }

    if (!options.allowJit) {
      throw new Error("该 Cloudflare 邮箱未加入 Memhub 本地允许列表");
    }

    const username = `cf-${createHash("sha256").update(email, "utf8").digest("hex").slice(0, 32)}`;
    if (data.accounts[username]) throw new Error("Cloudflare JIT 账号键冲突");
    const accountId = randomUUID();
    data.accounts[username] = {
      account_id: accountId,
      created_at: new Date().toISOString(),
      cloudflare: { email, sub }
    };
    await save(stateRoot, data);
    return { username, account_id: accountId, created: true };
  });
}

export async function importNormifyAccounts(
  stateRoot: string,
  normifyRoot: string
): Promise<{ imported: number; skipped: number }> {
  const sourcePath = join(resolve(normifyRoot), ".normify", "accounts.json");
  const raw = JSON.parse(await readFile(sourcePath, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Normify accounts.json 格式无效");
  const sourceAccounts = (raw as { accounts?: unknown }).accounts;
  if (!sourceAccounts || typeof sourceAccounts !== "object" || Array.isArray(sourceAccounts)) {
    throw new Error("Normify accounts.json 缺少 accounts");
  }
  return withMutationLock(async () => {
    const data = await load(stateRoot);
    let imported = 0;
    let skipped = 0;
    for (const [rawUsername, rawRecord] of Object.entries(sourceAccounts as Record<string, unknown>)) {
      const username = usernameOf(rawUsername);
      if (!rawRecord || typeof rawRecord !== "object" || Array.isArray(rawRecord)) {
        skipped += 1;
        continue;
      }
      const record = rawRecord as Record<string, unknown>;
      if (typeof record.account_id !== "string" || !record.account_id.trim()) {
        skipped += 1;
        continue;
      }
      const cloudflare = normalizeImportedCloudflare(record.cloudflare);
      const existingById = Object.entries(data.accounts).find(([, item]) => item.account_id === record.account_id);
      if (existingById) {
        skipped += 1;
        continue;
      }
      if (data.accounts[username]) throw new Error(`导入账号用户名冲突：${username}`);
      if (cloudflare) assertEmailAvailable(data, cloudflare.email);
      data.accounts[username] = {
        account_id: record.account_id.trim(),
        created_at: typeof record.created_at === "string" && record.created_at.trim()
          ? record.created_at
          : new Date().toISOString(),
        ...(record.role === "admin" ? { role: "admin" as const } : {}),
        ...(cloudflare ? { cloudflare } : {})
      };
      imported += 1;
    }
    if (imported > 0) await save(stateRoot, data);
    return { imported, skipped };
  });
}

function normalizeImportedCloudflare(value: unknown): { email: string; sub?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.email !== "string") return undefined;
  const email = emailOf(record.email);
  const sub = typeof record.sub === "string" && record.sub.trim() ? record.sub.trim() : undefined;
  return { email, ...(sub ? { sub } : {}) };
}

function assertEmailAvailable(data: AccountStore, email: string, exceptUsername?: string): void {
  const conflict = Object.entries(data.accounts).find(([username, record]) =>
    username !== exceptUsername && record.cloudflare?.email === email
  );
  if (conflict) throw new Error(`该 Cloudflare 邮箱已绑定账号：${conflict[0]}`);
}

async function withMutationLock<T>(run: () => Promise<T>): Promise<T> {
  const previous = mutationTail;
  let release!: () => void;
  mutationTail = new Promise<void>((resolveLock) => { release = resolveLock; });
  await previous;
  try {
    return await run();
  } finally {
    release();
  }
}

function filePath(stateRoot: string): string {
  return join(resolve(stateRoot), "accounts.json");
}

async function load(stateRoot: string): Promise<AccountStore> {
  try {
    const data = JSON.parse(await readFile(filePath(stateRoot), "utf8")) as unknown;
    if (!isAccountStore(data)) throw new Error("Memhub 账号数据库格式无效");
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { version: VERSION, accounts: {} };
    throw error;
  }
}

async function save(stateRoot: string, data: AccountStore): Promise<void> {
  const path = filePath(stateRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    await copyFile(path, `${path}.bak`).catch((error) => {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isAccountStore(value: unknown): value is AccountStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== VERSION || !record.accounts || typeof record.accounts !== "object" || Array.isArray(record.accounts)) {
    return false;
  }
  return Object.entries(record.accounts as Record<string, unknown>).every(([username, raw]) => {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(username) || !raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const account = raw as Record<string, unknown>;
    if (typeof account.account_id !== "string" || !account.account_id.trim()) return false;
    if (typeof account.created_at !== "string" || !account.created_at.trim()) return false;
    if (account.cloudflare === undefined) return true;
    if (!account.cloudflare || typeof account.cloudflare !== "object" || Array.isArray(account.cloudflare)) return false;
    const cloudflare = account.cloudflare as Record<string, unknown>;
    return typeof cloudflare.email === "string" &&
      (cloudflare.sub === undefined || typeof cloudflare.sub === "string");
  });
}

function usernameOf(value: string): string {
  const username = value.trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) {
    throw new Error("用户名只能包含字母、数字、点、下划线或连字符，长度 1..64");
  }
  return username;
}

function emailOf(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new Error("Cloudflare 邮箱格式无效");
  }
  return email;
}
