import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSkillExecution,
  recordSkillExecutionEvent,
  recordSkillLoad,
  skillTelemetrySummary
} from "../dist/skill-telemetry.js";

const root = await mkdtemp(join(tmpdir(), "memhub-skill-telemetry-"));
try {
  const loaded = await recordSkillLoad({ stateRoot: root, accountId: "acct", skillId: "skill-1", executor: "codex", projectId: "memhub" });
  assert.equal(loaded.events.length, 2);
  const duplicate = await recordSkillLoad({ stateRoot: root, accountId: "acct", skillId: "skill-1", executionId: loaded.executionId });
  assert.equal(duplicate.events.length, 0, "load retry should be idempotent for an execution id");
  await recordSkillExecutionEvent({ stateRoot: root, accountId: "acct", skillId: "skill-1", executionId: loaded.executionId, stage: "invoked" });
  await recordSkillExecutionEvent({ stateRoot: root, accountId: "acct", skillId: "skill-1", executionId: loaded.executionId, stage: "success" });
  const summary = await skillTelemetrySummary(root, "acct", "skill-1");
  assert.equal(summary.executions, 1);
  assert.equal(summary.successes, 1);
  assert.equal(summary.failures, 0);
  assert.ok(summary.reliability > 0.5);
  const execution = await readSkillExecution(root, "acct", loaded.executionId);
  assert.deepEqual(execution.map((event) => event.stage), ["selected", "loaded", "invoked", "success"]);

  const second = await recordSkillLoad({ stateRoot: root, accountId: "acct", skillId: "skill-1" });
  await assert.rejects(
    recordSkillExecutionEvent({ stateRoot: root, accountId: "acct", skillId: "skill-1", executionId: second.executionId, stage: "success" }),
    /invoked/
  );
  await recordSkillExecutionEvent({ stateRoot: root, accountId: "acct", skillId: "skill-1", executionId: second.executionId, stage: "invoked" });
  await recordSkillExecutionEvent({ stateRoot: root, accountId: "acct", skillId: "skill-1", executionId: second.executionId, stage: "failure", note: "tool timeout" });
  await recordSkillExecutionEvent({ stateRoot: root, accountId: "acct", skillId: "skill-1", executionId: second.executionId, stage: "user_correction", note: "retry with bounded scope" });
  const mixed = await skillTelemetrySummary(root, "acct", "skill-1");
  assert.equal(mixed.failures, 1);
  assert.equal(mixed.user_corrections, 1);
  assert.ok(mixed.reliability < summary.reliability);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("memhub-skill-telemetry-e2e: ok");
