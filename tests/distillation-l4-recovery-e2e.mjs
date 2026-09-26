import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  completeDistillationJob,
  enqueueDerivedDistillationJob,
  latestCompletedL3ByProject,
  leaseDistillationJob,
  listDistillationJobs
} from "../dist/distillation-jobs.js";
import { auditDistillationPipeline } from "../dist/distillation-audit.js";
import { reconcileCurrentL4DerivedJob } from "../dist/distillation-derived-recovery.js";

const root = await mkdtemp(join(tmpdir(), "memhub-l4-recovery-"));
const accountId = "l4-recovery-account";
const harness = "l4-recovery-harness";
const jobsPath = join(root, "distillation", "jobs.json");

const completionOrderFixture = [
  {
    job_id: "newer-created-finished-first", account_id: accountId,
    target: "l3", scope: "project", project_id: "order-project",
    status: "completed", reason: "upstream",
    created_at: "2026-09-26T00:00:02.000Z",
    updated_at: "2026-09-26T00:00:06.000Z",
    completed_at: "2026-09-26T00:00:06.000Z",
    result_committed_at: "2026-09-26T00:00:03.000Z",
    result_kind: "l3", result_id: "l3-new-created",
    result_content: "Completed first.",
    evidence_refs: ["l2:new"], evidence_hash: "new", evidence: []
  },
  {
    job_id: "older-created-finished-last", account_id: accountId,
    target: "l3", scope: "project", project_id: "order-project",
    status: "completed", reason: "upstream",
    created_at: "2026-09-26T00:00:01.000Z",
    updated_at: "2026-09-26T00:00:05.000Z",
    completed_at: "2026-09-26T00:00:05.000Z",
    result_committed_at: "2026-09-26T00:00:04.000Z",
    result_kind: "l3", result_id: "l3-old-created-late-write",
    result_content: "Completed last and therefore current.",
    evidence_refs: ["l2:old"], evidence_hash: "old", evidence: []
  }
];
assert.equal(
  latestCompletedL3ByProject(completionOrderFixture)[0].job_id,
  "older-created-finished-last",
  "current L3 must follow the frozen Core response/write order, not job creation or later local lock completion"
);

async function completeL3(projectId, suffix, content) {
  const queued = await enqueueDerivedDistillationJob({
    stateRoot: root,
    accountId,
    target: "l3",
    projectId,
    evidence: [{
      ref: `l2:${projectId}:${suffix}`,
      kind: "artifact",
      layer: "L2",
      timestamp: `2026-09-26T00:0${suffix}.000Z`,
      project_id: projectId,
      content: `L2 source ${projectId} ${suffix}`
    }]
  });
  const lease = await leaseDistillationJob(root, accountId, {
    projectId, target: "l3", harness, useLeaseToken: true
  });
  assert.equal(lease.job_id, queued.job.job_id);
  const completed = await completeDistillationJob(
    root, accountId, lease.job_id,
    { kind: "l3", resultId: `l3-result-${projectId}-${suffix}`, content },
    harness, lease.lease_token
  );
  return completed;
}

try {
  const alphaV1 = await completeL3("alpha", "1", "Alpha current project rules v1.");
  const betaV1 = await completeL3("beta", "2", "Beta current project rules v1.");
  let audit = await auditDistillationPipeline({
    stateRoot: root, accountId, bridgeRoot: null,
    resolveProject: async (hint) => hint
  });
  assert.equal(audit.recovery.current_l3_set_missing_l4, 1);
  assert.equal(audit.recovery.current_l3_set_conflicting_l4, 0);
  assert.equal(audit.review_samples.current_l3_set_l4.reason, "missing_claim");

  const recoveryInput = {
    stateRoot: root, accountId, jobId: betaV1.job_id
  };
  const dryRun = await reconcileCurrentL4DerivedJob({ ...recoveryInput, dryRun: true });
  assert.equal(dryRun.already_queued, false);
  assert.equal(dryRun.core_replayed, false);
  assert.deepEqual(dryRun.current_projects, ["alpha", "beta"]);
  assert.equal((await listDistillationJobs(root, accountId)).filter((job) => job.target === "l4").length, 0);

  const [first, second] = await Promise.all([
    reconcileCurrentL4DerivedJob({ ...recoveryInput, dryRun: false }),
    reconcileCurrentL4DerivedJob({ ...recoveryInput, dryRun: false })
  ]);
  assert.equal(first.derived_job_id, second.derived_job_id,
    "concurrent L4 recovery must converge to one durable claim");
  assert.equal(first.core_replayed, false);
  const firstL4Jobs = (await listDistillationJobs(root, accountId))
    .filter((job) => job.target === "l4");
  assert.equal(firstL4Jobs.length, 1);
  assert.equal((await reconcileCurrentL4DerivedJob({ ...recoveryInput, dryRun: false })).already_queued, true);

  audit = await auditDistillationPipeline({
    stateRoot: root, accountId, bridgeRoot: null,
    resolveProject: async (hint) => hint
  });
  assert.equal(audit.recovery.current_l3_set_missing_l4, 0);
  assert.equal(audit.recovery.current_l3_set_conflicting_l4, 0);
  assert.equal(audit.review_samples.current_l3_set_l4, null);

  const alphaV2 = await completeL3("alpha", "3", "Alpha current project rules v2.");
  await assert.rejects(
    reconcileCurrentL4DerivedJob({
      stateRoot: root, accountId, jobId: alphaV1.job_id, dryRun: false
    }),
    /not the current latest result/
  );
  const v2DryRun = await reconcileCurrentL4DerivedJob({
    stateRoot: root, accountId, jobId: betaV1.job_id, dryRun: true
  });
  assert.equal(v2DryRun.already_queued, false,
    "a newer L3 version must require a new current-set L4 claim");
  const v2Repair = await reconcileCurrentL4DerivedJob({
    stateRoot: root, accountId, jobId: alphaV2.job_id, dryRun: false
  });
  assert.notEqual(v2Repair.derived_job_id, first.derived_job_id);
  assert.equal((await listDistillationJobs(root, accountId)).filter((job) => job.target === "l4").length, 2);

  const originalStore = await readFile(jobsPath);
  try {
    const corrupt = JSON.parse(originalStore.toString("utf8"));
    const currentL4 = corrupt.jobs.find((job) => job.job_id === v2Repair.derived_job_id);
    currentL4.evidence[0].content = "forged L3 body with a reused reference";
    await writeFile(jobsPath, JSON.stringify(corrupt));
    const conflict = await auditDistillationPipeline({
      stateRoot: root, accountId, bridgeRoot: null,
      resolveProject: async (hint) => hint
    });
    assert.equal(conflict.recovery.current_l3_set_missing_l4, 0);
    assert.equal(conflict.recovery.current_l3_set_conflicting_l4, 1);
    assert.equal(conflict.review_samples.current_l3_set_l4.reason, "evidence_mismatch");
    await assert.rejects(
      reconcileCurrentL4DerivedJob({
        stateRoot: root, accountId, jobId: betaV1.job_id, dryRun: true
      }),
      /differs from current completed L3 provenance/
    );
  } finally {
    await writeFile(jobsPath, originalStore);
  }
  try {
    const contaminated = JSON.parse(originalStore.toString("utf8"));
    const currentL4 = contaminated.jobs.find((job) => job.job_id === v2Repair.derived_job_id);
    currentL4.evidence.push({
      ...currentL4.evidence[0],
      ref: "l3:foreign-result:foreign-job",
      content: "Extra foreign project material hidden behind an otherwise matching ref set."
    });
    await writeFile(jobsPath, JSON.stringify(contaminated));
    const conflict = await auditDistillationPipeline({
      stateRoot: root, accountId, bridgeRoot: null,
      resolveProject: async (hint) => hint
    });
    assert.equal(conflict.recovery.current_l3_set_conflicting_l4, 1);
    assert.equal(conflict.review_samples.current_l3_set_l4.reason, "evidence_mismatch");
    await assert.rejects(
      reconcileCurrentL4DerivedJob({
        stateRoot: root, accountId, jobId: betaV1.job_id, dryRun: true
      }),
      /differs from current completed L3 provenance/,
      "extra foreign evidence must not be accepted as an exact L4 claim"
    );
  } finally {
    await writeFile(jobsPath, originalStore);
  }
  console.log("distillation-l4-recovery-e2e: ok (dry-run, concurrent claim, latest-source fence, conflict audit)");
} finally {
  await rm(root, { recursive: true, force: true });
}
