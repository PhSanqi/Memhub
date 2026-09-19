import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { StoredCaptureEvent } from "./capture.js";

export interface DistillationConfig {
  auto_enabled: boolean;
  turn_threshold: number;
  idle_minutes: number;
}

export interface DistillationJob {
  job_id: string;
  account_id: string;
  scope: "global" | "project";
  project_id: string | null;
  conversation_id: string;
  status: "pending" | "leased" | "completed" | "failed";
  reason: "manual" | "turn_threshold" | "idle";
  created_at: string;
  updated_at: string;
  leased_until?: string;
  leased_by?: string;
  completed_at?: string;
  failure?: string;
  failed_at?: string;
  attempts?: number;
  result_kind?: "skill" | "summary" | "knowledge" | "noop";
  result_id?: string;
  evidence_refs: string[];
  evidence_hash: string;
  evidence: Array<{ event_id: string; timestamp: string; user_text: string; assistant_text: string }>;
}

interface JobStore { version: 1; jobs: DistillationJob[] }
let mutationTail = Promise.resolve();

export async function getDistillationConfig(stateRoot: string): Promise<DistillationConfig> {
  try {
    const raw = JSON.parse(await readFile(join(resolve(stateRoot), "distillation", "config.json"), "utf8")) as Partial<DistillationConfig>;
    return normalizeConfig(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    return { auto_enabled: false, turn_threshold: 8, idle_minutes: 30 };
  }
}

export async function setDistillationConfig(stateRoot: string, patch: Partial<DistillationConfig>): Promise<DistillationConfig> {
  const next = normalizeConfig({ ...(await getDistillationConfig(stateRoot)), ...patch });
  await atomicJson(join(resolve(stateRoot), "distillation", "config.json"), next);
  return next;
}

export async function listDistillationJobs(stateRoot: string, accountId?: string): Promise<DistillationJob[]> {
  const store = await loadStore(stateRoot);
  return store.jobs.filter((job) => !accountId || job.account_id === accountId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function enqueueDistillationJob(input: {
  stateRoot: string;
  accountId: string;
  projectId: string | null;
  conversationId: string;
  captures: StoredCaptureEvent[];
  reason: DistillationJob["reason"];
}): Promise<{ created: boolean; job: DistillationJob }> {
  const complete = input.captures
    .filter((item) => item.account_id === input.accountId && item.conversation_id === input.conversationId && item.user_text?.trim() && item.assistant_text?.trim())
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  if (complete.length === 0) throw new Error("distillation job requires complete captured turns");
  const evidence = complete.map((item) => ({
    event_id: item.event_id,
    timestamp: item.timestamp,
    user_text: item.user_text!.trim(),
    assistant_text: item.assistant_text!.trim()
  }));
  const evidenceHash = createHash("sha256").update(JSON.stringify(evidence), "utf8").digest("hex");
  return withMutation(async () => {
    const store = await loadStore(input.stateRoot);
    const existing = store.jobs.find((job) => job.account_id === input.accountId && job.conversation_id === input.conversationId && job.project_id === input.projectId && job.evidence_hash === evidenceHash);
    if (existing) return { created: false, job: existing };
    const now = new Date().toISOString();
    const job: DistillationJob = {
      job_id: randomUUID(),
      account_id: input.accountId,
      scope: input.projectId ? "project" : "global",
      project_id: input.projectId,
      conversation_id: input.conversationId,
      status: "pending",
      reason: input.reason,
      created_at: now,
      updated_at: now,
      evidence_refs: evidence.map((item) => `capture:${item.event_id}`),
      evidence_hash: evidenceHash,
      evidence
    };
    store.jobs.push(job);
    await saveStore(input.stateRoot, store);
    return { created: true, job };
  });
}

export async function leaseDistillationJob(
  stateRoot: string,
  accountId: string,
  input: { projectId?: string | null; harness: string; leaseSeconds?: number }
): Promise<DistillationJob | null> {
  return withMutation(async () => {
    const store = await loadStore(stateRoot);
    const now = Date.now();
    for (const job of store.jobs) {
      if (job.status === "leased" && job.leased_until && Date.parse(job.leased_until) <= now) {
        job.status = "pending";
        delete job.leased_until;
        delete job.leased_by;
      }
    }
    const job = store.jobs.find((item) =>
      item.account_id === accountId && item.status === "pending" &&
      (input.projectId === undefined || item.project_id === input.projectId)
    );
    if (!job) {
      await saveStore(stateRoot, store);
      return null;
    }
    const seconds = Math.max(30, Math.min(900, Math.trunc(input.leaseSeconds ?? 300)));
    job.status = "leased";
    job.attempts = (job.attempts ?? 0) + 1;
    job.leased_by = input.harness;
    job.leased_until = new Date(now + seconds * 1000).toISOString();
    job.updated_at = new Date(now).toISOString();
    await saveStore(stateRoot, store);
    return structuredClone(job);
  });
}

export async function completeDistillationJob(
  stateRoot: string,
  accountId: string,
  jobId: string,
  result: { kind: "skill" | "summary" | "knowledge" | "noop"; resultId?: string }
): Promise<void> {
  await mutateJob(stateRoot, accountId, jobId, (job) => {
    job.status = "completed";
    job.completed_at = new Date().toISOString();
    job.updated_at = job.completed_at;
    job.result_kind = result.kind;
    if (result.resultId) job.result_id = result.resultId;
    delete job.leased_until;
    delete job.leased_by;
    delete job.failure;
    delete job.failed_at;
  });
}

export async function failDistillationJob(stateRoot: string, accountId: string, jobId: string, message: string): Promise<void> {
  await mutateJob(stateRoot, accountId, jobId, (job) => {
    job.status = "failed";
    job.failure = message.slice(0, 2000);
    job.failed_at = new Date().toISOString();
    job.updated_at = job.failed_at;
    delete job.leased_until;
    delete job.leased_by;
  });
}

export async function retryDistillationJob(stateRoot: string, accountId: string, jobId: string): Promise<DistillationJob> {
  let retried!: DistillationJob;
  await mutateJob(stateRoot, accountId, jobId, (job) => {
    if (job.status !== "failed") throw new Error("only failed distillation jobs can be retried");
    job.status = "pending";
    job.updated_at = new Date().toISOString();
    delete job.failure;
    delete job.failed_at;
    delete job.leased_until;
    delete job.leased_by;
    retried = structuredClone(job);
  });
  return retried;
}

function normalizeConfig(value: Partial<DistillationConfig>): DistillationConfig {
  return {
    auto_enabled: value.auto_enabled === true,
    turn_threshold: Math.max(2, Math.min(100, Math.trunc(value.turn_threshold ?? 8))),
    idle_minutes: Math.max(5, Math.min(1440, Math.trunc(value.idle_minutes ?? 30)))
  };
}

async function mutateJob(stateRoot: string, accountId: string, jobId: string, fn: (job: DistillationJob) => void): Promise<void> {
  await withMutation(async () => {
    const store = await loadStore(stateRoot);
    const job = store.jobs.find((item) => item.job_id === jobId && item.account_id === accountId);
    if (!job) throw new Error("distillation job not found for account");
    fn(job);
    await saveStore(stateRoot, store);
  });
}

function storePath(root: string): string {
  return join(resolve(root), "distillation", "jobs.json");
}

async function loadStore(root: string): Promise<JobStore> {
  try {
    const raw = JSON.parse(await readFile(storePath(root), "utf8")) as JobStore;
    return raw.version === 1 && Array.isArray(raw.jobs) ? raw : { version: 1, jobs: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { version: 1, jobs: [] };
    throw error;
  }
}

async function saveStore(root: string, store: JobStore): Promise<void> {
  await atomicJson(storePath(root), store);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}

async function withMutation<T>(run: () => Promise<T>): Promise<T> {
  const previous = mutationTail;
  let release!: () => void;
  mutationTail = new Promise<void>((resolveLock) => { release = resolveLock; });
  await previous;
  try { return await run(); } finally { release(); }
}
