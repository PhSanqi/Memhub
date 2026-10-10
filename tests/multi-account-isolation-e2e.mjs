import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAccount, listAccounts, resolveCloudflareAccount, setAccountRole } from "../dist/auth.js";
import { JsonProjectRegistry } from "../dist/project-registry.js";
import { listCaptureEvents, storeCaptureEvent } from "../dist/capture.js";
import { recordSkillExecutionEvent, recordSkillLoad, skillTelemetrySummary } from "../dist/skill-telemetry.js";
import { listDistillationJobs, recordCompletedDistillationRevision } from "../dist/distillation-jobs.js";

const root = await mkdtemp(join(tmpdir(), "memhub-multi-account-"));
try {
  const first = await addAccount(root, "alpha-user", "alpha@example.org");
  const second = await addAccount(root, "beta-user", "beta@example.org");
  await setAccountRole(root, first.account_id, "admin");

  let accounts = await listAccounts(root);
  assert.equal(accounts.find((item) => item.account_id === first.account_id)?.role, "admin");
  assert.equal(accounts.find((item) => item.account_id === second.account_id)?.role, "user");

  const resolvedSecond = await resolveCloudflareAccount(
    root,
    { sub: "cloudflare-beta-subject", email: "beta@example.org" },
    { allowJit: false }
  );
  assert.equal(resolvedSecond.account_id, second.account_id);
  assert.equal(resolvedSecond.created, false);
  accounts = await listAccounts(root);
  assert.equal(accounts.find((item) => item.account_id === second.account_id)?.role, "user");

  const projects = new JsonProjectRegistry(join(root, "projects.json"));
  await projects.create(first.account_id, { projectId: "shared", description: "alpha project" });
  await projects.create(second.account_id, { projectId: "shared", description: "beta project" });
  await projects.addTodo(first.account_id, "shared", "alpha todo");
  await projects.addTodo(second.account_id, "shared", "beta todo");
  const firstProjects = await projects.list(first.account_id);
  const secondProjects = await projects.list(second.account_id);
  assert.equal(firstProjects[0].description, "alpha project");
  assert.equal(secondProjects[0].description, "beta project");
  assert.deepEqual(firstProjects[0].todos?.map((item) => item.text), ["alpha todo"]);
  assert.deepEqual(secondProjects[0].todos?.map((item) => item.text), ["beta todo"]);

  const event = {
    event_id: "same-event-id",
    host: "test",
    conversation_id: "same-conversation",
    continuity_id: "same-conversation",
    timestamp: "2026-10-10T00:00:00.000Z",
    project_hint: "shared",
    assistant_text: "ok",
    capture_status: "complete"
  };
  await storeCaptureEvent(root, { actor_id: "actor-a", account_id: first.account_id }, { ...event, user_text: "alpha l1" });
  await storeCaptureEvent(root, { actor_id: "actor-b", account_id: second.account_id }, { ...event, user_text: "beta l1" });
  assert.equal((await listCaptureEvents(root, first.account_id))[0].user_text, "alpha l1");
  assert.equal((await listCaptureEvents(root, second.account_id))[0].user_text, "beta l1");

  const firstSkill = await recordSkillLoad({ stateRoot: root, accountId: first.account_id, skillId: "same-skill" });
  await recordSkillExecutionEvent({ stateRoot: root, accountId: first.account_id, skillId: "same-skill", executionId: firstSkill.executionId, stage: "invoked" });
  await recordSkillExecutionEvent({ stateRoot: root, accountId: first.account_id, skillId: "same-skill", executionId: firstSkill.executionId, stage: "success" });
  const secondSkill = await recordSkillLoad({ stateRoot: root, accountId: second.account_id, skillId: "same-skill" });
  await recordSkillExecutionEvent({ stateRoot: root, accountId: second.account_id, skillId: "same-skill", executionId: secondSkill.executionId, stage: "invoked" });
  await recordSkillExecutionEvent({ stateRoot: root, accountId: second.account_id, skillId: "same-skill", executionId: secondSkill.executionId, stage: "failure" });
  assert.equal((await skillTelemetrySummary(root, first.account_id, "same-skill")).successes, 1);
  assert.equal((await skillTelemetrySummary(root, second.account_id, "same-skill")).failures, 1);

  await recordCompletedDistillationRevision({
    stateRoot: root,
    accountId: first.account_id,
    target: "l2",
    projectId: "shared",
    evidence: [{ ref: "l1:alpha", kind: "turn", layer: "L1", timestamp: "2026-10-10T00:00:00.000Z", project_id: "shared", content: "alpha evidence" }],
    resultId: "timeline-alpha",
    content: "alpha l2",
    committedAt: "2026-10-10T00:01:00.000Z"
  });
  await recordCompletedDistillationRevision({
    stateRoot: root,
    accountId: second.account_id,
    target: "l2",
    projectId: "shared",
    evidence: [{ ref: "l1:beta", kind: "turn", layer: "L1", timestamp: "2026-10-10T00:00:00.000Z", project_id: "shared", content: "beta evidence" }],
    resultId: "timeline-beta",
    content: "beta l2",
    committedAt: "2026-10-10T00:01:00.000Z"
  });
  assert.equal((await listDistillationJobs(root, first.account_id))[0].result_content, "alpha l2");
  assert.equal((await listDistillationJobs(root, second.account_id))[0].result_content, "beta l2");

  console.log("multi-account-isolation-e2e: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
