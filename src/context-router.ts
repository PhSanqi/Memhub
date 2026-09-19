import { buildContextCapsule, type ContextCapsule } from "./context-capsule.js";
import { resolveProjectScope, type ProjectScopeResolution } from "./project-scope.js";
import type { ProjectArchitectureSource } from "./architecture-source.js";
import type { ConversationProjectBindingStore } from "./binding-store.js";
import type { ContextMemorySource } from "./memory-source.js";

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
  limit?: number;
}

export class ContextRouter {
  constructor(
    private readonly memory: ContextMemorySource,
    private readonly architecture: ProjectArchitectureSource,
    private readonly bindings: ConversationProjectBindingStore
  ) {}

  async context(input: ContextRouterInput): Promise<ContextCapsule> {
    const accountId = requireNonEmpty(input.accountId, "accountId");
    const userId = requireNonEmpty(input.userId, "userId");
    const query = requireNonEmpty(input.query, "query");
    const conversationId = normalizeOptional(input.conversationId);
    const explicitProjectId = normalizeOptional(input.projectId);
    const workspaceProjectId = normalizeOptional(input.workspaceProjectId);
    const availableProjects = uniqueProjectIds([
      ...await this.architecture.listProjects(accountId),
      ...(input.knownProjectIds ?? [])
    ]);
    const aliases = exactProjectMentions(query, availableProjects);
    const semanticProjectIds = availableProjects.length > 0
      ? uniqueProjectIds(input.semanticProjectIds ?? []).filter((projectId) => availableProjects.includes(projectId))
      : uniqueProjectIds(input.semanticProjectIds ?? []);
    const priorBinding = conversationId && !explicitProjectId
      ? await this.bindings.get(accountId, conversationId)
      : null;

    const resolution = resolveRouterProjectScope({
      explicitProjectId,
      workspaceProjectId,
      conversationProjectId: priorBinding?.projectId,
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

    const limit = Math.min(50, Math.max(1, Math.trunc(input.limit ?? 12)));
    const recalled = await this.memory.recall({
      accountId,
      userId,
      query,
      projectId: resolution.projectId,
      conversationId,
      limit,
      reusableSkillProjectIds: uniqueProjectIds(input.reusableSkillProjectIds ?? [])
    });
    const projectArchitecture = resolution.projectId
      ? await this.architecture.getProjectArchitecture({
          accountId,
          projectId: resolution.projectId,
          query
        })
      : [];

    return buildContextCapsule({
      accountId,
      conversationId,
      resolution,
      globalMemory: recalled.globalMemory,
      projectMemory: recalled.projectMemory,
      reusableSkills: recalled.reusableSkills,
      projectArchitecture,
      recentSession: []
    });
  }

  async currentProject(accountId: string, conversationId: string): Promise<string | null> {
    return (await this.bindings.get(accountId, conversationId))?.projectId ?? null;
  }

  async bindProject(accountId: string, conversationId: string, projectId: string): Promise<void> {
    const projects = await this.architecture.listProjects(accountId);
    if (projects.length > 0 && !projects.includes(projectId)) {
      throw new Error(`unknown project for account: ${projectId}`);
    }
    await this.bindings.bind(accountId, conversationId, projectId);
  }

  async bindObservedProject(accountId: string, conversationId: string, projectId: string): Promise<void> {
    await this.bindings.bind(
      requireNonEmpty(accountId, "accountId"),
      requireNonEmpty(conversationId, "conversationId"),
      requireNonEmpty(projectId, "projectId")
    );
  }

  unbindProject(accountId: string, conversationId: string): Promise<boolean> {
    return this.bindings.unbind(accountId, conversationId);
  }

  listProjects(accountId: string): Promise<string[]> {
    return this.architecture.listProjects(accountId);
  }

  projectArchitecture(accountId: string, projectId: string, query: string) {
    return this.architecture.getProjectArchitecture({ accountId, projectId, query });
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

function exactProjectMentions(query: string, projects: readonly string[]): string[] {
  const lower = query.toLocaleLowerCase();
  return projects.filter((project) => {
    const candidate = project.trim().toLocaleLowerCase();
    if (!candidate) return false;
    const index = lower.indexOf(candidate);
    if (index < 0) return false;
    const before = index === 0 ? "" : lower[index - 1]!;
    const after = index + candidate.length >= lower.length ? "" : lower[index + candidate.length]!;
    return !isWordChar(before) && !isWordChar(after);
  });
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
