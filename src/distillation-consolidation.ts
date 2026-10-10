import { distillationResultTimestamp, listDistillationJobs } from "./distillation-jobs.js";
import type { MemhubRuntime } from "./runtime.js";

const MIN_CONSOLIDATION_REVISIONS = 8;

export interface DistillationConsolidationPlan {
  version: "consolidation-v1";
  strategy: "select_merge_reextract_supersede";
  kind: "l2" | "l3";
  project_id: string;
  canonical_artifact_id: string;
  historical_revision_count: number;
  minimum_revision_count: number;
  source_revision_refs: string[];
  submit_evidence_refs: string[];
  current_revision_ref: string | null;
  eligible: boolean;
  reason: string;
  write_contract: string;
}

/**
 * EverOS-style reflection without a second memory layer: select historical
 * revisions, merge/re-extract in the connected model, then submit one new
 * canonical L2/L3 revision through the existing evidence-governed writer.
 */
export async function planDistillationConsolidation(input: {
  stateRoot: string;
  runtime: MemhubRuntime;
  kind: "l2" | "l3";
  projectId: string;
}): Promise<DistillationConsolidationPlan> {
  const canonicalProject = await input.runtime.projects.resolve(input.runtime.accountId, input.projectId);
  if (!canonicalProject) throw new Error(`unknown or inactive project: ${input.projectId}`);
  const projectStorageIds = new Set(await input.runtime.projects.storageIds(input.runtime.accountId, canonicalProject));
  const jobs = await listDistillationJobs(input.stateRoot, input.runtime.accountId);
  const targetJobs = jobs
    .filter((job) => job.status === "completed" && job.target === input.kind &&
      job.result_kind === input.kind && Boolean(job.result_id) && Boolean(job.result_content?.trim()) &&
      Boolean(job.project_id && projectStorageIds.has(job.project_id)))
    .sort((a, b) =>
      (distillationResultTimestamp(a) ?? "").localeCompare(distillationResultTimestamp(b) ?? "") ||
      a.job_id.localeCompare(b.job_id)
    );
  const sourceRevisionRefs = targetJobs.map((job) => `${input.kind}:${job.result_id}:${job.job_id}`);
  const currentRevisionRef = sourceRevisionRefs.at(-1) ?? null;
  const submitEvidenceRefs = input.kind === "l2"
    ? unique(targetJobs.flatMap((job) => job.evidence_refs).filter((ref) => ref.startsWith("l1:")))
    : unique(jobs
        .filter((job) => job.status === "completed" && job.target === "l2" && job.result_kind === "l2" &&
          Boolean(job.result_id) && Boolean(job.result_content?.trim()) && Boolean(job.project_id && projectStorageIds.has(job.project_id)))
        .sort((a, b) =>
          (distillationResultTimestamp(a) ?? "").localeCompare(distillationResultTimestamp(b) ?? "") ||
          a.job_id.localeCompare(b.job_id)
        )
        .map((job) => `l2:${job.result_id}:${job.job_id}`));
  const eligible = targetJobs.length >= MIN_CONSOLIDATION_REVISIONS && submitEvidenceRefs.length > 0;
  return {
    version: "consolidation-v1",
    strategy: "select_merge_reextract_supersede",
    kind: input.kind,
    project_id: canonicalProject,
    canonical_artifact_id: input.kind === "l2"
      ? `project-timeline:${canonicalProject}`
      : `project-profile:${canonicalProject}`,
    historical_revision_count: targetJobs.length,
    minimum_revision_count: MIN_CONSOLIDATION_REVISIONS,
    source_revision_refs: sourceRevisionRefs,
    submit_evidence_refs: submitEvidenceRefs,
    current_revision_ref: currentRevisionRef,
    eligible,
    reason: eligible
      ? "The revision history is large enough to justify a manual consolidation review while preserving old revisions as evidence history."
      : targetJobs.length < MIN_CONSOLIDATION_REVISIONS
        ? `At least ${MIN_CONSOLIDATION_REVISIONS} completed historical revisions are required before consolidation is recommended.`
        : "No valid upstream evidence refs are available for a governed replacement revision.",
    write_contract: "Use the connected model to merge/re-extract a compact replacement, then call memhub_distill action=submit with the returned submit_evidence_refs. The stable canonical artifact id is reused; do not create a new layer or parallel truth."
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
