import { distillationContract } from "./distillation-contract.js";
import type { DistillationJob } from "./distillation-jobs.js";

/** Preserve legacy inline and chunked MCP evidence payloads across handler refactors. */
export function distillationNextPayload(
  job: DistillationJob,
  evidenceOffset: number,
  evidenceChunkChars: number
): Record<string, unknown> {
  const evidenceDocument = distillationEvidenceDocument(job);
  if (evidenceOffset > evidenceDocument.length) {
    throw new TypeError(`evidence_offset exceeds evidence length ${evidenceDocument.length}`);
  }
  const inline = evidenceOffset === 0 && evidenceDocument.length <= 120_000;
  if (inline) {
    return {
      job,
      contract: distillationContract(),
      evidence_transport: {
        mode: "inline",
        total_chars: evidenceDocument.length,
        complete: true
      },
      instructions: job.target === "l2"
        ? "Produce the requested L2 artifact from the supplied L1 evidence. First load the current canonical L2 from Memhub, preserve its existing timeline events and superseded history, then merge the new evidence into one full canonical timeline replacement. Never submit a delta-only L2 body. If evidence is insufficient, call action=skip with job_id."
        : `Produce only the requested ${job.target.toUpperCase()} artifact from the supplied evidence. Read current Memhub context first so the result updates the canonical artifact rather than duplicating it. If evidence is insufficient for this layer, call action=skip with job_id.`
    };
  }

  const end = Math.min(evidenceDocument.length, evidenceOffset + evidenceChunkChars);
  const nextOffset = end < evidenceDocument.length ? end : null;
  const manifest = job.evidence.map((item) => {
    const { content, user_text, assistant_text, reasoning_summary, ...metadata } = item;
    return {
      ...metadata,
      text_chars: {
        ...(content !== undefined ? { content: content.length } : {}),
        ...(user_text !== undefined ? { user_text: user_text.length } : {}),
        ...(assistant_text !== undefined ? { assistant_text: assistant_text.length } : {}),
        ...(reasoning_summary !== undefined ? { reasoning_summary: reasoning_summary.length } : {})
      }
    };
  });
  return {
    job: { ...job, evidence: manifest },
    contract: distillationContract(),
    evidence_transport: {
      mode: "chunked",
      offset: evidenceOffset,
      next_offset: nextOffset,
      total_chars: evidenceDocument.length,
      chunk_chars: end - evidenceOffset,
      complete: nextOffset === null
    },
    evidence_chunk: evidenceDocument.slice(evidenceOffset, end),
    instructions: nextOffset === null
      ? (job.target === "l2"
        ? `All evidence chunks for ${job.job_id} have been read. Load the current canonical L2, preserve its prior timeline events, and merge this evidence into one full canonical replacement; never submit a delta-only L2 body. Call action=skip if the evidence is insufficient.`
        : `All evidence chunks for ${job.job_id} have been read. Produce only the requested ${job.target.toUpperCase()} artifact, or call action=skip if the evidence is insufficient.`)
      : `This job uses chunked evidence. Keep the same lease owner and call action=next with job_id=${job.job_id}, source_harness=${job.leased_by ?? "<same-harness>"}, evidence_offset=${nextOffset}. Do not submit until evidence_transport.complete=true.`
  };
}

export function distillationEvidenceDocument(job: DistillationJob): string {
  return job.evidence.map((item, index) => {
    const lines = [
      `--- evidence ${index + 1}/${job.evidence.length} ---`,
      `ref: ${item.ref}`,
      `kind: ${item.kind}`,
      `timestamp: ${item.timestamp}`,
      ...(item.layer ? [`layer: ${item.layer}`] : []),
      ...(item.project_id ? [`project_id: ${item.project_id}`] : []),
      ...(item.conversation_id ? [`conversation_id: ${item.conversation_id}`] : []),
      ...(item.title ? [`title: ${item.title}`] : [])
    ];
    if (item.content !== undefined) lines.push("content:", item.content);
    if (item.user_text !== undefined) lines.push("user_text:", item.user_text);
    if (item.assistant_text !== undefined) lines.push("assistant_text:", item.assistant_text);
    if (item.reasoning_summary !== undefined) lines.push("reasoning_summary:", item.reasoning_summary);
    return lines.join("\n");
  }).join("\n\n");
}
