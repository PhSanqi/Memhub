export const DISTILLATION_CONTRACT_VERSION = "memhub-distill-v2";

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
  const content = input.content.trim();
  if (!content) throw new TypeError("distillation content must be non-empty");
  if (PROMPT_CONTAMINATION.some((pattern) => pattern.test(content))) {
    throw new Error("distillation rejected: host/system/developer prompt contamination");
  }
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
      "Do not turn system/developer prompts, tool schemas, safety policies, ambient suggestion prompts, or transient test instructions into user memory.",
      "Use project scope only when the project is explicit or deterministically conversation-bound.",
      "L2 is a project-scoped chronological development narrative derived from L1 turns; preserve sequence, state changes, decisions, current truth, and superseded history.",
      "When producing L2, also provide a concise evidence-backed project description when the project objective/scope/current focus is supported; Memhub stores it as distilled routing metadata without overwriting an explicit manual description.",
      "L3 is a project-scoped set of durable user rules, preferences, experience, and working habits derived from L2; do not promote one-off events without support.",
      "L4 is an account-scoped cross-project user profile derived from L3 artifacts; require repeated or cross-project evidence and do not infer sensitive traits.",
      "Skill is an executable reusable procedure and is orthogonal to L1-L4.",
      "Prefer a compact durable artifact over copying raw conversation text."
    ]
  };
}
