import {
  captureIngestedAt,
  captureIsFullyExcludedFromMemory,
  readCaptureIngestIntentStatus,
  readCaptureAuditSnapshot
} from "./capture.js";
import {
  distillationResultTimestamp,
  effectiveDistillationFailureKind,
  getDistillationConfig,
  latestCompletedL3ByProject,
  listDistillationJobs
} from "./distillation-jobs.js";
import { inspectDerivedL3Claims } from "./distillation-derived-provenance.js";
import { resolveCaptureProject } from "./capture-project-resolution.js";

export interface DistillationPipelineAudit {
  source: "read_only_durable_state";
  account_scoped: true;
  auto_enabled: boolean;
  auto_since: string | null;
  capture: {
    total: number;
    incomplete: number;
    complete_uningested: number;
    ingested: number;
  };
  evidence: {
    scanned_ingested_complete: number;
    before_cutover: number;
    unresolved_project: number;
    privacy_excluded: number;
    workspace_resolved: number;
    eligible_unqueued: number;
    ready_to_enqueue: number;
    waiting_for_idle_or_threshold: number;
    already_queued: number;
  };
  jobs: {
    pending: number;
    leased: number;
    completed: number;
    failed: number;
    actionable_failed: number;
    historical_failed: number;
  };
  recovery: {
    complete_uningested_requires_review: number;
    synthetic_complete_uningested_excluded: number;
    frozen_intent_without_marker: number;
    legacy_without_intent: number;
    conflicting_intent: number;
    durable_ingested_reconcilable: number;
    completed_l2_missing_l3: number;
    completed_l2_conflicting_l3: number;
    current_l3_set_missing_l4: number;
    current_l3_set_conflicting_l4: number;
  };
  review_samples: {
    /** At most 20 identifiers per category; no conversation content. */
    complete_uningested: Array<{
      event_id: string;
      project_hint: string | null;
      intent_status: "absent" | "matching" | "conflict";
    }>;
    unresolved_project: Array<{
      event_id: string;
      project_hint: string | null;
      reason: "missing_project_hint" | "incomplete_turn_content" | "unknown_project";
    }>;
    completed_l2_missing_l3: Array<{ job_id: string; project_id: string }>;
    completed_l2_conflicting_l3: Array<{ job_id: string; project_id: string; reason: string }>;
    current_l3_set_l4: {
      source_job_ids: string[];
      project_ids: string[];
      matching_l4_job_ids: string[];
      reason: "missing_claim" | "multiple_claims" | "scope_mismatch" | "evidence_mismatch";
    } | null;
  };
  warnings: string[];
}

function isLegacySyntheticCaptureEntry(event: { event_id: string; conversation_id: string }): boolean {
  return event.event_id.includes("memhub-plugin-e2e-") &&
    event.conversation_id.includes("memhub-plugin-e2e-");
}

/**
 * Read-only diagnosis of durable evidence. It deliberately does not call
 * discover(enqueue=true), write Core, or mutate jobs.
 */
export async function auditDistillationPipeline(input: {
  stateRoot: string;
  accountId: string;
  resolveProject: (projectHint: string) => Promise<string | null>;
  now?: Date;
}): Promise<DistillationPipelineAudit> {
  const config = await getDistillationConfig(input.stateRoot);
  const [captureSnapshot, jobs] = await Promise.all([
    readCaptureAuditSnapshot(input.stateRoot, input.accountId),
    listDistillationJobs(input.stateRoot, input.accountId)
  ]);
  const { stats, completeUningested, ingestedComplete: captures } = captureSnapshot;
  const reviewableCompleteUningested = completeUningested.filter((event) => !isLegacySyntheticCaptureEntry(event));
  const syntheticCompleteUningestedExcluded = completeUningested.length - reviewableCompleteUningested.length;
  const completedL2 = jobs.filter((job) =>
    job.status === "completed" &&
    job.result_kind === "l2" &&
    Boolean(job.project_id && job.result_id && job.result_content && distillationResultTimestamp(job))
  );
  const missingDerivedL3: typeof completedL2 = [];
  const conflictingDerivedL3: Array<{ source: typeof completedL2[number]; reason: string }> = [];
  for (const source of completedL2) {
    const claim = inspectDerivedL3Claims(jobs, source);
    if (claim.state === "missing") {
      missingDerivedL3.push(source);
      continue;
    }
    if (claim.state === "conflict") {
      conflictingDerivedL3.push({ source, reason: claim.reason });
    }
  }
  const currentL3 = latestCompletedL3ByProject(jobs);
  let currentL3SetMissingL4 = 0;
  let currentL3SetConflictingL4 = 0;
  let currentL3SetL4Sample: DistillationPipelineAudit["review_samples"]["current_l3_set_l4"] = null;
  if (currentL3.length >= 2) {
    const expected = currentL3.map((job) => ({
      ref: `l3:${job.result_id}:${job.job_id}`,
      kind: "artifact" as const,
      layer: "L3" as const,
      timestamp: distillationResultTimestamp(job)!,
      project_id: job.project_id!,
      content: job.result_content!
    }));
    const expectedRefs = expected.map((item) => item.ref).sort();
    const matches = jobs.filter((job) =>
      job.target === "l4" &&
      job.evidence_refs.length === expectedRefs.length &&
      [...job.evidence_refs].sort().every((ref, index) => ref === expectedRefs[index])
    );
    let reason: "missing_claim" | "multiple_claims" | "scope_mismatch" | "evidence_mismatch" | undefined;
    if (matches.length === 0) {
      currentL3SetMissingL4 = 1;
      reason = "missing_claim";
    } else if (matches.length > 1) {
      currentL3SetConflictingL4 = 1;
      reason = "multiple_claims";
    } else {
      const child = matches[0]!;
      if (child.project_id !== null || child.scope !== "account") {
        currentL3SetConflictingL4 = 1;
        reason = "scope_mismatch";
      } else if (child.evidence.length !== expected.length ||
          !expected.every((wanted) => child.evidence.some((actual) =>
        actual.ref === wanted.ref &&
        actual.kind === wanted.kind &&
        actual.layer === wanted.layer &&
        actual.project_id === wanted.project_id &&
        actual.content === wanted.content &&
        actual.timestamp === wanted.timestamp
      ))) {
        currentL3SetConflictingL4 = 1;
        reason = "evidence_mismatch";
      }
    }
    if (reason) {
      currentL3SetL4Sample = {
        source_job_ids: currentL3.slice(0, 20).map((job) => job.job_id),
        project_ids: currentL3.slice(0, 20).map((job) => job.project_id!),
        matching_l4_job_ids: matches.slice(0, 20).map((job) => job.job_id),
        reason
      };
    }
  }
  let frozenIntent = 0;
  let legacyWithoutIntent = 0;
  let conflictingIntent = 0;
  const completeUningestedSamples: DistillationPipelineAudit["review_samples"]["complete_uningested"] = [];
  const unresolvedProjectSamples: DistillationPipelineAudit["review_samples"]["unresolved_project"] = [];
  for (const event of reviewableCompleteUningested) {
    const intent = await readCaptureIngestIntentStatus(input.stateRoot, input.accountId, event.event_id);
    if (completeUningestedSamples.length < 20) completeUningestedSamples.push({
      event_id: event.event_id,
      project_hint: event.project_hint ?? null,
      intent_status: intent
    });
    if (intent === "matching") frozenIntent++;
    else if (intent === "absent") legacyWithoutIntent++;
    else conflictingIntent++;
  }
  const used = new Set(jobs.filter((job) => job.target === "l2").flatMap((job) =>
    job.evidence_refs.map((ref) => `${job.project_id ?? ""}\0${ref}`)
  ));
  const resolved = new Map<string, string | null>();
  let beforeCutover = 0;
  let unresolvedProject = 0;
  let privacyExcluded = 0;
  let workspaceResolved = 0;
  let eligibleUnqueued = 0;
  let alreadyQueued = 0;
  const unqueuedGroups = new Map<string, Array<{ timestamp: string; eventId: string; ingestedAt: string }>>();
  for (const event of captures) {
    const ingestedAt = await captureIngestedAt(input.stateRoot, input.accountId, event.event_id);
    if (config.auto_since && ingestedAt && ingestedAt < config.auto_since) {
      beforeCutover += 1;
      continue;
    }
    if (captureIsFullyExcludedFromMemory(event)) {
      privacyExcluded += 1;
      continue;
    }
    if (!event.user_text?.trim() || !event.assistant_text?.trim()) {
      unresolvedProject += 1;
      if (unresolvedProjectSamples.length < 20) unresolvedProjectSamples.push({
        event_id: event.event_id,
        project_hint: event.project_hint ?? null,
        reason: "incomplete_turn_content"
      });
      continue;
    }
    const resolution = await resolveCaptureProject(event, async (hint) => {
      if (!resolved.has(hint)) resolved.set(hint, await input.resolveProject(hint));
      return resolved.get(hint) ?? null;
    });
    const projectId = resolution.projectId;
    if (!projectId) {
      unresolvedProject += 1;
      if (unresolvedProjectSamples.length < 20) unresolvedProjectSamples.push({
        event_id: event.event_id,
        project_hint: event.project_hint ?? null,
        reason: event.project_hint ? "unknown_project" : "missing_project_hint"
      });
      continue;
    }
    if (resolution.source === "workspace_path") workspaceResolved += 1;
    if (used.has(`${projectId}\0l1:${event.event_id}`)) {
      alreadyQueued += 1;
    } else {
      eligibleUnqueued += 1;
      const key = projectId;
      const group = unqueuedGroups.get(key) ?? [];
      group.push({ timestamp: event.timestamp, eventId: event.event_id, ingestedAt: ingestedAt! });
      unqueuedGroups.set(key, group);
    }
  }
  // Mirror discover's grouping, batch boundary and idle cut-off. An ingested
  // but unqueued event may legitimately be waiting; it is not necessarily an
  // overdue reconciliation. This remains a read-only snapshot, not a claim.
  const cutoff = new Date((input.now ?? new Date()).getTime() - config.idle_minutes * 60_000).toISOString();
  let readyToEnqueue = 0;
  let waitingForIdleOrThreshold = 0;
  if (config.auto_enabled && config.auto_since) {
    for (const group of unqueuedGroups.values()) {
      group.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.eventId.localeCompare(b.eventId));
      const idle = group.every((item) => item.ingestedAt <= cutoff);
      for (let offset = 0; offset < group.length; offset += config.turn_threshold) {
        const batch = group.slice(offset, offset + config.turn_threshold);
        if (batch.length >= config.turn_threshold || idle) readyToEnqueue += batch.length;
        else waitingForIdleOrThreshold += batch.length;
      }
    }
  } else {
    waitingForIdleOrThreshold = eligibleUnqueued;
  }

  const warnings: string[] = [];
  if (reviewableCompleteUningested.length > 0) {
    warnings.push("complete_uningested captures require per-event provenance/Core outcome review before recover_ingest");
  }
  if (frozenIntent > 0) {
    warnings.push("matching frozen ingest intents are eligible for deterministic idempotent Core replay; legacy captures remain manual-review only");
  }
  if (conflictingIntent > 0) {
    warnings.push("capture ingest intent/payload conflicts require manual repair; never force a retry");
  }
  if (unresolvedProject > 0) {
    warnings.push("ingested captures with unresolved project evidence cannot be queued automatically");
  }
  if (readyToEnqueue > 0) {
    warnings.push("durable ingested evidence has reached a discovery enqueue threshold or idle cutoff");
  }
  if (!config.auto_enabled) warnings.push("automatic distillation is disabled");
  if (config.auto_enabled && !config.auto_since) warnings.push("automatic distillation cutover is missing");
  if (missingDerivedL3.length > 0) {
    warnings.push("completed L2 artifacts lack their derived L3 queue claim; review exact job provenance before recovery, never replay the completed Core write");
  }
  if (conflictingDerivedL3.length > 0) {
    warnings.push("completed L2 artifacts have conflicting L3 queue provenance; manual repair is required and reconcile_derived must fail closed");
  }
  if (currentL3SetMissingL4 > 0) {
    warnings.push("the current latest-per-project L3 evidence set lacks an L4 queue claim; inspect reconcile_l4 in dry-run mode and never replay completed L3 Core writes");
  }
  if (currentL3SetConflictingL4 > 0) {
    warnings.push("the current latest-per-project L3 evidence set has conflicting L4 queue provenance; manual repair is required and reconcile_l4 must fail closed");
  }

  return {
    source: "read_only_durable_state",
    account_scoped: true,
    auto_enabled: config.auto_enabled,
    auto_since: config.auto_since ?? null,
    capture: {
      total: stats.total,
      incomplete: stats.incomplete,
      complete_uningested: completeUningested.length,
      ingested: stats.ingested
    },
    evidence: {
      scanned_ingested_complete: captures.length,
      before_cutover: beforeCutover,
      unresolved_project: unresolvedProject,
      privacy_excluded: privacyExcluded,
      workspace_resolved: workspaceResolved,
      eligible_unqueued: eligibleUnqueued,
      ready_to_enqueue: readyToEnqueue,
      waiting_for_idle_or_threshold: waitingForIdleOrThreshold,
      already_queued: alreadyQueued
    },
    jobs: {
      pending: jobs.filter((job) => job.status === "pending").length,
      leased: jobs.filter((job) => job.status === "leased").length,
      completed: jobs.filter((job) => job.status === "completed").length,
      failed: jobs.filter((job) => job.status === "failed").length,
      actionable_failed: jobs.filter((job) =>
        job.status === "failed" && effectiveDistillationFailureKind(job) !== "invalid_legacy_evidence"
      ).length,
      historical_failed: jobs.filter((job) =>
        job.status === "failed" && effectiveDistillationFailureKind(job) === "invalid_legacy_evidence"
      ).length
    },
    recovery: {
      complete_uningested_requires_review: reviewableCompleteUningested.length,
      synthetic_complete_uningested_excluded: syntheticCompleteUningestedExcluded,
      frozen_intent_without_marker: frozenIntent,
      legacy_without_intent: legacyWithoutIntent,
      conflicting_intent: conflictingIntent,
      durable_ingested_reconcilable: readyToEnqueue,
      completed_l2_missing_l3: missingDerivedL3.length,
      completed_l2_conflicting_l3: conflictingDerivedL3.length,
      current_l3_set_missing_l4: currentL3SetMissingL4,
      current_l3_set_conflicting_l4: currentL3SetConflictingL4
    },
    review_samples: {
      complete_uningested: completeUningestedSamples,
      unresolved_project: unresolvedProjectSamples,
      completed_l2_missing_l3: missingDerivedL3.slice(0, 20).map((job) => ({
        job_id: job.job_id, project_id: job.project_id!
      })),
      completed_l2_conflicting_l3: conflictingDerivedL3.slice(0, 20).map(({ source, reason }) => ({
        job_id: source.job_id, project_id: source.project_id!, reason
      })),
      current_l3_set_l4: currentL3SetL4Sample
    },
    warnings
  };
}
