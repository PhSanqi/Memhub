import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { listCaptureEvents } from "./capture.js";
import { distillationResultTimestamp, listDistillationJobs } from "./distillation-jobs.js";

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
  const jobs = await listDistillationJobs(input.stateRoot, input.accountId);
  const job = jobs.find((candidate) =>
    candidate.job_id === revisionId &&
    candidate.status === "completed" &&
    candidate.target === prefix &&
    candidate.result_kind === prefix &&
    candidate.result_id === memoryId &&
    Boolean(candidate.result_content?.trim())
  );
  if (!job?.result_content) throw new Error(`exact Memory revision not found: ${ref}`);
  const content = job.result_content.trim();
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

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 4));
}

function telemetryPath(stateRoot: string, accountId: string): string {
  const hash = createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 24);
  return join(resolve(stateRoot), "telemetry", `memory-hydration-${hash}.jsonl`);
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
