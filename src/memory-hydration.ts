import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { listCaptureEvents } from "./capture.js";
import {
  attachExactDistillationEvidenceRefs,
  distillationRevisionBody
} from "./distillation-contract.js";
import type { ContextItem } from "./context-capsule.js";
import type { MemhubRuntime } from "./runtime.js";
import {
  distillationResultTimestamp,
  listDistillationJobs,
  type DistillationEvidenceItem,
  type DistillationJob
} from "./distillation-jobs.js";
import { tokenizeRetrievalText } from "./retrieval-ranker.js";

export interface HydratedMemoryEvidence {
  evidence_ref: string;
  layer: "L1" | "L2" | "L3" | "L4";
  memory_id: string;
  revision_id?: string;
  project_id: string | null;
  title: string;
  content: string;
  committed_at: string;
  source_conversation_id?: string;
  source_evidence_refs: string[];
  estimated_tokens: number;
}

export interface MemoryHydrationTelemetrySummary {
  evidence_ref: string;
  hydrations: number;
  total_estimated_tokens: number;
  last_hydrated_at: string | null;
}

export interface MemoryWhyEvidenceItem {
  evidence_ref: string;
  layer: string | null;
  timestamp: string;
  project_id: string | null;
  title: string | null;
  content_preview: string;
  matched_terms: string[];
}

interface MemoryHydrationEvent {
  event_id: string;
  evidence_ref: string;
  layer: HydratedMemoryEvidence["layer"];
  project_id: string | null;
  estimated_tokens: number;
  timestamp: string;
}

export async function hydrateMemoryEvidence(input: {
  stateRoot: string;
  accountId: string;
  evidenceRef: string;
}): Promise<HydratedMemoryEvidence> {
  const ref = input.evidenceRef.trim();
  const l1 = /^l1:(.+)$/.exec(ref);
  if (l1) {
    const eventId = l1[1];
    const event = (await listCaptureEvents(input.stateRoot, input.accountId)).find((item) => item.event_id === eventId);
    if (!event) throw new Error(`L1 evidence not found: ${ref}`);
    const content = [
      event.user_text ? `user: ${event.user_text}` : "",
      event.assistant_text ? `assistant: ${event.assistant_text}` : "",
      event.reasoning_summary ? `reasoning_summary: ${event.reasoning_summary}` : "",
      event.tool_summary ? `tool_summary: ${event.tool_summary}` : ""
    ].filter(Boolean).join("\n");
    if (!content) throw new Error(`L1 evidence has no memory-visible content: ${ref}`);
    return {
      evidence_ref: ref,
      layer: "L1",
      memory_id: event.event_id,
      project_id: event.project_hint ?? null,
      title: `L1 · ${event.event_id}`,
      content,
      committed_at: event.timestamp,
      source_conversation_id: event.conversation_id,
      source_evidence_refs: [],
      estimated_tokens: estimateTokens(content)
    };
  }

  const versioned = /^(l2|l3|l4):([^:]+):([^:]+)$/.exec(ref);
  if (!versioned) throw new TypeError("evidence_ref must be l1:<event-id> or l2/l3/l4:<memory-id>:<revision-id>");
  const prefix = versioned[1]! as "l2" | "l3" | "l4";
  const memoryId = versioned[2]!;
  const revisionId = versioned[3]!;
  const jobs = await listDistillationJobs(input.stateRoot, input.accountId, true);
  const job = jobs.find((candidate) =>
    candidate.job_id === revisionId &&
    candidate.status === "completed" &&
    candidate.target === prefix &&
    candidate.result_kind === prefix &&
    candidate.result_id === memoryId &&
    Boolean(candidate.result_content?.trim())
  );
  if (!job?.result_content) throw new Error(`exact Memory revision not found: ${ref}`);
  const content = distillationRevisionBody(job);
  return {
    evidence_ref: ref,
    layer: prefix.toUpperCase() as "L2" | "L3" | "L4",
    memory_id: memoryId,
    revision_id: revisionId,
    project_id: job.project_id,
    title: titleFromContent(content, `${prefix.toUpperCase()} · ${memoryId}`),
    content,
    committed_at: distillationResultTimestamp(job) ?? job.completed_at ?? job.updated_at,
    ...(job.conversation_id ? { source_conversation_id: job.conversation_id } : {}),
    source_evidence_refs: job.evidence_refs.slice(),
    estimated_tokens: estimateTokens(content)
  };
}

/**
 * Build a small, read-only evidence pack for causal/WHY review.
 *
 * This deliberately does not infer causality and does not persist a second
 * WHY graph. It reuses the immutable distillation evidence already stored in
 * the revision ledger, selects a few query-relevant sources, and leaves the
 * semantic judgement to the connected Harness.
 */
export async function explainMemoryWhy(input: {
  stateRoot: string;
  accountId: string;
  evidenceRef: string;
  query: string;
  maxSources?: number;
}): Promise<Record<string, unknown>> {
  const query = input.query.trim();
  if (!query) throw new TypeError("query is required for WHY review");
  const maxSources = Math.max(1, Math.min(8, Math.trunc(input.maxSources ?? 4)));
  const queryTerms = tokenizeRetrievalText(query).slice(0, 16);
  const root = await hydrateMemoryEvidence({
    stateRoot: input.stateRoot,
    accountId: input.accountId,
    evidenceRef: input.evidenceRef
  });
  const jobs = await listDistillationJobs(input.stateRoot, input.accountId, true);
  const rootJob = revisionJobFromRef(jobs, root.evidence_ref);
  const direct = rankWhyEvidence(rootJob?.evidence ?? [], queryTerms).slice(0, maxSources);
  const supporting: Array<{ item: DistillationEvidenceItem; matched: string[] }> = [];
  const seen = new Set(direct.map(({ item }) => item.ref));
  for (const { item } of direct) {
    const sourceJob = revisionJobFromRef(jobs, item.ref);
    if (!sourceJob) continue;
    for (const candidate of rankWhyEvidence(sourceJob.evidence, queryTerms).slice(0, 2)) {
      if (seen.has(candidate.item.ref)) continue;
      seen.add(candidate.item.ref);
      supporting.push(candidate);
      if (supporting.length >= maxSources) break;
    }
    if (supporting.length >= maxSources) break;
  }

  return {
    evidence_ref: root.evidence_ref,
    query,
    root: {
      layer: root.layer,
      project_id: root.project_id,
      title: root.title,
      committed_at: root.committed_at,
      content_preview: whySnippet(root.content, queryTerms, 2400),
      source_evidence_count: root.source_evidence_refs.length
    },
    direct_evidence: direct.map(({ item, matched }) => whyEvidenceItem(item, matched, queryTerms, 900)),
    supporting_evidence: supporting.map(({ item, matched }) => whyEvidenceItem(item, matched, queryTerms, 700)),
    causal_review_contract: {
      classifications: ["direct_reason", "context_supported_candidate", "unknown"],
      direct_reason: "Use only when the source itself explicitly states the reason/cause.",
      context_supported_candidate: "Use when chronology, constraints, or tradeoffs support a causal reading but the source does not explicitly state it; keep it provisional.",
      unknown: "Use when evidence is insufficient, conflicting, or only temporally adjacent.",
      temporal_adjacency_is_not_causality: true,
      preferred_sequence: ["prior_state_or_plan", "trigger", "constraint", "tradeoff", "decision", "execution_or_reversal"]
    },
    persistence: "none",
    note: "This is a bounded evidence view. Memhub does not store the Harness causal judgement as a new memory layer."
  };
}

export async function recordMemoryHydration(input: {
  stateRoot: string;
  accountId: string;
  item: HydratedMemoryEvidence;
}): Promise<MemoryHydrationTelemetrySummary> {
  const path = telemetryPath(input.stateRoot, input.accountId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const event: MemoryHydrationEvent = {
    event_id: randomUUID(),
    evidence_ref: input.item.evidence_ref,
    layer: input.item.layer,
    project_id: input.item.project_id,
    estimated_tokens: input.item.estimated_tokens,
    timestamp: new Date().toISOString()
  };
  await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  return memoryHydrationTelemetrySummary(input.stateRoot, input.accountId, input.item.evidence_ref);
}

export async function memoryHydrationTelemetrySummary(
  stateRoot: string,
  accountId: string,
  evidenceRef: string
): Promise<MemoryHydrationTelemetrySummary> {
  const events = await readTelemetry(telemetryPath(stateRoot, accountId));
  const matching = events.filter((event) => event.evidence_ref === evidenceRef);
  return {
    evidence_ref: evidenceRef,
    hydrations: matching.length,
    total_estimated_tokens: matching.reduce((sum, event) => sum + event.estimated_tokens, 0),
    last_hydrated_at: matching.at(-1)?.timestamp ?? null
  };
}

function titleFromContent(content: string, fallback: string): string {
  const heading = content.split(/\r?\n/).map((line) => line.trim()).find((line) => /^#{1,3}\s+/.test(line));
  return heading?.replace(/^#{1,3}\s+/, "").trim() || fallback;
}

function revisionJobFromRef(jobs: readonly DistillationJob[], ref: string): DistillationJob | undefined {
  const match = /^(l2|l3|l4):([^:]+):([^:]+)$/.exec(ref.trim());
  if (!match) return undefined;
  const target = match[1]!;
  const resultId = match[2]!;
  const revisionId = match[3]!;
  return jobs.find((job) =>
    job.job_id === revisionId &&
    job.status === "completed" &&
    job.target === target &&
    job.result_kind === target &&
    job.result_id === resultId
  );
}

function rankWhyEvidence(
  evidence: readonly DistillationEvidenceItem[],
  queryTerms: readonly string[]
): Array<{ item: DistillationEvidenceItem; matched: string[] }> {
  return evidence.map((item) => {
    const text = evidenceText(item).normalize("NFKC").toLocaleLowerCase();
    const matched = queryTerms.filter((term) => text.includes(term));
    return { item, matched };
  }).sort((left, right) =>
    right.matched.length - left.matched.length ||
    right.item.timestamp.localeCompare(left.item.timestamp) ||
    left.item.ref.localeCompare(right.item.ref)
  );
}

function whyEvidenceItem(
  item: DistillationEvidenceItem,
  matched: string[],
  queryTerms: readonly string[],
  maxChars: number
): MemoryWhyEvidenceItem {
  return {
    evidence_ref: item.ref,
    layer: item.layer ?? null,
    timestamp: item.timestamp,
    project_id: item.project_id ?? null,
    title: item.title ?? null,
    content_preview: whySnippet(evidenceText(item), queryTerms, maxChars),
    matched_terms: matched
  };
}

function evidenceText(item: DistillationEvidenceItem): string {
  return [item.content, item.user_text, item.assistant_text, item.reasoning_summary]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n")
    .trim();
}

function whySnippet(value: string, queryTerms: readonly string[], maxChars: number): string {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  const lower = text.normalize("NFKC").toLocaleLowerCase();
  const positions = queryTerms
    .map((term) => lower.indexOf(term))
    .filter((position) => position >= 0);
  const anchor = positions.length > 0 ? Math.min(...positions) : 0;
  const start = Math.max(0, Math.min(text.length - maxChars, anchor - Math.floor(maxChars / 3)));
  const end = Math.min(text.length, start + maxChars);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 4));
}

function telemetryPath(stateRoot: string, accountId: string): string {
  const hash = createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 24);
  return join(resolve(stateRoot), "telemetry", `memory-hydration-${hash}.jsonl`);
}

export async function attachExactEvidenceRefsToContext(
  stateRoot: string,
  runtime: MemhubRuntime,
  capsule: { globalMemory: ContextItem[]; projectMemory: ContextItem[] }
): Promise<void> {
  await attachExactDistillationEvidenceRefs({
    stateRoot, accountId: runtime.accountId,
    items: [...capsule.globalMemory, ...capsule.projectMemory],
    readMemory: (id) => runtime.memoryClient.viewerGet(`/api/v1/memory/${encodeURIComponent(id)}`)
  });
}

async function readTelemetry(path: string): Promise<MemoryHydrationEvent[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const value = JSON.parse(line) as Partial<MemoryHydrationEvent>;
      return typeof value.evidence_ref === "string" && typeof value.estimated_tokens === "number" && typeof value.timestamp === "string"
        ? [value as MemoryHydrationEvent]
        : [];
    } catch {
      return [];
    }
  });
}
