export const DISTILLATION_CONTRACT_VERSION = "memhub-distill-v1";

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
  kind: "skill" | "summary" | "knowledge";
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
      "Prefer a compact durable artifact over copying raw conversation text."
    ]
  };
}
