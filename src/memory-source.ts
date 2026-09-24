import { createHash } from "node:crypto";
import type { ContextItem } from "./context-capsule.js";
import type { LocalMemoryRestClient, RecallHit, RuntimeNamespace } from "./local-memory-client.js";
import { rankRecallHits, type RankedRecallHit, type RetrievalRankDiagnostics } from "./retrieval-ranker.js";
import { compactSkillContextItem } from "./skill-router.js";

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
  }): Promise<{
    globalMemory: ContextItem[];
    projectMemory: ContextItem[];
    reusableSkills: ContextItem[];
    diagnostics?: ContextRecallDiagnostics;
  }>;
}

export interface ContextRecallDiagnostics {
  version: "retrieval-v1";
  requestedLimit: number;
  finalLimit: number;
  candidateLimit: number;
  lanes: {
    global: RetrievalRankDiagnostics;
    project: RetrievalRankDiagnostics;
    skills: RetrievalRankDiagnostics;
  };
}

export type DistilledArtifactKind = "l2" | "l3" | "l4" | "skill";

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
  }): Promise<{
    globalMemory: ContextItem[];
    projectMemory: ContextItem[];
    reusableSkills: ContextItem[];
    diagnostics: ContextRecallDiagnostics;
  }> {
    const requestedLimit = Math.max(1, Math.min(50, input.limit));
    const finalLimit = Math.min(12, requestedLimit);
    const candidateLimit = Math.min(50, Math.max(12, finalLimit * 4));
    const globalResponse = await this.search(input, null, { layers: ["L4"], limit: candidateLimit });
    const globalHits = hitsFromResponse(globalResponse)
      .filter((hit) => hit.tags.includes("global"));
    const rankedGlobal = rankRecallHits(globalHits, input.query, finalLimit);
    const globalIds = new Set(rankedGlobal.hits.map(({ hit }) => hit.id));
    const globalMemory = rankedGlobal.hits.map((ranked) => contextItemFromRankedHit(ranked, "global", undefined, rankedGlobal.diagnostics));
    const projectStorageIds = input.projectId === null
      ? []
      : unique(input.projectStorageIds?.length ? input.projectStorageIds : [input.projectId]);
    let projectHits: RecallHit[] = [];
    if (input.projectId !== null) {
      projectHits = dedupeHits((await Promise.all(projectStorageIds.map(async (storageProjectId) =>
        hitsFromResponse(await this.search(input, storageProjectId, { layers: ["L3", "L2"], limit: candidateLimit }))
          .filter((hit) => hit.tags.includes(`project:${storageProjectId}`))
      ))).flat());
      // A freshly migrated/bootstrap project may not have a v2 L2/L3 artifact
      // yet. Keep continuity by falling back to relevant L1 evidence only while
      // the higher layers are absent. Once L2/L3 exists, raw L1 stays out of the
      // normal context capsule and remains an evidence layer for distillation.
      if (projectHits.length === 0) {
        projectHits = dedupeHits((await Promise.all(projectStorageIds.map(async (storageProjectId) =>
          hitsFromResponse(await this.search(input, storageProjectId, { layers: ["L1"], limit: candidateLimit }))
            .filter((hit) => hit.tags.includes(`project:${storageProjectId}`))
        ))).flat());
      }
    }
    const rankedProject = rankRecallHits(projectHits.filter((hit) => !globalIds.has(hit.id)), input.query, finalLimit);
    const projectMemory = rankedProject.hits
      .map((ranked) => contextItemFromRankedHit(ranked, "project", input.projectId ?? undefined, rankedProject.diagnostics));

    const reusableSkillProjectIds = unique([
      ...(input.projectId ? [input.projectId] : []),
      ...(input.reusableSkillProjectIds ?? [])
    ])
      .slice(0, 32);
    const perProjectSkillLimit = candidateLimit;
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
    const skillProjectById = new Map<string, string>();
    for (const { hit, projectId } of reusableHits) {
      if (!skillProjectById.has(hit.id)) skillProjectById.set(hit.id, projectId);
    }
    const dedupedReusableHits = dedupeHits(reusableHits.map(({ hit }) => hit));
    const rankedSkills = rankRecallHits(dedupedReusableHits, input.query, finalLimit);
    const reusableSkills = rankedSkills.hits
      .map((ranked) => compactSkillContextItem(contextItemFromRankedHit(
          ranked,
          "capability",
          skillProjectById.get(ranked.hit.id),
          rankedSkills.diagnostics
        )));

    return {
      globalMemory,
      projectMemory,
      reusableSkills,
      diagnostics: {
        version: "retrieval-v1",
        requestedLimit,
        finalLimit,
        candidateLimit,
        lanes: {
          global: rankedGlobal.diagnostics,
          project: rankedProject.diagnostics,
          skills: rankedSkills.diagnostics
        }
      }
    };
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
    const layer = input.kind === "l2"
      ? "L2"
      : input.kind === "l3"
        ? "L3"
        : input.kind === "l4"
          ? "L4"
          : "Skill";
    const sourceHarness = requireNonEmpty(input.sourceHarness, "sourceHarness");
    const stableArtifactId = input.artifactId?.trim() || stableDistillId(input);
    const tags = unique([
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
    ]);
    const requestBody = {
      namespace,
      source: `memhub:${sourceHarness}:${provenanceSource(input.provenance)}`,
      content: input.content,
      title: input.title,
      layer,
      tags,
      sourceArtifactId: stableArtifactId,
      ...(skill ? {
        sourceAgentId: sourceHarness,
        sourceSkillId: stableArtifactId,
        ...(input.version?.trim() ? { sourceSkillVersion: input.version.trim() } : {})
      } : {})
    };
    // requestId is retry-stable for an identical write, but changes when the
    // canonical artifact evolves. Memory Core upserts by memory key/title;
    // using only the artifact identity here would turn legitimate revisions
    // into idempotency conflicts (same key, different request body).
    const request = {
      requestId: stableRequestId("distill", [
        input.accountId,
        input.projectId ?? "global",
        input.kind,
        sourceHarness,
        stableArtifactId,
        stableHashJson(requestBody)
      ]),
      adapterId: "memhub-distill",
      ...requestBody
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
  const tags = hit.tags.slice(0, 32);
  const allRetrievalRoutes = hit.retrievalRoutes ?? [];
  const retrievalRoutes = allRetrievalRoutes.slice(0, 16);
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
      tags,
      ...(hit.tags.length > tags.length ? { tagsTruncated: true, originalTagCount: hit.tags.length } : {}),
      retrievalSource: hit.source,
      retrievalRoutes,
      ...(allRetrievalRoutes.length > retrievalRoutes.length
        ? { retrievalRoutesTruncated: true, originalRetrievalRouteCount: allRetrievalRoutes.length }
        : {})
    }
  };
}

function contextItemFromRankedHit(
  ranked: RankedRecallHit,
  scope: "global" | "project" | "capability",
  projectId: string | undefined,
  diagnostics: RetrievalRankDiagnostics
): ContextItem {
  const item = contextItemFromHit(ranked.hit, scope, projectId);
  return {
    ...item,
    provenance: {
      ...(item.provenance ?? {}),
      retrievalV1: {
        rank: ranked.rank,
        semanticScore: ranked.semanticScore,
        lexicalScore: ranked.lexicalScore,
        fusedScore: ranked.fusedScore,
        diversityPenaltyApplied: ranked.diversityPenaltyApplied,
        matchedTerms: ranked.matchedTerms,
        candidateCount: diagnostics.candidateCount,
        dedupedCount: diagnostics.dedupedCount
      }
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

function stableHashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
