import { DISTILLATION_CONTRACT_VERSION, validateDistillationCandidate } from "./distillation-contract.js";
import {
  assertActiveDistillationLease,
  completeDistillationJobAfterCoreCommit,
  enqueueDerivedDistillationJob,
  failDistillationJobForLeaseGeneration,
  latestCompletedL3ByProject,
  listDistillationJobs,
  prepareDistillationLeaseForExternalWrite,
  quarantineDistillationJobAfterCoreCommit,
  type DistillationJob
} from "./distillation-jobs.js";
import type { MemhubRuntime } from "./runtime.js";

export async function submitDistillationControl(input: {
  args: Record<string, unknown>;
  stateRoot: string;
  runtime: MemhubRuntime;
  sourceHarness: string;
  leaseToken?: string;
  enqueueDerived?: typeof enqueueDerivedDistillationJob;
  resolveToolScope: (runtime: MemhubRuntime, input: { scope: string; project?: string; workspaceProject?: string; conversationId?: string }) => Promise<{ projectId: string | null; conversationId?: string; resolutionSource: string }>;
  validateDistillationEvidenceChain: (input: { stateRoot: string; runtime: MemhubRuntime; kind: "l2" | "l3" | "l4" | "skill"; projectId: string | null; evidenceRefs: string[]; job?: DistillationJob }) => Promise<void>;
}): Promise<Record<string, unknown>> {
  const { args, stateRoot, runtime, sourceHarness, leaseToken, resolveToolScope, validateDistillationEvidenceChain } = input;
    const jobId = optionalString(args.job_id);
    const job = jobId
      ? (await listDistillationJobs(stateRoot, runtime.accountId)).find((item) => item.job_id === jobId)
      : undefined;
    if (jobId && !job) throw new Error("distillation job not found for account");
    if (job) assertActiveDistillationLease(job, sourceHarness, leaseToken);
    const kind = (optionalString(args.kind) ?? job?.target) as "l2" | "l3" | "l4" | "skill" | undefined;
    if (!kind || !["l2", "l3", "l4", "skill"].includes(kind)) {
      throw new TypeError("kind must be l2, l3, l4, or skill");
    }
    if (job && job.target !== kind) throw new Error(`distillation target mismatch: job expects ${job.target}`);
    const scope = optionalString(args.scope) ?? job?.scope;
    if (!scope) throw new TypeError("scope is required");
    if (scope !== "account" && scope !== "project") throw new TypeError("scope must be account or project");
    if ((kind === "l2" || kind === "l3") && scope !== "project") {
      throw new TypeError(`${kind.toUpperCase()} requires project scope`);
    }
    if (kind === "l4" && scope !== "account") throw new TypeError("L4 requires account scope");
    const title = optionalString(args.title);
    if (kind === "skill" && !title) throw new TypeError("title is required for skill distillation");
    const { projectId, conversationId } = await resolveToolScope(runtime, {
      scope: scope === "account" ? "global" : "project",
      project: optionalString(args.project) ?? job?.project_id ?? undefined,
      workspaceProject: optionalString(args.workspace_project),
      conversationId: optionalString(args.conversation_id) ?? job?.conversation_id
    });
    if (kind === "l4" && projectId !== null) throw new Error("L4 cannot be project-scoped");
    const canonicalJobProjectId = job?.project_id
      ? await runtime.projects.resolve(runtime.accountId, job.project_id)
      : job?.project_id ?? null;
    if (job && (job.scope !== scope || canonicalJobProjectId !== projectId)) {
      throw new Error("distillation job scope mismatch");
    }
    const explicitEvidenceRefs = stringArray(args.evidence_refs) ?? [];
    if (job && explicitEvidenceRefs.some((ref) => !job.evidence_refs.includes(ref))) {
      throw new Error("job-backed distillation cannot add evidence outside the leased job");
    }
    const evidenceRefs = uniqueStrings(job ? job.evidence_refs : explicitEvidenceRefs);
    const sourceConversations = uniqueStrings([
      ...(job?.conversation_id ? [job.conversation_id] : []),
      ...(stringArray(args.source_conversations) ?? [])
    ]);
    const confidence = optionalNumber(args.confidence);
    const content = requiredString(args.content, "content");
    const projectDescription = optionalString(args.project_description);
    if (projectDescription && kind !== "l2") throw new TypeError("project_description is only valid for L2 distillation");
    if (projectDescription && projectDescription.length > 1200) throw new TypeError("project_description must be at most 1200 characters");
    validateDistillationCandidate({
      kind,
      content,
      evidence: { evidenceRefs, sourceConversations, confidence }
    });
    await validateDistillationEvidenceChain({
      stateRoot,
      runtime,
      kind,
      projectId,
      evidenceRefs: evidenceRefs ?? [],
      job
    });
    if (args.dry_run === true) {
      return {
        ok: true,
        dryRun: true,
        kind,
        scope,
        project: projectId,
        sourceHarness,
        contract: DISTILLATION_CONTRACT_VERSION,
        evidenceRefs,
        sourceConversations,
        confidence
      };
    }
    // Evidence validation can take time; fence enough remaining lease budget
    // immediately before the external write. Local preparation failures are
    // not Memory Core failures and must not be recorded as such.
    if (jobId) {
      await prepareDistillationLeaseForExternalWrite(
        stateRoot,
        runtime.accountId,
        jobId,
        sourceHarness,
        leaseToken
      );
    }
    const canonicalArtifactId = optionalString(args.artifact_id) ??
      (kind === "l2"
        ? `project-timeline:${projectId}`
        : kind === "l3"
          ? `project-profile:${projectId}`
          : kind === "l4"
            ? `user-profile:${runtime.accountId}`
            : undefined);
    const canonicalTitle = title ??
      (kind === "l2"
        ? `Project Timeline · ${projectId}`
        : kind === "l3"
          ? `Project Rules & Experience · ${projectId}`
          : kind === "l4"
            ? "Cross-project User Profile"
            : undefined);
    let result: unknown;
    let coreCommittedAt: string | undefined;
    try {
      result = await runtime.memory.distill({
        accountId: runtime.accountId,
        userId: runtime.userId,
        kind,
        content,
        projectId,
        conversationId,
        title: canonicalTitle,
        tags: uniqueStrings(["memory-v2", `layer:${kind}`, ...(stringArray(args.tags) ?? [])]),
        sourceHarness,
        artifactId: canonicalArtifactId,
        version: optionalString(args.version),
        evidenceRefs,
        sourceConversations,
        confidence,
        contractVersion: DISTILLATION_CONTRACT_VERSION,
        provenance: {
          platform: runtime.source.platform,
          transport: runtime.source.transport,
          principal: runtime.source.principalId,
          connection: runtime.source.connectionId,
          account: runtime.accountId,
          authenticated_account: runtime.source.authenticatedAccount
        }
      });
      coreCommittedAt = new Date().toISOString();
    } catch (error) {
      if (jobId) {
        await failDistillationJobForLeaseGeneration(
          stateRoot,
          runtime.accountId,
          jobId,
          error instanceof Error ? error.message : String(error),
          sourceHarness,
          leaseToken
        ).catch(() => undefined);
      }
      throw error;
    }
    let resultId: string;
    try {
      resultId = requireMemoryResultId(result);
    } catch (error) {
      if (jobId) {
        await quarantineDistillationJobAfterCoreCommit(
          stateRoot,
          runtime.accountId,
          jobId,
          "Memory Core returned success without a stable result id; ambiguous commit requires manual reconciliation before retry",
          sourceHarness,
          leaseToken,
          coreCommittedAt
        ).catch((quarantineError) => {
          throw new Error(
            `Memory Core returned an ambiguous success and the lease generation could not be quarantined: ${String(quarantineError)}`
          );
        });
      }
      throw error;
    }
    let projectDescriptionError: string | undefined;
    let queuedNext: unknown;
    let nextLayerEnqueueError: string | undefined;
    if (jobId) {
      const completed = await completeDistillationJobAfterCoreCommit(stateRoot, runtime.accountId, jobId, {
        kind,
        resultId,
        content,
        committedAt: coreCommittedAt!
      }, sourceHarness, leaseToken);
      try {
      if (kind === "l2" && projectId) {
        queuedNext = await (input.enqueueDerived ?? enqueueDerivedDistillationJob)({
          stateRoot,
          accountId: runtime.accountId,
          target: "l3",
          projectId,
          evidence: [{
            ref: `l2:${resultId}:${completed.job_id}`,
            kind: "artifact",
            layer: "L2",
            timestamp: completed.result_committed_at ?? completed.completed_at ?? new Date().toISOString(),
            project_id: projectId,
            title: canonicalLayerTitle("l2", projectId),
            content
          }]
        });
      } else if (kind === "l3") {
        const latestByProject = latestCompletedL3ByProject(
          await listDistillationJobs(stateRoot, runtime.accountId)
        );
        if (latestByProject.length >= 2) {
          queuedNext = await (input.enqueueDerived ?? enqueueDerivedDistillationJob)({
            stateRoot,
            accountId: runtime.accountId,
            target: "l4",
            projectId: null,
            evidence: latestByProject.map((item) => ({
              ref: `l3:${item.result_id}:${item.job_id}`,
              kind: "artifact",
              layer: "L3",
              timestamp: item.result_committed_at ?? item.completed_at ?? item.updated_at,
              project_id: item.project_id!,
              title: canonicalLayerTitle("l3", item.project_id!),
              content: item.result_content!
            }))
          });
        }
      }
      } catch (error) {
        // Upstream L2/L3 and the completed job are durable. Queue failure
        // is a separate recoverable condition, not permission to replay Core.
        nextLayerEnqueueError = error instanceof Error ? error.message : String(error);
        console.error("[memhub] next-layer distillation enqueue failed:", nextLayerEnqueueError);
      }
    }
    if (kind === "l2" && projectId && projectDescription) {
      // Complete the source job before optional routing metadata: a slow or
      // failed secondary update must not hold a live distillation lease open
      // after the Core artifact has already been committed.
      try {
        await runtime.projects.updateDistilledDescription(
          runtime.accountId,
          projectId,
          projectDescription,
          evidenceRefs ?? []
        );
      } catch (error) {
        projectDescriptionError = error instanceof Error ? error.message : String(error);
        console.error("[memhub] distilled project description update failed:", projectDescriptionError);
      }
    }
    return {
      ok: true,
      kind,
      scope,
      project: projectId,
      sourceHarness,
      nativeEvolution: false,
      contract: DISTILLATION_CONTRACT_VERSION,
      job_id: jobId,
      memory: result,
      ...(projectDescriptionError ? { project_description_error: projectDescriptionError } : {}),
      ...(nextLayerEnqueueError ? { next_layer_enqueue_error: nextLayerEnqueueError } : {}),
      ...(queuedNext ? { next_layer_job: queuedNext } : {})
    };
}

function requiredString(value: unknown, field: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length ? [...new Set(values)] : undefined;
}

function uniqueStrings(values: string[]): string[] | undefined {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return normalized.length ? [...new Set(normalized)] : undefined;
}

function canonicalLayerTitle(kind: "l2" | "l3", projectId: string): string {
  return kind === "l2"
    ? `Project Timeline · ${projectId}`
    : `Project Rules & Experience · ${projectId}`;
}

function memoryResultId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["id", "memoryId", "skillId"] as const) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function requireMemoryResultId(value: unknown): string {
  const id = memoryResultId(value);
  if (!id) throw new Error("Memory Core did not return a stable result id for history distillation");
  return id;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("value must be a finite number");
  return value;
}
