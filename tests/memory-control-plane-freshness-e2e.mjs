import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMemoryControlData } from "../dist/memory-control-plane.js";
import { renderConsole } from "../dist/web-ui.js";

const root = await mkdtemp(join(tmpdir(), "memhub-control-freshness-"));
try {
  await mkdir(join(root, "distillation"), { recursive: true });
  await writeFile(join(root, "distillation", "jobs.json"), JSON.stringify({
    version: 2,
    jobs: [
      completedJob({
        jobId: "job-stale",
        resultId: "timeline-stale",
        committedAt: "2026-10-07T07:25:29.733Z"
      }),
      completedJob({
        jobId: "job-current",
        resultId: "timeline-current",
        committedAt: "2026-10-10T10:05:16.716Z"
      }),
      failedJob({
        jobId: "job-historical-failure",
        failureKind: "invalid_legacy_evidence",
        updatedAt: "2026-09-20T15:59:47.063Z"
      }),
      pendingJob({
        jobId: "job-pending",
        updatedAt: "2026-10-10T10:06:00.000Z"
      })
    ]
  }, null, 2));

  const viewerItems = [
    {
      id: "timeline-stale",
      memoryLayer: "L2",
      title: "Project Timeline · memhub",
      summary: "# Memhub project timeline",
      tags: ["artifact:l2", "project:memhub"],
      createdAt: "2026-10-03T08:47:50.697Z",
      updatedAt: "2026-10-07T07:25:29.786Z",
      status: "archived",
      body: "# Timeline\n\n## 2026-09-28: stale event\nold duplicate"
    },
    {
      id: "timeline-current",
      memoryLayer: "L2",
      title: "Project Timeline · memhub",
      summary: "# Memhub project timeline",
      tags: ["artifact:l2", "project:memhub"],
      createdAt: "2026-09-20T16:02:28.334Z",
      updatedAt: "2026-10-10T10:05:16.750Z",
      status: "activated",
      body: "# Timeline\n\n## 2026-10-10: current event\ncurrent canonical"
    }
  ];
  const runtime = {
    accountId: "acct-test",
    userId: "local-user",
    memoryClient: {
      async viewerGet(path) {
        assert.match(path, /^\/api\/v1\/l2\?/);
        const url = new URL(`http://local${path}`);
        assert.equal(url.searchParams.get("status"), "activated");
        const items = viewerItems.filter((item) => item.status === "activated");
        return { items, total: items.length, hasNext: false };
      }
    }
  };
  const payload = await readMemoryControlData({
    stateRoot: root,
    runtime,
    kind: "l2",
    projectId: "memhub",
    projects: []
  });
  assert.equal(payload.items[0].id, "timeline-current");
  assert.equal(payload.items[0].canonical_current, true);
  assert.equal(payload.items[0].canonical_revision_committed_at, "2026-10-10T10:05:16.716Z");
  assert.equal(payload.items.length, 1);
  assert.equal(payload.total, 1);
  assert.equal(payload.items.some((item) => item.id === "timeline-stale"), false);

  const processing = await readMemoryControlData({
    stateRoot: root,
    runtime,
    kind: "processing",
    projectId: "memhub",
    projects: []
  });
  assert.equal(processing.counts.failed, 0);
  assert.equal(processing.counts.historical_failed, 1);
  assert.equal(processing.counts.pending, 1);
  assert.equal(processing.items.find((item) => item.job_id === "job-historical-failure")?.failure_kind, "invalid_legacy_evidence");

  const html = renderConsole({
    account: { account_id: "acct-test", username: "tester", role: "user" },
    accounts: [{ account_id: "acct-test", username: "tester", role: "user" }],
    projects: [],
    adminView: false,
    localControl: true,
    selectedAccountId: "acct-test"
  });
  assert.match(html, /Canonical L2 最近更新/);
  assert.match(html, /事件日期/);
  assert.match(html, /stale duplicate L2 hidden/);
  assert.match(html, /canonical_current===true/);

  console.log("memory-control-plane-freshness-e2e: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

function completedJob({ jobId, resultId, committedAt }) {
  return {
    job_id: jobId,
    account_id: "acct-test",
    target: "l2",
    scope: "project",
    project_id: "memhub",
    status: "completed",
    reason: "manual",
    created_at: committedAt,
    updated_at: committedAt,
    completed_at: committedAt,
    result_kind: "l2",
    result_id: resultId,
    result_content: "fixture",
    result_committed_at: committedAt,
    evidence_refs: ["l1:fixture"],
    evidence_hash: `${jobId}-hash`,
    evidence: []
  };
}

function failedJob({ jobId, failureKind, updatedAt }) {
  return {
    job_id: jobId,
    account_id: "acct-test",
    target: "l2",
    scope: "project",
    project_id: "memhub",
    status: "failed",
    reason: "migration",
    created_at: updatedAt,
    updated_at: updatedAt,
    failed_at: updatedAt,
    failure_kind: failureKind,
    failure: "historical fixture",
    evidence_refs: ["l1:historical"],
    evidence_hash: `${jobId}-hash`,
    evidence: []
  };
}

function pendingJob({ jobId, updatedAt }) {
  return {
    job_id: jobId,
    account_id: "acct-test",
    target: "l2",
    scope: "project",
    project_id: "memhub",
    status: "pending",
    reason: "manual",
    created_at: updatedAt,
    updated_at: updatedAt,
    evidence_refs: ["l1:pending"],
    evidence_hash: `${jobId}-hash`,
    evidence: []
  };
}
