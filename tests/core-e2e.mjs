import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addAccount,
  listAccounts,
  resolveCloudflareAccount,
  setAccountRole
} from "../dist/auth.js";
import { JsonConversationProjectBindingStore } from "../dist/binding-store.js";
import { JsonProjectBranchStore } from "../dist/branch-store.js";
import { buildContextCapsule } from "../dist/context-capsule.js";
import { ContextRouter } from "../dist/context-router.js";
import { assertLoopbackMemoryEndpoint } from "../dist/local-memory-client.js";
import { MemoryRestContextSource } from "../dist/memory-source.js";
import { resolveProjectScope } from "../dist/project-scope.js";
import { countCaptureEvents, createDevice, listCaptureEvents, normalizeCaptureEvent } from "../dist/capture.js";
import { enqueueDerivedDistillationJob, listDistillationJobs } from "../dist/distillation-jobs.js";
import { EmbeddedMemoryCore } from "../dist/embedded-memory-core.js";
import { JsonProjectRegistry, projectSimilarity } from "../dist/project-registry.js";
import { JsonResultTransport } from "../dist/result-transport.js";

const root = await mkdtemp(join(tmpdir(), "memhub-core-"));
const state = join(root, "state");
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function runNodeEval(code, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) resolveRun(stdout.trim());
      else rejectRun(new Error(stderr || `child process exited with ${code}`));
    });
  });
}

try {
  assert.equal(resolveProjectScope({}).recallScope, "global_only");
  assert.equal(resolveProjectScope({ conversationProjectId: "aide" }).projectId, "aide");
  const conflict = resolveProjectScope({ conversationProjectId: "aide", workspaceProjectId: "memmy" });
  assert.equal(conflict.projectId, null);
  assert.equal(conflict.recallScope, "global_only");

  const capsule = buildContextCapsule({
    accountId: "acct",
    resolution: conflict,
    globalMemory: [{ id: "g", content: "global", authority: "remembered", scope: "global", source: "test" }],
    projectMemory: [{ id: "a", content: "aide", authority: "remembered", scope: "project", source: "test", projectId: "aide" }],
    reusableSkills: [{ id: "s", content: "reusable", authority: "remembered", scope: "capability", source: "test", projectId: "memmy" }]
  });
  assert.equal(capsule.globalMemory.length, 1);
  assert.equal(capsule.projectMemory.length, 0);
  assert.equal(capsule.reusableSkills.length, 1);
  assert.equal(capsule.contextBudget.truncatedItems, 0);

  const provenanceSource = new MemoryRestContextSource({
    async search(request) {
      if (request.layers?.includes("L4")) {
        return {
          debug: {
            hits: [{
              id: "provenance-cap",
              kind: "user_profile",
              memoryLayer: "L4",
              status: "activated",
              snippet: "bounded provenance",
              score: 0.9,
              tags: ["global", ...Array.from({ length: 80 }, (_, index) => `evidence:${index}`)],
              source: "search",
              retrievalRoutes: Array.from({ length: 40 }, (_, index) => `route-${index}`)
            }]
          }
        };
      }
      return { debug: { hits: [] } };
    }
  });
  const provenanceRecall = await provenanceSource.recall({
    accountId: "acct",
    userId: "user",
    query: "bounded provenance",
    projectId: null,
    limit: 4
  });
  assert.equal(provenanceRecall.globalMemory[0].provenance.tags.length, 32);
  assert.equal(provenanceRecall.globalMemory[0].provenance.tagsTruncated, true);
  assert.equal(provenanceRecall.globalMemory[0].provenance.originalTagCount, 81);
  assert.equal(provenanceRecall.globalMemory[0].provenance.retrievalRoutes.length, 16);

  const largeCapsule = buildContextCapsule({
    accountId: "acct",
    resolution: resolveProjectScope({ workspaceProjectId: "aide" }),
    maxContentBytes: 24_000,
    maxItemContentBytes: 8_000,
    globalMemory: [{ id: "large-global", content: "全".repeat(20_000), authority: "remembered", scope: "global", source: "test" }],
    projectMemory: [{ id: "large-project", content: "项".repeat(20_000), authority: "remembered", scope: "project", source: "test", projectId: "aide" }],
    reusableSkills: [{ id: "large-skill", content: "技".repeat(20_000), authority: "remembered", scope: "capability", source: "test", projectId: "aide" }],
    projectArchitecture: [{ id: "large-arch", content: "架".repeat(20_000), authority: "authoritative", scope: "project", source: "test", projectId: "aide" }]
  });
  assert.ok(largeCapsule.globalMemory.length >= 1);
  assert.ok(largeCapsule.projectMemory.length >= 1);
  assert.ok(largeCapsule.reusableSkills.length >= 1);
  assert.ok(largeCapsule.contextBudget.emittedContentBytes <= largeCapsule.contextBudget.maxContentBytes);
  assert.ok(largeCapsule.contextBudget.truncatedItems >= 3);
  for (const item of [...largeCapsule.globalMemory, ...largeCapsule.projectMemory, ...largeCapsule.reusableSkills]) {
    assert.equal(item.provenance?.contextTruncated, true);
    assert.match(item.content, /truncated by Memhub context budget/);
  }

  assert.doesNotThrow(() => assertLoopbackMemoryEndpoint("http://127.0.0.1:18960"));
  assert.doesNotThrow(() => assertLoopbackMemoryEndpoint("http://[::1]:18960"));
  assert.throws(() => assertLoopbackMemoryEndpoint("https://memory.example.test"), /non-loopback/);

  const fallbackSearches = [];
  const fallbackSource = new MemoryRestContextSource({
    async search(request) {
      fallbackSearches.push(request.layers ?? []);
      const layers = request.layers ?? [];
      if (layers.length === 1 && layers[0] === "L1") {
        return {
          debug: {
            hits: [{
              id: "l1-bootstrap",
              kind: "trace",
              memoryLayer: "L1",
              status: "activated",
              title: "Bootstrap current truth",
              snippet: "Project history remains available before the first L2 artifact exists.",
              score: 0.9,
              tags: ["project:aide"],
              source: "search"
            }]
          }
        };
      }
      return { debug: { hits: [] } };
    }
  });
  const fallbackRecall = await fallbackSource.recall({
    accountId: "acct",
    userId: "user",
    query: "current truth",
    projectId: "aide",
    projectStorageIds: ["aide"],
    limit: 8,
    reusableSkillProjectIds: []
  });
  assert.equal(fallbackRecall.projectMemory.length, 1);
  assert.equal(fallbackRecall.projectMemory[0].provenance.memoryLayer, "L1");
  assert.ok(fallbackSearches.some((layers) => layers.length === 2 && layers.includes("L2") && layers.includes("L3")));
  assert.ok(fallbackSearches.some((layers) => layers.length === 1 && layers[0] === "L1"));

  const layeredSource = new MemoryRestContextSource({
    async search(request) {
      const layers = request.layers ?? [];
      if (layers.includes("L2")) {
        return {
          debug: {
            hits: [{
              id: "l2-current",
              kind: "summary",
              memoryLayer: "L2",
              status: "activated",
              snippet: "Canonical project timeline.",
              score: 0.95,
              tags: ["project:aide"],
              source: "search"
            }]
          }
        };
      }
      if (layers.length === 1 && layers[0] === "L1") throw new Error("L1 fallback must not run when L2/L3 exists");
      return { debug: { hits: [] } };
    }
  });
  const layeredRecall = await layeredSource.recall({
    accountId: "acct",
    userId: "user",
    query: "current truth",
    projectId: "aide",
    projectStorageIds: ["aide"],
    limit: 8,
    reusableSkillProjectIds: []
  });
  assert.equal(layeredRecall.projectMemory.length, 1);
  assert.equal(layeredRecall.projectMemory[0].provenance.memoryLayer, "L2");

  const distillWrites = [];
  const distillSource = new MemoryRestContextSource({
    async addMemory(request) {
      distillWrites.push(request);
      return { id: "canonical-l2" };
    }
  });
  const distillBase = {
    accountId: "acct",
    userId: "user",
    kind: "l2",
    projectId: "aide",
    title: "Project Timeline · aide",
    sourceHarness: "test",
    artifactId: "project-timeline:aide",
    evidenceRefs: ["l1:turn-1"],
    contractVersion: "memhub-distill-v2"
  };
  await distillSource.distill({ ...distillBase, content: "timeline v1" });
  await distillSource.distill({ ...distillBase, content: "timeline v2" });
  await distillSource.distill({ ...distillBase, content: "timeline v2" });
  assert.equal(distillWrites[0].sourceArtifactId, "project-timeline:aide");
  assert.notEqual(distillWrites[0].requestId, distillWrites[1].requestId);
  assert.equal(distillWrites[1].requestId, distillWrites[2].requestId);

  const embeddedMemory = new EmbeddedMemoryCore({
    stateRoot: join(root, "embedded-memory"),
    configPath: join(root, "embedded-memory", "config.yaml"),
    dbPath: join(root, "embedded-memory", "memory.sqlite")
  });
  assert.equal(existsSync(embeddedMemory.entrypoint), true);
  const calls = [];
  const memory = {
    async recall(input) {
      calls.push(input.projectId);
      return {
        globalMemory: [{ id: "g", content: "global", authority: "remembered", scope: "global", source: "test" }],
        projectMemory: input.projectId
          ? [{ id: "p", content: input.projectId, authority: "remembered", scope: "project", source: "test", projectId: input.projectId }]
          : []
      };
    },
    async remember() { return { ok: true }; }
  };
  const router = new ContextRouter(memory, new JsonConversationProjectBindingStore(join(root, "bindings.json")));
  assert.equal((await router.context({ accountId: "acct", userId: "user", query: "继续 aide", conversationId: "chat", knownProjectIds: ["aide", "memmy"] })).resolvedProjectId, "aide");
  assert.equal((await router.context({ accountId: "acct", userId: "user", query: "继续", conversationId: "chat", knownProjectIds: ["aide", "memmy"] })).resolvedProjectId, "aide");
  assert.equal((await router.context({ accountId: "acct", userId: "user", query: "转到 memmy", conversationId: "chat", knownProjectIds: ["aide", "memmy"] })).resolvedProjectId, "memmy");
  assert.equal((await router.context({ accountId: "acct", userId: "user", query: "继续", conversationId: "chat", knownProjectIds: ["aide", "memmy"] })).resolvedProjectId, "memmy");
  assert.equal((await router.context({ accountId: "acct", userId: "user", query: "回 aide", conversationId: "chat", semanticProjectIds: ["aide"], knownProjectIds: ["aide", "memmy"] })).resolvedProjectId, "aide");
  assert.equal((await router.context({ accountId: "acct", userId: "user", query: "转到 memmy", conversationId: "chat", projectId: "memmy", knownProjectIds: ["aide", "memmy"] })).resolvedProjectId, "memmy");
  assert.deepEqual(calls, ["aide", "aide", "memmy", "memmy", "aide", "memmy"]);

  const branchStore = new JsonProjectBranchStore(join(root, "project-branches.json"));
  const retrievalBranch = await branchStore.create("acct", "aide", {
    name: "Retrieval",
    goal: "Improve semantic BM25 retrieval and relevant-memory precision."
  });
  const webBranch = await branchStore.create("acct", "aide", {
    name: "Web",
    goal: "Finish the Control Plane web interface."
  });
  await branchStore.create("acct", "aide", {
    name: "Network",
    goal: "Diagnose Cloudflare transport stability."
  });
  assert.equal((await branchStore.list("acct", "aide")).length, 3);
  const branchQueries = [];
  const branchMemory = {
    async recall(input) {
      branchQueries.push(input.query);
      return { globalMemory: [], projectMemory: [], reusableSkills: [] };
    },
    async remember() { return { ok: true }; }
  };
  const branchRouter = new ContextRouter(
    branchMemory,
    new JsonConversationProjectBindingStore(join(root, "branch-project-bindings.json")),
    undefined,
    branchStore
  );
  await branchStore.bind("acct", "branch-chat", "aide", retrievalBranch.branchId);
  let branchCapsule = await branchRouter.context({
    accountId: "acct",
    userId: "user",
    query: "继续",
    conversationId: "branch-chat",
    projectId: "aide",
    knownProjectIds: ["aide"]
  });
  assert.equal(branchCapsule.branchContext?.branchId, retrievalBranch.branchId);
  assert.equal(branchCapsule.branchContext?.source, "conversation_binding");
  assert.match(branchQueries.at(-1), /semantic BM25 retrieval/);
  branchCapsule = await branchRouter.context({
    accountId: "acct",
    userId: "user",
    query: "继续",
    conversationId: "branch-chat",
    projectId: "aide",
    branchId: webBranch.branchId,
    knownProjectIds: ["aide"]
  });
  assert.equal(branchCapsule.branchContext?.branchId, webBranch.branchId);
  assert.equal(branchCapsule.branchContext?.source, "explicit");
  assert.match(branchQueries.at(-1), /Control Plane web interface/);
  assert.equal((await branchStore.current("acct", "branch-chat", "aide"))?.branchId, webBranch.branchId);
  await branchStore.close("acct", "aide", webBranch.branchId);
  assert.equal(await branchStore.current("acct", "branch-chat", "aide"), null);
  assert.equal((await branchStore.list("acct", "aide")).length, 2);
  assert.equal((await branchStore.list("acct", "aide", { includeClosed: true })).length, 3);
  const crossProjectBranchCapsule = await branchRouter.context({
    accountId: "acct",
    userId: "user",
    query: "继续",
    conversationId: "branch-chat",
    projectId: "memmy",
    knownProjectIds: ["aide", "memmy"]
  });
  assert.equal(crossProjectBranchCapsule.branchContext, null);
  await assert.rejects(() => branchRouter.context({
    accountId: "acct",
    userId: "user",
    query: "继续",
    projectId: "memmy",
    branchId: retrievalBranch.branchId,
    knownProjectIds: ["aide", "memmy"]
  }), /unknown active branch for project memmy/);

  const concurrentBranchPath = join(root, "concurrent-branches.json");
  const concurrentBranchStores = Array.from({ length: 16 }, () => new JsonProjectBranchStore(concurrentBranchPath));
  await Promise.all(concurrentBranchStores.map((store, index) =>
    store.create("acct", "aide", { name: `branch-${index}`, goal: `parallel workstream ${index}` })
  ));
  assert.equal((await concurrentBranchStores[0].list("acct", "aide")).length, 16);

  const resultTransport = new JsonResultTransport(join(root, "result-state"), "acct", 100);
  const largeValue = { payload: "界".repeat(130_000), marker: "generic-result-transport" };
  let resultChunk = resultTransport.wrap(largeValue);
  assert.equal(resultChunk.result_transport.mode, "chunked");
  let reconstructed = resultChunk.result_chunk;
  while (resultChunk.result_transport.next_offset !== null) {
    resultChunk = resultTransport.read(
      resultChunk.result_transport.result_id,
      resultChunk.result_transport.next_offset,
      100_000
    );
    reconstructed += resultChunk.result_chunk;
  }
  assert.deepEqual(JSON.parse(reconstructed), largeValue);
  assert.throws(() => new JsonResultTransport(join(root, "result-state"), "other-account").read(
    resultChunk.result_transport.result_id,
    0,
    100_000
  ));
  assert.throws(() => resultTransport.read("../escape", 0, 100_000), /invalid result_id/);

  const concurrentBindingPath = join(root, "concurrent-bindings.json");
  const concurrentBindingStores = Array.from(
    { length: 32 },
    () => new JsonConversationProjectBindingStore(concurrentBindingPath)
  );
  await Promise.all(concurrentBindingStores.map((store, index) =>
    store.bind("acct", `parallel-chat-${index}`, `parallel-project-${index}`)
  ));
  const concurrentBindings = JSON.parse(await readFile(concurrentBindingPath, "utf8"));
  assert.equal(concurrentBindings.bindings.length, 32);

  const crossProcessBindingPath = join(root, "cross-process-bindings.json");
  await Promise.all(Array.from({ length: 8 }, (_, index) => runNodeEval(
    "import { JsonConversationProjectBindingStore } from './dist/binding-store.js'; await new JsonConversationProjectBindingStore(process.argv[1]).bind('acct', process.argv[2], process.argv[3]);",
    [crossProcessBindingPath, `cross-chat-${index}`, `cross-project-${index}`]
  )));
  const crossProcessBindings = JSON.parse(await readFile(crossProcessBindingPath, "utf8"));
  assert.equal(crossProcessBindings.bindings.length, 8);

  const crashedRegistryPath = join(root, "crashed-project-registry.json");
  await writeFile(`${crashedRegistryPath}.lock`, JSON.stringify({
    token: "crashed-owner",
    pid: 99999999,
    host: hostname(),
    createdAt: new Date().toISOString()
  }) + "\n");
  const crashedRegistry = new JsonProjectRegistry(crashedRegistryPath);
  await crashedRegistry.create("acct", { projectId: "recovered", description: "Dead local lock recovery regression." });
  assert.equal((await crashedRegistry.list("acct"))[0]?.projectId, "recovered");

  const concurrentCaptureRoot = join(root, "cross-process-captures");
  await Promise.all(Array.from({ length: 8 }, (_, index) => runNodeEval(
    "import { storeCaptureEvent } from './dist/capture.js'; const i=process.argv[2]; await storeCaptureEvent(process.argv[1], { device_id:'probe-device', account_id:'acct' }, { event_id:'capture-'+i, host:'probe', conversation_id:'capture-conv-'+i, continuity_id:'capture-conv-'+i, timestamp:'2026-09-22T00:00:00.000Z', project_hint:'memhub', user_text:'user-'+i, assistant_text:'assistant-'+i, capture_status:'complete' });",
    [concurrentCaptureRoot, String(index)]
  )));
  assert.equal(await countCaptureEvents(concurrentCaptureRoot), 8);

  const sameCaptureRoot = join(root, "cross-process-same-capture");
  const sameCaptureArgs = [sameCaptureRoot, "same-event", "same-conversation"];
  await Promise.all([
    runNodeEval(
      "import { storeCaptureEvent } from './dist/capture.js'; await storeCaptureEvent(process.argv[1], { device_id:'probe-device', account_id:'acct' }, { event_id:process.argv[2], host:'probe', conversation_id:process.argv[3], continuity_id:process.argv[3], timestamp:'2026-09-22T00:00:00.000Z', project_hint:'memhub', user_text:'user-half', capture_status:'partial' });",
      sameCaptureArgs
    ),
    runNodeEval(
      "import { storeCaptureEvent } from './dist/capture.js'; await storeCaptureEvent(process.argv[1], { device_id:'probe-device', account_id:'acct' }, { event_id:process.argv[2], host:'probe', conversation_id:process.argv[3], continuity_id:process.argv[3], timestamp:'2026-09-22T00:00:00.000Z', project_hint:'memhub', assistant_text:'assistant-half', capture_status:'partial' });",
      sameCaptureArgs
    )
  ]);
  const sameCapture = (await listCaptureEvents(sameCaptureRoot, "acct", { limit: 2 }))[0];
  assert.equal(sameCapture.user_text, "user-half");
  assert.equal(sameCapture.assistant_text, "assistant-half");
  assert.equal(sameCapture.capture_status, "complete");

  const concurrentDistillationRoot = join(root, "cross-process-distillation");
  await Promise.all(Array.from({ length: 8 }, (_, index) => runNodeEval(
    "import { enqueueDerivedDistillationJob } from './dist/distillation-jobs.js'; const i=process.argv[2]; await enqueueDerivedDistillationJob({ stateRoot:process.argv[1], accountId:'acct', target:'l3', projectId:'memhub', evidence:[{ ref:'artifact:'+i, kind:'artifact', timestamp:'2026-09-22T00:00:00.000Z', project_id:'memhub', layer:'L2', content:'evidence-'+i }] });",
    [concurrentDistillationRoot, String(index)]
  )));
  assert.equal((await listDistillationJobs(concurrentDistillationRoot, "acct")).length, 8);

  const leaseRoot = join(root, "cross-process-lease");
  const seededLeaseJob = await enqueueDerivedDistillationJob({
    stateRoot: leaseRoot,
    accountId: "acct",
    target: "l3",
    projectId: "memhub",
    evidence: [{
      ref: "artifact:lease-one",
      kind: "artifact",
      timestamp: "2026-09-22T00:00:00.000Z",
      project_id: "memhub",
      layer: "L2",
      content: "single lease evidence"
    }]
  });
  const leaseResults = await Promise.all(Array.from({ length: 8 }, (_, index) => runNodeEval(
    "import { leaseDistillationJob } from './dist/distillation-jobs.js'; const job=await leaseDistillationJob(process.argv[1], 'acct', { projectId:'memhub', target:'l3', harness:process.argv[2] }); console.log(job?.job_id ?? 'null');",
    [leaseRoot, `lease-harness-${index}`]
  )));
  const leasedIds = leaseResults.filter((value) => value !== "null");
  assert.deepEqual(leasedIds, [seededLeaseJob.job.job_id]);

  const concurrentBridgeRoot = join(root, "cross-process-bridge");
  const bridgeBaseArgs = [concurrentBridgeRoot, "bridge-race-event", "bridge-race-conv"];
  await Promise.all([
    runNodeEval(
      "import { MemhubBridgeQueue } from './dist/bridge.js'; await new MemhubBridgeQueue(process.argv[1]).enqueue({ event_id:process.argv[2], host:'probe', conversation_id:process.argv[3], continuity_id:process.argv[3], timestamp:'2026-09-22T00:00:00.000Z', user_text:'user-half', capture_status:'partial' });",
      bridgeBaseArgs
    ),
    runNodeEval(
      "import { MemhubBridgeQueue } from './dist/bridge.js'; await new MemhubBridgeQueue(process.argv[1]).enqueue({ event_id:process.argv[2], host:'probe', conversation_id:process.argv[3], continuity_id:process.argv[3], timestamp:'2026-09-22T00:00:00.000Z', assistant_text:'assistant-half', capture_status:'partial' });",
      bridgeBaseArgs
    )
  ]);
  const bridgeQueueFiles = (await readdir(join(concurrentBridgeRoot, "queue"))).filter((name) => name.endsWith(".json"));
  assert.equal(bridgeQueueFiles.length, 1);
  const bridgedRaceEvent = JSON.parse(await readFile(join(concurrentBridgeRoot, "queue", bridgeQueueFiles[0]), "utf8"));
  assert.equal(bridgedRaceEvent.user_text, "user-half");
  assert.equal(bridgedRaceEvent.assistant_text, "assistant-half");
  assert.equal(bridgedRaceEvent.capture_status, "complete");

  const projectRegistry = new JsonProjectRegistry(join(state, "project-registry.json"));
  const reconciled = await projectRegistry.reconcile("acct", [
    "oursmemory", "OursMemory", "Memhub", "memhub", "DevSpaceControl"
  ]);
  assert.deepEqual(reconciled.map((item) => item.projectId), ["DevSpaceControl", "memhub", "oursmemory"]);
  assert.equal(await projectRegistry.resolve("acct", "OursMemory"), "oursmemory");
  assert.equal(await projectRegistry.resolve("acct", "MEMHUB"), "memhub");
  assert.equal(projectSimilarity("OursMemory", "oursmemory"), 1);
  const ours = await projectRegistry.update("acct", "oursmemory", {
    description: "Long-term memory research and implementation project."
  });
  assert.match(ours.description, /Long-term memory/);
  const suggestion = await projectRegistry.suggest("acct", "OursMemori", 3);
  assert.equal(suggestion[0]?.projectId, "oursmemory");
  await projectRegistry.create("acct", {
    projectId: "ours-memory-next",
    description: "Temporary successor project used to verify logical merge."
  });
  await projectRegistry.merge("acct", "ours-memory-next", "oursmemory");
  assert.equal(await projectRegistry.resolve("acct", "ours-memory-next"), "oursmemory");
  assert.ok((await projectRegistry.storageIds("acct", "oursmemory")).includes("ours-memory-next"));
  await projectRegistry.create("acct", { projectId: "throwaway", description: "Disposable test project." });
  await projectRegistry.delete("acct", "throwaway");
  assert.equal(await projectRegistry.resolve("acct", "throwaway"), null);

  const concurrentRegistryPath = join(root, "concurrent-project-registry.json");
  const concurrentRegistry = new JsonProjectRegistry(concurrentRegistryPath);
  await concurrentRegistry.create("acct", { projectId: "memhub", description: "Concurrency regression fixture." });
  const concurrentRegistries = Array.from({ length: 32 }, () => new JsonProjectRegistry(concurrentRegistryPath));
  await Promise.all(concurrentRegistries.map((registry, index) =>
    registry.addTodo("acct", "memhub", `parallel-todo-${index}`)
  ));
  const concurrentProject = (await concurrentRegistry.list("acct")).find((item) => item.projectId === "memhub");
  assert.equal(concurrentProject?.todos?.length, 32);

  const aliasCalls = [];
  const aliasMemory = {
    async recall(input) {
      aliasCalls.push(input);
      return {
        globalMemory: [],
        projectMemory: input.projectId
          ? [{ id: "alias-p", content: "alias project", authority: "remembered", scope: "project", source: "test", projectId: input.projectId }]
          : [],
        reusableSkills: []
      };
    },
    async remember() { return { ok: true }; }
  };
  const aliasRouter = new ContextRouter(
    aliasMemory,
    new JsonConversationProjectBindingStore(join(root, "alias-bindings.json")),
    projectRegistry
  );
  const aliasCapsule = await aliasRouter.context({
    accountId: "acct",
    userId: "user",
    query: "继续 OursMemory",
    conversationId: "alias-chat",
    knownProjectIds: ["oursmemory", "OursMemory"]
  });
  assert.equal(aliasCapsule.resolvedProjectId, "oursmemory");
  assert.ok(aliasCalls[0].projectStorageIds.includes("OursMemory"));

  const owner = await addAccount(state, "owner", "owner@example.com");
  await assert.rejects(() => resolveCloudflareAccount(state, { sub: "unknown", email: "unknown@example.com" }), /允许列表/);
  assert.equal((await resolveCloudflareAccount(state, { sub: "owner-sub", email: "owner@example.com" })).account_id, owner.account_id);
  const linkedStore = JSON.parse(await readFile(join(state, "accounts.json"), "utf8"));
  assert.equal(linkedStore.accounts.owner.cloudflare.sub, "owner-sub");
  assert.equal((await resolveCloudflareAccount(state, { sub: "owner-sub", email: "owner-renamed@example.com" })).account_id, owner.account_id);
  assert.equal((await listAccounts(state)).find((item) => item.account_id === owner.account_id)?.cloudflare_email, "owner-renamed@example.com");
  await setAccountRole(state, owner.account_id, "admin");
  assert.equal((await listAccounts(state)).find((item) => item.account_id === owner.account_id)?.role, "admin");

  assert.equal(normalizeCaptureEvent({
    event_id: "partial-turn",
    host: "test",
    conversation_id: "conv",
    timestamp: "2026-09-18T08:00:00.000Z",
    user_text: "only user side"
  }).user_text, "only user side");
  assert.throws(() => normalizeCaptureEvent({
    event_id: "empty-turn",
    host: "test",
    conversation_id: "conv",
    timestamp: "2026-09-18T08:00:00.000Z"
  }), /requires user_text, assistant_text, reasoning_summary, or tool_summary/);
  const device = await createDevice(state, owner.account_id, "owner-laptop");
  const deviceStoreText = await readFile(join(state, "devices.json"), "utf8");
  assert.equal(deviceStoreText.includes(device.token), false);
  assert.match(deviceStoreText, /"token_hash":\s*"[a-f0-9]{64}"/);

  console.log("memhub-core-e2e: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
