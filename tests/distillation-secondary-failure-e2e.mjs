import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  completeDistillationJob,
  enqueueLegacyL1DistillationJob,
  leaseDistillationJob,
  listDistillationJobs,
  retryDistillationJob
} from "../dist/distillation-jobs.js";
import { submitDistillationControl } from "../dist/distillation-submit.js";
import { auditDistillationPipeline } from "../dist/distillation-audit.js";
import { reconcileCompletedL2DerivedJob } from "../dist/distillation-derived-recovery.js";

const root = await mkdtemp(join(tmpdir(), "memhub-distill-side-effect-"));
const accountId = "secondary-failure-test-account";
const projectId = "secondary-failure-test-project";
const harness = "secondary-failure-test-harness";
const jobsPath = join(root, "distillation", "jobs.json");
let coreWrites = 0;
let descriptions = 0;
let firstJobId;
const makeEvidence = (name) => [{
  ref: `l1:${name}`, kind: "turn", layer: "L1",
  timestamp: "2026-09-26T00:00:00.000Z", project_id: projectId,
  user_text: "Source evidence", assistant_text: "Recorded response"
}];
async function submit(job, runtime, description, enqueueDerived) {
  return submitDistillationControl({
    args: {
      job_id: job.job_id,
      content: "Source-grounded project chronology from the supplied turn.",
      project_description: description
    },
    stateRoot: root,
    runtime,
    sourceHarness: harness,
    leaseToken: job.lease_token,
    ...(enqueueDerived ? { enqueueDerived } : {}),
    resolveToolScope: async () => ({ projectId, resolutionSource: "explicit" }),
    validateDistillationEvidenceChain: async () => {}
  });
}
async function lease(name) {
  const queued = await enqueueLegacyL1DistillationJob({
    stateRoot: root, accountId, projectId, evidence: makeEvidence(name)
  });
  assert.equal(queued.created, true);
  return leaseDistillationJob(root, accountId, {
    harness, projectId, target: "l2", useLeaseToken: true
  });
}
async function expireLease(jobId) {
  return setLeaseUntil(jobId, "2000-01-01T00:00:00.000Z");
}
async function setLeaseUntil(jobId, value) {
  const store = JSON.parse(await readFile(jobsPath, "utf8"));
  const job = store.jobs.find((item) => item.job_id === jobId);
  assert.ok(job);
  job.leased_until = value;
  await writeFile(jobsPath, JSON.stringify(store));
}
const runtime = {
  accountId, userId: "local-user",
  source: {
    platform: "test", transport: "test",
    principalId: "test", connectionId: "test", authenticatedAccount: accountId
  },
  memory: {
    distill: async () => {
      coreWrites++;
      return { id: "durable-l2-result" };
    }
  },
  projects: {
    resolve: async () => projectId,
    updateDistilledDescription: async () => {
      descriptions++;
      if (firstJobId) {
        const durableJobs = await listDistillationJobs(root, accountId);
        assert.equal(durableJobs.find((job) => job.job_id === firstJobId).status, "completed",
          "optional metadata must run only after the source job is durably completed");
        assert.ok(durableJobs.some((job) => job.target === "l3"),
          "optional metadata must run only after the child claim was attempted");
      }
      throw new Error("injected secondary project metadata outage");
    }
  }
};
try {
  const first = await lease("first");
  firstJobId = first.job_id;
  const originalError = console.error;
  const diagnostic = [];
  console.error = (...args) => diagnostic.push(args.map(String).join(" "));
  let response;
  try {
    response = await submit(first, runtime, "Project metadata derived from verified L1.");
  } finally {
    console.error = originalError;
  }
  assert.equal(coreWrites, 1);
  assert.equal(descriptions, 1);
  assert.equal(response.ok, true);
  assert.equal(response.memory.id, "durable-l2-result");
  assert.match(response.project_description_error, /secondary project metadata outage/);
  assert.equal(response.next_layer_job.job.target, "l3",
    "an optional metadata write must not suppress the durable L2 -> L3 chain");
  assert.ok(diagnostic.some((line) => line.includes("distilled project description update failed")));
  const jobs = await listDistillationJobs(root, accountId);
  assert.equal(jobs.find((job) => job.job_id === first.job_id).status, "completed",
    "a secondary metadata outage must not mark the durable Core write failed");
  assert.equal(jobs.filter((job) => job.target === "l3").length, 1);

  const failedCore = await lease("second");
  runtime.memory.distill = async () => {
    coreWrites++;
    throw new Error("injected Core write failed before commit");
  };
  await assert.rejects(
    submit(failedCore, runtime, "Metadata should not be attempted."),
    /Core write failed/
  );
  assert.equal(descriptions, 1, "metadata must not run after a failed Core write");
  const failedJobs = await listDistillationJobs(root, accountId);
  assert.equal(failedJobs.find((job) => job.job_id === failedCore.job_id).status, "failed");
  const third = await lease("third");
  runtime.memory.distill = async () => {
    coreWrites++;
    return { id: "durable-third-L2" };
  };
  const queueDiagnostic = [];
  console.error = (...args) => queueDiagnostic.push(args.map(String).join(" "));
  let enqueueFailure;
  try {
    enqueueFailure = await submit(third, runtime, undefined, async () => {
      throw new Error("injected downstream queue unavailable");
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(enqueueFailure.memory.id, "durable-third-L2");
  assert.match(enqueueFailure.next_layer_enqueue_error, /downstream queue unavailable/);
  assert.equal(enqueueFailure.next_layer_job, undefined);
  assert.ok(queueDiagnostic.some((line) => line.includes("next-layer distillation enqueue failed")));
  const afterQueueFailure = await listDistillationJobs(root, accountId);
  assert.equal(afterQueueFailure.find((job) => job.job_id === third.job_id).status, "completed",
    "downstream enqueue failure cannot erase the completed upstream job");
  assert.equal(afterQueueFailure.filter((job) => job.target === "l3").length, 1,
    "downstream enqueue failure must not create a partial additional child");
  const audit = await auditDistillationPipeline({
    stateRoot: root, accountId,
    resolveProject: async () => projectId
  });
  assert.equal(audit.recovery.completed_l2_missing_l3, 1,
    "read-only audit must identify exactly the completed L2 without a child claim");
  assert.equal(audit.review_samples.completed_l2_missing_l3[0].job_id, third.job_id);
  assert.ok(audit.warnings.some((warning) => warning.includes("never replay the completed Core write")));
  const recoveryInput = {
    stateRoot: root, accountId, jobId: third.job_id, projectId
  };
  const dryRun = await reconcileCompletedL2DerivedJob({ ...recoveryInput, dryRun: true });
  assert.equal(dryRun.already_queued, false);
  assert.equal(dryRun.core_replayed, false);
  assert.equal((await listDistillationJobs(root, accountId)).filter((job) => job.target === "l3").length, 1,
    "dry-run cannot mutate the durable child queue");
  await assert.rejects(
    reconcileCompletedL2DerivedJob({ ...recoveryInput, projectId: "foreign-project", dryRun: false }),
    /project-matched L2/
  );
  await assert.rejects(
    reconcileCompletedL2DerivedJob({ ...recoveryInput, accountId: "foreign-account", dryRun: false }),
    /not found for account/
  );
  // The queue's cross-process mutation lock resolves simultaneous explicit
  // reconciliations to exactly one new child claim.
  const [one, two] = await Promise.all([
    reconcileCompletedL2DerivedJob({ ...recoveryInput, dryRun: false }),
    reconcileCompletedL2DerivedJob({ ...recoveryInput, dryRun: false })
  ]);
  assert.equal(one.core_replayed, false);
  assert.equal(two.core_replayed, false);
  assert.equal(coreWrites, 3, "reconcile_derived must never call Memory Core");
  const afterRepair = await listDistillationJobs(root, accountId);
  const children = afterRepair.filter((job) => job.target === "l3" &&
    job.evidence_refs.includes(`l2:durable-third-L2:${third.job_id}`));
  assert.equal(children.length, 1, "concurrent repair must create one derived claim");
  assert.equal(one.derived_job_id, children[0].job_id);
  assert.equal(two.derived_job_id, children[0].job_id);
  assert.equal((await reconcileCompletedL2DerivedJob({ ...recoveryInput, dryRun: false })).already_queued, true);
  const repairedAudit = await auditDistillationPipeline({
    stateRoot: root, accountId, resolveProject: async () => projectId
  });
  assert.equal(repairedAudit.recovery.completed_l2_missing_l3, 0);
  const originalStoreBytes = await readFile(jobsPath);
  try {
    const corrupted = JSON.parse(originalStoreBytes.toString("utf8"));
    const child = corrupted.jobs.find((job) => job.job_id === children[0].job_id);
    child.evidence[0].content = "forged evidence body with the same reference";
    await writeFile(jobsPath, JSON.stringify(corrupted));
    await assert.rejects(
      reconcileCompletedL2DerivedJob({ ...recoveryInput, dryRun: true }),
      /differs from completed L2 provenance/,
      "a reused ref with divergent content must not count as successful recovery"
    );
    const conflictAudit = await auditDistillationPipeline({
      stateRoot: root, accountId,
      resolveProject: async () => projectId
    });
    assert.equal(conflictAudit.recovery.completed_l2_missing_l3, 0,
      "a conflicting claim is not the same as a missing claim");
    assert.equal(conflictAudit.recovery.completed_l2_conflicting_l3, 1);
    assert.equal(conflictAudit.review_samples.completed_l2_conflicting_l3[0].job_id, third.job_id);
    assert.equal(conflictAudit.review_samples.completed_l2_conflicting_l3[0].reason, "evidence_mismatch");
    assert.ok(conflictAudit.warnings.some((warning) => warning.includes("conflicting L3 queue provenance")));
  } finally {
    await writeFile(jobsPath, originalStoreBytes);
  }
  try {
    const contaminated = JSON.parse(originalStoreBytes.toString("utf8"));
    const child = contaminated.jobs.find((job) => job.job_id === children[0].job_id);
    const unrelatedRef = "l2:foreign-result:foreign-job";
    child.evidence_refs.push(unrelatedRef);
    child.evidence.push({
      ref: unrelatedRef, kind: "artifact", layer: "L2",
      project_id: projectId, content: "An unrelated source was mixed into the child.",
      timestamp: child.evidence[0].timestamp
    });
    await writeFile(jobsPath, JSON.stringify(contaminated));
    await assert.rejects(
      reconcileCompletedL2DerivedJob({ ...recoveryInput, dryRun: true }),
      /differs from completed L2 provenance/,
      "a child with extra foreign evidence must not be accepted as an exact L3 claim"
    );
    const contaminatedAudit = await auditDistillationPipeline({
      stateRoot: root, accountId,
      resolveProject: async () => projectId
    });
    assert.equal(contaminatedAudit.recovery.completed_l2_conflicting_l3, 1);
    assert.equal(contaminatedAudit.review_samples.completed_l2_conflicting_l3[0].reason, "evidence_mismatch");
  } finally {
    await writeFile(jobsPath, originalStoreBytes);
  }

  const nearExpiryToken = await lease("near-expiry-token");
  await setLeaseUntil(
    nearExpiryToken.job_id,
    new Date(Date.now() + 2_000).toISOString()
  );
  runtime.memory.distill = async () => {
    coreWrites++;
    const prepared = (await listDistillationJobs(root, accountId))
      .find((job) => job.job_id === nearExpiryToken.job_id);
    assert.ok(Date.parse(prepared.leased_until) - Date.now() > 50_000,
      "opaque lease generation should be extended before entering Core");
    return { id: "prepared-token-L2" };
  };
  await submit(nearExpiryToken, runtime, undefined);
  const preparedCompleted = (await listDistillationJobs(root, accountId))
    .find((job) => job.job_id === nearExpiryToken.job_id);
  assert.equal(preparedCompleted.status, "completed");
  assert.ok(Number.isFinite(Date.parse(preparedCompleted.result_committed_at)),
    "successful external Core response time must be frozen separately from local job completion");

  const legacyQueued = await enqueueLegacyL1DistillationJob({
    stateRoot: root, accountId, projectId, evidence: makeEvidence("near-expiry-legacy")
  });
  const nearExpiryLegacy = await leaseDistillationJob(root, accountId, {
    harness, projectId, target: "l2", useLeaseToken: false
  });
  assert.equal(nearExpiryLegacy.job_id, legacyQueued.job.job_id);
  await setLeaseUntil(
    nearExpiryLegacy.job_id,
    new Date(Date.now() + 2_000).toISOString()
  );
  const writesBeforeLegacyGuard = coreWrites;
  await assert.rejects(
    submit(nearExpiryLegacy, runtime, undefined),
    /too close to expiry/
  );
  assert.equal(coreWrites, writesBeforeLegacyGuard,
    "near-expiry legacy lease must be rejected before any external Core write");
  const guardedLegacy = (await listDistillationJobs(root, accountId))
    .find((job) => job.job_id === nearExpiryLegacy.job_id);
  assert.equal(guardedLegacy.status, "leased");
  assert.equal(guardedLegacy.failure, undefined,
    "local lease preparation refusal must not be misclassified as a Core failure");
  await setLeaseUntil(
    nearExpiryLegacy.job_id,
    new Date(Date.now() + 60_000).toISOString()
  );
  await completeDistillationJob(
    root, accountId, nearExpiryLegacy.job_id, { kind: "noop" }, harness
  );

  // A token-fenced lease may expire while an external Core write is in
  // flight. If nobody has reassigned the generation, the successful Core
  // result must still be recorded instead of becoming a replay candidate.
  const expiredSuccess = await lease("expired-success");
  runtime.memory.distill = async () => {
    coreWrites++;
    await expireLease(expiredSuccess.job_id);
    return { id: "expired-same-generation-L2" };
  };
  const expiredResult = await submit(expiredSuccess, runtime, undefined);
  assert.equal(expiredResult.memory.id, "expired-same-generation-L2");
  const afterExpiredSuccess = await listDistillationJobs(root, accountId);
  assert.equal(afterExpiredSuccess.find((job) => job.job_id === expiredSuccess.job_id).status, "completed");

  // A 2xx Core response without a stable result ID is an ambiguous commit.
  // Quarantine the same token generation even if its wall-clock lease has
  // expired, so it cannot silently return to pending and replay Core.
  const ambiguous = await lease("ambiguous-success");
  runtime.memory.distill = async () => {
    coreWrites++;
    await expireLease(ambiguous.job_id);
    return {};
  };
  await assert.rejects(
    submit(ambiguous, runtime, undefined),
    /stable result id/
  );
  const afterAmbiguous = await listDistillationJobs(root, accountId);
  const quarantined = afterAmbiguous.find((job) => job.job_id === ambiguous.job_id);
  assert.equal(quarantined.status, "failed");
  assert.equal(quarantined.failure_kind, "ambiguous_core_commit");
  assert.match(quarantined.failure, /ambiguous commit requires manual reconciliation/);
  assert.equal(quarantined.lease_token, undefined);
  await assert.rejects(
    retryDistillationJob(root, accountId, ambiguous.job_id),
    /ordinary retry is disabled/
  );

  // If expiry has actually resulted in a new opaque lease generation, the
  // old worker must not record its late Core result into the replacement.
  const oldGeneration = await lease("reassigned-generation");
  let replacement;
  runtime.memory.distill = async () => {
    coreWrites++;
    await expireLease(oldGeneration.job_id);
    replacement = await leaseDistillationJob(root, accountId, {
      harness, projectId, target: "l2", useLeaseToken: true
    });
    assert.equal(replacement.job_id, oldGeneration.job_id);
    assert.notEqual(replacement.lease_token, oldGeneration.lease_token);
    return { id: "late-old-generation-result" };
  };
  await assert.rejects(
    submit(oldGeneration, runtime, undefined),
    /lease token is missing or stale/
  );
  const afterReassignment = await listDistillationJobs(root, accountId);
  const reassigned = afterReassignment.find((job) => job.job_id === oldGeneration.job_id);
  assert.equal(reassigned.status, "leased");
  assert.equal(reassigned.lease_token, replacement.lease_token);
  assert.equal(reassigned.result_id, undefined, "old generation must not overwrite the replacement lease");

  // Explicit Core failures keep their normal failed-job semantics even if
  // the token-fenced request crossed the wall-clock lease deadline.
  const expiredFailure = await lease("expired-core-failure");
  runtime.memory.distill = async () => {
    coreWrites++;
    await expireLease(expiredFailure.job_id);
    throw new Error("injected long Core request failure");
  };
  await assert.rejects(
    submit(expiredFailure, runtime, undefined),
    /long Core request failure/
  );
  const afterExpiredFailure = await listDistillationJobs(root, accountId);
  const expiredFailedJob = afterExpiredFailure.find((job) => job.job_id === expiredFailure.job_id);
  assert.equal(expiredFailedJob.status, "failed");
  assert.equal(expiredFailedJob.failure_kind, "core_error");

  // Once a new opaque generation actually owns the expired job, an older
  // failing request cannot mark the replacement failed.
  const reassignedFailure = await lease("reassigned-core-failure");
  let failureReplacement;
  runtime.memory.distill = async () => {
    coreWrites++;
    await expireLease(reassignedFailure.job_id);
    failureReplacement = await leaseDistillationJob(root, accountId, {
      harness, projectId, target: "l2", useLeaseToken: true
    });
    assert.equal(failureReplacement.job_id, reassignedFailure.job_id);
    throw new Error("old generation Core failure after reassignment");
  };
  await assert.rejects(
    submit(reassignedFailure, runtime, undefined),
    /old generation Core failure/
  );
  const afterFailureReassignment = await listDistillationJobs(root, accountId);
  const failureOwner = afterFailureReassignment.find((job) => job.job_id === reassignedFailure.job_id);
  assert.equal(failureOwner.status, "leased");
  assert.equal(failureOwner.lease_token, failureReplacement.lease_token);

  console.log("distillation-secondary-failure-e2e: ok (durable Core, metadata/queue warnings, L3 chain, real Core failure)");
} finally {
  await rm(root, { recursive: true, force: true });
}
