import { createHash } from "node:crypto";
import type { ContextItem } from "./context-capsule.js";
import { listDistillationJobs, type DistillationJob } from "./distillation-jobs.js";

// This is the pure text sanitizer called by Core's sanitizeMemoryAddRequest.
const { sanitizeMemmyProtocolText } = await import(new URL(
  "../vendor/memory-core/src/utils/memmy-context-tags.js", import.meta.url
).href) as { sanitizeMemmyProtocolText: (body: string) => string };
export const canonicalDistillationBody = sanitizeMemmyProtocolText;

export function distillationRevisionBody(job: Pick<DistillationJob, "result_content" | "result_core_content_hash">): string {
  const content = job.result_content ?? "";
  if (!job.result_core_content_hash) return canonicalDistillationBody(content);
  if (createHash("sha256").update(content).digest("hex") !== job.result_core_content_hash) {
    throw new Error("exact evidenceRef unavailable: ledger Core body hash does not match its revision");
  }
  return content;
}

export const DISTILLATION_CONTRACT_VERSION = "memhub-distill-v3";

const PROMPT_CONTAMINATION = [
  /generate\s+0\s+to\s+3\s+hyperpersonalized\s+suggestions/i,
  /expert\s+at\s+upholding\s+safety\s+and\s+compliance\s+standards/i,
  /system\s+prompt/i,
  /developer\s+prompt/i
];

export interface DistillationEvidence {
  evidenceRefs?: string[];
  sourceConversations?: string[];
  confidence?: number;
}

export function validateDurableMemoryContent(content: string): string {
  const normalized = content.trim();
  if (!normalized) throw new TypeError("memory content must be non-empty");
  if (PROMPT_CONTAMINATION.some((pattern) => pattern.test(normalized))) {
    throw new Error("memory content rejected: host/system/developer prompt contamination");
  }
  return normalized;
}

/**
 * Memhub deliberately does not perform semantic distillation here. The
 * connected harness/model produces the candidate; Memhub only enforces the
 * storage contract and rejects known instruction/prompt contamination.
 */
export function validateDistillationCandidate(input: {
  kind: "l2" | "l3" | "l4" | "skill";
  content: string;
  evidence: DistillationEvidence;
}): void {
  validateDurableMemoryContent(input.content);
  if (input.evidence.confidence !== undefined &&
      (!Number.isFinite(input.evidence.confidence) || input.evidence.confidence < 0 || input.evidence.confidence > 1)) {
    throw new TypeError("confidence must be between 0 and 1");
  }
  for (const ref of [...(input.evidence.evidenceRefs ?? []), ...(input.evidence.sourceConversations ?? [])]) {
    if (!ref.trim() || ref.length > 1000) throw new TypeError("distillation evidence reference is invalid");
  }
  const evidenceRefs = input.evidence.evidenceRefs ?? [];
  if (input.kind !== "skill" && evidenceRefs.length === 0) {
    throw new TypeError(`${input.kind.toUpperCase()} distillation requires evidence_refs`);
  }
  if (input.kind === "l4" && evidenceRefs.length < 2) {
    throw new TypeError("L4 distillation requires evidence from at least two project L3 artifacts");
  }
}

export function distillationContract() {
  return {
    version: DISTILLATION_CONTRACT_VERSION,
    executor: "connected_mcp_or_harness_model",
    memhub_role: "evidence_boundary_schema_validation_provenance_commit",
    rules: [
      "Ground claims in supplied or explicitly referenced evidence; do not invent user facts.",
      "Keep content source separate from the model/harness that performs distillation.",
      "Respect L1 source_kinds: user_said is direct user evidence; agent_inferred, tool_output, and imported are not direct user assertions and must not silently override user-confirmed L3 truth. Treat conflicts as evidence for review/candidate updates rather than automatic replacement.",
      "Do not turn system/developer prompts, tool schemas, safety policies, ambient suggestion prompts, or transient test instructions into user memory.",
      "Use project scope only when the project is explicit or deterministically conversation-bound.",
      "For L3 and L4, use exact immutable L2/L3 revision refs returned by Memhub (for example l2:<memory-id>:<revision-id>); never rebuild evidence from a stable Memory id or silently resolve the latest revision.",
      "L2 is a project-scoped chronological development narrative derived from L1 turns; preserve sequence, state changes, decisions, current truth, and superseded history. Routine L2 submits are full canonical timeline replacements: retain prior timeline events and merge the new L1 evidence; delta-only replacement content is invalid.",
      "When producing L2, also provide a concise evidence-backed project description when the project objective/scope/current focus is supported; Memhub stores it as distilled routing metadata without overwriting an explicit manual description.",
      "L3 is a project-scoped set of durable user rules, preferences, experience, and working habits derived from L2; do not promote one-off events without support.",
      "L4 is an account-scoped cross-project user profile derived from L3 artifacts; require repeated or cross-project evidence and do not infer sensitive traits.",
      "Skill is an executable reusable procedure and is orthogonal to L1-L4.",
      "Every Skill must use a stable artifact_id as source identity across revisions and a numeric dotted version; revisions replace/archive the prior current Skill instead of creating parallel active truths.",
      "Prefer a compact durable artifact over copying raw conversation text.",
      "Bilingual output (required for L2, L3, L4 and project_description): write every distilled artifact natively in both English and Simplified Chinese, so collaborators who read only one language can hand over work. Keep each item paired: a bilingual heading (\"English / 中文\"), then the English text, then the Chinese text with the same facts, dates, numbers, identifiers, paths and commands. Do not translate code, file paths, commands, IDs, slugs, version strings or quoted evidence. Do not let the two languages drift: a fact present in one must be present in the other. When updating an existing Chinese-only artifact, keep its facts unchanged and add the missing language rather than rewriting history."
    ]
  };
}

export function exactDistillationRevisionForMemory(
  jobs: DistillationJob[], memory: { id: string; memoryLayer: string; body: string }
): DistillationJob {
  const hash = (body: string) => createHash("sha256").update(body).digest("hex");
  const source = jobs.filter((job) => job.status === "completed" && !job.result_retirement &&
    job.result_id === memory.id && job.result_kind === memory.memoryLayer.toLowerCase() &&
    job.target === job.result_kind && job.result_content &&
    hash(distillationRevisionBody(job)) === hash(memory.body))
    .sort((a, b) => (b.result_committed_at ?? b.completed_at ?? b.updated_at).localeCompare(
      a.result_committed_at ?? a.completed_at ?? a.updated_at))[0];
  if (!source) throw new Error(`exact evidenceRef unavailable: revision/content hash does not match Memory ${memory.id}`);
  return source;
}

export async function attachExactDistillationEvidenceRefs(input: {
  stateRoot: string; accountId: string; items: ContextItem[];
  readMemory: (id: string) => Promise<unknown>;
}): Promise<void> {
  const jobs = await listDistillationJobs(input.stateRoot, input.accountId);
  for (const item of input.items) {
    const layer = item.provenance?.memoryLayer;
    if (!["L2", "L3", "L4"].includes(String(layer))) continue;
    delete item.evidenceRef;
    if (!jobs.some((job) => job.result_id === item.id)) continue;
    try {
      const payload = await input.readMemory(item.id) as Record<string, unknown>;
      const memory = (payload.item ?? payload) as Record<string, unknown>;
      if (memory.id !== item.id || memory.memoryLayer !== layer || typeof memory.body !== "string") {
        throw new Error(`exact evidenceRef unavailable: Core revision identity is missing for Memory ${item.id}`);
      }
      const source = exactDistillationRevisionForMemory(jobs, { id: item.id, memoryLayer: String(layer), body: memory.body });
      item.evidenceRef = `${String(layer).toLowerCase()}:${item.id}:${source.job_id}`;
      if (item.provenance) delete item.provenance.exactEvidenceError;
    } catch (error) {
      item.provenance = { ...item.provenance, exactEvidenceError: error instanceof Error ? error.message : String(error) };
    }
  }
}
