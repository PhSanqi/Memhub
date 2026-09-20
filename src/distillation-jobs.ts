import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { StoredCaptureEvent } from "./capture.js";

export type DistillationTarget = "l2" | "l3" | "l4" | "skill";

export interface DistillationConfig {
  auto_enabled: boolean;
  turn_threshold: number;
  idle_minutes: number;
}

export interface DistillationEvidenceItem {
  ref: string;
  kind: "turn" | "artifact";
  timestamp: string;
  project_id?: string;
  conversation_id?: string;
  layer?: "L1" | "L2" | "L3" | "L4" | "Skill";
  title?: string;
  content?: string;
  user_text?: string;
  assistant_text?: string;
  reasoning_summary?: string;
}

export interface DistillationJob {
  job_id: string;
  account_id: string;
  target: DistillationTarget;
  scope: "account" | "project";
  project_id: string | null;
  conversation_id?: string;
  status: "pending" | "leased" | "completed" | "failed";
  reason: "manual" | "turn_threshold" | "idle" | "upstream";
  created_at: string;
  updated_at: string;
  leased_until?: string;
  leased_by?: string;
  completed_at?: string;
  failure?: string;
  failed_at?: string;
  attempts?: number;
  result_kind?: DistillationTarget | "noop";
  result_id?: string;
  result_content?: string;
  evidence_refs: string[];
  evidence_hash: string;
  evidence: DistillationEvidenceItem[];
}

interface JobStore {
  version: 2;
  jobs: DistillationJob[];
}

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
  return store.jobs
    .filter((job) => !accountId || job.account_id === accountId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function enqueueDistillationJob(input: {
  stateRoot: string;
  accountId: string;
  projectId: string | null;
  conversationId: string;
  captures: StoredCaptureEvent[];
  reason: "manual" | "turn_threshold" | "idle";
}): Promise<{ created: boolean; job: DistillationJob }> {
  if (!input.projectId) throw new Error("L2 project timeline requires a resolved project");
  const evidence: DistillationEvidenceItem[] = input.captures
    .filter((item) =>
      item.account_id === input.accountId &&
      item.conversation_id === input.conversationId &&
      item.capture_status === "complete" &&
      item.user_text?.trim() &&
      item.assistant_text?.trim()
    )
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map((item) => ({
      ref: `l1:${item.event_id}`,
      kind: "turn",
      layer: "L1",
      timestamp: item.timestamp,
      project_id: input.projectId!,
      conversation_id: item.conversation_id,
      user_text: item.user_text!.trim(),
      assistant_text: item.assistant_text!.trim(),
      ...(item.reasoning_summary?.trim() ? { reasoning_summary: item.reasoning_summary.trim() } : {})
    }));
  if (evidence.length === 0) throw new Error("L2 distillation requires complete L1 turns");
  return enqueueJob({
    stateRoot: input.stateRoot,
    accountId: input.accountId,
    target: "l2",
    projectId: input.projectId,
    conversationId: input.conversationId,
    evidence,
    reason: input.reason
  });
}

export async function enqueueDerivedDistillationJob(input: {
  stateRoot: string;
  accountId: string;
  target: "l3" | "l4" | "skill";
  projectId: string | null;
  evidence: DistillationEvidenceItem[];
  reason?: "manual" | "upstream";
}): Promise<{ created: boolean; job: DistillationJob }> {
  if (input.target === "l3" && !input.projectId) throw new Error("L3 project profile requires projectId");
  if (input.target === "l4" && input.projectId) throw new Error("L4 user profile is account-scoped");
  if (input.evidence.length === 0) throw new Error(`${input.target.toUpperCase()} distillation requires evidence`);
  return enqueueJob({
    stateRoot: input.stateRoot,
    accountId: input.accountId,
    target: input.target,
    projectId: input.projectId,
    evidence: input.evidence,
    reason: input.reason ?? "upstream"
  });
}

export async function leaseDistillationJob(
  stateRoot: string,
  accountId: string,
  input: {
    projectId?: string | null;
    target?: DistillationTarget;
    harness: string;
    leaseSeconds?: number;
  }
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
      item.account_id === accountId &&
      item.status === "pending" &&
      (input.projectId === undefined || item.project_id === input.projectId) &&
      (input.target === undefined || item.target === input.target)
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
  result: { kind: DistillationTarget | "noop"; resultId?: string; content?: string }
): Promise<DistillationJob> {
  let completed!: DistillationJob;
  await mutateJob(stateRoot, accountId, jobId, (job) => {
    job.status = "completed";
    job.completed_at = new Date().toISOString();
    job.updated_at = job.completed_at;
    job.result_kind = result.kind;
    if (result.resultId) job.result_id = result.resultId;
    if (result.content) job.result_content = result.content;
    delete job.leased_until;
    delete job.leased_by;
    delete job.failure;
    delete job.failed_at;
    completed = structuredClone(job);
  });
  return completed;
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

async function enqueueJob(input: {
  stateRoot: string;
  accountId: string;
  target: DistillationTarget;
  projectId: string | null;
  conversationId?: string;
  evidence: DistillationEvidenceItem[];
  reason: DistillationJob["reason"];
}): Promise<{ created: boolean; job: DistillationJob }> {
  const evidence = uniqueEvidence(input.evidence);
  const evidenceHash = createHash("sha256")
    .update(JSON.stringify({ target: input.target, project: input.projectId, evidence }), "utf8")
    .digest("hex");
  return withMutation(async () => {
    const store = await loadStore(input.stateRoot);
    const existing = store.jobs.find((job) =>
      job.account_id === input.accountId &&
      job.target === input.target &&
      job.project_id === input.projectId &&
      job.evidence_hash === evidenceHash
    );
    if (existing) return { created: false, job: structuredClone(existing) };
    const now = new Date().toISOString();
    const job: DistillationJob = {
      job_id: randomUUID(),
      account_id: input.accountId,
      target: input.target,
      scope: input.projectId ? "project" : "account",
      project_id: input.projectId,
      ...(input.conversationId ? { conversation_id: input.conversationId } : {}),
      status: "pending",
      reason: input.reason,
      created_at: now,
      updated_at: now,
      evidence_refs: evidence.map((item) => item.ref),
      evidence_hash: evidenceHash,
      evidence
    };
    store.jobs.push(job);
    await saveStore(input.stateRoot, store);
    return { created: true, job: structuredClone(job) };
  });
}

function uniqueEvidence(items: DistillationEvidenceItem[]): DistillationEvidenceItem[] {
  const byRef = new Map<string, DistillationEvidenceItem>();
  for (const item of items) {
    if (!item.ref.trim()) throw new TypeError("distillation evidence ref must be non-empty");
    byRef.set(item.ref, structuredClone(item));
  }
  return [...byRef.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.ref.localeCompare(b.ref));
}

function normalizeConfig(value: Partial<DistillationConfig>): DistillationConfig {
  return {
    auto_enabled: value.auto_enabled === true,
    turn_threshold: Math.max(2, Math.min(100, Math.trunc(value.turn_threshold ?? 8))),
    idle_minutes: Math.max(5, Math.min(1440, Math.trunc(value.idle_minutes ?? 30)))
  };
}

async function mutateJob(
  stateRoot: string,
  accountId: string,
  jobId: string,
  fn: (job: DistillationJob) => void
): Promise<void> {
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
    const raw = JSON.parse(await readFile(storePath(root), "utf8")) as {
      version?: number;
      jobs?: Array<Record<string, unknown>>;
    };
    if (!Array.isArray(raw.jobs)) return { version: 2, jobs: [] };
    if (raw.version === 2) return { version: 2, jobs: raw.jobs as unknown as DistillationJob[] };
    const jobs = raw.jobs.map((item) => migrateV1Job(item));
    const store: JobStore = { version: 2, jobs };
    await saveStore(root, store);
    return store;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { version: 2, jobs: [] };
    throw error;
  }
}

function migrateV1Job(item: Record<string, unknown>): DistillationJob {
  const evidence = Array.isArray(item.evidence)
    ? item.evidence.map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          ref: `l1:${String(row.event_id ?? randomUUID())}`,
          kind: "turn" as const,
          layer: "L1" as const,
          timestamp: String(row.timestamp ?? new Date(0).toISOString()),
          ...(typeof item.project_id === "string" ? { project_id: item.project_id } : {}),
          ...(typeof item.conversation_id === "string" ? { conversation_id: item.conversation_id } : {}),
          ...(typeof row.user_text === "string" ? { user_text: row.user_text } : {}),
          ...(typeof row.assistant_text === "string" ? { assistant_text: row.assistant_text } : {})
        };
      })
    : [];
  const legacyResult = typeof item.result_kind === "string" ? item.result_kind : undefined;
  return {
    job_id: String(item.job_id ?? randomUUID()),
    account_id: String(item.account_id ?? ""),
    target: legacyResult === "skill" ? "skill" : "l2",
    scope: item.project_id ? "project" : "account",
    project_id: typeof item.project_id === "string" ? item.project_id : null,
    ...(typeof item.conversation_id === "string" ? { conversation_id: item.conversation_id } : {}),
    status: (["pending", "leased", "completed", "failed"].includes(String(item.status))
      ? item.status
      : "failed") as DistillationJob["status"],
    reason: (["manual", "turn_threshold", "idle"].includes(String(item.reason))
      ? item.reason
      : "manual") as DistillationJob["reason"],
    created_at: String(item.created_at ?? new Date(0).toISOString()),
    updated_at: String(item.updated_at ?? item.created_at ?? new Date(0).toISOString()),
    ...(typeof item.leased_until === "string" ? { leased_until: item.leased_until } : {}),
    ...(typeof item.leased_by === "string" ? { leased_by: item.leased_by } : {}),
    ...(typeof item.completed_at === "string" ? { completed_at: item.completed_at } : {}),
    ...(typeof item.failure === "string" ? { failure: item.failure } : {}),
    ...(typeof item.failed_at === "string" ? { failed_at: item.failed_at } : {}),
    ...(typeof item.attempts === "number" ? { attempts: item.attempts } : {}),
    ...(legacyResult ? { result_kind: legacyResult === "skill" ? "skill" : legacyResult === "noop" ? "noop" : "l2" } : {}),
    ...(typeof item.result_id === "string" ? { result_id: item.result_id } : {}),
    evidence_refs: evidence.map((entry) => entry.ref),
    evidence_hash: String(item.evidence_hash ?? createHash("sha256").update(JSON.stringify(evidence)).digest("hex")),
    evidence
  };
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
  try {
    return await run();
  } finally {
    release();
  }
}
