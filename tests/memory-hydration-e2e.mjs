import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordCompletedDistillationRevision } from "../dist/distillation-jobs.js";
import { hydrateMemoryEvidence, recordMemoryHydration } from "../dist/memory-hydration.js";

const root = await mkdtemp(join(tmpdir(), "memhub-memory-hydration-"));
try {
  const accountId = "account-a";
  const job = await recordCompletedDistillationRevision({
    stateRoot: root,
    accountId,
    target: "l2",
    projectId: "memhub",
    conversationId: "conversation-a",
    evidence: [{ ref: "l1:event-a", kind: "memory", layer: "L1", timestamp: "2026-10-09T00:00:00.000Z", project_id: "memhub", content: "source" }],
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

  const first = await recordMemoryHydration({ stateRoot: root, accountId, item: hydrated });
  const second = await recordMemoryHydration({ stateRoot: root, accountId, item: hydrated });
  assert.equal(first.hydrations, 1);
  assert.equal(second.hydrations, 2);
  assert.equal(second.total_estimated_tokens, hydrated.estimated_tokens * 2);
  console.log("memory-hydration-e2e: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
