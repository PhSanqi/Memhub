import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addAccount,
  listAccounts,
  resolveCloudflareAccount,
  setAccountRole
} from "../dist/auth.js";
import { JsonConversationProjectBindingStore } from "../dist/binding-store.js";
import { buildContextCapsule } from "../dist/context-capsule.js";
import { ContextRouter } from "../dist/context-router.js";
import { assertLoopbackMemoryEndpoint } from "../dist/local-memory-client.js";
import { MemoryRestContextSource } from "../dist/memory-source.js";
import { resolveProjectScope } from "../dist/project-scope.js";
import { createDevice, normalizeCaptureEvent } from "../dist/capture.js";
import { EmbeddedMemoryCore } from "../dist/embedded-memory-core.js";
import { JsonProjectRegistry, projectSimilarity } from "../dist/project-registry.js";

const root = await mkdtemp(join(tmpdir(), "memhub-core-"));
const state = join(root, "state");

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
