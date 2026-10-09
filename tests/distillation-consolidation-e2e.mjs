import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordCompletedDistillationRevision } from "../dist/distillation-jobs.js";
import { planDistillationConsolidation } from "../dist/distillation-consolidation.js";

const root = await mkdtemp(join(tmpdir(), "memhub-consolidation-"));
try {
  const accountId = "account-a";
  const runtime = {
    accountId,
    projects: {
      async resolve(_accountId, projectId) { return projectId === "memhub" ? "memhub" : null; },
      async storageIds() { return ["memhub"]; }
    }
  };
  for (let index = 0; index < 2; index += 1) {
    await recordCompletedDistillationRevision({
      stateRoot: root,
      accountId,
      target: "l2",
      projectId: "memhub",
      evidence: [{ ref: `l1:event-${index}`, kind: "memory", layer: "L1", timestamp: `2026-10-0${index + 1}T00:00:00.000Z`, project_id: "memhub", content: `event ${index}` }],
      resultId: "timeline-a",
      content: `# Timeline\n\nrevision ${index}`,
      committedAt: `2026-10-0${index + 1}T00:01:00.000Z`
    });
  }
  const plan = await planDistillationConsolidation({ stateRoot: root, runtime, kind: "l2", projectId: "memhub" });
  assert.equal(plan.eligible, true);
  assert.equal(plan.historical_revision_count, 2);
  assert.deepEqual(plan.submit_evidence_refs.sort(), ["l1:event-0", "l1:event-1"]);
  assert.equal(plan.canonical_artifact_id, "project-timeline:memhub");
  assert.equal(plan.strategy, "select_merge_reextract_supersede");
  console.log("distillation-consolidation-e2e: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
