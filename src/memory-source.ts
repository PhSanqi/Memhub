import { createHash } from "node:crypto";
import type { ContextItem } from "./context-capsule.js";
import type { LocalMemoryRestClient, RecallHit, RuntimeNamespace } from "./local-memory-client.js";

interface SearchResponseLike {
  hits?: RecallHit[];
  debug?: {
    hits?: RecallHit[];
  };
}

export interface ContextMemorySource {
  recall(input: {
    accountId: string;
    userId: string;
    query: string;
    projectId: string | null;
    projectStorageIds?: readonly string[];
    conversationId?: string;
    limit: number;
    reusableSkillProjectIds?: readonly string[];
  }): Promise<{ globalMemory: ContextItem[]; projectMemory: ContextItem[]; reusableSkills: ContextItem[] }>;
  remember(input: {
    accountId: string;
    userId: string;
    content: string;
    projectId: string | null;
    conversationId?: string;
    title?: string;
    tags?: string[];
    provenance?: Record<string, string | undefined>;
    evidenceRefs?: string[];
    sourceConversations?: string[];
    confidence?: number;
    contractVersion?: string;
  }): Promise<unknown>;
}

export type DistilledArtifactKind = "skill" | "summary" | "knowledge";

export class MemoryRestContextSource implements ContextMemorySource {
  constructor(private readonly client: LocalMemoryRestClient) {}

  async recall(input: {
    accountId: string;
    userId: string;
    query: string;
    projectId: string | null;
    projectStorageIds?: readonly string[];
    conversationId?: string;
    limit: number;
    reusableSkillProjectIds?: readonly string[];
  }): Promise<{ globalMemory: ContextItem[]; projectMemory: ContextItem[]; reusableSkills: ContextItem[] }> {
    const globalResponse = await this.search(input, null);
    const globalHits = hitsFromResponse(globalResponse)
      .filter((hit) => hit.tags.includes("global"));
    const globalIds = new Set(globalHits.map((hit) => hit.id));
    const globalMemory = globalHits.map((hit) => contextItemFromHit(hit, "global"));
    const projectStorageIds = input.projectId === null
      ? []
      : unique(input.projectStorageIds?.length ? input.projectStorageIds : [input.projectId]);
    const projectMemory = input.projectId === null
      ? []
      : dedupeHits((await Promise.all(projectStorageIds.map(async (storageProjectId) =>
          hitsFromResponse(await this.search(input, storageProjectId))
            .filter((hit) => hit.tags.includes(`project:${storageProjectId}`))
        ))).flat())
          .filter((hit) => !globalIds.has(hit.id))
          .map((hit) => contextItemFromHit(hit, "project", input.projectId ?? undefined));

    const reusableSkillProjectIds = unique(input.reusableSkillProjectIds ?? [])
      .filter((projectId) => projectId !== input.projectId)
      .slice(0, 32);
    const perProjectSkillLimit = Math.min(20, Math.max(6, input.limit));
    const reusableHits = (await Promise.all(reusableSkillProjectIds.map(async (projectId) => {
      const response = await this.search(input, projectId, {
        layers: ["Skill"],
        tags: ["artifact:skill"],
        limit: perProjectSkillLimit
      });
      return hitsFromResponse(response)
        .filter((hit) => isReusableSkillHit(hit, projectId))
        .map((hit) => ({ hit, projectId }));
    }))).flat()
      .filter(({ hit }) => !globalIds.has(hit.id))
      .sort((left, right) => right.hit.score - left.hit.score);
    const seenSkillIds = new Set<string>();
    const reusableSkills = reusableHits
      .filter(({ hit }) => {
        if (seenSkillIds.has(hit.id)) return false;
        seenSkillIds.add(hit.id);
        return true;
      })
      .slice(0, input.limit)
      .map(({ hit, projectId }) => contextItemFromHit(hit, "capability", projectId));

    return { globalMemory, projectMemory, reusableSkills };
  }

  remember(input: {
    accountId: string;
    userId: string;
    content: string;
    projectId: string | null;
    conversationId?: string;
    title?: string;
    tags?: string[];
    provenance?: Record<string, string | undefined>;
  }): Promise<unknown> {
    const namespace = namespaceFor(input, input.projectId);
    const request = {
      adapterId: "memhub",
      namespace,
      source: provenanceSource(input.provenance),
      content: input.content,
      title: input.title,
      layer: "L1",
      tags: unique([
        "memhub",
        ...provenanceTags(input.provenance),
        ...(input.projectId ? [`project:${input.projectId}`] : ["global"]),
        ...(input.tags ?? [])
      ])
    };
    return this.client.addMemory(request);
  }

  distill(input: {
    accountId: string;
    userId: string;
    kind: DistilledArtifactKind;
    content: string;
    projectId: string | null;
    conversationId?: string;
    title?: string;
    tags?: string[];
    sourceHarness: string;
    artifactId?: string;
    version?: string;
    provenance?: Record<string, string | undefined>;
    evidenceRefs?: string[];
    sourceConversations?: string[];
    confidence?: number;
    contractVersion?: string;
  }): Promise<unknown> {
    const namespace = namespaceFor(input, input.projectId);
    const skill = input.kind === "skill";
    const sourceHarness = requireNonEmpty(input.sourceHarness, "sourceHarness");
    const stableArtifactId = input.artifactId?.trim() || stableDistillId(input);
    const request = {
      requestId: stableRequestId("distill", [
        input.accountId,
        input.projectId ?? "global",
        input.kind,
        sourceHarness,
        stableArtifactId
      ]),
      adapterId: "memhub-distill",
      namespace,
      source: `memhub:${sourceHarness}:${provenanceSource(input.provenance)}`,
      content: input.content,
      title: input.title,
      layer: skill ? "Skill" : "L1",
      tags: unique([
        "memhub",
        "distilled",
        ...(input.contractVersion ? [`distill-contract:${input.contractVersion}`] : []),
        ...(input.confidence !== undefined ? [`confidence:${input.confidence}`] : []),
        ...(input.evidenceRefs ?? []).map((ref) => `evidence:${ref}`),
        ...(input.sourceConversations ?? []).map((ref) => `source-conversation:${ref}`),
        ...provenanceTags(input.provenance),
        `artifact:${input.kind}`,
        ...(input.projectId ? [`project:${input.projectId}`] : ["global"]),
        ...(input.tags ?? [])
      ]),
      ...(skill ? {
        sourceAgentId: sourceHarness,
        sourceSkillId: stableArtifactId,
        ...(input.version?.trim() ? { sourceSkillVersion: input.version.trim() } : {})
      } : {})
    };
    return this.client.addMemory(request);
  }

  private search(input: {
    accountId: string;
    userId: string;
    query: string;
    projectId: string | null;
    conversationId?: string;
    limit: number;
  }, projectId: string | null, filters: {
    layers?: string[];
    tags?: string[];
    limit?: number;
  } = {}): Promise<unknown> {
    const namespace = namespaceFor(input, projectId);
    const request = {
      adapterId: "memhub",
      namespace,
      query: input.query,
      limit: filters.limit ?? input.limit,
      ...(filters.layers?.length ? { layers: filters.layers } : {}),
      ...(filters.tags?.length ? { tags: filters.tags } : {}),
      includeInjectedContext: false,
      // Memory Core's public HTTP contract only exposes structured recall
      // hits under debug.hits when verbose=true. The injected markdown alone
      // is not enough for Memhub because it must preserve global/project
      // provenance and compose a typed Context Capsule.
      verbose: true
    };
    return this.client.search(request);
  }
}

function isReusableSkillHit(hit: RecallHit, projectId: string): boolean {
  return hit.memoryLayer === "Skill" &&
    hit.tags.includes("artifact:skill") &&
    hit.tags.includes(`project:${projectId}`);
}

function provenanceTags(provenance?: Record<string, string | undefined>): string[] {
  if (!provenance) return [];
  return Object.entries(provenance)
    .filter((entry): entry is [string, string] => Boolean(entry[1]?.trim()))
    .map(([key, value]) => `provenance:${key}:${value.trim()}`);
}

function provenanceSource(provenance?: Record<string, string | undefined>): string {
  const platform = provenance?.platform?.trim() || "unknown";
  const transport = provenance?.transport?.trim() || "unknown";
  return `memhub:${platform}:${transport}`;
}

export function defaultMemoryUserId(accountId: string, ownerAccountId?: string, ownerUserId = "local-user"): string {
  const normalized = requireNonEmpty(accountId, "accountId");
  if (normalized === "local" || (ownerAccountId && normalized === ownerAccountId.trim())) return ownerUserId;
  return `acct_${createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32)}`;
}

function namespaceFor(
  input: { accountId: string; userId: string; conversationId?: string },
  projectId: string | null
): RuntimeNamespace {
  return {
    source: "memhub",
    profileId: "default",
    userId: requireNonEmpty(input.userId, "userId"),
    tenantId: requireNonEmpty(input.accountId, "accountId"),
    ...(projectId ? { projectId } : {}),
    ...(input.conversationId?.trim() ? { sessionKey: input.conversationId.trim() } : {})
  };
}

function hitsFromResponse(value: unknown): RecallHit[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const response = value as SearchResponseLike;
  const hits = Array.isArray(response.debug?.hits)
    ? response.debug.hits
    : response.hits;
  return Array.isArray(hits) ? hits.filter(isRecallHit) : [];
}

function isRecallHit(value: unknown): value is RecallHit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const hit = value as Partial<RecallHit>;
  return typeof hit.id === "string" && typeof hit.snippet === "string" && typeof hit.score === "number";
}

function dedupeHits(hits: readonly RecallHit[]): RecallHit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    if (seen.has(hit.id)) return false;
    seen.add(hit.id);
    return true;
  });
}

function contextItemFromHit(hit: RecallHit, scope: "global" | "project" | "capability", projectId?: string): ContextItem {
  const content = hit.title?.trim() ? `${hit.title.trim()}\n${hit.snippet}` : hit.snippet;
  return {
    id: hit.id,
    content,
    authority: "remembered",
    scope,
    source: "memmy-memory",
    ...(projectId ? { projectId } : {}),
    createdAt: hit.createdAt,
    updatedAt: hit.updatedAt,
    provenance: {
      kind: hit.kind,
      memoryLayer: hit.memoryLayer,
      score: hit.score,
      tags: hit.tags,
      retrievalSource: hit.source,
      retrievalRoutes: hit.retrievalRoutes
    }
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be non-empty`);
  return normalized;
}

function stableDistillId(input: {
  kind: DistilledArtifactKind;
  title?: string;
  content: string;
}): string {
  return `distill_${createHash("sha256")
    .update([input.kind, input.title?.trim() ?? "", input.content.trim()].join("\u0000"), "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

function stableRequestId(prefix: string, parts: readonly string[]): string {
  return `${prefix}_${createHash("sha256")
    .update(parts.join("\u0000"), "utf8")
    .digest("hex")
    .slice(0, 40)}`;
}
