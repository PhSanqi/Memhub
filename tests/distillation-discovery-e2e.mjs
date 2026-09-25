import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevice, markCaptureIngested, storeCaptureEvent } from "../dist/capture.js";
import { discoverDistillationJobs } from "../dist/distillation-discovery.js";
import { getDistillationConfig, listDistillationJobs, setDistillationConfig } from "../dist/distillation-jobs.js";

const root = await mkdtemp(join(tmpdir(), "memhub-discovery-"));
try {
  const { device } = await createDevice(root, "acct-discovery", "test harness");
  async function capture(id, project = "alpha", status = "complete") {
    const stored = await storeCaptureEvent(root, device, {
      event_id: id, host: "test", conversation_id: project === "beta" ? "beta-chat" : "alpha-chat",
      continuity_id: project === "beta" ? "beta-chat" : "alpha-chat",
      timestamp: new Date().toISOString(),
      ...(project ? { project_hint: project } : {}),
      user_text: `user ${id}`,
      ...(status === "complete" ? { assistant_text: `assistant ${id}` } : {}),
      capture_status: status
    });
    if (status === "complete") await markCaptureIngested(root, device.account_id, stored.event.event_id);
  }
  const discover = (enqueue = true, now = new Date()) => discoverDistillationJobs({
    stateRoot: root, accountId: device.account_id,
    resolveProject: async (hint) => ["alpha", "beta"].includes(hint) ? hint : null,
    enqueue, now
  });
  await capture("historical");
  await capture("opened-before-enable", "beta", "partial");
  await new Promise((resolve) => setTimeout(resolve, 12));
  await setDistillationConfig(root, { auto_enabled: true, turn_threshold: 2, idle_minutes: 30 });
  assert.ok((await getDistillationConfig(root)).auto_since);
  const firstCutover = (await getDistillationConfig(root)).auto_since;
  await Promise.all([
    setDistillationConfig(root, { turn_threshold: 3 }),
    setDistillationConfig(root, { idle_minutes: 45 })
  ]);
  assert.deepEqual(
    (({ turn_threshold, idle_minutes, auto_since }) => ({ turn_threshold, idle_minutes, auto_since }))(await getDistillationConfig(root)),
    { turn_threshold: 3, idle_minutes: 45, auto_since: firstCutover },
    "concurrent admin patches must not lose either update or the cutover"
  );
  await setDistillationConfig(root, { turn_threshold: 2, idle_minutes: 30 });
  assert.equal((await discover()).queued, 0, "enable must not replay old captures");
  const completed = await storeCaptureEvent(root, device, {
    event_id: "opened-before-enable", host: "test", conversation_id: "beta-chat", continuity_id: "beta-chat",
    timestamp: new Date().toISOString(), project_hint: "beta", user_text: "user opened-before-enable",
    assistant_text: "completed after enable", capture_status: "complete"
  });
  await markCaptureIngested(root, device.account_id, completed.event.event_id);
  await capture("alpha-1");
  await capture("alpha-2");
  await capture("partial", "alpha", "partial");
  await capture("unresolved", null);
  const preview = await discover(false);
  assert.equal(preview.would_enqueue, 1);
  assert.equal(preview.unresolved, 1);
  assert.equal((await listDistillationJobs(root, device.account_id)).length, 0);
  const [first, concurrent] = await Promise.all([discover(), discover()]);
  assert.equal(first.queued + concurrent.queued, 1);
  assert.equal((await discover()).pending_jobs, 1, "discovery must report the durable post-reconciliation queue");
  let jobs = await listDistillationJobs(root, device.account_id);
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].evidence_refs.sort(), ["l1:alpha-1", "l1:alpha-2"]);
  assert.equal((await discover()).already_queued, 2);
  await capture("alpha-3");
  assert.equal((await discover()).waiting, 2);
  await capture("alpha-4");
  assert.equal((await discover()).queued, 1);
  const future = new Date(Date.now() + 31 * 60_000);
  assert.equal((await discover(true, future)).queued, 1, "idle should include complete turns after cutover");
  jobs = await listDistillationJobs(root, device.account_id);
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs.find((job) => job.project_id === "beta")?.evidence_refs, ["l1:opened-before-enable"]);
  await setDistillationConfig(root, { auto_enabled: false });
  assert.equal((await discover()).queued, 0);
  await setDistillationConfig(root, { auto_enabled: true });
  assert.notEqual((await getDistillationConfig(root)).auto_since, firstCutover, "re-enable starts a new cutover");
  await setDistillationConfig(root, { turn_threshold: Number.NaN, idle_minutes: Number.POSITIVE_INFINITY });
  assert.equal((await getDistillationConfig(root)).turn_threshold, 8);
  assert.equal((await getDistillationConfig(root)).idle_minutes, 30);
  console.log("distillation-discovery-e2e: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
