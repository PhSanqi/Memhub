import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getDistillationConfig, listDistillationJobs, type DistillationJob } from "./distillation-jobs.js";
import { captureIndexStats } from "./capture.js";
import { listL1Turns } from "./turn-log.js";
import type { MemhubRuntime } from "./runtime.js";
import { normalizeProjectKey, type ProjectDescriptor } from "./project-registry.js";

export type MemoryControlKind =
  | "overview"
  | "projects"
  | "l1"
  | "l2"
  | "l3"
  | "l4"
  | "skills"
  | "processing";

export interface MemoryControlRequest {
  stateRoot: string;
  runtime: MemhubRuntime;
  kind: MemoryControlKind;
  projects: ProjectDescriptor[];
  projectId?: string;
  includeOverviewItems?: boolean;
}

type ControlPlaneJob = Omit<DistillationJob, "evidence" | "result_content"> & {
  evidence_count: number;
};

interface JobSummaryCacheEntry {
  fingerprint: string;
  items: ControlPlaneJob[];
}

const jobSummaryCache = new Map<string, JobSummaryCacheEntry>();

export async function readMemoryControlData(input: MemoryControlRequest): Promise<unknown> {
  switch (input.kind) {
    case "projects":
      return projectPayload(input.projects);
    case "l1":
      return l1Payload(input);
    case "l2":
      return coreLayerPayload(input, "l2");
    case "l3":
      return coreLayerPayload(input, "l3");
    case "l4":
      return coreLayerPayload(input, "l4");
    case "skills":
      return coreLayerPayload(input, "skills");
    case "processing":
      return processingPayload(input);
    case "overview":
    default:
      return overviewPayload(input);
  }
}

async function overviewPayload(input: MemoryControlRequest): Promise<unknown> {
  const [l1, l2, l3, l4, skills, jobs] = await Promise.all([
    l1OverviewStats(input),
    coreLayerPayload(input, "l2", false),
    coreLayerPayload(input, "l3", false),
    coreLayerPayload(input, "l4", false),
    coreLayerPayload(input, "skills"),
    listControlPlaneJobs(input.stateRoot, input.runtime.accountId)
  ]);
  const scopedProjects = input.projectId
    ? input.projects.filter((project) => project.projectId === input.projectId)
    : input.projects;
  const relevantJobs = await visibleControlPlaneJobs(input, jobs);
  const pendingTodos = scopedProjects.flatMap((project) => (project.todos ?? [])
    .filter((todo) => todo.status === "pending")
    .map((todo) => ({
      ...todo,
      project_id: project.projectId,
      project_name: project.name || project.projectId
    })));
  const processing = {
    pending: relevantJobs.filter((job) => job.status === "pending").length,
    leased: relevantJobs.filter((job) => job.status === "leased").length,
    failed: relevantJobs.filter((job) => job.status === "failed").length
  };
  return {
    counts: {
      projects: scopedProjects.length,
      L1: l1.total,
      L2: totalValue(l2),
      L3: totalValue(l3),
      L4: totalValue(l4),
      Skill: totalValue(skills),
      pendingTodo: pendingTodos.length
    },
    todos: {
      pending: pendingTodos,
      total: pendingTodos.length,
      projects: new Set(pendingTodos.map((todo) => todo.project_id)).size
    },
    l1: {
      complete: l1.counts.complete,
      incomplete: l1.counts.incomplete
    },
    processing: input.includeOverviewItems ? {
      ...processing,
      items: relevantJobs
        .filter((job) => job.status === "failed" || job.status === "pending" || job.status === "leased")
        .map((job) => ({ project_id: job.project_id, status: job.status }))
    } : processing,
    ...(input.includeOverviewItems ? {
      projects: overviewProjectItems(scopedProjects),
      layers: {
        l2: overviewLayerItems(itemsValue(l2)),
        l3: overviewLayerItems(itemsValue(l3))
      }
    } : {}),
    account_id: input.runtime.accountId,
    project_id: input.projectId ?? null
  };
}

async function l1OverviewStats(input: MemoryControlRequest): Promise<{
  total: number;
  counts: { complete: number; incomplete: number; memory_records: number; raw_turns: number; captures: number };
}> {
  const storageIds = input.projectId
    ? await input.runtime.projects.storageIds(input.runtime.accountId, input.projectId)
    : [];
  const archivedStorageIds = input.projectId ? [] : await archivedProjectStorageIds(input);
  const captureStats = input.projectId
    ? await Promise.all(storageIds.map((projectId) => captureIndexStats(input.stateRoot, input.runtime.accountId, projectId)))
    : [await captureIndexStats(input.stateRoot, input.runtime.accountId)];
  const [coreStats, rawStats] = await Promise.all([
    input.projectId
      ? Promise.all(storageIds.map((projectId) => coreL1Count(input, projectId)))
      : Promise.all([coreL1Count(input, undefined)]),
    input.projectId
      ? Promise.all(storageIds.map((projectId) => coreRawTurnStats(input, projectId)))
      : Promise.all([coreRawTurnStats(input, undefined)])
  ]);
  const [archivedCaptureStats, archivedCoreStats, archivedRawStats] = archivedStorageIds.length > 0
    ? await Promise.all([
        Promise.all(archivedStorageIds.map((projectId) => captureIndexStats(input.stateRoot, input.runtime.accountId, projectId))),
        Promise.all(archivedStorageIds.map((projectId) => coreL1Count(input, projectId))),
        Promise.all(archivedStorageIds.map((projectId) => coreRawTurnStats(input, projectId)))
      ])
    : [[], [], []] as const;
  const archivedMemoryRecords = archivedCoreStats.reduce((sum, count) => sum + count, 0);
  const memoryRecords = Math.max(0, coreStats.reduce((sum, count) => sum + count, 0) - archivedMemoryRecords);
  const raw = rawStats.reduce((total, stats) => ({
    total: total.total + stats.total,
    succeeded: total.succeeded + stats.succeeded,
    captureManaged: total.captureManaged + stats.captureManaged,
    captureManagedSucceeded: total.captureManagedSucceeded + stats.captureManagedSucceeded
  }), { total: 0, succeeded: 0, captureManaged: 0, captureManagedSucceeded: 0 });
  const archivedRaw = archivedRawStats.reduce((total, stats) => ({
    total: total.total + stats.total,
    succeeded: total.succeeded + stats.succeeded,
    captureManaged: total.captureManaged + stats.captureManaged,
    captureManagedSucceeded: total.captureManagedSucceeded + stats.captureManagedSucceeded
  }), { total: 0, succeeded: 0, captureManaged: 0, captureManagedSucceeded: 0 });
  raw.total = Math.max(0, raw.total - archivedRaw.total);
  raw.succeeded = Math.max(0, raw.succeeded - archivedRaw.succeeded);
  raw.captureManaged = Math.max(0, raw.captureManaged - archivedRaw.captureManaged);
  raw.captureManagedSucceeded = Math.max(0, raw.captureManagedSucceeded - archivedRaw.captureManagedSucceeded);
  const capture = captureStats.reduce((total, stats) => ({
    total: total.total + stats.total,
    not_ingested: total.not_ingested + stats.not_ingested
  }), { total: 0, not_ingested: 0 });
  const archivedCapture = archivedCaptureStats.reduce((total, stats) => ({
    total: total.total + stats.total,
    not_ingested: total.not_ingested + stats.not_ingested
  }), { total: 0, not_ingested: 0 });
  capture.total = Math.max(0, capture.total - archivedCapture.total);
  capture.not_ingested = Math.max(0, capture.not_ingested - archivedCapture.not_ingested);
  const legacyRaw = Math.max(0, raw.total - raw.captureManaged);
  const legacyRawSucceeded = Math.max(0, raw.succeeded - raw.captureManagedSucceeded);
  const legacyRawIncomplete = Math.max(0, legacyRaw - legacyRawSucceeded);
  const total = memoryRecords + legacyRaw + capture.not_ingested;
  return {
    total,
    counts: {
      complete: memoryRecords + legacyRawSucceeded,
      incomplete: legacyRawIncomplete + capture.not_ingested,
      memory_records: memoryRecords,
      raw_turns: legacyRaw,
      captures: capture.total
    }
  };
}

async function l1Payload(input: MemoryControlRequest): Promise<unknown> {
  return unifiedL1Payload(input, 200);
}

async function unifiedL1Payload(input: MemoryControlRequest, limit: number): Promise<{
  items: Record<string, unknown>[];
  total: number;
  page_limit: number;
  counts: { complete: number; incomplete: number; memory_records: number; raw_turns: number; captures: number };
}> {
  const storageIds = input.projectId
    ? await input.runtime.projects.storageIds(input.runtime.accountId, input.projectId)
    : [];
  const [captureGroups, corePayloads, rawTurnPayloads] = await Promise.all([
    input.projectId
      ? Promise.all(storageIds.map((projectId) => listL1Turns({
          stateRoot: input.stateRoot,
          accountId: input.runtime.accountId,
          projectId,
          limit: 500
        })))
      : Promise.all([listL1Turns({
          stateRoot: input.stateRoot,
          accountId: input.runtime.accountId,
          limit: 500
        })]),
    input.projectId
      ? Promise.all(storageIds.map((projectId) => coreL1Payload(input, projectId, Math.max(limit, 200))))
      : Promise.all([coreL1Payload(input, undefined, Math.max(limit, 200))]),
    input.projectId
      ? Promise.all(storageIds.map((projectId) => coreRawTurnPayload(input, projectId, Math.max(limit, 200))))
      : Promise.all([coreRawTurnPayload(input, undefined, Math.max(limit, 200))])
  ]);

  const archivedProjectKeys = input.projectId ? new Set<string>() : await archivedProjectKeySet(input);
  const captureItems = dedupeCaptureTurns(captureGroups.flat())
    .filter((item) => !isArchivedProjectRef(item.project_hint, archivedProjectKeys));
  const coreItems = dedupeRecords(corePayloads.flatMap((payload) => payload.items))
    .filter((item) => !isArchivedProjectRef(projectFromCoreItem(item), archivedProjectKeys));
  const rawTurnItems = dedupeRawTurns(rawTurnPayloads.flatMap((payload) => payload.items))
    .filter((item) => !isArchivedProjectRef(stringValue(item.projectId), archivedProjectKeys));
  const captureProjectRefs = [...new Set(captureItems
    .map((item) => item.project_hint)
    .filter((value): value is string => Boolean(value)))];
  const coreProjectRefs = [...new Set(coreItems
    .map((item) => projectFromCoreItem(item))
    .filter((value): value is string => Boolean(value)))];
  const canonicalCaptureProjects = new Map<string, string>();
  const canonicalCoreProjects = new Map<string, string>();
  await Promise.all(captureProjectRefs.map(async (projectRef) => {
    canonicalCaptureProjects.set(
      projectRef,
      input.projectId ?? await input.runtime.projects.resolve(input.runtime.accountId, projectRef) ?? projectRef
    );
  }));
  await Promise.all(coreProjectRefs.map(async (projectRef) => {
    canonicalCoreProjects.set(
      projectRef,
      input.projectId ?? await input.runtime.projects.resolve(input.runtime.accountId, projectRef) ?? projectRef
    );
  }));
  const captures = captureItems.map((item) => ({
    ...item,
    id: item.event_id,
    source_kind: "capture",
    memory_layer: "L1",
    project_id: item.project_hint ? canonicalCaptureProjects.get(item.project_hint) ?? item.project_hint : null,
    updated_at: item.timestamp
  }));
  const rawProjectRefs = [...new Set(rawTurnItems
    .map((item) => stringValue(item.projectId))
    .filter((value): value is string => Boolean(value)))];
  const canonicalRawProjects = new Map<string, string | null>();
  await Promise.all(rawProjectRefs.map(async (projectRef) => {
    canonicalRawProjects.set(
      projectRef,
      input.projectId ?? await input.runtime.projects.resolve(input.runtime.accountId, projectRef)
    );
  }));
  const rawTurns: Array<Record<string, unknown> & {
    rawTurnId?: string;
    sessionSource?: string;
    conversationId?: string;
    userText?: string;
    assistantText?: string;
    project_id: string | null;
    raw_project_id: string | null;
    project_unresolved: boolean;
  }> = rawTurnItems.map((item) => {
    const rawProjectId = stringValue(item.projectId);
    const canonicalProjectId = rawProjectId
      ? canonicalRawProjects.get(rawProjectId) ?? null
      : null;
    return {
      ...item,
      rawTurnId: stringValue(item.rawTurnId),
      sessionSource: stringValue(item.sessionSource),
      conversationId: stringValue(item.conversationId),
      userText: stringValue(item.userText),
      assistantText: stringValue(item.assistantText),
      id: `raw-turn:${stringValue(item.rawTurnId) ?? "unknown"}`,
      source_kind: "raw-turn",
      memory_layer: "L1",
      project_id: canonicalProjectId,
      raw_project_id: rawProjectId ?? null,
      project_unresolved: Boolean(rawProjectId && !canonicalProjectId),
      timestamp: stringValue(item.createdAt) ?? null,
      updated_at: stringValue(item.createdAt) ?? null
    };
  });

  const consumedRawTurnIds = new Set<string>();
  for (const capture of captureItems.filter((item) => item.user_text?.trim())) {
    const captureProject = capture.project_hint ? canonicalCaptureProjects.get(capture.project_hint) ?? capture.project_hint : null;
    const match = rawTurns.find((item) => {
      if (item.sessionSource !== "memhub-capture") return false;
      const rawTurnId = String(item.rawTurnId ?? "");
      if (!rawTurnId || consumedRawTurnIds.has(rawTurnId)) return false;
      if (item.conversationId !== capture.conversation_id) return false;
      if (item.userText !== capture.user_text) return false;
      if (capture.assistant_text?.trim() && item.assistantText !== capture.assistant_text) return false;
      return (item.project_id ?? null) === captureProject;
    });
    if (match?.rawTurnId) consumedRawTurnIds.add(String(match.rawTurnId));
  }

  // Completed/ingested captures already have a Memory Core L1 representation.
  // Prefer the original capture row in the Control Plane because it contains
  // the full user/assistant text. Match only explicit memhub-capture summaries;
  // unmatched Core rows are retained so historical data can never disappear.
  const consumedCoreIds = new Set<string>();
  for (const capture of captureItems.filter((item) => item.ingested && item.user_text?.trim())) {
    const captureProject = capture.project_hint ? canonicalCaptureProjects.get(capture.project_hint) ?? capture.project_hint : null;
    const match = coreItems.find((item) => {
      if (consumedCoreIds.has(String(item.id ?? ""))) return false;
      const metadata = objectRecord(item.metadata);
      if (metadata.source !== "memhub-capture") return false;
      const summary = typeof item.summary === "string" ? item.summary.trim() : "";
      if (summary !== capture.user_text!.trim()) return false;
      const storageProject = projectFromCoreItem(item);
      const canonicalStorageProject = storageProject
        ? canonicalCoreProjects.get(storageProject) ?? storageProject
        : null;
      return captureProject === canonicalStorageProject;
    });
    if (match?.id) consumedCoreIds.add(String(match.id));
  }

  const legacyCoreItems = coreItems
    .filter((item) => !consumedCoreIds.has(String(item.id ?? "")))
    .map((item) => ({
      ...item,
      source_kind: "memory-core",
      memory_id: item.id,
      memory_layer: "L1",
      project_id: input.projectId ?? (
        projectFromCoreItem(item)
          ? canonicalCoreProjects.get(projectFromCoreItem(item)!) ?? projectFromCoreItem(item)!
          : null
      ),
      timestamp: item.createdAt ?? item.updatedAt ?? null,
      updated_at: item.updatedAt ?? item.createdAt ?? null
    }));
  const incompleteCaptures = captureItems.filter((item) => !item.ingested).length;
  const visibleRawTurns = rawTurns.filter((item) => !consumedRawTurnIds.has(String(item.rawTurnId ?? "")));
  const incompleteRawTurns = visibleRawTurns.filter((item) => item.status !== "succeeded").length;
  const completeRawTurns = visibleRawTurns.length - incompleteRawTurns;
  const items = [...captures, ...visibleRawTurns, ...legacyCoreItems]
    .sort((left, right) => timestampOf(right).localeCompare(timestampOf(left)))
    .slice(0, limit);
  const visibleStats = input.projectId ? null : await l1OverviewStats(input);
  return {
    items,
    total: visibleStats?.total ?? (corePayloads.reduce((sum, payload) => sum + payload.total, 0) + rawTurnPayloads.reduce((sum, payload) => sum + payload.total, 0) + incompleteCaptures - consumedRawTurnIds.size),
    page_limit: limit,
    counts: visibleStats?.counts ?? {
      complete: corePayloads.reduce((sum, payload) => sum + payload.total, 0) + completeRawTurns,
      incomplete: incompleteCaptures + incompleteRawTurns,
      memory_records: corePayloads.reduce((sum, payload) => sum + payload.total, 0),
      raw_turns: rawTurnPayloads.reduce((sum, payload) => sum + payload.total, 0),
      captures: captureItems.length
    }
  };
}

function dedupeCaptureTurns<T extends { event_id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.event_id)) continue;
    seen.add(item.event_id);
    result.push(item);
  }
  return result;
}

function dedupeRawTurns(items: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const result: Record<string, unknown>[] = [];
  for (const item of items) {
    const id = stringValue(item.rawTurnId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function coreL1Payload(
  input: MemoryControlRequest,
  projectId: string | undefined,
  limit: number
): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const items: Record<string, unknown>[] = [];
  let total = 0;
  const pageSize = Math.max(1, Math.min(100, Math.trunc(limit)));
  for (let page = 1; items.length < limit && page <= 100; page += 1) {
    const params = new URLSearchParams({
      limit: String(pageSize),
      page: String(page),
      userId: input.runtime.userId
    });
    if (projectId) params.set("projectId", projectId);
    const payload = objectRecord(await input.runtime.memoryClient.viewerGet(`/api/v1/l1?${params.toString()}`));
    if (page === 1) total = totalValue(payload);
    const pageItems = Array.isArray(payload.items) ? payload.items.map(objectRecord) : [];
    items.push(...pageItems);
    if (payload.hasNext !== true || pageItems.length === 0) break;
  }
  return { items: items.slice(0, limit), total };
}

async function coreL1Count(input: MemoryControlRequest, projectId: string | undefined): Promise<number> {
  const params = new URLSearchParams({ limit: "1", page: "1", userId: input.runtime.userId });
  if (projectId) params.set("projectId", projectId);
  const payload = objectRecord(await input.runtime.memoryClient.viewerGet(`/api/v1/l1?${params.toString()}`));
  return totalValue(payload);
}

async function coreRawTurnPayload(
  input: MemoryControlRequest,
  projectId: string | undefined,
  limit: number
): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const items: Record<string, unknown>[] = [];
  let total = 0;
  const pageSize = Math.max(1, Math.min(100, Math.trunc(limit)));
  for (let page = 1; items.length < limit && page <= 100; page += 1) {
    const params = new URLSearchParams({
      limit: String(pageSize),
      page: String(page),
      userId: input.runtime.userId
    });
    if (projectId) params.set("projectId", projectId);
    const payload = objectRecord(await input.runtime.memoryClient.viewerGet(`/api/v1/raw-turns?${params.toString()}`));
    if (page === 1) total = totalValue(payload);
    const pageItems = Array.isArray(payload.items) ? payload.items.map(objectRecord) : [];
    items.push(...pageItems);
    if (payload.hasNext !== true || pageItems.length === 0) break;
  }
  return { items: items.slice(0, limit), total };
}

async function coreRawTurnStats(input: MemoryControlRequest, projectId: string | undefined): Promise<{
  total: number;
  succeeded: number;
  captureManaged: number;
  captureManagedSucceeded: number;
}> {
  const params = new URLSearchParams({ limit: "1", page: "1", userId: input.runtime.userId });
  if (projectId) params.set("projectId", projectId);
  const payload = objectRecord(await input.runtime.memoryClient.viewerGet(`/api/v1/raw-turns?${params.toString()}`));
  const stats = objectRecord(payload.stats);
  return {
    total: Number(stats.total ?? totalValue(payload)),
    succeeded: Number(stats.succeeded ?? totalValue(payload)),
    captureManaged: Number(stats.captureManaged ?? 0),
    captureManagedSucceeded: Number(stats.captureManagedSucceeded ?? 0)
  };
}

async function coreLayerPayload(
  input: MemoryControlRequest,
  kind: "l2" | "l3" | "l4" | "skills",
  hydrateBody = true
): Promise<unknown> {
  const archivedProjectKeys = !input.projectId && kind !== "l4" ? await archivedProjectKeySet(input) : new Set<string>();
  const archivedStorageIds = !input.projectId && kind !== "l4" ? await archivedProjectStorageIds(input) : [];
  let payload: Record<string, unknown> = {};
  let items: Record<string, unknown>[] = [];
  for (let page = 1; page <= 100 && items.length < 100; page += 1) {
    const params = new URLSearchParams({
      limit: "100",
      page: String(page),
      userId: input.runtime.userId
    });
    if (input.projectId && kind !== "l4") params.set("projectId", input.projectId);
    if (kind === "skills") params.set("status", "activated");
    if (hydrateBody && kind !== "skills") params.set("includeBody", "1");
    const pagePayload = objectRecord(await input.runtime.memoryClient.viewerGet(`/api/v1/${kind}?${params.toString()}`));
    if (page === 1) payload = pagePayload;
    const pageItems = Array.isArray(pagePayload.items) ? pagePayload.items.map(objectRecord) : [];
    items.push(...pageItems.filter((item) => !isArchivedProjectRef(projectFromCoreItem(item), archivedProjectKeys)));
    if (pagePayload.hasNext !== true || pageItems.length === 0 || !hydrateBody) break;
  }
  items = items.slice(0, 100);
  let visibleTotal = totalValue(payload);
  if (archivedStorageIds.length > 0) {
    const archivedTotals = await Promise.all(archivedStorageIds.map(async (projectId) => {
      const params = new URLSearchParams({ limit: "1", page: "1", userId: input.runtime.userId, projectId });
      if (kind === "skills") params.set("status", "activated");
      return totalValue(await input.runtime.memoryClient.viewerGet(`/api/v1/${kind}?${params.toString()}`));
    }));
    visibleTotal = Math.max(0, visibleTotal - archivedTotals.reduce((sum, total) => sum + total, 0));
  }
  return { ...payload, items, total: visibleTotal };
}

async function processingPayload(input: MemoryControlRequest): Promise<unknown> {
  const [allJobs, config] = await Promise.all([
    listControlPlaneJobs(input.stateRoot, input.runtime.accountId),
    getDistillationConfig(input.stateRoot)
  ]);
  const items = await visibleControlPlaneJobs(input, allJobs);
  return {
    items,
    total: items.length,
    config,
    counts: {
      pending: items.filter((job) => job.status === "pending").length,
      leased: items.filter((job) => job.status === "leased").length,
      completed: items.filter((job) => job.status === "completed").length,
      failed: items.filter((job) => job.status === "failed").length
    }
  };
}

async function listControlPlaneJobs(stateRoot: string, accountId: string): Promise<ControlPlaneJob[]> {
  const root = resolve(stateRoot);
  const path = join(root, "distillation", "jobs.json");
  let fingerprint = "missing";
  try {
    const info = await stat(path);
    fingerprint = `${info.ino}:${info.size}:${info.mtimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }

  const cacheKey = `${root}:${accountId}`;
  const cached = jobSummaryCache.get(cacheKey);
  if (cached?.fingerprint === fingerprint) return cached.items;

  const jobs = await listDistillationJobs(stateRoot, accountId);
  const items = jobs.map((job) => {
    const { evidence: _evidence, result_content: _resultContent, ...rest } = job;
    return {
      ...rest,
      evidence_refs: [...job.evidence_refs],
      evidence_count: job.evidence_refs.length
    };
  });
  jobSummaryCache.set(cacheKey, { fingerprint, items });
  return items;
}

function overviewProjectItems(projects: ProjectDescriptor[]): Record<string, unknown>[] {
  return projects.map((project) => {
    const pendingTodos = (project.todos ?? []).filter((todo) => todo.status === "pending");
    return {
      id: project.projectId,
      project_id: project.projectId,
      title: project.name || project.projectId,
      description: project.description,
      status: project.state,
      updated_at: project.updatedAt,
      pending_todos: pendingTodos,
      pending_todo_count: pendingTodos.length
    };
  });
}

function overviewLayerItems(items: Record<string, unknown>[]): Record<string, unknown>[] {
  return items.map((item) => {
    const projectId = projectFromCoreItem(item);
    return {
      id: item.id,
      ...(projectId ? { project_id: projectId } : {}),
      ...(typeof item.title === "string" ? { title: item.title } : {}),
      ...(typeof item.summary === "string" ? { summary: item.summary } : {}),
      ...(typeof item.updatedAt === "string" ? { updatedAt: item.updatedAt } : {}),
      ...(typeof item.updated_at === "string" ? { updated_at: item.updated_at } : {}),
      ...(typeof item.createdAt === "string" ? { createdAt: item.createdAt } : {})
    };
  });
}

function projectPayload(projects: ProjectDescriptor[]): { items: Record<string, unknown>[]; total: number } {
  const items = projects.map((project) => ({
    id: project.projectId,
    title: project.name || project.projectId,
    project_id: project.projectId,
    description: project.description,
    description_source: project.descriptionSource ?? (project.description ? "legacy" : "empty"),
    distilled_description: project.distilledDescription ?? null,
    description_evidence_refs: project.descriptionEvidenceRefs ?? [],
    description_updated_at: project.descriptionUpdatedAt ?? null,
    todos: project.todos ?? [],
    pending_todos: (project.todos ?? []).filter((todo) => todo.status === "pending"),
    pending_todo_count: (project.todos ?? []).filter((todo) => todo.status === "pending").length,
    aliases: project.aliases,
    status: project.state,
    updated_at: project.updatedAt
  }));
  return { items, total: items.length };
}

async function archivedProjectStorageIds(input: MemoryControlRequest): Promise<string[]> {
  const archived = (await input.runtime.projects.list(input.runtime.accountId, { includeInactive: true }))
    .filter((project) => project.state === "archived");
  const storageIds = await Promise.all(archived.map((project) =>
    input.runtime.projects.storageIds(input.runtime.accountId, project.projectId)
  ));
  return [...new Set(storageIds.flat())];
}

async function archivedProjectKeySet(input: MemoryControlRequest): Promise<Set<string>> {
  const archived = (await input.runtime.projects.list(input.runtime.accountId, { includeInactive: true }))
    .filter((project) => project.state === "archived");
  const storageIds = await Promise.all(archived.map((project) =>
    input.runtime.projects.storageIds(input.runtime.accountId, project.projectId)
  ));
  return new Set([
    ...archived.flatMap((project) => [project.projectId, project.name, ...project.aliases]),
    ...storageIds.flat()
  ].map(normalizeProjectKey));
}

function isArchivedProjectRef(projectRef: string | null | undefined, archivedProjectKeys: Set<string>): boolean {
  return Boolean(projectRef && archivedProjectKeys.has(normalizeProjectKey(projectRef)));
}

async function visibleControlPlaneJobs(input: MemoryControlRequest, jobs: ControlPlaneJob[]): Promise<ControlPlaneJob[]> {
  if (input.projectId) return jobs.filter((job) => job.project_id === input.projectId);
  const archivedProjectKeys = await archivedProjectKeySet(input);
  return jobs.filter((job) => !isArchivedProjectRef(job.project_id, archivedProjectKeys));
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function dedupeRecords(items: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const result: Record<string, unknown>[] = [];
  for (const item of items) {
    const id = typeof item.id === "string" ? item.id : JSON.stringify(item);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

function projectFromCoreItem(item: Record<string, unknown>): string | undefined {
  if (typeof item.projectId === "string" && item.projectId.trim()) return item.projectId.trim();
  const tags = Array.isArray(item.tags) ? item.tags : [];
  for (const tag of tags) {
    if (typeof tag !== "string" || !tag.startsWith("project:")) continue;
    const value = tag.slice("project:".length).trim();
    if (value) return value;
  }
  return undefined;
}

function timestampOf(item: Record<string, unknown>): string {
  for (const key of ["timestamp", "updated_at", "updatedAt", "created_at", "createdAt"] as const) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function itemsValue(value: unknown): Record<string, unknown>[] {
  const record = objectRecord(value);
  return Array.isArray(record.items) ? record.items.map(objectRecord) : [];
}

function totalValue(value: unknown): number {
  const record = objectRecord(value);
  if (typeof record.total === "number" && Number.isFinite(record.total)) return record.total;
  return Array.isArray(record.items) ? record.items.length : 0;
}
