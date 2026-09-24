import { buildContextCapsule, type ContextCapsule } from "./context-capsule.js";
import { resolveProjectScope, type ProjectScopeResolution } from "./project-scope.js";
import { NullProjectArchitectureSource, type ProjectArchitectureSource } from "./architecture-source.js";
import type { ConversationProjectBindingStore } from "./binding-store.js";
import type { JsonProjectBranchStore, ProjectBranch } from "./branch-store.js";
import type { ContextMemorySource } from "./memory-source.js";
import type { JsonProjectRegistry, ProjectDescriptor } from "./project-registry.js";

export interface ContextRouterInput {
  accountId: string;
  userId: string;
  query: string;
  conversationId?: string;
  projectId?: string;
  workspaceProjectId?: string;
  semanticProjectIds?: string[];
  knownProjectIds?: string[];
  reusableSkillProjectIds?: string[];
  branchId?: string;
  limit?: number;
}

export class ContextRouter {
  private readonly memory: ContextMemorySource;
  private readonly architecture: ProjectArchitectureSource;
  private readonly bindings: ConversationProjectBindingStore;
  private readonly projects?: JsonProjectRegistry;
  private readonly branches?: JsonProjectBranchStore;

  constructor(
    memory: ContextMemorySource,
    bindings: ConversationProjectBindingStore,
    projects?: JsonProjectRegistry,
    branches?: JsonProjectBranchStore
  );
  constructor(
    memory: ContextMemorySource,
    architecture: ProjectArchitectureSource,
    bindings: ConversationProjectBindingStore,
    projects?: JsonProjectRegistry,
    branches?: JsonProjectBranchStore
  );
  constructor(
    memory: ContextMemorySource,
    architectureOrBindings: ProjectArchitectureSource | ConversationProjectBindingStore,
    bindingsOrProjects?: ConversationProjectBindingStore | JsonProjectRegistry,
    projectsOrBranches?: JsonProjectRegistry | JsonProjectBranchStore,
    branches?: JsonProjectBranchStore
  ) {
    this.memory = memory;
    if (isArchitectureSource(architectureOrBindings)) {
      this.architecture = architectureOrBindings;
      this.bindings = bindingsOrProjects as ConversationProjectBindingStore;
      this.projects = projectsOrBranches as JsonProjectRegistry | undefined;
      this.branches = branches;
    } else {
      this.architecture = new NullProjectArchitectureSource();
      this.bindings = architectureOrBindings;
      this.projects = bindingsOrProjects as JsonProjectRegistry | undefined;
      this.branches = projectsOrBranches as JsonProjectBranchStore | undefined;
    }
  }

  async context(input: ContextRouterInput): Promise<ContextCapsule> {
    const accountId = requireNonEmpty(input.accountId, "accountId");
    const userId = requireNonEmpty(input.userId, "userId");
    const query = requireNonEmpty(input.query, "query");
    const conversationId = normalizeOptional(input.conversationId);
    const rawAvailableProjects = uniqueProjectIds([
      ...await this.architecture.listProjects(accountId),
      ...(input.knownProjectIds ?? [])
    ]);
    const projectRecords = this.projects
      ? await this.projects.reconcile(accountId, rawAvailableProjects)
      : rawAvailableProjects.map((projectId) => ({
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
    const priorBinding = conversationId && !explicitProjectId && !unresolvedCurrentTurnProject
      ? await this.bindings.get(accountId, conversationId)
      : null;
    const conversationProjectId = await this.canonicalize(accountId, priorBinding?.projectId, true);

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
          conversationProjectId,
          exactAliasProjectIds: aliases,
          semanticProjectIds
        });

    const hasCurrentTurnProjectEvidence = Boolean(
      explicitProjectId || workspaceProjectId || aliases.length === 1 || semanticProjectIds.length === 1
    );
    if (
      conversationId &&
      resolution.projectId &&
      (hasCurrentTurnProjectEvidence || priorBinding === null || priorBinding.projectId === resolution.projectId)
    ) {
      await this.bindings.bind(accountId, conversationId, resolution.projectId);
    }

    const branchContext = await this.resolveBranchContext({
      accountId,
      projectId: resolution.projectId,
      conversationId,
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
      conversationId,
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
      resolution,
      globalMemory: recalled.globalMemory,
      projectMemory: recalled.projectMemory,
      reusableSkills: recalled.reusableSkills,
      projectArchitecture,
      recentSession: [],
      retrievalDiagnostics: recalled.diagnostics,
      branchContext: branchContext ? {
        branchId: branchContext.branch.branchId,
        name: branchContext.branch.name,
        goal: branchContext.branch.goal,
        source: branchContext.source
      } : null
    });
  }

  private async resolveBranchContext(input: {
    accountId: string;
    projectId: string | null;
    conversationId?: string;
    branchRef?: string;
  }): Promise<{ branch: ProjectBranch; source: "explicit" | "conversation_binding" } | null> {
    if (!this.branches) return null;
    if (input.branchRef && !input.projectId) {
      throw new Error("branch requires one resolved project");
    }
    if (input.branchRef && input.projectId) {
      const branch = await this.branches.resolve(input.accountId, input.projectId, input.branchRef);
      if (!branch) throw new Error(`unknown active branch for project ${input.projectId}: ${input.branchRef}`);
      if (input.conversationId) {
        await this.branches.bind(input.accountId, input.conversationId, input.projectId, branch.branchId);
      }
      return { branch, source: "explicit" };
    }
    if (!input.conversationId || !input.projectId) return null;
    const branch = await this.branches.current(input.accountId, input.conversationId, input.projectId);
    return branch ? { branch, source: "conversation_binding" } : null;
  }

  async currentProject(accountId: string, conversationId: string): Promise<string | null> {
    const bound = (await this.bindings.get(accountId, conversationId))?.projectId;
    if (!bound) return null;
    if (this.projects) {
      const discovered = await this.architecture.listProjects(accountId).catch(() => []);
      await this.projects.reconcile(accountId, [...discovered, bound]);
    }
    return await this.canonicalize(accountId, bound, true) ?? null;
  }

  async bindProject(accountId: string, conversationId: string, projectId: string): Promise<void> {
    const projects = await this.listProjects(accountId);
    const canonical = await this.canonicalize(accountId, projectId, true);
    if (!canonical || (projects.length > 0 && !projects.includes(canonical))) {
      throw new Error(`unknown project for account: ${projectId}`);
    }
    await this.bindings.bind(accountId, conversationId, canonical);
  }

  async bindObservedProject(accountId: string, conversationId: string, projectId: string): Promise<void> {
    const observed = requireNonEmpty(projectId, "projectId");
    if (this.projects) await this.projects.reconcile(accountId, [observed]);
    const canonical = await this.canonicalize(accountId, observed, true) ?? observed;
    await this.bindings.bind(
      requireNonEmpty(accountId, "accountId"),
      requireNonEmpty(conversationId, "conversationId"),
      canonical
    );
  }

  unbindProject(accountId: string, conversationId: string): Promise<boolean> {
    return this.bindings.unbind(accountId, conversationId);
  }

  async listProjects(accountId: string): Promise<string[]> {
    const discovered = await this.architecture.listProjects(accountId);
    if (!this.projects) return discovered;
    const existing = (await this.projects.list(accountId, { includeInactive: true })).map((project) => project.projectId);
    return (await this.projects.reconcile(accountId, [...existing, ...discovered])).map((project) => project.projectId);
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
  conversationProjectId?: string;
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
  return resolveProjectScope({
    conversationProjectId: input.conversationProjectId
  });
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

function isArchitectureSource(
  value: ProjectArchitectureSource | ConversationProjectBindingStore
): value is ProjectArchitectureSource {
  return typeof (value as ProjectArchitectureSource).listProjects === "function" &&
    typeof (value as ProjectArchitectureSource).getProjectArchitecture === "function";
}

function uniqueProjectIds(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value)))]
    .sort((left, right) => left.localeCompare(right));
}
