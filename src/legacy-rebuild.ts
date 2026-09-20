import { enqueueLegacyL1DistillationJob, type DistillationEvidenceItem } from "./distillation-jobs.js";
import type { MemhubRuntime } from "./runtime.js";

export interface LegacyRebuildProjectResult {
  project_id: string;
  storage_ids: string[];
  evidence_count: number;
  raw_turn_count: number;
  memory_count: number;
  deduped_memory_count: number;
  excluded_capture_count: number;
  created: boolean;
  job_id?: string;
}

export interface LegacyRebuildResult {
  projects: LegacyRebuildProjectResult[];
  queued_jobs: number;
  reused_jobs: number;
  evidence_count: number;
}

/**
 * Queue evidence-backed L2 rebuild jobs from Memory Core L1 history.
 *
 * This deliberately does not synthesize L2/L3/L4 content itself. It only
 * converts already-stored project-scoped L1 memories into the normal Memhub
 * distillation job format so the connected Harness still performs semantic
 * distillation under the same lease/evidence contract as new captures.
 */
export async function queueLegacyLayerRebuild(input: {
  stateRoot: string;
  runtime: MemhubRuntime;
  projectId?: string;
}): Promise<LegacyRebuildResult> {
  const projectIds = input.projectId
    ? [input.projectId]
    : (await input.runtime.projects.list(input.runtime.accountId))
        .filter((project) => project.state === "active")
        .map((project) => project.projectId);

  const projects: LegacyRebuildProjectResult[] = [];
  for (const projectId of projectIds) {
    const storageIds = await input.runtime.projects.storageIds(input.runtime.accountId, projectId);
    const [rawTurns, coreItems] = await Promise.all([
      Promise.all(storageIds.map((storageId) => readAllRawTurns(input.runtime, storageId)))
        .then((groups) => dedupeRawTurns(groups.flat())),
      Promise.all(storageIds.map((storageId) => readAllL1(input.runtime, storageId)))
        .then((groups) => dedupeById(groups.flat()))
    ]);
    let excludedCaptureCount = 0;
    const evidence: DistillationEvidenceItem[] = [];
    for (const item of rawTurns) {
      if (text(item.sessionSource) === "memhub-capture") {
        excludedCaptureCount += 1;
        continue;
      }
      const id = text(item.rawTurnId);
      const userText = text(item.userText);
      const assistantText = text(item.assistantText);
      if (!id || !userText || !assistantText || text(item.status) !== "succeeded") continue;
      evidence.push({
        ref: `raw-turn:${id}`,
        kind: "turn",
        layer: "L1",
        timestamp: text(item.createdAt) || new Date(0).toISOString(),
        project_id: projectId,
        user_text: userText,
        assistant_text: assistantText,
        ...(text(item.reasoningSummary) ? { reasoning_summary: text(item.reasoningSummary) } : {})
      });
    }
    const rawTurnIds = new Set(evidence
      .filter((item) => item.kind === "turn")
      .map((item) => item.ref.slice("raw-turn:".length)));
    let dedupedMemoryCount = 0;
    let memoryCount = 0;
    const detailedCoreItems = await mapLimit(coreItems, 8, async (item) => {
      const id = text(item.id);
      if (!id) return { item, detail: {} };
      try {
        return { item, detail: record(await input.runtime.memoryClient.viewerGet(`/api/v1/memory/${encodeURIComponent(id)}`)) };
      } catch {
        return { item, detail: {} };
      }
    });
    for (const { item, detail } of detailedCoreItems) {
      if (isCaptureManaged(item)) {
        excludedCaptureCount += 1;
        continue;
      }
      const id = text(item.id);
      const body = text(detail.body);
      const linkedRawTurnId = body ? rawTurnIdFromBody(body) : undefined;
      if (linkedRawTurnId && rawTurnIds.has(linkedRawTurnId)) {
        dedupedMemoryCount += 1;
        continue;
      }
      const content = memoryEvidenceContent(item, detail);
      if (!id || !content) continue;
      memoryCount += 1;
      evidence.push({
        ref: `l1-memory:${id}`,
        kind: "memory",
        layer: "L1",
        timestamp: text(item.createdAt) || text(item.updatedAt) || new Date(0).toISOString(),
        project_id: projectId,
        ...(text(detail.title) || text(item.title) ? { title: text(detail.title) || text(item.title) } : {}),
        content
      });
    }
    if (evidence.length === 0) {
      projects.push({
        project_id: projectId,
        storage_ids: storageIds,
        evidence_count: 0,
        raw_turn_count: 0,
        memory_count: 0,
        deduped_memory_count: dedupedMemoryCount,
        excluded_capture_count: excludedCaptureCount,
        created: false
      });
      continue;
    }
    const queued = await enqueueLegacyL1DistillationJob({
      stateRoot: input.stateRoot,
      accountId: input.runtime.accountId,
      projectId,
      evidence
    });
    projects.push({
      project_id: projectId,
      storage_ids: storageIds,
      evidence_count: evidence.length,
      raw_turn_count: evidence.filter((item) => item.kind === "turn").length,
      memory_count: memoryCount,
      deduped_memory_count: dedupedMemoryCount,
      excluded_capture_count: excludedCaptureCount,
      created: queued.created,
      job_id: queued.job.job_id
    });
  }

  return {
    projects,
    queued_jobs: projects.filter((item) => item.created).length,
    reused_jobs: projects.filter((item) => item.job_id && !item.created).length,
    evidence_count: projects.reduce((sum, item) => sum + item.evidence_count, 0)
  };
}

async function readAllL1(runtime: MemhubRuntime, storageProjectId: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const params = new URLSearchParams({
      userId: runtime.userId,
      projectId: storageProjectId,
      page: String(page),
      limit: "200"
    });
    const payload = record(await runtime.memoryClient.viewerGet(`/api/v1/l1?${params.toString()}`));
    if (Array.isArray(payload.items)) items.push(...payload.items.map(record));
    if (payload.hasNext !== true) break;
  }
  return items;
}

async function readAllRawTurns(runtime: MemhubRuntime, storageProjectId: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const params = new URLSearchParams({
      userId: runtime.userId,
      projectId: storageProjectId,
      page: String(page),
      limit: "100"
    });
    const payload = record(await runtime.memoryClient.viewerGet(`/api/v1/raw-turns?${params.toString()}`));
    if (Array.isArray(payload.items)) items.push(...payload.items.map(record));
    if (payload.hasNext !== true) break;
  }
  return items;
}

function isCaptureManaged(item: Record<string, unknown>): boolean {
  const metadata = record(item.metadata);
  if (metadata.source === "memhub-capture") return true;
  return Array.isArray(item.tags) && item.tags.some((tag) => tag === "memhub-capture");
}

function memoryEvidenceContent(item: Record<string, unknown>, detail: Record<string, unknown>): string | undefined {
  const body = text(detail.body);
  if (body) return body.slice(0, 50_000);
  const title = text(detail.title) || text(item.title);
  const summary = text(detail.summary) || text(item.summary);
  const snippet = text(item.snippet);
  const parts = [title, summary || snippet].filter(Boolean);
  const unique = [...new Set(parts)];
  const content = unique.join("\n\n").trim();
  return content ? content.slice(0, 50_000) : undefined;
}

function rawTurnIdFromBody(body: string): string | undefined {
  return /^RawTurn:\s*(raw_[A-Za-z0-9_-]+)/m.exec(body)?.[1];
}

function dedupeById(items: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const result: Record<string, unknown>[] = [];
  for (const item of items) {
    const id = text(item.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

function dedupeRawTurns(items: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const result: Record<string, unknown>[] = [];
  for (const item of items) {
    const id = text(item.rawTurnId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

async function mapLimit<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      result[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return result;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
