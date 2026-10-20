import { randomUUID } from "node:crypto";
import { listDistillationJobs, type DistillationJob } from "./distillation-jobs.js";
import type { ProjectDescriptor } from "./project-registry.js";
import type { MemhubRuntime } from "./runtime.js";

/**
 * Project Registry governance: plan -> explicit user authorization -> execute.
 * The authorization map is process-affine and one-shot, exactly like Skill and
 * Architecture governance; entries expire after one day.
 */
const projectMutationAuthorizations = new Map<string, {
  accountId: string;
  operation: "create" | "update" | "archive" | "unarchive" | "delete" | "merge";
  payload: Record<string, unknown>;
  expiresAt: number;
}>();

export async function planProjectMutation(input: {
  stateRoot: string;
  runtime: MemhubRuntime;
  args: Record<string, unknown>;
  projectForModel: (project: ProjectDescriptor) => Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const { stateRoot, runtime, args, projectForModel } = input;
  await runtime.projects.list(runtime.accountId);
  const operation = requiredString(args.operation, "operation");
  if (!["create", "update", "archive", "unarchive", "delete", "merge"].includes(operation)) throw new TypeError("unsupported project management operation");
  const project = requiredString(args.project, "project");
  const payload: Record<string, unknown> = { project };
  let impact: Record<string, unknown>;

  if (operation === "create") {
    const description = requiredString(args.description, "description");
    if (await runtime.projects.resolve(runtime.accountId, project)) {
      throw new Error(`project already exists or aliases to an existing project: ${project}`);
    }
    payload.description = description;
    if (optionalString(args.name)) payload.name = optionalString(args.name);
    if (stringArray(args.aliases)) payload.aliases = stringArray(args.aliases);
    impact = {
      createsCanonicalProject: project,
      similarProjects: (await runtime.projects.suggest(runtime.accountId, project, 6)).map(projectForModel),
      requiresDescription: true
    };
  } else {
    const canonical = operation === "unarchive"
      ? await runtime.projects.resolve(runtime.accountId, project, { includeArchived: true })
      : await runtime.projects.resolve(runtime.accountId, project);
    if (!canonical) throw new Error(`unknown or inactive project: ${project}`);
    payload.project = canonical;
    if (operation === "update") {
      const hasName = typeof args.name === "string";
      const hasDescription = typeof args.description === "string";
      const hasAliases = Array.isArray(args.aliases);
      if (!hasName && !hasDescription && !hasAliases) throw new TypeError("update requires name, description, or aliases");
      if (hasName && !String(args.name).trim()) throw new TypeError("name must be a non-empty string");
      if (hasAliases && (args.aliases as unknown[]).some((item) => typeof item !== "string" || !item.trim())) {
        throw new TypeError("aliases must contain only non-empty strings; use [] to clear aliases");
      }
      const current = (await runtime.projects.list(runtime.accountId)).find((item) => item.projectId === canonical);
      if (!current) throw new Error(`unknown or inactive project: ${canonical}`);
      const normalizedAliases = hasAliases ? stringArray(args.aliases) ?? [] : current.aliases;
      const sameAliases = [...normalizedAliases].sort().join("\u0000") === [...current.aliases].sort().join("\u0000");
      if ((!hasName || String(args.name).trim() === current.name) &&
          (!hasDescription || String(args.description).trim() === (current.manualDescription ?? "")) &&
          (!hasAliases || sameAliases)) {
        throw new TypeError("update has no effective changes; provide a different name, description, or aliases");
      }
      if (hasName) payload.name = String(args.name);
      if (hasDescription) payload.description = String(args.description);
      if (hasAliases) payload.aliases = stringArray(args.aliases) ?? [];
      impact = {
        project: canonical,
        stableCanonicalSlug: canonical,
        changesMetadataOnly: true
      };
    } else if (operation === "archive") {
      const blockers = (await unfinishedDistillationJobsForProject(stateRoot, runtime, canonical))
        .filter((job) => job.status === "pending" || job.status === "leased");
      const historicalFailed = (await unfinishedDistillationJobsForProject(stateRoot, runtime, canonical))
        .filter((job) => job.status === "failed");
      impact = {
        project: canonical,
        logicalArchive: true,
        memoryPurged: false,
        hiddenByDefault: true,
        restorable: true,
        blockedByDistillationJobs: blockers.map((job) => ({
          job_id: job.job_id,
          status: job.status,
          target: job.target
        })),
        preservedFailedDistillationJobs: historicalFailed.map((job) => ({
          job_id: job.job_id,
          status: job.status,
          target: job.target
        })),
        note: "All durable evidence, aliases and Todos remain stored. The project is removed from normal routing/list/UI until unarchived."
      };
    } else if (operation === "unarchive") {
      const current = (await runtime.projects.list(runtime.accountId, { includeInactive: true }))
        .find((item) => item.projectId === canonical);
      if (!current || current.state !== "archived") throw new Error(`project is not archived: ${project}`);
      impact = {
        project: canonical,
        restoresActiveRouting: true,
        memoryPreserved: true,
        aliasesPreserved: true,
        todosPreserved: true
      };
    } else if (operation === "delete") {
      const blockers = await unfinishedDistillationJobsForProject(stateRoot, runtime, canonical);
      impact = {
        project: canonical,
        logicalDelete: true,
        memoryPurged: false,
        blockedByDistillationJobs: blockers.map((job) => ({
          job_id: job.job_id,
          status: job.status,
          target: job.target
        })),
        note: "Existing durable evidence is retained; the project becomes unavailable for new routing/writes."
      };
    } else {
      const target = requiredString(args.target, "target");
      const canonicalTarget = await runtime.projects.resolve(runtime.accountId, target);
      if (!canonicalTarget) throw new Error(`unknown merge target: ${target}`);
      if (canonicalTarget === canonical) throw new Error("source and target already resolve to the same project");
      payload.target = canonicalTarget;
      impact = {
        source: canonical,
        target: canonicalTarget,
        logicalMerge: true,
        futureWritesUse: canonicalTarget,
        historicalAliasRecallPreserved: true,
        physicalMemoryRewrite: false
      };
    }
  }

  const authorizationId = randomUUID();
  // Project governance has the same human-in-the-loop approval boundary as
  // Skill governance; use the same one-day approval window. Execute remains
  // one-shot and validates the planned object before mutation.
  const expiresAt = Date.now() + 24 * 60 * 60_000;
  projectMutationAuthorizations.set(authorizationId, {
    accountId: runtime.accountId,
    operation: operation as "create" | "update" | "archive" | "unarchive" | "delete" | "merge",
    payload,
    expiresAt
  });
  return {
    status: "awaiting_user_authorization",
    operation,
    payload,
    impact,
    authorization_id: authorizationId,
    expires_at: new Date(expiresAt).toISOString(),
    instructions: "Show this plan to the user. Call action=execute with authorization_id only after the user explicitly approves this exact plan."
  };
}

export async function executeProjectMutation(input: {
  stateRoot: string;
  runtime: MemhubRuntime;
  args: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const { stateRoot, runtime, args } = input;
  const authorizationId = requiredString(args.authorization_id, "authorization_id");
  const authorization = projectMutationAuthorizations.get(authorizationId);
  if (!authorization || authorization.accountId !== runtime.accountId) throw new Error("invalid or already-used project authorization");
  projectMutationAuthorizations.delete(authorizationId);
  if (authorization.expiresAt < Date.now()) throw new Error("project authorization expired; create a new plan");
  const project = requiredString(authorization.payload.project, "project");
  let result: unknown;
  if (authorization.operation === "create") {
    result = await runtime.projects.create(runtime.accountId, {
      projectId: project,
      name: optionalString(authorization.payload.name),
      description: requiredString(authorization.payload.description, "description"),
      aliases: stringArray(authorization.payload.aliases)
    });
  } else if (authorization.operation === "update") {
    result = await runtime.projects.update(runtime.accountId, project, {
      ...(typeof authorization.payload.name === "string" ? { name: authorization.payload.name } : {}),
      ...(typeof authorization.payload.description === "string" ? { description: authorization.payload.description } : {}),
      ...(Array.isArray(authorization.payload.aliases) ? { aliases: stringArray(authorization.payload.aliases) ?? [] } : {})
    });
  } else if (authorization.operation === "archive") {
    const blockers = (await unfinishedDistillationJobsForProject(stateRoot, runtime, project))
      .filter((job) => job.status === "pending" || job.status === "leased");
    if (blockers.length > 0) {
      throw new Error(`project has ${blockers.length} active distillation job(s); complete or resolve them before archive`);
    }
    result = await runtime.projects.archive(runtime.accountId, project);
  } else if (authorization.operation === "unarchive") {
    result = await runtime.projects.unarchive(runtime.accountId, project);
  } else if (authorization.operation === "delete") {
    const blockers = await unfinishedDistillationJobsForProject(stateRoot, runtime, project);
    if (blockers.length > 0) {
      throw new Error(`project has ${blockers.length} unfinished distillation job(s); complete, skip, or resolve them before delete`);
    }
    result = await runtime.projects.delete(runtime.accountId, project);
  } else {
    result = await runtime.projects.merge(
      runtime.accountId,
      project,
      requiredString(authorization.payload.target, "target")
    );
  }
  return { ok: true, operation: authorization.operation, result };
}

export async function unfinishedDistillationJobsForProject(
  stateRoot: string,
  runtime: MemhubRuntime,
  projectId: string
): Promise<DistillationJob[]> {
  const jobs = await listDistillationJobs(stateRoot, runtime.accountId);
  const blockers: DistillationJob[] = [];
  for (const job of jobs) {
    if (job.scope !== "project" || !job.project_id || job.status === "completed") continue;
    const canonical = await runtime.projects.resolve(runtime.accountId, job.project_id);
    if (job.project_id === projectId || canonical === projectId) blockers.push(job);
  }
  return blockers;
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
