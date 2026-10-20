import { createHash } from "node:crypto";
import type { ContextItem } from "./context-capsule.js";
import { listFreshCaptureEvidence } from "./capture.js";
import { captureCoreRawTurnId, captureTurnId } from "./capture-ingest.js";
import type { LocalMemoryRestClient, RecallHit, RuntimeNamespace } from "./local-memory-client.js";
import { rankRecallHits, tokenizeRetrievalText, type RankedRecallHit, type RetrievalRankDiagnostics } from "./retrieval-ranker.js";
import { compactSkillContextItem } from "./skill-router.js";

interface SearchResponseLike {
  hits?: RecallHit[];
  status?: string[];
  debug?: {
    hits?: RecallHit[];
    status?: string[];
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
    continuityId?: string;
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
  coreStatus?: string[];
  lanes: {
    global: RetrievalRankDiagnostics;
    project: RetrievalRankDiagnostics;
    skills: RetrievalRankDiagnostics;
  };
}

export type DistilledArtifactKind = "l2" | "l3" | "l4" | "skill";

export const FRESH_L1_MAX = 4;
const FRESH_L1_CHARS = 600;

export class MemoryRestContextSource implements ContextMemorySource {
  constructor(private readonly client: LocalMemoryRestClient, private readonly stateRoot?: string) {}

  async recall(input: {
    accountId: string;
    userId: string;
    query: string;
    projectId: string | null;
    projectStorageIds?: readonly string[];
    conversationId?: string;
    continuityId?: string;
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
    const coreStatus: string[] = [];
    const search = async (projectId: string | null, filters: {
      layers?: string[];
      tags?: string[];
      limit?: number;
      accountWide?: boolean;
      projectIds?: readonly string[];
    } = {}) => {
      const response = await this.search(input, projectId, filters);
      coreStatus.push(...statusFromResponse(response));
      return response;
    };
    const globalResponse = await search(null, { layers: ["L4"], limit: candidateLimit });
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
      const canonicalProjectId = input.projectId;
      const historicalStorageIds = projectStorageIds.filter((projectId) => projectId !== canonicalProjectId);
      const [canonicalHits, historicalL2Hits] = await Promise.all([
        search(canonicalProjectId, { layers: ["L3", "L2"], limit: candidateLimit })
          .then((response) => hitsFromResponse(response)
            .filter((hit) => hit.tags.includes(`project:${canonicalProjectId}`))),
        Promise.all(historicalStorageIds.map(async (storageProjectId) =>
          hitsFromResponse(await search(storageProjectId, { layers: ["L2"], limit: candidateLimit }))
            .filter((hit) => hit.tags.includes(`project:${storageProjectId}`))
        )).then((hits) => hits.flat())
      ]);
      // storageIds intentionally includes merged project ids and historical
      // aliases so chronology/provenance stays discoverable after a merge.
      // L3 is different: it is Current Truth for the active canonical project.
      // A merged project's historical L3 must therefore remain durable/auditable
      // in its original namespace, but must not re-enter normal Current Truth
      // ranking merely because that namespace is now an alias of the canonical
      // project. Only canonical L3 participates in project recall; historical
      // namespaces contribute L2 chronology.
      projectHits = dedupeHits([...canonicalHits, ...historicalL2Hits]);
      // Preserve Core's L1-only fallback for bootstrap projects.
      if (projectHits.length === 0) {
        projectHits = dedupeHits((await Promise.all(projectStorageIds.map(async (storageProjectId) =>
          hitsFromResponse(await search(storageProjectId, { layers: ["L1"], limit: candidateLimit }))
            .filter((hit) => hit.tags.includes(`project:${storageProjectId}`))
        ))).flat());
      }
    }
    const rankedProject = rankRecallHits(projectHits.filter((hit) => !globalIds.has(hit.id)), input.query, finalLimit);
    let projectMemory = rankedProject.hits
      .map((ranked) => contextItemFromRankedHit(ranked, "project", input.projectId ?? undefined, rankedProject.diagnostics));

    if (this.stateRoot && (input.projectId !== null || input.continuityId?.trim())) {
      const watermark = projectHits
        .filter((hit) => hit.memoryLayer === "L2")
        .map((hit) => Date.parse(hit.updatedAt ?? ""))
        .filter(Number.isFinite)
        .reduce((latest, timestamp) => Math.max(latest, timestamp), Number.NEGATIVE_INFINITY);
      const captures = await listFreshCaptureEvidence(this.stateRoot, input.accountId, {
        ...(input.projectId !== null ? { projectIds: projectStorageIds } : { continuityId: input.continuityId }),
        ...(Number.isFinite(watermark) ? { afterTimestamp: new Date(watermark).toISOString() } : {}),
        limit: input.projectId !== null ? FRESH_L1_MAX : 2
      });
      const queryTerms = tokenizeRetrievalText(input.query).slice(0, 32);
      const freshItems = captures.map((event): ContextItem => {
        const user = event.user_text?.trim() ?? "";
        const assistant = event.assistant_text?.trim() ?? "";
        const userLimit = Math.min(user.length, 290);
        const assistantLimit = FRESH_L1_CHARS - "User: \nAssistant: ".length - userLimit;
        const content = `User: ${clipFreshText(user, userLimit)}\nAssistant: ${clipFreshText(assistant, assistantLimit)}`;
        const tokens = new Set(tokenizeRetrievalText(content));
        const matchedTerms = queryTerms.filter((term) => tokens.has(term));
        return {
          id: event.event_id,
          evidenceRef: `l1:${event.event_id}`,
          content,
          authority: "evidence",
          scope: "project",
          source: "memhub-capture",
          ...(input.projectId !== null ? { projectId: input.projectId } : {}),
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
          provenance: {
            memoryLayer: "L1",
            freshness: "undistilled",
            continuityId: event.continuity_id,
            captureProjectId: event.project_hint,
            retrievalV1: { matchedTerms }
          }
        };
      });
      if (freshItems.length > 0) {
        const relevant = (item: ContextItem) => {
          const matched = (item.provenance!.retrievalV1 as { matchedTerms: string[] }).matchedTerms;
          return queryTerms.length === 0 || matched.length / queryTerms.length >= 0.1;
        };
        const freshIds = new Set(captures.flatMap((event) => [
          event.event_id,
          captureTurnId(input.accountId, event.host, event.event_id),
          captureCoreRawTurnId(input.accountId, event.host, event.event_id)
        ]));
        const older = projectMemory.filter((item) => item.provenance?.memoryLayer !== "L1" || !freshIds.has(item.id));
        const replacedCount = projectMemory.length - older.length;
        projectMemory = [
          ...older.filter((item) => item.provenance?.memoryLayer === "L3"),
          ...freshItems.filter(relevant),
          ...older.filter((item) => item.provenance?.memoryLayer !== "L3"),
          ...freshItems.filter((item) => !relevant(item))
        ].slice(0, finalLimit);
        rankedProject.diagnostics.candidateCount += freshItems.length;
        rankedProject.diagnostics.dedupedCount += freshItems.length - replacedCount;
        rankedProject.diagnostics.emittedCount = projectMemory.length;
      }
    }

    const reusableSkillProjectIds = unique([
      ...(input.projectId ? [input.projectId] : []),
      ...(input.reusableSkillProjectIds ?? [])
    ])
      .slice(0, 32);
    const perProjectSkillLimit = candidateLimit;
    const singleSkillProject = (reusableSkillProjectIds.length === 1 ? reusableSkillProjectIds[0] : null) ?? null;
    let rawReusableHits: Array<{ hit: RecallHit; projectId: string }> = [];
    if (reusableSkillProjectIds.length > 0) {
      const response = await search(singleSkillProject, {
        layers: ["Skill"],
        tags: ["artifact:skill"],
        limit: perProjectSkillLimit,
        accountWide: true,
        projectIds: reusableSkillProjectIds
      });
      const hits = hitsFromResponse(response);
      for (const projectId of reusableSkillProjectIds) {
        for (const hit of hits) {
          if (isReusableSkillHit(hit, projectId)) {
            rawReusableHits.push({ hit, projectId });
          }
        }
      }
    }
    const reusableHits = rawReusableHits
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
        coreStatus: unique(coreStatus),
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
    accountWide?: boolean;
    projectIds?: readonly string[];
  } = {}): Promise<unknown> {
    const namespace = namespaceFor(input, projectId);
    const request = {
      adapterId: "memhub",
      namespace,
      query: input.query,
      limit: filters.limit ?? input.limit,
      ...(filters.layers?.length ? { layers: filters.layers } : {}),
      ...(filters.tags?.length ? { tags: filters.tags } : {}),
      ...(filters.accountWide ? { accountWide: true } : {}),
      ...(filters.projectIds?.length ? { projectIds: filters.projectIds } : {}),
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

export function clipFreshText(value: string, limit: number): string {
  if (limit <= 0) return "";
  if (value.length <= limit) return value;
  let end = Math.max(0, limit - 1);
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end -= 1;
  return `${value.slice(0, end)}…`;
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

function statusFromResponse(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const response = value as SearchResponseLike;
  const status = Array.isArray(response.debug?.status) ? response.debug.status : response.status;
  return Array.isArray(status) ? unique(status.filter((item): item is string => typeof item === "string")) : [];
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
