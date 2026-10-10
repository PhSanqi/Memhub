import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enqueueLegacyL1DistillationJob,
  leaseDistillationJob,
  listDistillationJobs
} from "../dist/distillation-jobs.js";
import { submitDistillationControl } from "../dist/distillation-submit.js";

const root = await mkdtemp(join(tmpdir(), "memhub-l2-history-guard-"));
const accountId = "l2-history-guard-account";
const projectId = "memhub";
const harness = "l2-history-guard-harness";
let coreWrites = 0;

const runtime = {
  accountId,
  userId: "local-user",
  source: {
    platform: "test",
    transport: "test",
    principalId: "test",
    connectionId: "test",
    authenticatedAccount: accountId
  },
  memory: {
    distill: async () => {
      coreWrites += 1;
      return { id: "canonical-l2" };
    }
  },
  projects: {
    resolve: async () => projectId
  }
};

const evidence = (id) => [{
  ref: `l1:${id}`,
  kind: "turn",
  layer: "L1",
  timestamp: "2026-10-10T00:00:00.000Z",
  project_id: projectId,
  user_text: `user ${id}`,
  assistant_text: `assistant ${id}`
}];

async function lease(id) {
  const queued = await enqueueLegacyL1DistillationJob({
    stateRoot: root,
    accountId,
    projectId,
    evidence: evidence(id)
  });
  assert.equal(queued.created, true);
  return leaseDistillationJob(root, accountId, {
    harness,
    projectId,
    target: "l2",
    useLeaseToken: true
  });
}

async function submit(job, content) {
  return submitDistillationControl({
    args: { job_id: job.job_id, content },
    stateRoot: root,
    runtime,
    sourceHarness: harness,
    leaseToken: job.lease_token,
    resolveToolScope: async () => ({ projectId, resolutionSource: "explicit" }),
    validateDistillationEvidenceChain: async () => []
  });
}

try {
  const first = await lease("first");
  await submit(first, `# Memhub 项目时间线

## 2026-10-09：第一阶段
第一阶段已经完成。`);
  assert.equal(coreWrites, 1);

  const second = await lease("second");
  await assert.rejects(
    submit(second, `# Memhub 项目时间线

## 2026-10-10：第二阶段
第二阶段已经完成。`),
    /would drop canonical timeline history.*full timeline replacement, not a delta/s
  );
  assert.equal(coreWrites, 1, "delta-only L2 must fail before Memory Core is called");

  await submit(second, `# Memhub 项目时间线

## 2026-10-09：第一阶段
第一阶段已经完成。

## 2026-10-10：第二阶段
第二阶段已经完成。`);
  assert.equal(coreWrites, 2);

  const completed = (await listDistillationJobs(root, accountId))
    .filter((job) => job.status === "completed" && job.target === "l2");
  assert.equal(completed.length, 2);
  const secondCompleted = completed.find((job) => job.job_id === second.job_id);
  assert.ok(secondCompleted);
  assert.match(secondCompleted.result_content, /2026-10-09：第一阶段/);
  assert.match(secondCompleted.result_content, /2026-10-10：第二阶段/);
  console.log("distillation-l2-history-guard-e2e: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
