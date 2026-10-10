import { recoverCaptureIngest } from "./capture-recovery.js";
import { auditDistillationPipeline } from "./distillation-audit.js";
import { discoverDistillationJobs } from "./distillation-discovery.js";
import { distillationContract } from "./distillation-contract.js";
import {
  assertActiveDistillationLease,
  completeDistillationJob,
  getDistillationConfig,
  leaseDistillationJob,
  listDistillationJobs,
  renewDistillationJobLease,
  type DistillationJob
} from "./distillation-jobs.js";
import type { MemhubRuntime } from "./runtime.js";

/**
 * Capture/queue control-plane actions used by the MCP distillation tool.
 * Keep input parsing and project-scope authorization at the MCP boundary;
 * this module operates only on an already authenticated account/runtime.
 */
export async function auditDistillationControl(input: {
  stateRoot: string;
  runtime: MemhubRuntime;
}) {
  const { stateRoot, runtime } = input;
  return auditDistillationPipeline({
    stateRoot,
    accountId: runtime.accountId,
    resolveProject: (hint) => runtime.projects.resolve(runtime.accountId, hint)
  });
}

export async function recoverDistillationControl(input: {
  stateRoot: string;
  runtime: MemhubRuntime;
  eventId: string;
  projectId: string;
  dryRun: boolean;
}) {
  return recoverCaptureIngest(input);
}

export async function discoverDistillationControl(input: {
  stateRoot: string;
  runtime: MemhubRuntime;
  dryRun: boolean;
}) {
  const { stateRoot, runtime, dryRun } = input;
  const report = await discoverDistillationJobs({
    stateRoot,
    accountId: runtime.accountId,
    resolveProject: (hint) => runtime.projects.resolve(runtime.accountId, hint),
    enqueue: !dryRun
  });
  return {
    ...report,
    instructions: "Discover scans completed, ingested, project-resolved captures and batches them by project, not by host conversation. It cannot read uncaptured ChatGPT history or invoke a model."
  };
}

export async function nextDistillationControl(input: {
  stateRoot: string;
  runtime: MemhubRuntime;
  sourceHarness: string;
  leaseToken?: string;
  jobId?: string;
  kind?: string;
  scope?: string;
  project?: string;
  workspaceProject?: string;
  evidenceOffset: number;
  evidenceChunkChars: number;
  leaseSeconds?: number;
  leaseTokenSupported: boolean;
  resolveProjectScope: (scope: {
    project?: string;
    workspaceProject?: string;
  }) => Promise<string | null>;
  renderNext: (
    job: DistillationJob, evidenceOffset: number, evidenceChunkChars: number
  ) => Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const { stateRoot, runtime, sourceHarness, leaseToken } = input;
  if (input.evidenceOffset < 0) throw new TypeError("evidence_offset must be non-negative");
  if (input.evidenceChunkChars < 10_000 || input.evidenceChunkChars > 200_000) {
    throw new TypeError("evidence_chunk_chars must be between 10000 and 200000");
  }
  if (input.jobId) {
    const job = (await listDistillationJobs(stateRoot, runtime.accountId))
      .find((item) => item.job_id === input.jobId);
    if (!job) throw new Error("distillation job not found for account");
    assertActiveDistillationLease(job, sourceHarness, leaseToken);
    if (input.kind && input.kind !== job.target) {
      throw new Error(`distillation target mismatch: job expects ${job.target}`);
    }
    if (input.scope && input.scope !== job.scope) {
      throw new Error(`distillation scope mismatch: job expects ${job.scope}`);
    }
    return input.renderNext(job, input.evidenceOffset, input.evidenceChunkChars);
  }

  let projectFilter: string | null | undefined;
  if (input.scope === "account") projectFilter = null;
  else if (input.scope === "project") {
    projectFilter = await input.resolveProjectScope({
      project: input.project,
      workspaceProject: input.workspaceProject
    });
  }
  const leaseInput = {
    projectId: projectFilter,
    target: input.kind as "l2" | "l3" | "l4" | "skill" | undefined,
    harness: sourceHarness,
    leaseSeconds: input.leaseSeconds,
    useLeaseToken: input.leaseTokenSupported
  };
  let job = await leaseDistillationJob(stateRoot, runtime.accountId, leaseInput);
  let discovery: Awaited<ReturnType<typeof discoverDistillationJobs>> | undefined;
  let discovery_error: string | undefined;
  if (!job && (await getDistillationConfig(stateRoot)).auto_enabled) {
    try {
      discovery = await discoverDistillationJobs({
        stateRoot,
        accountId: runtime.accountId,
        resolveProject: (hint) => runtime.projects.resolve(runtime.accountId, hint),
        enqueue: true
      });
    } catch (error) {
      discovery_error = error instanceof Error ? error.message : String(error);
      console.error("[memhub] on-demand distillation discovery:", discovery_error);
    }
    job = await leaseDistillationJob(stateRoot, runtime.accountId, leaseInput);
  }
  if (!job) {
    const config = await getDistillationConfig(stateRoot);
    return {
      job: null,
      queue_state: "idle",
      auto_enabled: config.auto_enabled,
      discovery_available: true,
      ...(discovery ? { discovery } : {}),
      ...(discovery_error ? { discovery_error } : {}),
      contract: distillationContract(),
      instructions: "No pending job. This does not establish that all conversations were captured or ingested. Call action=discover to reconcile eligible L1 evidence, then call next again."
    };
  }
  return {
    ...input.renderNext(job, input.evidenceOffset, input.evidenceChunkChars),
    ...(discovery ? { discovery } : {})
  };
}

export async function renewDistillationControl(input: {
  stateRoot: string;
  runtime: MemhubRuntime;
  jobId: string;
  sourceHarness: string;
  leaseToken?: string;
  leaseSeconds: number;
}) {
  if (!input.leaseToken) throw new TypeError("lease_token is required for renewal");
  const renewed = await renewDistillationJobLease(
    input.stateRoot, input.runtime.accountId, input.jobId,
    input.sourceHarness, input.leaseToken, input.leaseSeconds
  );
  return {
    ok: true,
    job_id: input.jobId,
    leased_until: renewed.leased_until,
    lease_token: renewed.lease_token
  };
}

export async function skipDistillationControl(input: {
  stateRoot: string;
  runtime: MemhubRuntime;
  jobId: string;
  sourceHarness: string;
  leaseToken?: string;
}) {
  const job = (await listDistillationJobs(input.stateRoot, input.runtime.accountId))
    .find((item) => item.job_id === input.jobId);
  if (!job) throw new Error("distillation job not found for account");
  assertActiveDistillationLease(job, input.sourceHarness, input.leaseToken);
  await completeDistillationJob(
    input.stateRoot, input.runtime.accountId, input.jobId,
    { kind: "noop" }, input.sourceHarness, input.leaseToken
  );
  return {
    ok: true, job_id: input.jobId, skipped: true,
    reason: "no durable artifact justified by evidence"
  };
}
