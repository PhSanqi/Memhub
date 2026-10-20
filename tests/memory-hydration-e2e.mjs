import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordCompletedDistillationRevision } from "../dist/distillation-jobs.js";
import { explainMemoryWhy, hydrateMemoryEvidence, recordMemoryHydration } from "../dist/memory-hydration.js";

const root = await mkdtemp(join(tmpdir(), "memhub-memory-hydration-"));
try {
  const accountId = "account-a";
  const job = await recordCompletedDistillationRevision({
    stateRoot: root,
    accountId,
    target: "l2",
    projectId: "memhub",
    conversationId: "conversation-a",
    evidence: [{
      ref: "l1:event-a",
      kind: "memory",
      layer: "L1",
      timestamp: "2026-10-09T00:00:00.000Z",
      project_id: "memhub",
      content: "user: Keep Memhub simple because extra services add unnecessary overhead."
    }],
    resultId: "timeline-a",
    content: "# Memhub Timeline\n\n## 2026-10-09\nProgressive disclosure shipped.",
    committedAt: "2026-10-09T00:01:00.000Z"
  });
  const ref = `l2:timeline-a:${job.job_id}`;
  const hydrated = await hydrateMemoryEvidence({ stateRoot: root, accountId, evidenceRef: ref });
  assert.equal(hydrated.evidence_ref, ref);
  assert.equal(hydrated.layer, "L2");
  assert.equal(hydrated.project_id, "memhub");
  assert.match(hydrated.content, /Progressive disclosure shipped/);
  assert.ok(hydrated.estimated_tokens > 0);

  const l3Job = await recordCompletedDistillationRevision({
    stateRoot: root,
    accountId,
    target: "l3",
    projectId: "memhub",
    evidence: [{
      ref,
      kind: "artifact",
      layer: "L2",
      timestamp: hydrated.committed_at,
      project_id: "memhub",
      title: hydrated.title,
      content: hydrated.content
    }],
    resultId: "profile-a",
    content: "# Memhub Rules\n\nKeep the memory system minimal and avoid unnecessary service layers.",
    committedAt: "2026-10-09T00:02:00.000Z"
  });
  const why = await explainMemoryWhy({
    stateRoot: root,
    accountId,
    evidenceRef: `l3:profile-a:${l3Job.job_id}`,
    query: "why keep Memhub simple extra services overhead",
    maxSources: 4
  });
  assert.equal(why.persistence, "none");
  assert.equal(why.causal_review_contract.temporal_adjacency_is_not_causality, true);
  assert.equal(why.direct_evidence[0].evidence_ref, ref);
  assert.ok(why.supporting_evidence.some((item) => item.evidence_ref === "l1:event-a"));
  assert.ok(why.supporting_evidence.some((item) => /extra services add unnecessary overhead/.test(item.content_preview)));

  const first = await recordMemoryHydration({ stateRoot: root, accountId, item: hydrated });
  const second = await recordMemoryHydration({ stateRoot: root, accountId, item: hydrated });
  assert.equal(first.hydrations, 1);
  assert.equal(second.hydrations, 2);
  assert.equal(second.total_estimated_tokens, hydrated.estimated_tokens * 2);
  console.log("memory-hydration-e2e: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
