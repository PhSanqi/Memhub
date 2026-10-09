import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withFileMutationLock } from "./file-mutation-lock.js";

export interface ArchitectureRevisionRecord {
  revision_id: string;
  account_id: string;
  project_id: string;
  path: string;
  before_exists: boolean;
  before_fingerprint: string;
  before_content: string;
  proposed_content: string;
  proposed_sha256: string;
  status: "prepared" | "committed";
  created_at: string;
  committed_at?: string;
  after_fingerprint?: string;
}

export async function prepareArchitectureRevision(input: {
  stateRoot: string;
  accountId: string;
  projectId: string;
  path: string;
  beforeExists: boolean;
  beforeFingerprint: string;
  beforeContent: string;
  proposedContent: string;
}): Promise<ArchitectureRevisionRecord> {
  const record: ArchitectureRevisionRecord = {
    revision_id: randomUUID(),
    account_id: requireNonEmpty(input.accountId, "accountId"),
    project_id: requireNonEmpty(input.projectId, "projectId"),
    path: requireNonEmpty(input.path, "path"),
    before_exists: input.beforeExists,
    before_fingerprint: requireNonEmpty(input.beforeFingerprint, "beforeFingerprint"),
    before_content: input.beforeContent,
    proposed_content: requireNonEmpty(input.proposedContent, "proposedContent"),
    proposed_sha256: createHash("sha256").update(input.proposedContent, "utf8").digest("hex"),
    status: "prepared",
    created_at: new Date().toISOString()
  };
  const path = revisionPath(input.stateRoot, input.accountId, input.projectId, record.revision_id);
  await atomicJson(path, record);
  return record;
}

export async function commitArchitectureRevision(input: {
  stateRoot: string;
  accountId: string;
  projectId: string;
  revisionId: string;
  afterFingerprint: string;
}): Promise<ArchitectureRevisionRecord> {
  const path = revisionPath(input.stateRoot, input.accountId, input.projectId, input.revisionId);
  return withFileMutationLock(path, async () => {
    const current = JSON.parse(await readFile(path, "utf8")) as ArchitectureRevisionRecord;
    if (current.account_id !== input.accountId || current.project_id !== input.projectId) {
      throw new Error("Architecture revision scope mismatch");
    }
    const next: ArchitectureRevisionRecord = {
      ...current,
      status: "committed",
      committed_at: new Date().toISOString(),
      after_fingerprint: requireNonEmpty(input.afterFingerprint, "afterFingerprint")
    };
    await atomicJsonUnlocked(path, next);
    return next;
  });
}

export async function listArchitectureRevisions(input: {
  stateRoot: string;
  accountId: string;
  projectId: string;
  limit?: number;
}): Promise<ArchitectureRevisionRecord[]> {
  const dir = revisionDir(input.stateRoot, input.accountId, input.projectId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
  const records: ArchitectureRevisionRecord[] = [];
  for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
    try {
      const record = JSON.parse(await readFile(join(dir, name), "utf8")) as ArchitectureRevisionRecord;
      if (record.account_id === input.accountId && record.project_id === input.projectId) records.push(record);
    } catch {
      // A malformed audit record must not make the entire project unreadable.
    }
  }
  return records
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, Math.max(1, Math.min(100, input.limit ?? 20)));
}

function revisionDir(stateRoot: string, accountId: string, projectId: string): string {
  const accountHash = createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 24);
  const projectHash = createHash("sha256").update(projectId, "utf8").digest("hex").slice(0, 24);
  return join(resolve(stateRoot), "architecture-history", accountHash, projectHash);
}

function revisionPath(stateRoot: string, accountId: string, projectId: string, revisionId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(revisionId)) throw new TypeError("invalid Architecture revision id");
  return join(revisionDir(stateRoot, accountId, projectId), `${revisionId}.json`);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await withFileMutationLock(path, () => atomicJsonUnlocked(path, value));
}

async function atomicJsonUnlocked(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be non-empty`);
  return normalized;
}
