import type { ContextCapsule, ContextItem } from "./context-capsule.js";
import { tokenizeRetrievalText } from "./retrieval-ranker.js";

export type TurnKnowledgeRole = "required" | "supporting";
export type TurnKnowledgeKind = "L1" | "L2" | "L3" | "L4" | "architecture" | "skill";

export interface TurnKnowledgePassage {
  heading?: string;
  text: string;
  matched_terms: string[];
  score: number;
}

export interface TurnKnowledgeEntry {
  role: TurnKnowledgeRole;
  kind: TurnKnowledgeKind;
  id: string;
  project_id?: string;
  evidence_ref?: string;
  reason: string;
  use?: string;
  passages?: TurnKnowledgePassage[];
  passage_headings?: string[];
  load?: {
    tool: "memhub_skill";
    action: "load";
    skill_id: string;
  };
}

export interface TurnKnowledgePlan {
  version: "turn-knowledge-plan-v1";
  mode: "deterministic-existing-retrieval";
  persistence: "none";
  model_calls: 0;
  required: TurnKnowledgeEntry[];
  supporting: TurnKnowledgeEntry[];
  evidence_on_demand: {
    purpose: "why_or_provenance_only";
    rule?: string;
    tool: "memhub_memory";
    action: "why";
    candidate_evidence_refs: string[];
  };
  coverage: {
    project_resolved: boolean;
    recall_scope: ContextCapsule["recallScope"];
    current_truth_found: boolean;
    architecture_relevant: boolean;
    context_truncated_items: number;
    context_dropped_items: number;
    passage_bytes: number;
    hydrated_full_revisions: number;
    hydration_failures: number;
    retrieval_degraded: boolean;
    core_status: string[];
    omitted_items: number;
  };
  sufficiency: "unknown" | "partial";
  rules?: string[];
}

export interface BuildTurnKnowledgePlanInput {
  query: string;
  capsule: ContextCapsule;
  hydrateEvidence?: (evidenceRef: string) => Promise<{ content: string } | null>;
  detail?: "brief" | "full";
  dedupe?: boolean;
}

export interface PassageCandidate {
  heading?: string;
  text: string;
}

const MAX_PASSAGES_PER_ENTRY = 3;
const MAX_PASSAGE_CHARS = 900;
const MAX_REQUIRED_ENTRIES = 4;
const MAX_SUPPORTING_ENTRIES = 4;

/**
 * Builds a small advisory plan above the existing Context Capsule.
 *
 * It intentionally does not create another memory layer, index, cache or
 * semantic model call. Existing retrieval establishes legal scope and item
 * relevance; this helper only assigns turn-local roles and chooses bounded
 * passages with the same lexical terms already used by Retrieval v1.
 */
export async function buildTurnKnowledgePlan(input: BuildTurnKnowledgePlanInput): Promise<TurnKnowledgePlan> {
  const query = input.query.trim();
  const capsule = input.capsule;
  const queryTerms = turnQueryTerms(query, capsule);
  const hydrated = new Map<string, string>();
  let hydrationFailures = 0;

  const topL3 = capsule.projectMemory.find((item) => memoryLayer(item) === "L3");
  const topL2 = capsule.projectMemory.find((item) => memoryLayer(item) === "L2");
  const hydrationTargets = [topL3, topL2]
    .filter((item): item is ContextItem => Boolean(item?.evidenceRef && input.hydrateEvidence));

  await Promise.all(hydrationTargets.map(async (item) => {
    try {
      const result = await input.hydrateEvidence!(item.evidenceRef!);
      if (result?.content.trim()) hydrated.set(item.evidenceRef!, result.content.trim());
    } catch {
      hydrationFailures += 1;
    }
  }));

  const required: TurnKnowledgeEntry[] = [];
  const supporting: TurnKnowledgeEntry[] = [];
  let omittedItems = 0;

  if (topL3) {
    required.push(memoryEntry({
      item: topL3,
      role: "required",
      kind: "L3",
      reason: "project_current_truth",
      use: "Use as project Current Truth/rules within the resolved project. It outranks L2 chronology and L4 preferences when they conflict.",
      queryTerms,
      fullContent: topL3.evidenceRef ? hydrated.get(topL3.evidenceRef) : undefined,
      fallback: "retrieval"
    }));
  }

  const architectureEntries = capsule.projectArchitecture
    .map((item) => {
      const passages = selectPassages(item.content, queryTerms, matchedTerms(item), "none");
      return { item, passages, score: passages[0]?.score ?? 0 };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.item.id.localeCompare(right.item.id))
    .slice(0, 2);
  for (const candidate of architectureEntries) {
    required.push({
      role: "required",
      kind: "architecture",
      id: candidate.item.id,
      ...(candidate.item.projectId ? { project_id: candidate.item.projectId } : {}),
      reason: "query_relevant_project_architecture",
      use: "Treat as authoritative structural/source-of-truth constraints for implementation. Do not infer business memory from it.",
      passages: candidate.passages
    });
  }

  for (const item of capsule.projectMemory) {
    if (item.provenance?.memoryLayer !== "L1" || item.provenance.freshness !== "undistilled") continue;
    supporting.push(memoryEntry({
      item,
      role: "supporting",
      kind: "L1",
      reason: "undistilled_turn_evidence",
      use: "Recent undistilled turn evidence. Check its provenance; it does not override L3 Current Truth/rules.",
      queryTerms,
      fallback: "retrieval"
    }));
  }

  if (topL2) {
    supporting.push(memoryEntry({
      item: topL2,
      role: "supporting",
      kind: "L2",
      reason: "project_chronology_and_recent_change",
      use: "Use for chronology, recent changes and how the project reached its current state. Do not let L2 override L3 Current Truth.",
      queryTerms,
      fullContent: topL2.evidenceRef ? hydrated.get(topL2.evidenceRef) : undefined,
      fallback: "latest"
    }));
  }

  for (const item of capsule.globalMemory) {
    if (memoryLayer(item) !== "L4") continue;
    const terms = matchedTerms(item);
    if (terms.length === 0) {
      omittedItems += 1;
      continue;
    }
    supporting.push(memoryEntry({
      item,
      role: "supporting",
      kind: "L4",
      reason: "relevant_cross_project_stable_preference",
      use: "Use only when the stable cross-project preference materially affects this turn. It does not override project-specific L3 rules.",
      queryTerms,
      fallback: "retrieval"
    }));
  }

  for (const item of capsule.reusableSkills) {
    const terms = matchedTerms(item);
    if (terms.length === 0) {
      omittedItems += 1;
      continue;
    }
    supporting.push({
      role: "supporting",
      kind: "skill",
      id: item.id,
      ...(item.projectId ? { project_id: item.projectId } : {}),
      reason: "workflow_candidate_only",
      use: "Load only if the workflow matches the requested task. A Skill is procedure, not business fact or Current Truth.",
      passages: selectPassages(item.content, queryTerms, terms, "retrieval"),
      load: { tool: "memhub_skill", action: "load", skill_id: item.id }
    });
  }

  const boundedRequired = required.slice(0, MAX_REQUIRED_ENTRIES);
  const boundedSupporting = supporting.slice(0, MAX_SUPPORTING_ENTRIES);
  omittedItems += Math.max(0, required.length - boundedRequired.length);
  omittedItems += Math.max(0, supporting.length - boundedSupporting.length);

  const evidenceRefs = uniqueStrings([
    ...boundedRequired.map((entry) => entry.evidence_ref),
    ...boundedSupporting.map((entry) => entry.evidence_ref)
  ].filter((value): value is string => Boolean(value)));
  const passageBytes = [...boundedRequired, ...boundedSupporting]
    .flatMap((entry) => entry.passages ?? [])
    .reduce((total, passage) => total + (passage ? Buffer.byteLength(passage.text, "utf8") : 0), 0);
  const coreStatus = capsule.retrievalDiagnostics?.coreStatus ?? [];
  const retrievalDegraded = coreStatus.some((status) => /failed|degraded|fallback/.test(status));
  const partial = capsule.ambiguities.length > 0 ||
    capsule.contextBudget.truncatedItems > 0 ||
    capsule.contextBudget.droppedItems > 0 ||
    hydrationFailures > 0 ||
    retrievalDegraded;

  const rawPlan: TurnKnowledgePlan = {
    version: "turn-knowledge-plan-v1",
    mode: "deterministic-existing-retrieval",
    persistence: "none",
    model_calls: 0,
    required: boundedRequired,
    supporting: boundedSupporting,
    evidence_on_demand: {
      purpose: "why_or_provenance_only",
      ...(input.detail !== "brief" ? {
        rule: "Use WHY/L1 evidence only when the user asks why, provenance is disputed, memories conflict, or the model needs to distinguish direct reason from contextual candidate/unknown. Temporal adjacency alone is not causality."
      } : {}),
      tool: "memhub_memory",
      action: "why",
      candidate_evidence_refs: evidenceRefs.slice(0, 6)
    },
    coverage: {
      project_resolved: capsule.resolvedProjectId !== null,
      recall_scope: capsule.recallScope,
      current_truth_found: Boolean(topL3),
      architecture_relevant: architectureEntries.length > 0,
      context_truncated_items: capsule.contextBudget.truncatedItems,
      context_dropped_items: capsule.contextBudget.droppedItems,
      passage_bytes: passageBytes,
      hydrated_full_revisions: hydrated.size,
      hydration_failures: hydrationFailures,
      retrieval_degraded: retrievalDegraded,
      core_status: coreStatus,
      omitted_items: omittedItems
    },
    sufficiency: partial ? "partial" : "unknown",
    ...(input.detail !== "brief" ? {
      rules: [
        "required: use as current/authoritative guidance within its declared scope.",
        "supporting: use for chronology, stable preference or workflow context; it must not silently override required knowledge.",
        "evidence_on_demand: descend to WHY/L1 only when the reason or provenance matters; do not eagerly inject raw evidence.",
        "Memhub organizes evidence and scope; the connected Harness remains responsible for semantic judgment and deciding whether more context is needed."
      ]
    } : {})
  };

  return input.dedupe ? dedupeTurnKnowledgePlan(rawPlan, capsule) : rawPlan;
}

export function dedupeTurnKnowledgePlan(plan: TurnKnowledgePlan, capsule: ContextCapsule): TurnKnowledgePlan {
  const capsuleIds = new Set([
    ...capsule.globalMemory.map((item) => item.id),
    ...capsule.projectMemory.map((item) => item.id),
    ...capsule.reusableSkills.map((item) => item.id),
    ...capsule.projectArchitecture.map((item) => item.id)
  ]);

  const dedupeEntry = (entry: TurnKnowledgeEntry): TurnKnowledgeEntry => {
    if (!capsuleIds.has(entry.id)) return entry;
    const passageHeadings = uniqueStrings((entry.passages ?? []).map((p) => p.heading).filter((h): h is string => Boolean(h)));
    return {
      role: entry.role,
      kind: entry.kind,
      id: entry.id,
      reason: entry.reason,
      passage_headings: passageHeadings
    };
  };

  return {
    ...plan,
    required: plan.required.map(dedupeEntry),
    supporting: plan.supporting.map(dedupeEntry)
  };
}

function memoryEntry(input: {
  item: ContextItem;
  role: TurnKnowledgeRole;
  kind: "L1" | "L2" | "L3" | "L4";
  reason: string;
  use: string;
  queryTerms: readonly string[];
  fullContent?: string;
  fallback: "retrieval" | "latest";
}): TurnKnowledgeEntry {
  const content = input.fullContent?.trim() || input.item.content;
  return {
    role: input.role,
    kind: input.kind,
    id: input.item.id,
    ...(input.item.projectId ? { project_id: input.item.projectId } : {}),
    ...(input.item.evidenceRef ? { evidence_ref: input.item.evidenceRef } : {}),
    reason: input.reason,
    use: input.use,
    passages: selectPassages(content, input.queryTerms, matchedTerms(input.item), input.fallback, input.item.content)
  };
}

export function scoreMarkdownPassages(
  candidates: readonly PassageCandidate[],
  queryTerms: readonly string[],
  itemMatchedTerms: readonly string[] = []
): Array<PassageCandidate & { matched: string[]; score: number; index: number }> {
  const terms = uniqueStrings([...itemMatchedTerms, ...queryTerms])
    .map((term) => term.trim())
    .filter((term) => [...term].length >= 2)
    .slice(0, 48);
  return candidates.map((candidate, index) => {
    const haystack = `${candidate.heading ?? ""}\n${candidate.text}`.toLocaleLowerCase();
    const matched = terms.filter((term) => haystack.includes(term.toLocaleLowerCase()));
    const heading = (candidate.heading ?? "").toLocaleLowerCase();
    const score = matched.reduce((total, term) => {
      const normalized = term.toLocaleLowerCase();
      const lengthWeight = Math.min(8, Math.max(2, [...term].length));
      const headingBoost = heading.includes(normalized) ? lengthWeight : 0;
      return total + lengthWeight + headingBoost;
    }, 0);
    return { ...candidate, matched, score, index };
  });
}

export function selectPassages(
  content: string,
  queryTerms: readonly string[],
  itemMatchedTerms: readonly string[],
  fallback: "none" | "retrieval" | "latest",
  retrievalFallback?: string,
  maxPassages = MAX_PASSAGES_PER_ENTRY
): TurnKnowledgePassage[] {
  const candidates = markdownPassages(content);
  const scored = scoreMarkdownPassages(candidates, queryTerms, itemMatchedTerms);
  const positive = scored
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, maxPassages)
    .map(toPassage);
  if (positive.length > 0) return positive;
  if (fallback === "none") return [];
  if (fallback === "latest" && scored.length > 0) return [toPassage(scored[scored.length - 1]!)];
  const fallbackContent = (retrievalFallback ?? content).trim();
  if (!fallbackContent) return [];
  return [{ text: boundText(fallbackContent), matched_terms: [], score: 0 }];
}

export function extractMarkdownHeadings(content: string, limit = 12): string[] {
  const headings: string[] = [];
  let inFence = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^artifact:[^\s]+$/.test(line)) continue;
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      headings.push(headingMatch[2]!.trim());
      if (headings.length >= limit) break;
    }
  }
  return headings;
}

export function markdownPassages(content: string): PassageCandidate[] {
  const passages: PassageCandidate[] = [];
  let heading: string | undefined;
  let paragraph: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = paragraph.join(" ").trim();
    paragraph = [];
    if (text) passages.push({ ...(heading ? { heading } : {}), text: boundText(text) });
  };
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^```/.test(line)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence || /^artifact:[^\s]+$/.test(line)) continue;
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      flush();
      heading = headingMatch[2]!.trim();
      continue;
    }
    if (!line) {
      flush();
      continue;
    }
    if (/^(?:[-*+]\s+|\d+[.)]\s+)/.test(line)) {
      flush();
      passages.push({ ...(heading ? { heading } : {}), text: boundText(line) });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  if (passages.length === 0 && content.trim()) passages.push({ text: boundText(content.trim()) });
  return passages;
}

function toPassage(candidate: PassageCandidate & { matched: string[]; score: number }): TurnKnowledgePassage {
  return {
    ...(candidate.heading ? { heading: candidate.heading } : {}),
    text: boundText(candidate.text),
    matched_terms: candidate.matched.slice(0, 12),
    score: candidate.score
  };
}

export function turnQueryTerms(query: string, capsule: ContextCapsule): string[] {
  const diagnostics = capsule.retrievalDiagnostics;
  return uniqueStrings([
    ...(diagnostics?.lanes.project.queryTerms ?? []),
    ...(diagnostics?.lanes.global.queryTerms ?? []),
    ...(diagnostics?.lanes.skills.queryTerms ?? []),
    ...tokenizeRetrievalText(query)
  ]).slice(0, 64);
}

function matchedTerms(item: ContextItem): string[] {
  const retrieval = objectRecord(item.provenance?.retrievalV1);
  const value = retrieval?.matchedTerms;
  return Array.isArray(value) ? uniqueStrings(value.filter((term): term is string => typeof term === "string")) : [];
}

function memoryLayer(item: ContextItem): "L2" | "L3" | "L4" | null {
  const value = typeof item.provenance?.memoryLayer === "string"
    ? item.provenance.memoryLayer.trim().toUpperCase()
    : "";
  return value === "L2" || value === "L3" || value === "L4" ? value : null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function boundText(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= MAX_PASSAGE_CHARS) return normalized;
  let end = MAX_PASSAGE_CHARS - 1;
  const previous = normalized.charCodeAt(end - 1), next = normalized.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return `${normalized.slice(0, end).trimEnd()}…`;
}
