import { captureIndexStats, captureIngestedAt, listCaptureEvents, listCaptureIndexEntries, type StoredCaptureEvent } from "./capture.js";
import {
  enqueueDistillationJob,
  getDistillationConfig,
  listDistillationJobs
} from "./distillation-jobs.js";

export interface DiscoveryReport {
  auto_enabled: boolean;
  auto_since: string | null;
  source: "complete_ingested_capture_only";
  captured_total: number;
  complete_uningested: number;
  incomplete: number;
  pending_jobs: number;
  leased_jobs: number;
  failed_jobs: number;
  scanned: number;
  eligible: number;
  unresolved: number;
  already_queued: number;
  waiting: number;
  would_enqueue: number;
  queued: number;
  duplicates: number;
  cutover_missing: boolean;
}

/** Reconcile durable L1 captures into jobs; semantic synthesis remains with the Harness. */
export async function discoverDistillationJobs(input: {
  stateRoot: string;
  accountId: string;
  resolveProject: (projectHint: string) => Promise<string | null>;
  enqueue?: boolean;
  conversationId?: string;
  now?: Date;
}): Promise<DiscoveryReport> {
  const config = await getDistillationConfig(input.stateRoot);
  const stats = await captureIndexStats(input.stateRoot, input.accountId);
  const unIngested = await listCaptureIndexEntries(input.stateRoot, input.accountId, { completeOnly: true, ingested: false });
  const jobs = await listDistillationJobs(input.stateRoot, input.accountId);
  const report: DiscoveryReport = {
    auto_enabled: config.auto_enabled,
    auto_since: config.auto_since ?? null,
    source: "complete_ingested_capture_only",
    captured_total: stats.total,
    complete_uningested: unIngested.length,
    incomplete: stats.incomplete,
    pending_jobs: jobs.filter((job) => job.status === "pending").length,
    leased_jobs: jobs.filter((job) => job.status === "leased").length,
    failed_jobs: jobs.filter((job) => job.status === "failed").length,
    scanned: 0, eligible: 0, unresolved: 0, already_queued: 0,
    waiting: 0, would_enqueue: 0, queued: 0, duplicates: 0,
    cutover_missing: config.auto_enabled && !config.auto_since
  };
  if (!config.auto_enabled || !config.auto_since) return report;
  const captures = await listCaptureEvents(input.stateRoot, input.accountId, {
    ingested: true,
    completeOnly: true,
    ...(input.conversationId ? { conversationId: input.conversationId } : {})
  });
  const used = new Set(jobs.filter((job) => job.target === "l2").flatMap((job) =>
    job.evidence_refs.map((ref) => `${job.project_id ?? ""}\0${job.conversation_id ?? ""}\0${ref}`)
  ));
  const groups = new Map<string, { projectId: string; conversationId: string; captures: StoredCaptureEvent[] }>();
  const resolved = new Map<string, string | null>();
  const ingestedTimes = new Map<string, string>();
  for (const event of captures) {
    const ingestedAt = await captureIngestedAt(input.stateRoot, input.accountId, event.event_id);
    if (!ingestedAt || ingestedAt < config.auto_since) continue;
    ingestedTimes.set(event.event_id, ingestedAt);
    report.scanned += 1;
    if (!event.project_hint || !event.user_text?.trim() || !event.assistant_text?.trim()) {
      report.unresolved += 1;
      continue;
    }
    if (!resolved.has(event.project_hint)) {
      resolved.set(event.project_hint, await input.resolveProject(event.project_hint));
    }
    const projectId = resolved.get(event.project_hint);
    if (!projectId) { report.unresolved += 1; continue; }
    report.eligible += 1;
    if (used.has(`${projectId}\0${event.conversation_id}\0l1:${event.event_id}`)) {
      report.already_queued += 1;
      continue;
    }
    const key = `${projectId}\0${event.conversation_id}`;
    const group = groups.get(key) ?? { projectId, conversationId: event.conversation_id, captures: [] };
    group.captures.push(event);
    groups.set(key, group);
  }
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - config.idle_minutes * 60_000).toISOString();
  for (const group of groups.values()) {
    group.captures.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.event_id.localeCompare(b.event_id));
    const idle = group.captures.every((item) => (ingestedTimes.get(item.event_id) ?? "") <= cutoff);
    for (let offset = 0; offset < group.captures.length; offset += config.turn_threshold) {
      const batch = group.captures.slice(offset, offset + config.turn_threshold);
      if (batch.length < config.turn_threshold && !idle) {
        report.waiting += batch.length;
        continue;
      }
      report.would_enqueue += 1;
      if (!input.enqueue) continue;
      const result = await enqueueDistillationJob({
        stateRoot: input.stateRoot,
        accountId: input.accountId,
        projectId: group.projectId,
        conversationId: group.conversationId,
        captures: batch,
        reason: batch.length >= config.turn_threshold ? "turn_threshold" : "idle"
      });
      if (result.created) report.queued += 1;
      else report.duplicates += 1;
    }
  }
  // Report the durable post-reconciliation queue, not only the pre-scan
  // snapshot. A caller must be able to distinguish newly queued work from
  // an idle queue without issuing a second, potentially failing MCP call.
  if (input.enqueue) {
    const currentJobs = await listDistillationJobs(input.stateRoot, input.accountId);
    report.pending_jobs = currentJobs.filter((job) => job.status === "pending").length;
    report.leased_jobs = currentJobs.filter((job) => job.status === "leased").length;
    report.failed_jobs = currentJobs.filter((job) => job.status === "failed").length;
  }
  return report;
}
