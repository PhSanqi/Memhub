import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { captureIngestedAt, createDevice, isCaptureIngested, markCaptureIngested, readCaptureIngestIntentStatus, storeCaptureEvent, withCaptureIngestAttempt } from "../dist/capture.js";
import { ingestCaptureIntoMemory } from "../dist/capture-ingest.js";
import { recoverCaptureIngest } from "../dist/capture-recovery.js";
import { auditDistillationPipeline } from "../dist/distillation-audit.js";
import { discoverDistillationJobs } from "../dist/distillation-discovery.js";
import { enqueueDistillationJob, getDistillationConfig, listDistillationJobs, setDistillationConfig } from "../dist/distillation-jobs.js";
import { MemhubBridgeQueue } from "../dist/bridge.js";

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
  const originalIngestedAt = await captureIngestedAt(root, device.account_id, "historical");
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
  await markCaptureIngested(root, device.account_id, "historical");
  await Promise.all([
    markCaptureIngested(root, device.account_id, "historical"),
    markCaptureIngested(root, device.account_id, "historical")
  ]);
  assert.equal(await captureIngestedAt(root, device.account_id, "historical"), originalIngestedAt,
    "replayed ingestion marker must keep the original cutover timestamp");
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
  // Crash-window analogue: durable ingested evidence survives a reconciliation
  // failure before enqueue; a later scan recovers it once, without replaying
  // historical captures or creating duplicate jobs.
  const recoveryRoot = join(root, "recovery");
  const { device: recoveryDevice } = await createDevice(recoveryRoot, "acct-recovery", "recovery harness");
  await setDistillationConfig(recoveryRoot, { auto_enabled: true, turn_threshold: 2 });
  for (const id of ["recovery-1", "recovery-2"]) {
    await storeCaptureEvent(recoveryRoot, recoveryDevice, {
      event_id: id, host: "test", conversation_id: "recovery-chat",
      continuity_id: "recovery-chat", timestamp: new Date().toISOString(),
      project_hint: "alpha", user_text: `user ${id}`, assistant_text: `assistant ${id}`,
      capture_status: "complete"
    });
    await markCaptureIngested(recoveryRoot, recoveryDevice.account_id, id);
  }
  await assert.rejects(
    discoverDistillationJobs({
      stateRoot: recoveryRoot, accountId: recoveryDevice.account_id, enqueue: true,
      resolveProject: async () => { throw new Error("injected project resolution outage"); }
    }),
    /injected project resolution outage/
  );
  assert.equal((await listDistillationJobs(recoveryRoot, recoveryDevice.account_id)).length, 0);
  const recoveryDiscovery = () => discoverDistillationJobs({
    stateRoot: recoveryRoot, accountId: recoveryDevice.account_id, enqueue: true,
    resolveProject: async () => "alpha"
  });
  assert.equal((await recoveryDiscovery()).queued, 1);
  assert.equal((await recoveryDiscovery()).queued, 0);
  assert.deepEqual(
    (await listDistillationJobs(recoveryRoot, recoveryDevice.account_id))[0].evidence_refs.sort(),
    ["l1:recovery-1", "l1:recovery-2"]
  );

  // Simulate Memory Core committing completeTurn and losing its response.
  // The durable capture remains unmarked; retry must use the exact same Core
  // request IDs, mark ingestion once, and reconcile one downstream job.
  const coreRoot = join(root, "lost-core-response");
  const { device: coreDevice } = await createDevice(coreRoot, "acct-core-retry", "core retry harness");
  await setDistillationConfig(coreRoot, { auto_enabled: true, turn_threshold: 1 });
  const coreCapture = (await storeCaptureEvent(coreRoot, coreDevice, {
    event_id: "lost-response", host: "test", conversation_id: "core-retry-chat",
    continuity_id: "core-retry-chat", timestamp: new Date().toISOString(),
    project_hint: "alpha", user_text: "durable user", assistant_text: "durable assistant",
    capture_status: "complete"
  })).event;
  const coreRequests = new Map();
  const completeCalls = [];
  let dropFirstResponse = true;
  let projectResolutionCalls = 0;
  const fakeRuntime = {
    accountId: coreDevice.account_id, userId: "core-retry-user",
    projects: { async resolve(_accountId, hint) {
      projectResolutionCalls += 1;
      if (projectResolutionCalls > 1) throw new Error("injected discovery failure after marker");
      return hint === "alpha" ? "alpha" : null;
    } },
    memoryClient: {
      async openSession(request) {
        const previous = coreRequests.get(request.requestId);
        if (previous && previous !== JSON.stringify(request)) throw new Error("session request ID changed its payload");
        coreRequests.set(request.requestId, JSON.stringify(request));
      },
      async completeTurn(turnId, request) {
        const body = JSON.stringify({ turnId, request });
        const previous = coreRequests.get(request.requestId);
        if (previous && previous !== body) throw new Error("turn request ID changed its payload");
        coreRequests.set(request.requestId, body);
        completeCalls.push({ turnId, requestId: request.requestId });
        if (dropFirstResponse) {
          dropFirstResponse = false;
          throw new Error("injected response lost after Core committed turn");
        }
      }
    }
  };
  const ingestCore = () => ingestCaptureIntoMemory({
    event: coreCapture, device: coreDevice, runtime: fakeRuntime, projectId: "alpha"
  });
  await assert.rejects(ingestCore(), /injected response lost/);
  assert.equal(await isCaptureIngested(coreRoot, coreDevice.account_id, coreCapture.event_id), false);
  assert.equal((await listDistillationJobs(coreRoot, coreDevice.account_id)).length, 0);
  const retriedCapture = await recoverCaptureIngest({
    stateRoot: coreRoot, runtime: fakeRuntime, eventId: coreCapture.event_id,
    projectId: "alpha", dryRun: false
  });
  assert.equal(retriedCapture.ingested, true);
  assert.match(retriedCapture.discovery_error, /injected discovery failure after marker/);
  assert.equal(await isCaptureIngested(coreRoot, coreDevice.account_id, coreCapture.event_id), true,
    "a downstream enqueue failure must not roll back the durable Core ingestion marker");
  assert.equal(new Set(completeCalls.map((call) => call.requestId)).size, 1,
    "retry after a lost Core response must use the same idempotency request ID");
  assert.equal(new Set(completeCalls.map((call) => call.turnId)).size, 1);
  const coreDiscovery = () => discoverDistillationJobs({
    stateRoot: coreRoot, accountId: coreDevice.account_id, enqueue: true,
    resolveProject: async (hint) => hint === "alpha" ? "alpha" : null,
    now: new Date(Date.now() + 31 * 60_000)
  });
  assert.equal((await coreDiscovery()).queued, 1);
  assert.equal((await coreDiscovery()).queued, 0);
  assert.deepEqual((await listDistillationJobs(coreRoot, coreDevice.account_id))[0].evidence_refs,
    ["l1:lost-response"]);
  // Competing scans with different batch boundaries must not double-consume
  // the same L1 turn simply because their batch hashes differ.
  const overlapRoot = join(root, "overlap");
  const { device: overlapDevice } = await createDevice(overlapRoot, "acct-overlap", "concurrent harness");
  await setDistillationConfig(overlapRoot, { auto_enabled: true, turn_threshold: 2 });
  const overlappingCaptures = [];
  for (const id of ["a", "b", "c"]) {
    const stored = await storeCaptureEvent(overlapRoot, overlapDevice, {
      event_id: id, host: "test", conversation_id: "overlap-chat",
      continuity_id: "overlap-chat", timestamp: new Date().toISOString(),
      project_hint: "alpha", user_text: `user ${id}`, assistant_text: `assistant ${id}`,
      capture_status: "complete"
    });
    overlappingCaptures.push(stored.event);
    await markCaptureIngested(overlapRoot, overlapDevice.account_id, id);
  }
  const enqueueOverlap = (captures) => enqueueDistillationJob({
    stateRoot: overlapRoot, accountId: overlapDevice.account_id,
    projectId: "alpha", conversationId: "overlap-chat", captures, reason: "turn_threshold"
  });
  const overlapResults = await Promise.all([
    enqueueOverlap(overlappingCaptures.slice(0, 2)),
    enqueueOverlap(overlappingCaptures.slice(1, 3))
  ]);
  assert.equal(overlapResults.filter((item) => item.created).length, 1);
  assert.equal((await listDistillationJobs(overlapRoot, overlapDevice.account_id)).length, 1);
  const overlapDiscovery = () => discoverDistillationJobs({
    stateRoot: overlapRoot, accountId: overlapDevice.account_id, enqueue: true,
    resolveProject: async () => "alpha", now: new Date(Date.now() + 31 * 60_000)
  });
  assert.equal((await overlapDiscovery()).queued, 1,
    "an unclaimed turn from the losing batch must be recovered by discovery");
  const overlapJobs = await listDistillationJobs(overlapRoot, overlapDevice.account_id);
  assert.deepEqual(overlapJobs.flatMap((job) => job.evidence_refs).sort(), ["l1:a", "l1:b", "l1:c"]);
  // Multiple discover consumers can race after seeing the same marker backlog.
  // Their in-memory snapshots are advisory; only the durable queue lock can
  // establish which L1 references have already been claimed.
  const concurrentRoot = join(root, "concurrent-reconciliation");
  const { device: concurrentDevice } = await createDevice(concurrentRoot, "acct-concurrent-reconcile", "reconcile harness");
  await setDistillationConfig(concurrentRoot, { auto_enabled: true, turn_threshold: 2 });
  for (const id of ["r1", "r2", "r3", "r4"]) {
    await storeCaptureEvent(concurrentRoot, concurrentDevice, {
      event_id: id, host: "test", conversation_id: "reconcile-chat",
      continuity_id: "reconcile-chat", timestamp: new Date().toISOString(),
      project_hint: "alpha", user_text: `user ${id}`,
      assistant_text: `assistant ${id}`, capture_status: "complete"
    });
    await markCaptureIngested(concurrentRoot, concurrentDevice.account_id, id);
  }
  const concurrentDiscover = () => discoverDistillationJobs({
    stateRoot: concurrentRoot, accountId: concurrentDevice.account_id,
    enqueue: true, resolveProject: async () => "alpha"
  });
  const concurrentReports = await Promise.all(Array.from({ length: 4 }, concurrentDiscover));
  assert.equal(concurrentReports.reduce((sum, result) => sum + result.queued, 0), 2);
  const concurrentJobs = await listDistillationJobs(concurrentRoot, concurrentDevice.account_id);
  assert.equal(concurrentJobs.length, 2);
  assert.deepEqual(concurrentJobs.flatMap((job) => job.evidence_refs).sort(),
    ["l1:r1", "l1:r2", "l1:r3", "l1:r4"]);
  assert.equal((await concurrentDiscover()).queued, 0);
  // Late project routing must not rewrite an already ingested event locally:
  // the Core's stable idempotency key still refers to the original payload.
  const immutable = {
    event_id: "immutable", host: "test", conversation_id: "immutable-chat",
    continuity_id: "immutable-chat", timestamp: new Date().toISOString(),
    user_text: "immutable user", assistant_text: "immutable assistant",
    capture_status: "complete"
  };
  await storeCaptureEvent(coreRoot, coreDevice, immutable);
  await markCaptureIngested(coreRoot, coreDevice.account_id, immutable.event_id);
  assert.equal((await storeCaptureEvent(coreRoot, coreDevice, immutable)).updated, false);
  await assert.rejects(storeCaptureEvent(coreRoot, coreDevice, {
    ...immutable, project_hint: "alpha"
  }), /already ingested; immutable event metadata/);

  // A concurrent HTTP update must not change the Core request payload after
  // recover_ingest has begun, even before the durable .ingested marker exists.
  const raceRoot = join(root, "ingest-intent-race");
  const { device: raceDevice } = await createDevice(raceRoot, "acct-race", "race harness");
  const raceEvent = {
    event_id: "race-event", host: "test", conversation_id: "race-conversation",
    continuity_id: "race-conversation", timestamp: new Date().toISOString(),
    project_hint: "alpha", user_text: "race user", assistant_text: "race assistant",
    capture_status: "complete"
  };
  await storeCaptureEvent(raceRoot, raceDevice, raceEvent);
  let unblockCore;
  let indicateCore;
  const coreEntered = new Promise((resolveCore) => { indicateCore = resolveCore; });
  const coreBlocked = new Promise((resolveCore) => { unblockCore = resolveCore; });
  let raceCompletes = 0;
  const raceRuntime = {
    accountId: raceDevice.account_id, userId: "race-user",
    projects: { resolve: async (_account, hint) => hint === "alpha" ? "alpha" : null },
    memoryClient: {
      openSession: async () => undefined,
      completeTurn: async () => {
        raceCompletes += 1;
        indicateCore();
        await coreBlocked;
      }
    }
  };
  const raceArgs = {
    stateRoot: raceRoot, runtime: raceRuntime, eventId: raceEvent.event_id,
    projectId: "alpha", dryRun: false
  };
  const firstRace = recoverCaptureIngest(raceArgs);
  await coreEntered;
  assert.equal(await isCaptureIngested(raceRoot, raceDevice.account_id, raceEvent.event_id), false);
  await assert.rejects(storeCaptureEvent(raceRoot, raceDevice, {
    ...raceEvent, provenance: { late_metadata: "changed during Core request" }
  }), /ingestion already attempted; immutable event metadata/,
  "the durable intent must fence enrichment while Core is still in flight");
  assert.equal((await storeCaptureEvent(raceRoot, raceDevice, raceEvent)).updated, false,
    "exact replay of the frozen event must remain safe");
  const duplicateRace = recoverCaptureIngest(raceArgs);
  unblockCore();
  const raceResults = await Promise.all([firstRace, duplicateRace]);
  assert.equal(raceCompletes, 1, "concurrent recovery callers must not duplicate Core completeTurn");
  assert.deepEqual(raceResults.map((value) => value.already_ingested), [false, true]);
  assert.equal(await isCaptureIngested(raceRoot, raceDevice.account_id, raceEvent.event_id), true);

  // Failure before the marker must retain the frozen intent so a lost Core
  // response cannot be replayed with different content under the same ID.
  const errorEvent = { ...raceEvent, event_id: "failed-once" };
  await storeCaptureEvent(raceRoot, raceDevice, errorEvent);
  let failFirst = true;
  const failureRuntime = {
    ...raceRuntime,
    memoryClient: {
      openSession: async () => undefined,
      completeTurn: async () => {
        if (failFirst) {
          failFirst = false;
          throw new Error("injected Core response lost after first ingest attempt");
        }
      }
    }
  };
  const errorArgs = { ...raceArgs, runtime: failureRuntime, eventId: errorEvent.event_id };
  await assert.rejects(recoverCaptureIngest(errorArgs), /injected Core response lost/);
  assert.equal(await isCaptureIngested(raceRoot, raceDevice.account_id, errorEvent.event_id), false);
  await assert.rejects(storeCaptureEvent(raceRoot, raceDevice, {
    ...errorEvent, provenance: { late_metadata: "changed after lost response" }
  }), /ingestion already attempted; immutable event metadata/);
  assert.equal((await recoverCaptureIngest(errorArgs)).ingested, true,
    "the unchanged payload must remain replayable using the same Core idempotency key");

  const auditRoot = join(root, "audit");
  const auditBridgeRoot = join(root, "audit-bridge");
  const { device: auditDevice } = await createDevice(auditRoot, "acct-audit", "audit harness");
  await setDistillationConfig(auditRoot, { auto_enabled: true, turn_threshold: 2 });
  const auditCapture = async (id, { project = "alpha", ingested = true, complete = true } = {}) => {
    const stored = await storeCaptureEvent(auditRoot, auditDevice, {
      event_id: id, host: "test", conversation_id: "audit-chat", continuity_id: "audit-chat",
      timestamp: new Date().toISOString(), ...(project ? { project_hint: project } : {}),
      user_text: `user ${id}`, ...(complete ? { assistant_text: `assistant ${id}` } : {}),
      capture_status: complete ? "complete" : "partial"
    });
    if (ingested) await markCaptureIngested(auditRoot, auditDevice.account_id, id);
    return stored.event;
  };
  const queuedAudit = await auditCapture("audit-queued");
  const unqueuedAudit = await auditCapture("audit-unqueued");
  await auditCapture("audit-unresolved", { project: null });
  await auditCapture("audit-uningested", { ingested: false });
  await auditCapture("audit-incomplete", { ingested: false, complete: false });
  await enqueueDistillationJob({
    stateRoot: auditRoot, accountId: auditDevice.account_id, projectId: "alpha",
    conversationId: "audit-chat", captures: [queuedAudit], reason: "manual"
  });
  await new MemhubBridgeQueue(auditBridgeRoot).enqueue({
    event_id: "bridge-backlog", host: "test", conversation_id: "bridge-chat",
    continuity_id: "bridge-chat", timestamp: new Date().toISOString(),
    project_hint: "alpha", user_text: "bridge user", assistant_text: "bridge assistant",
    capture_status: "complete"
  });
  const indexPath = join(auditRoot, "capture-index.sqlite");
  const beforeReadOnlyAudit = await stat(indexPath);
  const audit = await auditDistillationPipeline({
    stateRoot: auditRoot, accountId: auditDevice.account_id,
    resolveProject: async (hint) => hint === "alpha" ? "alpha" : null,
    bridgeRoot: auditBridgeRoot
  });
  assert.equal(audit.source, "read_only_durable_state");
  assert.equal(audit.capture.total, 5);
  assert.equal(audit.capture.complete_uningested, 1);
  assert.equal(audit.capture.incomplete, 1);
  assert.equal(audit.evidence.unresolved_project, 1);
  assert.equal(audit.evidence.eligible_unqueued, 1);
  assert.equal(audit.evidence.ready_to_enqueue, 0);
  assert.equal(audit.evidence.waiting_for_idle_or_threshold, 1);
  assert.equal(audit.evidence.already_queued, 1);
  assert.equal(audit.bridge.pending, 1);
  assert.equal(audit.bridge.inspected, true);
  // An upload may have already renamed a queued event to a .sending claim.
  // Read-only production audits must count that claim as pending WITHOUT
  // stealing it, rewriting its content or trying to flush it.
  const queuedName = createHash("sha256").update("bridge-backlog").digest("hex");
  const canonicalQueue = join(auditBridgeRoot, "queue", queuedName + ".json");
  const claimedQueue = join(auditBridgeRoot, "queue",
    queuedName + ".sending-1790400000000-12345-11111111-1111-4111-8111-111111111111.json");
  await rename(canonicalQueue, claimedQueue);
  const claimBeforeAudit = await stat(claimedQueue);
  const claimedAudit = await auditDistillationPipeline({
    stateRoot: auditRoot, accountId: auditDevice.account_id,
    resolveProject: async (hint) => hint === "alpha" ? "alpha" : null,
    bridgeRoot: auditBridgeRoot
  });
  assert.deepEqual(claimedAudit.bridge, { pending: 1, inspected: true },
    "inflight Bridge claims are still durable backlog");
  assert.equal((await stat(claimedQueue)).mtimeMs, claimBeforeAudit.mtimeMs,
    "audit must not reclaim or mutate a Bridge claim");
  await rename(claimedQueue, canonicalQueue);
  assert.equal(audit.recovery.complete_uningested_requires_review, 1);
  assert.deepEqual(audit.review_samples.complete_uningested, [{
    event_id: "audit-uningested", project_hint: "alpha", intent_status: "absent"
  }]);
  assert.deepEqual(audit.review_samples.unresolved_project, [{
    event_id: "audit-unresolved", project_hint: null, reason: "missing_project_hint"
  }]);
  assert.equal(JSON.stringify(audit.review_samples).includes("user audit-"), false,
    "audit review samples must not leak raw conversation text");
  assert.equal(audit.recovery.durable_ingested_reconcilable, 0,
    "an unqueued event below threshold is still legitimately waiting");
  const afterIdle = await auditDistillationPipeline({
    stateRoot: auditRoot, accountId: auditDevice.account_id,
    resolveProject: async (hint) => hint === "alpha" ? "alpha" : null,
    bridgeRoot: null, now: new Date(Date.now() + 31 * 60_000)
  });
  assert.equal(afterIdle.evidence.ready_to_enqueue, 1);
  assert.deepEqual(afterIdle.bridge, { pending: null, inspected: false },
    "omitting Bridge root must not silently inspect an unrelated default queue");
  assert.equal(afterIdle.evidence.waiting_for_idle_or_threshold, 0);
  assert.equal(afterIdle.recovery.durable_ingested_reconcilable, 1);
  assert.ok(afterIdle.warnings.some((warning) => warning.includes("enqueue threshold or idle cutoff")));
  assert.ok(audit.warnings.some((item) => item.includes("complete_uningested")));
  assert.ok(audit.warnings.some((item) => item.includes("offline capture backlog")));
  assert.equal((await stat(indexPath)).mtimeMs, beforeReadOnlyAudit.mtimeMs,
    "a read-only audit must not run capture index migration/rebuild/write");
  const dirtyIndex = new Database(indexPath);
  try {
    dirtyIndex.prepare("INSERT INTO capture_index_dirty(account_id,event_id) VALUES (?,?)")
      .run(auditDevice.account_id, "injected-dirty-event");
  } finally {
    dirtyIndex.close();
  }
  await assert.rejects(auditDistillationPipeline({
    stateRoot: auditRoot, accountId: auditDevice.account_id,
    resolveProject: async () => "alpha", bridgeRoot: null
  }), /existing clean index; repair separately/,
  "read-only audit must refuse a dirty index instead of silently rebuilding it");
  const cleanIndex = new Database(indexPath);
  try {
    cleanIndex.prepare("DELETE FROM capture_index_dirty WHERE account_id=?")
      .run(auditDevice.account_id);
  } finally {
    cleanIndex.close();
  }
  const sha = (value) => createHash("sha256").update(value, "utf8").digest("hex");
  await rm(join(auditRoot, "captures", sha(auditDevice.account_id), `${sha("audit-unqueued")}.json.ingested`));
  await assert.rejects(auditDistillationPipeline({
    stateRoot: auditRoot, accountId: auditDevice.account_id,
    resolveProject: async () => "alpha", bridgeRoot: null
  }), /index\/marker mismatch; repair separately/,
  "read-only audit must flag a missing durable marker rather than trusting stale index rows");
  const uninitializedRoot = join(root, "audit-without-index");
  const emptyAudit = await auditDistillationPipeline({
    stateRoot: uninitializedRoot, accountId: auditDevice.account_id,
    resolveProject: async () => "alpha", bridgeRoot: null
  });
  assert.equal(emptyAudit.capture.total, 0, "new account with no captures is an empty read-only audit");
  await assert.rejects(stat(join(uninitializedRoot, "capture-index.sqlite")), { code: "ENOENT" });
  await storeCaptureEvent(uninitializedRoot, auditDevice, {
    event_id: "raw-before-index", host: "test", conversation_id: "raw-chat",
    continuity_id: "raw-chat", timestamp: new Date().toISOString(),
    project_hint: "alpha", user_text: "raw user", assistant_text: "raw assistant",
    capture_status: "complete"
  });
  await rm(join(uninitializedRoot, "capture-index.sqlite"));
  await assert.rejects(auditDistillationPipeline({
    stateRoot: uninitializedRoot, accountId: auditDevice.account_id,
    resolveProject: async () => "alpha", bridgeRoot: null
  }), /existing clean index; repair separately/,
  "missing index alongside durable captures must fail closed rather than reindex during audit");
  await assert.rejects(stat(join(uninitializedRoot, "capture-index.sqlite")), { code: "ENOENT" });
  const intentAuditRoot = join(root, "audit-frozen-intents");
  const { device: intentDevice } = await createDevice(intentAuditRoot, "acct-frozen", "frozen-intent-harness");
  const makeIntentEvent = async (id) => (await storeCaptureEvent(intentAuditRoot, intentDevice, {
    event_id: id, host: "test", conversation_id: "intent-chat", continuity_id: "intent-chat",
    timestamp: new Date().toISOString(), project_hint: "alpha",
    user_text: `user ${id}`, assistant_text: `assistant ${id}`, capture_status: "complete"
  })).event;
  await makeIntentEvent("legacy-without-intent");
  for (const id of ["frozen-without-marker", "conflicting-intent"]) {
    const event = await makeIntentEvent(id);
    const attempt = await withCaptureIngestAttempt({
      stateRoot: intentAuditRoot, accountId: intentDevice.account_id, eventId: id,
      expectedEvent: event, ingest: async () => ({ ingested: false })
    });
    assert.equal(attempt.result?.ingested, false);
    assert.equal(await isCaptureIngested(intentAuditRoot, intentDevice.account_id, id), false);
  }
  const captureHash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
  const conflictIntentPath = join(intentAuditRoot, "captures", captureHash(intentDevice.account_id),
    `${captureHash("conflicting-intent")}.json.ingest-intent`);
  await writeFile(conflictIntentPath, "0".repeat(64) + "\n");
  assert.equal(await readCaptureIngestIntentStatus(intentAuditRoot, intentDevice.account_id, "legacy-without-intent"), "absent");
  assert.equal(await readCaptureIngestIntentStatus(intentAuditRoot, intentDevice.account_id, "frozen-without-marker"), "matching");
  assert.equal(await readCaptureIngestIntentStatus(intentAuditRoot, intentDevice.account_id, "conflicting-intent"), "conflict");
  const intentIndexPath = join(intentAuditRoot, "capture-index.sqlite");
  const indexBeforeIntentAudit = await stat(intentIndexPath);
  const intentAudit = await auditDistillationPipeline({
    stateRoot: intentAuditRoot, accountId: intentDevice.account_id,
    resolveProject: async (hint) => hint === "alpha" ? "alpha" : null,
    bridgeRoot: null
  });
  assert.equal(intentAudit.recovery.complete_uningested_requires_review, 3);
  assert.equal(intentAudit.recovery.frozen_intent_without_marker, 1);
  assert.equal(intentAudit.recovery.legacy_without_intent, 1);
  assert.equal(intentAudit.recovery.conflicting_intent, 1);
  assert.deepEqual(intentAudit.review_samples.complete_uningested.map(({ event_id, intent_status }) =>
    [event_id, intent_status]).sort(), [
      ["conflicting-intent", "conflict"],
      ["frozen-without-marker", "matching"],
      ["legacy-without-intent", "absent"]
    ].sort());
  assert.ok(intentAudit.warnings.some((warning) => warning.includes("intent/payload conflicts")));
  assert.equal((await stat(intentIndexPath)).mtimeMs, indexBeforeIntentAudit.mtimeMs);
  await rm(join(intentAuditRoot, "captures", captureHash(intentDevice.account_id),
    `${captureHash("legacy-without-intent")}.json`));
  await assert.rejects(auditDistillationPipeline({
    stateRoot: intentAuditRoot, accountId: intentDevice.account_id,
    resolveProject: async () => "alpha", bridgeRoot: null
  }), /ENOENT/,
  "an indexed capture with missing durable raw content must not be reported as safely recoverable");
  assert.equal((await stat(intentIndexPath)).mtimeMs, indexBeforeIntentAudit.mtimeMs);
  console.log("distillation-discovery-e2e: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
