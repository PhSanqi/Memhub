import {
  distillationResultTimestamp,
  enqueueDerivedDistillationJob,
  latestCompletedL3ByProject,
  listDistillationJobs,
  type DistillationJob
} from "./distillation-jobs.js";

/**
 * Rebuild only a missing L3 queue claim from an already completed L2 job.
 * Core must never be called: the source result is durable and its exact
 * account, project, result id, content and completion time are reused.
 */
export async function reconcileCompletedL2DerivedJob(input: {
  stateRoot: string;
  accountId: string;
  jobId: string;
  projectId: string;
  dryRun: boolean;
}): Promise<Record<string, unknown>> {
  const { stateRoot, accountId, jobId, projectId } = input;
  const jobs = await listDistillationJobs(stateRoot, accountId);
  const source = checkedSource(jobs.find((item) => item.job_id === jobId), projectId);
  const evidenceRef = `l2:${source.result_id}:${source.job_id}`;
  const matches = jobs.filter((item) =>
    item.target === "l3" && item.evidence_refs.includes(evidenceRef)
  );
  if (matches.length > 1) {
    throw new Error("multiple L3 queue claims contain the same source; manual review required");
  }
  const existing = matches[0];
  if (existing && existing.project_id !== projectId) {
    throw new Error("derived L3 evidence already exists under another project; manual review required");
  }
  if (existing && (existing.scope !== "project" ||
      existing.evidence_refs.length !== 1 ||
      existing.evidence_refs[0] !== evidenceRef ||
      existing.evidence.length !== 1 ||
      !existing.evidence.some((item) =>
        item.ref === evidenceRef && item.kind === "artifact" && item.layer === "L2" &&
        item.project_id === projectId && item.content === source.result_content &&
        item.timestamp === distillationResultTimestamp(source)
      ))) {
    throw new Error("derived L3 evidence differs from completed L2 provenance; manual review required");
  }
  if (existing || input.dryRun) {
    return {
      ok: true, dry_run: input.dryRun,
      source_job_id: jobId, project: projectId,
      already_queued: Boolean(existing),
      ...(existing ? { derived_job_id: existing.job_id } : {}),
      core_replayed: false
    };
  }
  // A source Job is immutable after completion, but recheck after the
  // read-only preflight to reject concurrent store repair/replacement.
  const latest = checkedSource(
    (await listDistillationJobs(stateRoot, accountId)).find((item) => item.job_id === jobId),
    projectId
  );
  if (latest.result_id !== source.result_id ||
      latest.result_content !== source.result_content ||
      distillationResultTimestamp(latest) !== distillationResultTimestamp(source)) {
    throw new Error("completed L2 provenance changed during reconciliation");
  }
  const queued = await enqueueDerivedDistillationJob({
    stateRoot, accountId, projectId, target: "l3",
    evidence: [{
      ref: evidenceRef,
      kind: "artifact",
      layer: "L2",
      timestamp: distillationResultTimestamp(source)!,
      project_id: projectId,
      title: `Project Timeline · ${projectId}`,
      content: source.result_content!
    }]
  });
  if (queued.job.project_id !== projectId ||
      queued.job.scope !== "project" ||
      queued.job.evidence_refs.length !== 1 ||
      queued.job.evidence_refs[0] !== evidenceRef ||
      queued.job.evidence.length !== 1 ||
      !queued.job.evidence.some((item) =>
        item.ref === evidenceRef && item.kind === "artifact" && item.layer === "L2" &&
        item.project_id === projectId && item.content === source.result_content &&
        item.timestamp === distillationResultTimestamp(source)
      )) {
    throw new Error("derived queue claim conflicts with source evidence; manual review required");
  }
  return {
    ok: true, dry_run: false,
    source_job_id: jobId, project: projectId,
    already_queued: !queued.created,
    derived_job_id: queued.job.job_id,
    core_replayed: false
  };
}

/**
 * Rebuild only the missing account-scoped L4 queue claim for the current
 * latest completed L3 result from every project. The supplied source L3 job
 * must itself still be the latest result for its project, preventing an old
 * snapshot from authorizing a newer cross-project aggregation.
 */
export async function reconcileCurrentL4DerivedJob(input: {
  stateRoot: string;
  accountId: string;
  jobId: string;
  dryRun: boolean;
}): Promise<Record<string, unknown>> {
  const { stateRoot, accountId, jobId } = input;
  const jobs = await listDistillationJobs(stateRoot, accountId);
  const source = checkedL3Source(jobs.find((item) => item.job_id === jobId));
  const snapshot = currentL3Snapshot(jobs);
  if (snapshot.length < 2) {
    throw new Error("L4 reconciliation requires completed L3 evidence from at least two projects");
  }
  const currentSource = snapshot.find((item) => item.project_id === source.project_id);
  if (!currentSource || currentSource.job_id !== source.job_id) {
    throw new Error("source L3 job is not the current latest result for its project");
  }
  const evidence = l4Evidence(snapshot);
  const expectedRefs = evidence.map((item) => item.ref).sort();
  const matches = jobs.filter((item) =>
    item.target === "l4" &&
    item.evidence_refs.length === expectedRefs.length &&
    [...item.evidence_refs].sort().every((ref, index) => ref === expectedRefs[index])
  );
  if (matches.length > 1) {
    throw new Error("multiple L4 queue claims contain the current L3 evidence set; manual review required");
  }
  const existing = matches[0];
  if (existing && (
    existing.project_id !== null ||
    existing.scope !== "account" ||
    existing.evidence.length !== evidence.length ||
    !evidence.every((expected) => existing.evidence.some((actual) =>
      actual.ref === expected.ref &&
      actual.kind === expected.kind &&
      actual.layer === expected.layer &&
      actual.project_id === expected.project_id &&
      actual.content === expected.content &&
      actual.timestamp === expected.timestamp
    ))
  )) {
    throw new Error("derived L4 evidence differs from current completed L3 provenance; manual review required");
  }
  if (existing || input.dryRun) {
    return {
      ok: true,
      dry_run: input.dryRun,
      source_job_id: source.job_id,
      source_project: source.project_id,
      current_projects: snapshot.map((item) => item.project_id),
      already_queued: Boolean(existing),
      ...(existing ? { derived_job_id: existing.job_id } : {}),
      core_replayed: false
    };
  }

  const latestJobs = await listDistillationJobs(stateRoot, accountId);
  const latestSnapshot = currentL3Snapshot(latestJobs);
  if (JSON.stringify(l4Evidence(latestSnapshot)) !== JSON.stringify(evidence)) {
    throw new Error("current L3 evidence set changed during L4 reconciliation");
  }
  const queued = await enqueueDerivedDistillationJob({
    stateRoot,
    accountId,
    projectId: null,
    target: "l4",
    evidence
  });
  if (queued.job.project_id !== null ||
      queued.job.scope !== "account" ||
      queued.job.evidence_refs.length !== expectedRefs.length ||
      queued.job.evidence.length !== evidence.length ||
      ![...queued.job.evidence_refs].sort().every((ref, index) => ref === expectedRefs[index]) ||
      !evidence.every((expected) => queued.job.evidence.some((actual) =>
        actual.ref === expected.ref &&
        actual.kind === expected.kind &&
        actual.layer === expected.layer &&
        actual.project_id === expected.project_id &&
        actual.content === expected.content &&
        actual.timestamp === expected.timestamp
      ))) {
    throw new Error("derived L4 queue claim conflicts with current L3 evidence; manual review required");
  }
  return {
    ok: true,
    dry_run: false,
    source_job_id: source.job_id,
    source_project: source.project_id,
    current_projects: snapshot.map((item) => item.project_id),
    already_queued: !queued.created,
    derived_job_id: queued.job.job_id,
    core_replayed: false
  };
}

function currentL3Snapshot(jobs: DistillationJob[]): DistillationJob[] {
  return latestCompletedL3ByProject(jobs);
}

function l4Evidence(snapshot: DistillationJob[]) {
  return snapshot.map((item) => ({
    ref: `l3:${item.result_id}:${item.job_id}`,
    kind: "artifact" as const,
    layer: "L3" as const,
    timestamp: distillationResultTimestamp(item)!,
    project_id: item.project_id!,
    title: `Project Rules & Experience · ${item.project_id}`,
    content: item.result_content!
  }));
}

function checkedL3Source(job: DistillationJob | undefined): DistillationJob {
  if (!job) throw new Error("completed L3 source job not found for account");
  if (job.target !== "l3" || job.result_kind !== "l3" ||
      job.status !== "completed" || !job.project_id ||
      !job.result_id?.trim() || !job.result_content?.trim() ||
      !job.evidence_refs.length || !distillationResultTimestamp(job)) {
    throw new Error("source is not a complete project L3 result; manual review required");
  }
  return job;
}

function checkedSource(job: DistillationJob | undefined, projectId: string): DistillationJob {
  if (!job) throw new Error("completed L2 source job not found for account");
  if (job.target !== "l2" || job.result_kind !== "l2" ||
      job.status !== "completed" || job.project_id !== projectId ||
      !job.result_id?.trim() || !job.result_content?.trim() ||
      !job.evidence_refs.length || !distillationResultTimestamp(job)) {
    throw new Error("source is not a complete, project-matched L2 result; manual review required");
  }
  return job;
}
