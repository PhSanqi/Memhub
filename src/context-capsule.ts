import type { ProjectScopeResolution } from "./project-scope.js";

export type ContextAuthority = "remembered" | "authoritative" | "observed";
export type ContextScope = "global" | "project" | "conversation" | "capability";

export interface ContextItem {
  id: string;
  content: string;
  authority: ContextAuthority;
  scope: ContextScope;
  source: string;
  projectId?: string;
  createdAt?: string;
  updatedAt?: string;
  provenance?: Record<string, unknown>;
}

export interface ContextCapsuleInput {
  accountId: string;
  conversationId?: string;
  resolution: ProjectScopeResolution;
  globalMemory?: readonly ContextItem[];
  projectMemory?: readonly ContextItem[];
  reusableSkills?: readonly ContextItem[];
  projectArchitecture?: readonly ContextItem[];
  recentSession?: readonly ContextItem[];
}

export interface ContextCapsule {
  accountId: string;
  conversationId: string | null;
  resolvedProjectId: string | null;
  resolutionSource: ProjectScopeResolution["source"];
  recallScope: ProjectScopeResolution["recallScope"];
  globalMemory: ContextItem[];
  projectMemory: ContextItem[];
  reusableSkills: ContextItem[];
  projectArchitecture: ContextItem[];
  recentSession: ContextItem[];
  ambiguities: string[];
}

/**
 * Build the host-facing context envelope after project resolution.
 *
 * This is deliberately defensive: callers may pass broader candidate data,
 * but project-scoped items are only emitted for the one resolved project.
 * Ambiguous/no-project requests therefore cannot accidentally leak context
 * from another project into the model prompt.
 */
export function buildContextCapsule(input: ContextCapsuleInput): ContextCapsule {
  const accountId = requireNonEmpty(input.accountId, "accountId");
  const resolvedProjectId = input.resolution.projectId;

  const globalMemory = filterItems(input.globalMemory, (item) => item.scope === "global");
  const recentSession = filterItems(input.recentSession, (item) => item.scope === "conversation");
  const reusableSkills = filterItems(input.reusableSkills, (item) =>
    item.scope === "capability" && item.authority === "remembered");

  const allowProject = input.resolution.recallScope === "global_and_project" && resolvedProjectId !== null;
  const projectMemory = allowProject
    ? filterItems(input.projectMemory, (item) =>
        item.scope === "project" && item.projectId === resolvedProjectId && item.authority === "remembered")
    : [];
  const projectArchitecture = allowProject
    ? filterItems(input.projectArchitecture, (item) =>
        item.scope === "project" && item.projectId === resolvedProjectId && item.authority === "authoritative")
    : [];

  return {
    accountId,
    conversationId: normalizeOptional(input.conversationId) ?? null,
    resolvedProjectId,
    resolutionSource: input.resolution.source,
    recallScope: input.resolution.recallScope,
    globalMemory,
    projectMemory,
    reusableSkills,
    projectArchitecture,
    recentSession,
    ambiguities: input.resolution.source === "ambiguous"
      ? [...input.resolution.candidates]
      : []
  };
}

function filterItems(
  items: readonly ContextItem[] | undefined,
  predicate: (item: ContextItem) => boolean
): ContextItem[] {
  return (items ?? [])
    .filter(isValidContextItem)
    .filter(predicate)
    .map((item) => ({ ...item }));
}

function isValidContextItem(item: ContextItem): boolean {
  return Boolean(item.id.trim()) && Boolean(item.content.trim()) && Boolean(item.source.trim());
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be non-empty`);
  return normalized;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
