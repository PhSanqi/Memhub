import { listDistillationJobs } from "./distillation-jobs.js";
import { listL1Turns } from "./turn-log.js";
import type { MemhubRuntime } from "./runtime.js";
import type { ProjectDescriptor } from "./project-registry.js";

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
}

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
  const [turns, l2, l3, l4, skills, jobs] = await Promise.all([
    listL1Turns({
      stateRoot: input.stateRoot,
      accountId: input.runtime.accountId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      limit: 500
    }),
    coreLayerPayload(input, "l2"),
    coreLayerPayload(input, "l3"),
    coreLayerPayload(input, "l4"),
    coreLayerPayload(input, "skills"),
    listDistillationJobs(input.stateRoot, input.runtime.accountId)
  ]);
  const scopedProjects = input.projectId
    ? input.projects.filter((project) => project.projectId === input.projectId)
    : input.projects;
  const relevantJobs = jobs.filter((job) => !input.projectId || job.project_id === input.projectId);
  return {
    counts: {
      projects: scopedProjects.length,
      L1: turns.length,
      L2: totalValue(l2),
      L3: totalValue(l3),
      L4: totalValue(l4),
      Skill: totalValue(skills)
    },
    l1: {
      complete: turns.filter((turn) => turn.status === "complete").length,
      incomplete: turns.filter((turn) => turn.status !== "complete").length
    },
    processing: {
      pending: relevantJobs.filter((job) => job.status === "pending").length,
      leased: relevantJobs.filter((job) => job.status === "leased").length,
      failed: relevantJobs.filter((job) => job.status === "failed").length
    },
    account_id: input.runtime.accountId,
    project_id: input.projectId ?? null
  };
}

async function l1Payload(input: MemoryControlRequest): Promise<unknown> {
  const items = await listL1Turns({
    stateRoot: input.stateRoot,
    accountId: input.runtime.accountId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    limit: 500
  });
  return { items, total: items.length };
}

async function coreLayerPayload(
  input: MemoryControlRequest,
  kind: "l2" | "l3" | "l4" | "skills"
): Promise<unknown> {
  const params = new URLSearchParams({
    limit: "100",
    userId: input.runtime.userId
  });
  if (input.projectId && kind !== "l4") params.set("projectId", input.projectId);
  return input.runtime.memoryClient.viewerGet(`/api/v1/${kind}?${params.toString()}`);
}

async function processingPayload(input: MemoryControlRequest): Promise<unknown> {
  const items = (await listDistillationJobs(input.stateRoot, input.runtime.accountId))
    .filter((job) => !input.projectId || job.project_id === input.projectId);
  return {
    items,
    total: items.length,
    counts: {
      pending: items.filter((job) => job.status === "pending").length,
      leased: items.filter((job) => job.status === "leased").length,
      completed: items.filter((job) => job.status === "completed").length,
      failed: items.filter((job) => job.status === "failed").length
    }
  };
}

function projectPayload(projects: ProjectDescriptor[]): unknown {
  const items = projects.map((project) => ({
    id: project.projectId,
    title: project.name || project.projectId,
    project_id: project.projectId,
    description: project.description,
    aliases: project.aliases,
    status: project.state,
    updated_at: project.updatedAt
  }));
  return { items, total: items.length };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function totalValue(value: unknown): number {
  const record = objectRecord(value);
  if (typeof record.total === "number" && Number.isFinite(record.total)) return record.total;
  return Array.isArray(record.items) ? record.items.length : 0;
}
