import { buildContextCapsule, utf8Prefix, type ContextCapsule } from "./context-capsule.js";
import { resolveProjectScope, type ProjectScopeResolution } from "./project-scope.js";
import { NullProjectArchitectureSource, type ProjectArchitectureSource } from "./architecture-source.js";
import type { JsonProjectBranchStore, ProjectBranch } from "./branch-store.js";
import type { ContextMemorySource } from "./memory-source.js";
import type { JsonProjectRegistry, ProjectDescriptor, ProjectTodo } from "./project-registry.js";
import { tokenizeRetrievalText } from "./retrieval-ranker.js";
import type { MemhubRuntime } from "./runtime.js";

export interface ContextRouterInput {
  accountId: string;
  userId: string;
  query: string;
  conversationId?: string;
  continuityId?: string;
  projectId?: string;
  workspaceProjectId?: string;
  semanticProjectIds?: string[];
  knownProjectIds?: string[];
  reusableSkillProjectIds?: string[];
  branchId?: string;
  limit?: number;
  detail?: "brief" | "full";
  maxContentBytes?: number;
  maxItemContentBytes?: number;
}

export class ContextRouter {
  private readonly memory: ContextMemorySource;
  private readonly architecture: ProjectArchitectureSource;
  private readonly projects?: JsonProjectRegistry;
  private readonly branches?: JsonProjectBranchStore;

  constructor(
    memory: ContextMemorySource,
    architecture: ProjectArchitectureSource = new NullProjectArchitectureSource(),
    projects?: JsonProjectRegistry,
    branches?: JsonProjectBranchStore
  ) {
    this.memory = memory;
    this.architecture = architecture;
    this.projects = projects;
    this.branches = branches;
  }

  async context(input: ContextRouterInput): Promise<ContextCapsule> {
    const accountId = requireNonEmpty(input.accountId, "accountId");
    const userId = requireNonEmpty(input.userId, "userId");
    const query = requireNonEmpty(input.query, "query");
    // Host conversation identifiers are provenance only. Project selection must
    // come from the current request/workspace (or an explicit semantic/alias
    // match), not from a durable chat-window binding.
    const conversationId = normalizeOptional(input.conversationId);
    const continuityId = normalizeOptional(input.continuityId);
    const projectRecords = this.projects
      ? await this.projects.list(accountId)
      : uniqueProjectIds([
          ...await this.architecture.listProjects(accountId),
          ...(input.knownProjectIds ?? [])
        ]).map((projectId) => ({
          projectId,
          name: projectId,
          description: "",
          aliases: [],
          state: "active" as const,
          createdAt: "",
          updatedAt: ""
        }));
    const availableProjects = projectRecords.map((project) => project.projectId);
    const requestedProjectId = normalizeOptional(input.projectId);
    const requestedWorkspaceProjectId = normalizeOptional(input.workspaceProjectId);
    const explicitProjectId = await this.canonicalize(accountId, requestedProjectId, true);
    const workspaceProjectId = await this.canonicalize(accountId, requestedWorkspaceProjectId, true);
    const aliases = exactProjectMentions(query, projectRecords);
    const semanticProjectIds = availableProjects.length > 0
      ? uniqueProjectIds(await Promise.all((input.semanticProjectIds ?? []).map((projectId) => this.canonicalize(accountId, projectId, true))))
          .filter((projectId) => availableProjects.includes(projectId))
      : uniqueProjectIds(await Promise.all((input.semanticProjectIds ?? []).map((projectId) => this.canonicalize(accountId, projectId, true))));
    const unresolvedCurrentTurnProject = Boolean(
      (requestedProjectId && !explicitProjectId) ||
      (requestedWorkspaceProjectId && !workspaceProjectId) ||
      ((input.semanticProjectIds?.length ?? 0) > 0 && semanticProjectIds.length === 0)
    );
    const resolution = unresolvedCurrentTurnProject
      ? {
          projectId: null,
          source: "ambiguous" as const,
          recallScope: "global_only" as const,
          candidates: [],
          evidence: ["unregistered current-turn project evidence; inspect project candidates before binding or creating"]
        }
      : resolveRouterProjectScope({
          explicitProjectId,
          workspaceProjectId,
          exactAliasProjectIds: aliases,
          semanticProjectIds
        });

    const branchContext = await this.resolveBranchContext({
      accountId,
      projectId: resolution.projectId,
      branchRef: normalizeOptional(input.branchId)
    });
    const retrievalQuery = branchContext
      ? `${query}\n\n[project branch]\nname: ${branchContext.branch.name}\ngoal: ${branchContext.branch.goal}`
      : query;
    const limit = Math.min(50, Math.max(1, Math.trunc(input.limit ?? 6)));
    const projectStorageIds = resolution.projectId && this.projects
      ? await this.projects.storageIds(accountId, resolution.projectId)
      : resolution.projectId ? [resolution.projectId] : [];
    const canonicalReusableSkillProjectIds = uniqueProjectIds(input.reusableSkillProjectIds ?? []);
    const reusableSkillProjectIds = this.projects
      ? uniqueProjectIds((await Promise.all(canonicalReusableSkillProjectIds.map((projectId) =>
          this.projects!.storageIds(accountId, projectId)
        ))).flat())
      : canonicalReusableSkillProjectIds;
    const recalled = await this.memory.recall({
      accountId,
      userId,
      query: retrievalQuery,
      projectId: resolution.projectId,
      projectStorageIds,
      continuityId,
      limit,
      reusableSkillProjectIds
    });
    if (this.projects && recalled.reusableSkills.length > 0) {
      recalled.reusableSkills = await Promise.all(recalled.reusableSkills.map(async (item) => ({
        ...item,
        ...(item.projectId
          ? { projectId: await this.projects!.resolve(accountId, item.projectId) ?? item.projectId }
          : {})
      })));
    }
    const projectArchitecture = resolution.projectId
      ? await this.projectArchitectureFromStorageIds(accountId, resolution.projectId, projectStorageIds, retrievalQuery)
      : [];
    return buildContextCapsule({
      accountId,
      conversationId,
      continuityId,
      resolution,
      globalMemory: recalled.globalMemory,
      projectMemory: recalled.projectMemory,
      reusableSkills: recalled.reusableSkills,
      projectArchitecture,
      retrievalDiagnostics: recalled.diagnostics,
      branchContext: branchContext ? {
        branchId: branchContext.branch.branchId,
        name: branchContext.branch.name,
        goal: branchContext.branch.goal,
        source: branchContext.source
      } : null,
      detail: input.detail,
      maxContentBytes: input.maxContentBytes,
      maxItemContentBytes: input.maxItemContentBytes,
      query: retrievalQuery
    });
  }

  private async resolveBranchContext(input: {
    accountId: string;
    projectId: string | null;
    branchRef?: string;
  }): Promise<{ branch: ProjectBranch; source: "explicit" } | null> {
    if (!this.branches) return null;
    if (input.branchRef && !input.projectId) {
      throw new Error("branch requires one resolved project");
    }
    if (input.branchRef && input.projectId) {
      const branch = await this.branches.resolve(input.accountId, input.projectId, input.branchRef);
      if (!branch) throw new Error(`unknown active branch for project ${input.projectId}: ${input.branchRef}`);
      return { branch, source: "explicit" };
    }
    return null;
  }

  async listProjects(accountId: string): Promise<string[]> {
    if (!this.projects) return this.architecture.listProjects(accountId);
    return (await this.projects.list(accountId)).map((project) => project.projectId);
  }

  projectArchitecture(accountId: string, projectId: string, query: string) {
    return this.projectArchitectureCanonical(accountId, projectId, query);
  }

  private async projectArchitectureCanonical(accountId: string, projectId: string, query: string) {
    const canonical = await this.canonicalize(accountId, projectId) ?? projectId;
    const storageIds = this.projects ? await this.projects.storageIds(accountId, canonical) : [canonical];
    return this.projectArchitectureFromStorageIds(accountId, canonical, storageIds, query);
  }

  private async projectArchitectureFromStorageIds(
    accountId: string,
    canonicalProjectId: string,
    storageIds: string[],
    query: string
  ) {
    for (const storageProjectId of uniqueProjectIds([canonicalProjectId, ...storageIds])) {
      const items = await this.architecture.getProjectArchitecture({
        accountId,
        projectId: storageProjectId,
        query
      });
      if (items.length > 0) return items.map((item) => ({ ...item, projectId: canonicalProjectId }));
    }
    return [];
  }

  private async canonicalize(accountId: string, projectId: string | undefined, strict = false): Promise<string | undefined> {
    const normalized = normalizeOptional(projectId);
    if (!normalized || !this.projects) return normalized;
    return await this.projects.resolve(accountId, normalized) ?? (strict ? undefined : normalized);
  }
}

function resolveRouterProjectScope(input: {
  explicitProjectId?: string;
  workspaceProjectId?: string;
  exactAliasProjectIds: string[];
  semanticProjectIds?: string[];
}): ProjectScopeResolution {
  if (input.explicitProjectId) {
    return resolveProjectScope({
      namespaceProjectId: input.explicitProjectId,
      workspaceProjectId: input.workspaceProjectId
    });
  }
  const aliases = uniqueProjectIds(input.exactAliasProjectIds);
  const semantic = uniqueProjectIds(input.semanticProjectIds ?? []);
  const turnCandidates = uniqueProjectIds([
    input.workspaceProjectId,
    ...aliases,
    ...semantic
  ]);
  if (turnCandidates.length > 1) {
    return {
      projectId: null,
      source: "ambiguous",
      recallScope: "global_only",
      candidates: turnCandidates,
      evidence: ["conflicting current-turn project evidence"]
    };
  }
  if (turnCandidates.length === 1) {
    const projectId = turnCandidates[0]!;
    if (input.workspaceProjectId === projectId) {
      return resolveProjectScope({ workspaceProjectId: projectId });
    }
    if (aliases.includes(projectId)) {
      return resolveProjectScope({ exactAliasProjectIds: [projectId] });
    }
    return resolveProjectScope({ semanticProjectIds: [projectId] });
  }
  return resolveProjectScope({});
}

function exactProjectMentions(query: string, projects: readonly ProjectDescriptor[]): string[] {
  const lower = query.toLocaleLowerCase();
  const matches: string[] = [];
  for (const project of projects) {
    const names = [project.projectId, project.name, ...project.aliases];
    if (names.some((value) => {
      const candidate = value.trim().toLocaleLowerCase();
      if (!candidate) return false;
      const index = lower.indexOf(candidate);
      if (index < 0) return false;
      const before = index === 0 ? "" : lower[index - 1]!;
      const after = index + candidate.length >= lower.length ? "" : lower[index + candidate.length]!;
      return !isWordChar(before) && !isWordChar(after);
    })) matches.push(project.projectId);
  }
  return uniqueProjectIds(matches);
}

function isWordChar(value: string): boolean {
  return /[\p{L}\p{N}_-]/u.test(value);
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be non-empty`);
  return normalized;
}

function uniqueProjectIds(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value)))]
    .sort((left, right) => left.localeCompare(right));
}

export async function resolveToolScope(
  runtime: MemhubRuntime,
  input: { scope: string; project?: string; workspaceProject?: string }
): Promise<{ projectId: string | null; resolutionSource: string }> {
  if (input.scope !== "global" && input.scope !== "project") {
    throw new TypeError("scope must be global or project");
  }
  if (input.scope === "global") {
    return {
      projectId: null,
      resolutionSource: "global"
    };
  }
  const explicitEvidence = await resolveExplicitProjectEvidence(runtime, {
    project: input.project,
    workspaceProject: input.workspaceProject
  });
  const projectId = explicitEvidence.projectId;
  const resolutionSource = explicitEvidence.resolutionSource ?? "unresolved";
  if (input.scope === "project" && projectId === null) {
    throw new Error("project scope requires explicit current workspace_project or project evidence");
  }
  return {
    projectId,
    resolutionSource
  };
}

export async function resolveExplicitProjectEvidence(
  runtime: MemhubRuntime,
  input: { project?: string; workspaceProject?: string }
): Promise<{ projectId: string | null; resolutionSource: string | null }> {
  const projectRef = input.project?.trim() || undefined;
  const workspaceRef = input.workspaceProject?.trim() || undefined;
  if (!projectRef && !workspaceRef) return { projectId: null, resolutionSource: null };
  await runtime.projects.list(runtime.accountId);

  const resolveOne = async (reference: string, field: string): Promise<string> => {
    const canonical = await runtime.projects.resolve(runtime.accountId, reference);
    if (canonical) return canonical;
    const candidates = await runtime.projects.suggest(runtime.accountId, reference, 5);
    throw new Error(`unknown ${field} "${reference}". Use memmy_project_list before project-scoped operations. Similar: ${candidates.map((item) => item.projectId).join(", ") || "none"}`);
  };

  const explicit = projectRef ? await resolveOne(projectRef, "project") : null;
  const workspace = workspaceRef ? await resolveOne(workspaceRef, "workspace_project") : null;
  if (explicit && workspace && explicit !== workspace) {
    throw new Error(`project/workspace conflict: project resolves to "${explicit}" but workspace_project resolves to "${workspace}"`);
  }
  return {
    projectId: workspace ?? explicit,
    resolutionSource: workspace && explicit
      ? "workspace_and_project"
      : workspace
        ? "workspace_project"
        : "explicit_project"
  };
}

export function relevantProjectTodos(
  todos: readonly ProjectTodo[] | undefined,
  query: string,
  limit = 1,
  maxTextBytes = 2000
): Array<{
  id: string;
  text: string;
  status: ProjectTodo["status"];
  completedAt?: string;
  matchedTerms: string[];
}> {
  const queryTerms = (uniqueStrings(tokenizeRetrievalText(query)) ?? []).slice(0, 32);
  const todoList = todos ?? [];
  if (queryTerms.length === 0 || todoList.length === 0) return [];
  const scored = todoList
    .map((todo) => {
      const todoTerms = new Set(tokenizeRetrievalText(todo.text));
      const matchedTerms = queryTerms.filter((term) => todoTerms.has(term));
      return { todo, matchedTerms, score: matchedTerms.length };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      Number(right.todo.status === "pending") - Number(left.todo.status === "pending") ||
      right.todo.updatedAt.localeCompare(left.todo.updatedAt)
    );
  const topScore = scored[0]?.score ?? 0;
  const minimumScore = queryTerms.length <= 2 ? 1 : Math.max(2, Math.ceil(topScore * 0.4));
  return scored
    .filter((item) => item.score >= minimumScore)
    .slice(0, limit)
    .map(({ todo, matchedTerms }) => {
      const text = Buffer.byteLength(todo.text, "utf8") <= maxTextBytes
        ? todo.text
        : utf8Prefix(todo.text, maxTextBytes);
      return {
        id: todo.id,
        text,
        status: todo.status,
        ...(todo.completedAt ? { completedAt: todo.completedAt } : {}),
        matchedTerms
      };
    });
}

function uniqueStrings(values: string[]): string[] | undefined {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return normalized.length ? [...new Set(normalized)] : undefined;
}
