import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { StoredCaptureEvent } from "./capture.js";
import { withFileMutationLock } from "./file-mutation-lock.js";

export type DistillationTarget = "l2" | "l3" | "l4" | "skill";
export type DistillationFailureKind =
  | "core_error"
  | "ambiguous_core_commit"
  | "invalid_legacy_evidence";

export interface DistillationConfig {
  auto_enabled: boolean;
  turn_threshold: number;
  idle_minutes: number;
  auto_since?: string;
}

export interface DistillationEvidenceItem {
  ref: string;
  kind: "turn" | "memory" | "artifact";
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
  reason: "manual" | "turn_threshold" | "idle" | "upstream" | "migration";
  created_at: string;
  updated_at: string;
  leased_until?: string;
  leased_by?: string;
  lease_token?: string;
  completed_at?: string;
  failure?: string;
  failure_kind?: DistillationFailureKind;
  failed_at?: string;
  attempts?: number;
  result_kind?: DistillationTarget | "noop";
  result_id?: string;
  result_content?: string;
  result_committed_at?: string;
  evidence_refs: string[];
  evidence_hash: string;
  evidence: DistillationEvidenceItem[];
}

interface JobStore {
  version: 2;
  jobs: DistillationJob[];
}

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
  const path = join(resolve(stateRoot), "distillation", "config.json");
  // A read/modify/write without the same cross-process lock loses concurrent
  // admin changes and can silently reset the cutover boundary.
  return withFileMutationLock(path, async () => {
    const previous = await getDistillationConfig(stateRoot);
    const next = normalizeConfig({
      ...previous,
      ...patch,
      ...(patch.auto_enabled === true && !previous.auto_enabled ? { auto_since: new Date().toISOString() } : {})
    });
    await atomicJson(path, next);
    return next;
  });
}

export function effectiveDistillationFailureKind(
  job: Pick<DistillationJob, "status" | "failure" | "failure_kind">
): DistillationFailureKind | undefined {
  if (job.failure_kind) return job.failure_kind;
  if (job.status === "failed" && job.failure?.startsWith("invalid legacy rebuild evidence:")) {
    return "invalid_legacy_evidence";
  }
  return undefined;
}

export function distillationJobIsRetryable(
  job: Pick<DistillationJob, "status" | "failure" | "failure_kind">
): boolean {
  if (job.status !== "failed") return false;
  const kind = effectiveDistillationFailureKind(job);
  return kind !== "ambiguous_core_commit" && kind !== "invalid_legacy_evidence";
}

function withFailureClassification(job: DistillationJob): DistillationJob {
  const failureKind = effectiveDistillationFailureKind(job);
  return failureKind && failureKind !== job.failure_kind
    ? { ...job, failure_kind: failureKind }
    : job;
}

export async function listDistillationJobs(stateRoot: string, accountId?: string): Promise<DistillationJob[]> {
  const store = await loadStore(stateRoot);
  return store.jobs
    .filter((job) => !accountId || job.account_id === accountId)
    .map(withFailureClassification)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * The current L3 artifact for a project is the one whose durable Core write
 * was completed last, not necessarily the job that was created last.
 * Concurrent workers can finish older-created jobs after newer-created jobs.
 */
export function latestCompletedL3ByProject(jobs: DistillationJob[]): DistillationJob[] {
  const latest = new Map<string, DistillationJob>();
  for (const job of jobs) {
    if (job.status !== "completed" ||
        job.result_kind !== "l3" ||
        !job.project_id ||
        !job.result_id?.trim() ||
        !job.result_content?.trim() ||
        !job.completed_at ||
        !Number.isFinite(Date.parse(job.completed_at))) continue;
    const previous = latest.get(job.project_id);
    if (!previous || compareCompletedRevision(job, previous) > 0) {
      latest.set(job.project_id, job);
    }
  }
  return [...latest.values()].sort((a, b) => a.project_id!.localeCompare(b.project_id!));
}

function compareCompletedRevision(a: DistillationJob, b: DistillationJob): number {
  return distillationResultTimestamp(a)!.localeCompare(distillationResultTimestamp(b)!) ||
    a.created_at.localeCompare(b.created_at) ||
    a.job_id.localeCompare(b.job_id);
}

export function distillationResultTimestamp(job: DistillationJob): string | undefined {
  if (job.result_committed_at && Number.isFinite(Date.parse(job.result_committed_at))) {
    return job.result_committed_at;
  }
  return job.completed_at && Number.isFinite(Date.parse(job.completed_at))
    ? job.completed_at
    : undefined;
}

export async function enqueueDistillationJob(input: {
  stateRoot: string;
  accountId: string;
  projectId: string | null;
  captures: StoredCaptureEvent[];
  reason: "manual" | "turn_threshold" | "idle";
}): Promise<{ created: boolean; job: DistillationJob }> {
  if (!input.projectId) throw new Error("L2 project timeline requires a resolved project");
  const evidence: DistillationEvidenceItem[] = input.captures
    .filter((item) =>
      item.account_id === input.accountId &&
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


/**
 * Record a direct/manual L2-L4 Core write as an immutable completed revision.
 *
 * Job-backed distillation already gets this identity from its leased job.
 * Direct submit used to update the stable Memory id without leaving a durable
 * revision handle, which made downstream provenance race with later updates.
 * This ledger entry gives every successful direct write the same
 * <result_id>:<job_id> evidence identity as the queued path.
 */
export async function recordCompletedDistillationRevision(input: {
  stateRoot: string;
  accountId: string;
  target: "l2" | "l3" | "l4";
  projectId: string | null;
  conversationId?: string;
  evidence: DistillationEvidenceItem[];
  resultId: string;
  content: string;
  committedAt: string;
}): Promise<DistillationJob> {
  const resultId = input.resultId.trim();
  const content = input.content.trim();
  if (!resultId) throw new TypeError("completed revision requires resultId");
  if (!content) throw new TypeError("completed revision requires content");
  if ((input.target === "l2" || input.target === "l3") && !input.projectId) {
    throw new Error(`${input.target.toUpperCase()} completed revision requires projectId`);
  }
  if (input.target === "l4" && input.projectId) {
    throw new Error("L4 completed revision must be account-scoped");
  }
  if (input.evidence.length === 0) {
    throw new Error(`${input.target.toUpperCase()} completed revision requires evidence`);
  }
  const committedAtMs = Date.parse(input.committedAt);
  if (!Number.isFinite(committedAtMs)) throw new TypeError("completed revision requires a valid committedAt");
  const committedAt = new Date(committedAtMs).toISOString();
  const evidence = uniqueEvidence(input.evidence);
  const evidenceHash = createHash("sha256")
    .update(JSON.stringify({ target: input.target, project: input.projectId, evidence }), "utf8")
    .digest("hex");

  return withMutation(input.stateRoot, async () => {
    const store = await loadStore(input.stateRoot);
    const existing = store.jobs.find((job) =>
      job.account_id === input.accountId &&
      job.target === input.target &&
      job.project_id === input.projectId &&
      job.status === "completed" &&
      job.result_kind === input.target &&
      job.result_id === resultId &&
      job.result_content === content &&
      job.evidence_hash === evidenceHash
    );
    if (existing) return structuredClone(existing);

    const job: DistillationJob = {
      job_id: randomUUID(),
      account_id: input.accountId,
      target: input.target,
      scope: input.projectId ? "project" : "account",
      project_id: input.projectId,
      ...(input.conversationId ? { conversation_id: input.conversationId } : {}),
      status: "completed",
      reason: "manual",
      created_at: committedAt,
      updated_at: committedAt,
      completed_at: committedAt,
      result_kind: input.target,
      result_id: resultId,
      result_content: content,
      result_committed_at: committedAt,
      evidence_refs: evidence.map((item) => item.ref),
      evidence_hash: evidenceHash,
      evidence
    };
    store.jobs.push(job);
    await saveStore(input.stateRoot, store);
    return structuredClone(job);
  });
}

export async function enqueueLegacyL1DistillationJob(input: {
  stateRoot: string;
  accountId: string;
  projectId: string;
  evidence: DistillationEvidenceItem[];
}): Promise<{ created: boolean; job: DistillationJob }> {
  const projectId = input.projectId.trim();
  if (!projectId) throw new TypeError("legacy L1 rebuild requires projectId");
  if (input.evidence.length === 0) throw new Error("legacy L1 rebuild requires evidence");
  for (const item of input.evidence) {
    if (item.layer !== "L1" || item.project_id !== projectId) {
      throw new Error("legacy L1 rebuild evidence must be project-scoped L1");
    }
    if (item.kind === "turn") {
      if (!item.user_text?.trim() || !item.assistant_text?.trim()) {
        throw new Error("legacy L1 turn evidence must contain user and assistant text");
      }
      continue;
    }
    if (item.kind !== "memory" || !item.content?.trim()) {
      throw new Error("legacy L1 rebuild evidence must contain raw turn or Memory Core L1 content");
    }
  }
  return enqueueJob({
    stateRoot: input.stateRoot,
    accountId: input.accountId,
    target: "l2",
    projectId,
    evidence: input.evidence,
    reason: "migration"
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
    useLeaseToken?: boolean;
  }
): Promise<DistillationJob | null> {
  return withMutation(stateRoot, async () => {
    const store = await loadStore(stateRoot);
    const now = Date.now();
    const job = store.jobs.find((item) =>
      item.account_id === accountId &&
      (
        item.status === "pending" ||
        (item.status === "leased" && Boolean(item.leased_until) && Date.parse(item.leased_until!) <= now)
      ) &&
      (input.projectId === undefined || item.project_id === input.projectId) &&
      (input.target === undefined || item.target === input.target)
    );
    if (!job) return null;
    // Reassign an expired generation only when this exact job is actually
    // selected. Leasing unrelated work must not erase another in-flight
    // worker's opaque token before its external Core request returns.
    const seconds = Math.max(30, Math.min(900, Math.trunc(input.leaseSeconds ?? 300)));
    job.status = "leased";
    job.attempts = (job.attempts ?? 0) + 1;
    job.leased_by = input.harness;
    if (input.useLeaseToken) job.lease_token = randomUUID();
    else delete job.lease_token;
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
  result: { kind: DistillationTarget | "noop"; resultId?: string; content?: string },
  leaseOwner: string,
  leaseToken?: string
): Promise<DistillationJob> {
  let completed!: DistillationJob;
  await mutateJob(stateRoot, accountId, jobId, (job) => {
    assertActiveDistillationLease(job, leaseOwner, leaseToken);
    job.status = "completed";
    job.completed_at = new Date().toISOString();
    job.updated_at = job.completed_at;
    job.result_kind = result.kind;
    if (result.resultId) job.result_id = result.resultId;
    if (result.content) job.result_content = result.content;
    delete job.leased_until;
    delete job.leased_by;
    delete job.lease_token;
    delete job.failure;
    delete job.failed_at;
    completed = structuredClone(job);
  });
  return completed;
}

/**
 * Record a Memory Core result that has already committed. With an opaque
 * lease token, expiry alone must not erase a successful write: the token
 * proves this is still the same lease generation unless another worker has
 * actually reassigned the job. Legacy owner-only leases retain the stricter
 * active-time requirement because same-owner reassignment is not fenced.
 */
export async function completeDistillationJobAfterCoreCommit(
  stateRoot: string,
  accountId: string,
  jobId: string,
  result: { kind: DistillationTarget; resultId: string; content: string; committedAt: string },
  leaseOwner: string,
  leaseToken?: string
): Promise<DistillationJob> {
  let completed!: DistillationJob;
  await mutateJob(stateRoot, accountId, jobId, (job) => {
    assertPostCoreCommitLeaseGeneration(job, leaseOwner, leaseToken);
    job.status = "completed";
    job.completed_at = new Date().toISOString();
    job.updated_at = job.completed_at;
    job.result_kind = result.kind;
    job.result_id = result.resultId;
    job.result_content = result.content;
    job.result_committed_at = result.committedAt;
    delete job.leased_until;
    delete job.leased_by;
    delete job.lease_token;
    delete job.failure;
    delete job.failed_at;
    completed = structuredClone(job);
  });
  return completed;
}

/**
 * A successful Core HTTP response without a stable artifact ID is an
 * ambiguous commit, not a retryable Core failure. Fence that lease
 * generation into failed/manual-review state so expiry cannot requeue it.
 */
export async function quarantineDistillationJobAfterCoreCommit(
  stateRoot: string,
  accountId: string,
  jobId: string,
  message: string,
  leaseOwner: string,
  leaseToken?: string,
  committedAt?: string
): Promise<void> {
  await failDistillationJobForLeaseGeneration(
    stateRoot, accountId, jobId, message, leaseOwner, leaseToken, "ambiguous_core_commit"
  );
  if (committedAt) {
    await mutateJob(stateRoot, accountId, jobId, (job) => {
      if (job.status !== "failed" || job.failure_kind !== "ambiguous_core_commit") {
        throw new Error("ambiguous Core commit quarantine changed before timestamp recording");
      }
      job.result_committed_at = committedAt;
    });
  }
}

/**
 * Preserve the current failed-job semantics for an external Core attempt
 * even if its token-fenced lease crossed the wall-clock deadline while the
 * request was in flight. A reassigned generation is still untouchable.
 */
export async function failDistillationJobForLeaseGeneration(
  stateRoot: string,
  accountId: string,
  jobId: string,
  message: string,
  leaseOwner: string,
  leaseToken?: string,
  failureKind: "core_error" | "ambiguous_core_commit" = "core_error"
): Promise<void> {
  await mutateJob(stateRoot, accountId, jobId, (job) => {
    assertPostCoreCommitLeaseGeneration(job, leaseOwner, leaseToken);
    job.status = "failed";
    job.failure = message.slice(0, 2000);
    job.failure_kind = failureKind;
    job.failed_at = new Date().toISOString();
    job.updated_at = job.failed_at;
    delete job.leased_until;
    delete job.leased_by;
    delete job.lease_token;
  });
}

export async function failDistillationJob(
  stateRoot: string,
  accountId: string,
  jobId: string,
  message: string,
  leaseOwner: string,
  leaseToken?: string
): Promise<void> {
  await mutateJob(stateRoot, accountId, jobId, (job) => {
    assertActiveDistillationLease(job, leaseOwner, leaseToken);
    job.status = "failed";
    job.failure = message.slice(0, 2000);
    job.failure_kind = "core_error";
    job.failed_at = new Date().toISOString();
    job.updated_at = job.failed_at;
    delete job.leased_until;
    delete job.leased_by;
    delete job.lease_token;
  });
}

export function assertActiveDistillationLease(job: DistillationJob, leaseOwner: string, leaseToken?: string): void {
  if (job.status !== "leased") throw new Error(`distillation job is not leased: ${job.status}`);
  if (!job.leased_until || Date.parse(job.leased_until) <= Date.now()) {
    throw new Error("distillation job lease has expired");
  }
  if (job.leased_by !== leaseOwner) {
    throw new Error(`distillation job is leased by another harness: ${job.leased_by ?? "unknown"}`);
  }
  if (job.lease_token && job.lease_token !== leaseToken) {
    throw new Error("distillation job lease token is missing or stale");
  }
}

function assertPostCoreCommitLeaseGeneration(
  job: DistillationJob,
  leaseOwner: string,
  leaseToken?: string
): void {
  if (job.status !== "leased") throw new Error(`distillation job is not leased: ${job.status}`);
  if (job.leased_by !== leaseOwner) {
    throw new Error(`distillation job is leased by another harness: ${job.leased_by ?? "unknown"}`);
  }
  if (job.lease_token) {
    if (job.lease_token !== leaseToken) {
      throw new Error("distillation job lease token is missing or stale");
    }
    return;
  }
  if (!job.leased_until || Date.parse(job.leased_until) <= Date.now()) {
    throw new Error("legacy distillation lease expired after Core commit; manual reconciliation required");
  }
}

export async function renewDistillationJobLease(
  stateRoot: string,
  accountId: string,
  jobId: string,
  leaseOwner: string,
  leaseToken: string,
  leaseSeconds = 300
): Promise<DistillationJob> {
  let renewed!: DistillationJob;
  await mutateJob(stateRoot, accountId, jobId, (job) => {
    assertActiveDistillationLease(job, leaseOwner, leaseToken);
    if (!job.lease_token) throw new Error("legacy distillation lease cannot be renewed without a token");
    const seconds = Math.max(30, Math.min(900, Math.trunc(leaseSeconds)));
    job.leased_until = new Date(Math.max(Date.parse(job.leased_until!), Date.now() + seconds * 1000)).toISOString();
    job.updated_at = new Date().toISOString();
    renewed = structuredClone(job);
  });
  return renewed;
}

/**
 * Fence the external Memory Core request with enough lease budget to outlive
 * the local Core client's bounded request timeout. Token-aware clients can
 * safely extend the same generation. Legacy owner-only leases cannot prove
 * same-owner generation after reassignment, so a near-expiry legacy submit
 * must reacquire before it is allowed to write Core.
 */
export async function prepareDistillationLeaseForExternalWrite(
  stateRoot: string,
  accountId: string,
  jobId: string,
  leaseOwner: string,
  leaseToken?: string,
  minimumRemainingSeconds = 60
): Promise<DistillationJob> {
  let prepared!: DistillationJob;
  await mutateJob(stateRoot, accountId, jobId, (job) => {
    assertActiveDistillationLease(job, leaseOwner, leaseToken);
    const now = Date.now();
    const minimumMs = Math.max(30, Math.min(900, Math.trunc(minimumRemainingSeconds))) * 1000;
    const remainingMs = Date.parse(job.leased_until!) - now;
    if (!job.lease_token) {
      if (remainingMs < minimumMs) {
        throw new Error("legacy distillation lease is too close to expiry for an external Core write; reacquire the job first");
      }
      prepared = structuredClone(job);
      return;
    }
    if (remainingMs < minimumMs) {
      job.leased_until = new Date(now + minimumMs).toISOString();
      job.updated_at = new Date(now).toISOString();
    }
    prepared = structuredClone(job);
  });
  return prepared;
}

export async function retryDistillationJob(stateRoot: string, accountId: string, jobId: string): Promise<DistillationJob> {
  let retried!: DistillationJob;
  await mutateJob(stateRoot, accountId, jobId, (job) => {
    if (job.status !== "failed") throw new Error("only failed distillation jobs can be retried");
    const failureKind = effectiveDistillationFailureKind(job);
    if (failureKind === "ambiguous_core_commit") {
      throw new Error("ambiguous Core commit requires manual reconciliation; ordinary retry is disabled");
    }
    if (failureKind === "invalid_legacy_evidence") {
      throw new Error("invalid legacy migration evidence is superseded and cannot be retried; rebuild from current project-scoped evidence instead");
    }
    job.status = "pending";
    job.updated_at = new Date().toISOString();
    delete job.failure;
    delete job.failure_kind;
    delete job.failed_at;
    delete job.leased_until;
    delete job.leased_by;
    delete job.lease_token;
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
  return withMutation(input.stateRoot, async () => {
    const store = await loadStore(input.stateRoot);
    const existing = store.jobs.find((job) =>
      job.account_id === input.accountId &&
      job.target === input.target &&
      job.project_id === input.projectId &&
      job.evidence_hash === evidenceHash
    );
    if (existing) return { created: false, job: structuredClone(existing) };
    // Discovery scans and threshold updates can race. An exact batch hash is
    // insufficient: [A,B] and [B,C] have different hashes but must not create
    // two L2 jobs containing the same durable turn. Check within the locked
    // mutation; a later discovery pass can enqueue the remaining turn.
    if (input.target === "l2") {
      const refs = new Set(evidence.map((item) => item.ref));
      const overlap = store.jobs.find((job) =>
        job.account_id === input.accountId &&
        job.target === "l2" &&
        job.project_id === input.projectId &&
        job.evidence_refs.some((ref) => refs.has(ref))
      );
      if (overlap) return { created: false, job: structuredClone(overlap) };
    }
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
  const threshold = Number.isFinite(value.turn_threshold) ? Math.trunc(value.turn_threshold!) : 8;
  const idleMinutes = Number.isFinite(value.idle_minutes) ? Math.trunc(value.idle_minutes!) : 30;
  return {
    auto_enabled: value.auto_enabled === true,
    turn_threshold: Math.max(2, Math.min(100, threshold)),
    idle_minutes: Math.max(5, Math.min(1440, idleMinutes)),
    ...(typeof value.auto_since === "string" && Number.isFinite(Date.parse(value.auto_since))
      ? { auto_since: new Date(value.auto_since).toISOString() }
      : {})
  };
}

async function mutateJob(
  stateRoot: string,
  accountId: string,
  jobId: string,
  fn: (job: DistillationJob) => void
): Promise<void> {
  await withMutation(stateRoot, async () => {
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
    reason: (["manual", "turn_threshold", "idle", "upstream", "migration"].includes(String(item.reason))
      ? item.reason
      : "manual") as DistillationJob["reason"],
    created_at: String(item.created_at ?? new Date(0).toISOString()),
    updated_at: String(item.updated_at ?? item.created_at ?? new Date(0).toISOString()),
    ...(typeof item.leased_until === "string" ? { leased_until: item.leased_until } : {}),
    ...(typeof item.leased_by === "string" ? { leased_by: item.leased_by } : {}),
    ...(typeof item.lease_token === "string" ? { lease_token: item.lease_token } : {}),
    ...(typeof item.completed_at === "string" ? { completed_at: item.completed_at } : {}),
    ...(typeof item.failure === "string" ? { failure: item.failure } : {}),
    ...(["core_error", "ambiguous_core_commit", "invalid_legacy_evidence"].includes(String(item.failure_kind))
      ? { failure_kind: item.failure_kind as DistillationJob["failure_kind"] }
      : {}),
    ...(typeof item.failed_at === "string" ? { failed_at: item.failed_at } : {}),
    ...(typeof item.attempts === "number" ? { attempts: item.attempts } : {}),
    ...(legacyResult ? { result_kind: legacyResult === "skill" ? "skill" : legacyResult === "noop" ? "noop" : "l2" } : {}),
    ...(typeof item.result_id === "string" ? { result_id: item.result_id } : {}),
    ...(typeof item.result_committed_at === "string" &&
        Number.isFinite(Date.parse(item.result_committed_at))
      ? { result_committed_at: item.result_committed_at }
      : {}),
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

async function withMutation<T>(stateRoot: string, run: () => Promise<T>): Promise<T> {
  return withFileMutationLock(storePath(stateRoot), run);
}
