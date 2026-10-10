import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  markCaptureIngested,
  storeCaptureEvent
} from "../dist/capture.js";
import { auditDistillationPipeline } from "../dist/distillation-audit.js";
import { discoverDistillationJobs } from "../dist/distillation-discovery.js";
import { reconcileCompletedL2DerivedJob } from "../dist/distillation-derived-recovery.js";
import {
  listDistillationJobs,
  retryDistillationJob,
  setDistillationConfig
} from "../dist/distillation-jobs.js";

const iso = (n) => `2026-10-08T07:${String(n).padStart(2, "0")}:00.000Z`;
const l1Evidence = (project, id, timestamp) => ({
  ref: `l1:${id}`,
  kind: "turn",
  layer: "L1",
  timestamp,
  project_id: project,
  user_text: `source ${id}`,
  assistant_text: `response ${id}`
});
const l2Job = (account, project, id, minute) => {
  const timestamp = iso(minute);
  return {
    job_id: id,
    account_id: account,
    target: "l2",
    scope: "project",
    project_id: project,
    status: "completed",
    reason: "manual",
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: timestamp,
    result_committed_at: timestamp,
    result_kind: "l2",
    result_id: `timeline_${id}`,
    result_content: `L2 content ${id}`,
    evidence_refs: [`l1:${id}`],
    evidence_hash: `hash-${id}`,
    evidence: [l1Evidence(project, id, timestamp)]
  };
};
const l2Artifact = (source) => ({
  ref: `l2:${source.result_id}:${source.job_id}`,
  kind: "artifact",
  layer: "L2",
  timestamp: source.result_committed_at,
  project_id: source.project_id,
  content: source.result_content
});
const l3Job = (account, project, id, resultId, sources, minute) => {
  const timestamp = iso(minute);
  const evidence = sources.map(l2Artifact);
  return {
    job_id: id,
    account_id: account,
    target: "l3",
    scope: "project",
    project_id: project,
    status: "completed",
    reason: "upstream",
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: timestamp,
    result_committed_at: timestamp,
    result_kind: "l3",
    result_id: resultId,
    result_content: `L3 content ${id}`,
    evidence_refs: evidence.map((item) => item.ref),
    evidence_hash: `hash-${id}`,
    evidence
  };
};

const jobsRoot = await mkdtemp(join(tmpdir(), "memhub-anomaly-jobs-"));
const accountId = "anomaly-governance-account";
try {
  const kookSources = Array.from({ length: 6 }, (_, index) =>
    l2Job(accountId, "kook_robot", `kook-l2-${index + 1}`, 20 + index)
  );
  const kookAggregate = l3Job(
    accountId,
    "kook_robot",
    "kook-l3-aggregate",
    "project_profile_kook",
    kookSources,
    30
  );
  const betaSource = l2Job(accountId, "beta", "beta-l2", 31);
  const betaRevisions = [32, 33, 34].map((minute, index) =>
    l3Job(
      accountId,
      "beta",
      `beta-l3-r${index + 1}`,
      "project_profile_beta",
      [betaSource],
      minute
    )
  );
  const legacyFailure = {
    job_id: "legacy-migration-poisoned",
    account_id: accountId,
    target: "l2",
    scope: "project",
    project_id: "memhub",
    status: "failed",
    reason: "migration",
    created_at: iso(1),
    updated_at: iso(2),
    failed_at: iso(2),
    failure: "invalid legacy rebuild evidence: Memory Core panelItems ignored projectIds before project-filter fix",
    evidence_refs: ["l1:legacy-mixed"],
    evidence_hash: "legacy-poisoned-hash",
    evidence: [l1Evidence("memhub", "legacy-mixed", iso(1))]
  };
  await mkdir(join(jobsRoot, "distillation"), { recursive: true });
  await writeFile(join(jobsRoot, "distillation", "jobs.json"), JSON.stringify({
    version: 2,
    jobs: [...kookSources, kookAggregate, betaSource, ...betaRevisions, legacyFailure]
  }, null, 2));

  const loaded = await listDistillationJobs(jobsRoot, accountId);
  const classifiedLegacy = loaded.find((job) => job.job_id === legacyFailure.job_id);
  assert.equal(classifiedLegacy.failure_kind, "invalid_legacy_evidence");
  await assert.rejects(
    retryDistillationJob(jobsRoot, accountId, legacyFailure.job_id),
    /invalid legacy migration evidence is superseded and cannot be retried/
  );

  const audit = await auditDistillationPipeline({
    stateRoot: jobsRoot,
    accountId,
    resolveProject: async (hint) => hint
  });
  assert.equal(audit.recovery.completed_l2_missing_l3, 0);
  assert.equal(audit.recovery.completed_l2_conflicting_l3, 0,
    "many-L2 -> one-L3 and same-artifact revision lineage are valid provenance shapes");
  assert.equal(audit.jobs.failed, 1);
  assert.equal(audit.jobs.actionable_failed, 0);
  assert.equal(audit.jobs.historical_failed, 1);

  for (const source of kookSources) {
    const reconciliation = await reconcileCompletedL2DerivedJob({
      stateRoot: jobsRoot,
      accountId,
      jobId: source.job_id,
      projectId: source.project_id,
      dryRun: true
    });
    assert.equal(reconciliation.ok, true);
    assert.equal(reconciliation.already_queued, true);
    assert.equal(reconciliation.derived_job_id, kookAggregate.job_id);
  }
  const lineage = await reconcileCompletedL2DerivedJob({
    stateRoot: jobsRoot,
    accountId,
    jobId: betaSource.job_id,
    projectId: "beta",
    dryRun: true
  });
  assert.equal(lineage.already_queued, true);
  assert.equal(lineage.derived_job_id, "beta-l3-r3",
    "latest completed revision of the same stable L3 artifact should represent the lineage");
} finally {
  await rm(jobsRoot, { recursive: true, force: true });
}

const captureRoot = await mkdtemp(join(tmpdir(), "memhub-anomaly-captures-"));
const captureAccount = "anomaly-capture-account";
const device = { actor_id: "anomaly-device", account_id: captureAccount };
try {
  await setDistillationConfig(captureRoot, {
    auto_enabled: true,
    turn_threshold: 99,
    idle_minutes: 1,
    auto_since: "2026-10-01T00:00:00.000Z"
  });
  const workspaceResolved = (await storeCaptureEvent(captureRoot, device, {
    event_id: "workspace-beta",
    host: "codex",
    conversation_id: "workspace-beta",
    continuity_id: "workspace-beta",
    timestamp: "2026-10-09T11:00:00.000Z",
    workspace_path: "/srv/agent-workspace/alpha",
    user_text: "Generate the reviewed banner candidate.",
    assistant_text: "Generated the requested candidate.",
    capture_status: "complete"
  })).event;
  await markCaptureIngested(captureRoot, captureAccount, workspaceResolved.event_id);

  const arbitraryWorkspace = (await storeCaptureEvent(captureRoot, device, {
    event_id: "arbitrary-workspace",
    host: "codex",
    conversation_id: "arbitrary-workspace",
    continuity_id: "arbitrary-workspace",
    timestamp: "2026-10-09T11:01:00.000Z",
    workspace_path: "/srv/example-workspace/unbound-work",
    user_text: "Work in the current Linux terminal.",
    assistant_text: "Completed a local check.",
    capture_status: "complete"
  })).event;
  await markCaptureIngested(captureRoot, captureAccount, arbitraryWorkspace.event_id);

  const privateEvent = (await storeCaptureEvent(captureRoot, device, {
    event_id: "privacy-excluded",
    host: "production-acceptance",
    conversation_id: "privacy-excluded",
    continuity_id: "privacy-excluded",
    timestamp: "2026-10-09T11:02:00.000Z",
    project_hint: "memhub",
    user_text: "<private>private acceptance payload</private>",
    assistant_text: "<no-memory>private result</no-memory>",
    capture_status: "complete"
  })).event;
  await markCaptureIngested(captureRoot, captureAccount, privateEvent.event_id);

  await storeCaptureEvent(captureRoot, device, {
    event_id: "codex:memhub-plugin-e2e-legacy:turn-1",
    host: "codex",
    conversation_id: "memhub-plugin-e2e-legacy",
    continuity_id: "memhub-plugin-e2e-legacy",
    timestamp: "2026-10-09T11:03:00.000Z",
    project_hint: "alpha",
    user_text: "MEMHUB_PLUGIN_E2E user marker",
    assistant_text: "MEMHUB_PLUGIN_E2E assistant marker",
    capture_status: "complete"
  });

  const resolveProject = async (hint) => ["beta", "memhub", "alpha"].includes(hint) ? hint : null;
  const discovery = await discoverDistillationJobs({
    stateRoot: captureRoot,
    accountId: captureAccount,
    resolveProject,
    enqueue: false,
    now: new Date("2026-10-09T12:00:00.000Z")
  });
  assert.equal(discovery.workspace_resolved, 1);
  assert.equal(discovery.privacy_excluded, 1);
  assert.equal(discovery.unresolved, 1,
    "arbitrary non-canonical workspaces must remain unresolved instead of being guessed");

  const audit = await auditDistillationPipeline({
    stateRoot: captureRoot,
    accountId: captureAccount,
    resolveProject,
    now: new Date("2026-10-09T12:00:00.000Z")
  });
  assert.equal(audit.evidence.workspace_resolved, 1);
  assert.equal(audit.evidence.privacy_excluded, 1);
  assert.equal(audit.evidence.unresolved_project, 1);
  assert.equal(audit.capture.complete_uningested, 1,
    "raw capture stats still preserve the historical synthetic record");
  assert.equal(audit.recovery.complete_uningested_requires_review, 0,
    "explicit legacy E2E captures should not masquerade as recoverable user evidence");
  assert.equal(audit.recovery.synthetic_complete_uningested_excluded, 1);
} finally {
  await rm(captureRoot, { recursive: true, force: true });
}

console.log("distillation-anomaly-governance-e2e: ok");
