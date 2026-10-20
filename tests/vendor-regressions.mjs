import { assertTestPaths, createTestRoot, testEnvironment } from "./test-isolation.mjs";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { listenMemoryHttpServer } from "../vendor/memory-core/src/index.js";
import { closeMemoryHttpServer } from "../vendor/memory-core/src/server/http.js";
import { agentSourceAutomationEnabled, assertLoopbackBindHost } from "../vendor/memory-core/src/server/index.js";
import { createLlmClient } from "../vendor/memory-core/src/model/llm.js";
import { compileRetrievalQuery, skillMetaFromMemory } from "../vendor/memory-core/src/algorithm/plugin-algorithms.js";
import { memoryAddKey } from "../vendor/memory-core/src/service/import/memory-import-pipeline.js";
import { PanelReadModel } from "../vendor/memory-core/src/service/read-model/panel-read.js";
import { Repositories, RuntimeRepository } from "../vendor/memory-core/src/storage/repositories.js";
import { IndexedCandidatePool } from "../vendor/memory-core/src/service/retrieval/indexed-candidate-pool.js";
import { filterMemoriesForProjectRecallScope, memoryMatchesProjectRecallScope } from "../vendor/memory-core/src/service/retrieval/project-scope-filter.js";
import { RetrievalService } from "../vendor/memory-core/src/service/retrieval/retrieval-service.js";
import { migrate, SCHEMA_VERSION } from "../vendor/memory-core/src/storage/schema.js";
import { FileProjectArchitectureSource } from "../dist/architecture-source.js";
import { ContextRouter } from "../dist/context-router.js";
import { MemoryRestContextSource } from "../dist/memory-source.js";
import { rankRecallHits } from "../dist/retrieval-ranker.js";
import { JsonProjectRegistry } from "../dist/project-registry.js";
import { projectOptionLabel, renderConsole } from "../dist/web-ui.js";

const root = await createTestRoot("memhub-vendor-regression-");
try {
  await testRegistryAuthoritativeReads();
  testProjectOptionLabels();
  await testRuntimeIsolation();
  testUnavailableAssignedModelIsNotConfigured();
  testStableArtifactMemoryKey();
  testV7ToV8Migration();
  testRawTurnProjectFilter();
  testPanelItemsProjectFilterPropagation();
  testPanelItemsIncludeBody();
  testSkillMetadataPrefersStructuredTitle();
  testConfigStatusRedactsSecrets();
  testAgentSourceAutomationIsOptIn();
  await testLoopbackListenerGuard();
  await testChineseNoVectorRetrievalAndFtsFallback();
  await testAccountWideSkillRetrievalAndIsolation();
  console.log("memhub-vendor-regressions: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function testRegistryAuthoritativeReads() {
  const architectureRoot = join(root, "fooruntime");
  const aliasRoot = join(architectureRoot, "registered-alias");
  await mkdir(join(aliasRoot, "docs"), { recursive: true });
  await writeFile(join(architectureRoot, "ARCHITECTURE.md"), "# Unknown filesystem project\n");
  await writeFile(join(aliasRoot, "package.json"), "{}\n");
  await writeFile(join(aliasRoot, "docs", "ARCHITECTURE.md"), "# Registered alias architecture\n");
  const architecture = new FileProjectArchitectureSource({ rootDir: architectureRoot });
  assert.deepEqual(await architecture.listProjects("acct-test"), ["fooruntime", "registered-alias"]);
  const registryPath = join(root, "readonly-registry.json");
  const registry = new JsonProjectRegistry(registryPath);
  await registry.create("acct-test", {
    projectId: "canonical", aliases: ["registered-alias"], description: "Registered project."
  });
  await registry.create("acct-test", { projectId: "archived", description: "Inactive fixture." });
  await registry.archive("acct-test", "archived");
  await registry.create("other-account", { projectId: "other", description: "Other account fixture." });
  const before = await readFile(registryPath);
  const memory = { async recall() { return { globalMemory: [], projectMemory: [], reusableSkills: [] }; } };
  const router = new ContextRouter(memory, architecture, registry);
  assert.deepEqual(await router.listProjects("acct-test"), ["canonical"]);
  for (const input of [
    { query: "continue", projectId: "fooruntime" },
    { query: "fooruntime", workspaceProjectId: "fooruntime" },
    { query: "fooruntime", semanticProjectIds: ["fooruntime"] },
    { query: "fooruntime", knownProjectIds: ["fooruntime", "new-alias"] },
    { query: "continue", knownProjectIds: ["CANONICAL"] }
  ]) {
    const capsule = await router.context({ accountId: "acct-test", userId: "user", ...input });
    assert.equal(capsule.resolvedProjectId, null);
    assert.deepEqual(await readFile(registryPath), before, "context must not write registry bytes or add aliases");
  }
  for (const projectId of ["canonical", "REGISTERED-ALIAS"]) {
    const capsule = await router.context({ accountId: "acct-test", userId: "user", projectId, query: "architecture" });
    assert.equal(capsule.resolvedProjectId, "canonical");
    assert.ok(capsule.projectArchitecture.some((item) => item.content.includes("Registered alias architecture")));
    assert.ok(capsule.projectArchitecture.every((item) => item.projectId === "canonical"));
  }
  assert.deepEqual(await readFile(registryPath), before, "alias architecture lookup must remain read-only");
  const missingPath = join(root, "never-created-registry.json");
  const emptyRouter = new ContextRouter(memory, architecture, new JsonProjectRegistry(missingPath));
  assert.deepEqual(await emptyRouter.listProjects("acct-test"), []);
  assert.equal((await emptyRouter.context({ accountId: "acct-test", userId: "user", projectId: "fooruntime", query: "continue" })).resolvedProjectId, null);
  await assert.rejects(readFile(missingPath), { code: "ENOENT" });
  const unregisteredRouter = new ContextRouter(memory, architecture);
  assert.deepEqual(await unregisteredRouter.listProjects("acct-test"), ["fooruntime", "registered-alias"]);
  const legacy = await unregisteredRouter.context({ accountId: "acct-test", userId: "user", projectId: "fooruntime", knownProjectIds: ["extra"], query: "architecture" });
  assert.equal(legacy.resolvedProjectId, "fooruntime");
  assert.ok(legacy.projectArchitecture.some((item) => item.content.includes("Unknown filesystem project")));
}

function testProjectOptionLabels() {
  for (const [name, projectId, expected] of [
    ["memhub", "memhub", "memhub"],
    ["MemHub", "memhub", "MemHub"],
    ["Memory Hub", "memhub", "Memory Hub · memhub"],
    ["", "memhub", "memhub"],
    ["<Hub & Co>", "hub", "<Hub & Co> · hub"]
  ]) {
    assert.equal(projectOptionLabel({ name, projectId }), expected);
  }
  const account = { account_id: "acct-test", username: "tester", role: "admin" };
  const html = renderConsole({ account, accounts: [account], projects: [
    { projectId: "memhub", name: "MemHub", aliases: [], state: "active" },
    { projectId: "hub", name: "<Hub & Co>", aliases: [], state: "active" }
  ], adminView: true, localControl: true, selectedAccountId: account.account_id });
  assert.ok(html.includes('<option value="memhub">MemHub</option>'));
  assert.ok(html.includes('<option value="hub">&lt;Hub &amp; Co&gt; · hub</option>'));
}

async function testRuntimeIsolation() {
  const stateRoot = join(root, "isolated-state");
  const protectedPath = join(homedir(), ".memmy", "memhub", "fixture.json");
  const inherited = {
    PATH: process.env.PATH,
    MEMHUB_OWNER_ACCOUNT_ID: "production-owner",
    MEMHUB_MEMORY_TOKEN: "production-token",
    MEMHUB_MEMORY_URL: "https://production.invalid",
    MEMHUB_PROJECT_REGISTRY: protectedPath,
    MEMHUB_BRANCHES: protectedPath,
    MEMHUB_CONTROL_ROOT: protectedPath,
    MEMHUB_FUTURE_CREDENTIAL: "production-credential"
  };
  const env = testEnvironment(stateRoot, root, {}, inherited);
  assert.deepEqual(Object.keys(env).filter((key) => key.startsWith("MEMHUB_")).sort(), ["MEMHUB_ARCHITECTURE_ROOT", "MEMHUB_STATE_ROOT"]);
  assert.equal(env.MEMHUB_STATE_ROOT, stateRoot);
  assert.equal(env.MEMHUB_ARCHITECTURE_ROOT, root);
  assert.equal(env.PATH, inherited.PATH);
  for (const key of ["MEMHUB_STATE_ROOT", "MEMHUB_CONTROL_ROOT", "MEMHUB_PROJECT_REGISTRY", "MEMHUB_BRANCHES"]) {
    assert.throws(() => testEnvironment(stateRoot, root, { [key]: protectedPath }), /~\/.memmy/);
  }
  // A sibling with a similar prefix is still outside the writable test tree.
  assert.throws(() => assertTestPaths({ stateRoot: `${root}/../../../../memhubruntime-other` }), /under memhubruntime/);
  if (process.platform !== "win32") {
    const link = join(root, "escape-link");
    await symlink(new URL("../..", import.meta.url), link);
    assert.throws(() => assertTestPaths({ registry: join(link, "outside.json") }), /under memhubruntime/);
  }
}

function testSkillMetadataPrefersStructuredTitle() {
  const memory = {
    id: "skill-title-1",
    memoryLayer: "Skill",
    memoryKey: "skill.import:internal-key",
    memoryValue: "Purpose: audit durable memory without mutating it.",
    info: { title: "Memhub Long-Term Content Audit" },
    properties: { internal_info: { skill: { status: "active", eta: 1 } } },
    tags: [],
    status: "activated",
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z"
  };
  assert.equal(skillMetaFromMemory(memory)?.name, "Memhub Long-Term Content Audit");
}

function testAgentSourceAutomationIsOptIn() {
  assert.equal(agentSourceAutomationEnabled({}), false, "automation must be off by default");
  assert.equal(agentSourceAutomationEnabled({ MEMHUB_CORE_AGENT_SOURCE_AUTOMATION: "0" }), false);
  assert.equal(agentSourceAutomationEnabled({ MEMHUB_CORE_AGENT_SOURCE_AUTOMATION: "true" }), false);
  assert.equal(agentSourceAutomationEnabled({ MEMHUB_CORE_AGENT_SOURCE_AUTOMATION: "1" }), true);
  const serverSource = readFileSync(new URL("../vendor/memory-core/src/server/index.js", import.meta.url), "utf8");
  assert.match(serverSource, /startAgentSourceAutomation:\s*agentSourceAutomationEnabled\(\)/,
    "the Core CLI call site must use the opt-in helper");
  assert.doesNotMatch(serverSource, /startAgentSourceAutomation:\s*true/,
    "the Core CLI must not start agent-source automation unconditionally");
}

async function testLoopbackListenerGuard() {
  for (const host of ["127.0.0.1", "::1", "localhost"]) {
    assert.doesNotThrow(() => assertLoopbackBindHost(host), host);
  }
  assert.throws(() => assertLoopbackBindHost("0.0.0.0"), /loopback/);
  const options = {
    service: {
      nextWorkerRunAt() { return undefined; },
      reconcileWorkerStartup() {},
      async runWorkerOnce() { return { leased: 0, embeddingRetries: { leased: 0 } }; }
    },
    port: 0,
    agentSourceExecutor: { startAutomation() {}, async dispose() {} }
  };
  await assert.rejects(listenMemoryHttpServer({ ...options, host: "0.0.0.0" }), /loopback/);
  const listening = await listenMemoryHttpServer({ ...options, host: "127.0.0.1" });
  try {
    assert.match(listening.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await closeMemoryHttpServer(listening.server);
  }
}

function testConfigStatusRedactsSecrets() {
  const model = new PanelReadModel({
    config() {
      return {
        version: 2,
        userId: "user-a",
        storage: { token: "storage-secret", endpoint: "http://127.0.0.1:18960" },
        nested: [{ apiKey: "nested-secret", enabled: true }]
      };
    },
    now: () => "2026-09-20T00:00:00.000Z"
  });
  const result = model.configStatus();
  assert.equal(result.config.storage.token, "********");
  assert.equal(result.config.storage.endpoint, "http://127.0.0.1:18960");
  assert.equal(result.config.nested[0].apiKey, "********");
  assert.equal(result.config.nested[0].enabled, true);
}

function testPanelItemsIncludeBody() {
  const memory = {
    id: "skill-1",
    memoryLayer: "Skill",
    status: "activated",
    memoryValue: "# Useful Skill\nProcedure",
    tags: [],
    properties: { internal_info: {} },
    info: { title: "Useful Skill" },
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    version: 1
  };
  const model = new PanelReadModel({
    repos: {
      memories: {
        count() { return 1; },
        list() { return [memory]; },
        toListItem(item) {
          return {
            id: item.id, kind: "skill", memoryLayer: item.memoryLayer, status: item.status,
            title: item.info.title, summary: "summary", tags: item.tags, createdAt: item.createdAt,
            updatedAt: item.updatedAt, version: item.version
          };
        }
      },
      processing: { getMany() { return []; } },
      runtime: { latestChangeSeq() { return 0; } }
    },
    now: () => "2026-09-20T00:00:00.000Z"
  });
  assert.equal(model.panelItems({ userId: "user-a", layer: "Skill" }).items[0].body, undefined);
  assert.equal(model.panelItems({ userId: "user-a", layer: "Skill", includeBody: true }).items[0].body, memory.memoryValue);
}

function testPanelItemsProjectFilterPropagation() {
  const seen = [];
  const model = new PanelReadModel({
    repos: {
      memories: {
        count(filter) { seen.push({ phase: "count", filter }); return 0; },
        list(filter) { seen.push({ phase: "list", filter }); return []; }
      },
      processing: { getMany() { return []; } },
      runtime: { latestChangeSeq() { return 0; } }
    },
    now: () => "2026-09-20T00:00:00.000Z"
  });
  const result = model.panelItems({ userId: "user-a", layer: "L1", projectIds: ["memhub"] });
  assert.equal(result.total, 0);
  assert.deepEqual(seen.map((entry) => entry.filter.projectIds), [["memhub"], ["memhub"]]);
}

function testRawTurnProjectFilter() {
  const db = new Database(join(root, "raw-turn-project-filter.sqlite"));
  try {
    migrate(db);
    const runtime = new RuntimeRepository(db);
    const at = "2026-09-20T00:00:00.000Z";
    for (const projectId of ["alpha", "memhub"]) {
      const sessionId = `session-${projectId}`;
      const episodeId = `episode-${projectId}`;
      runtime.createSession({
        id: sessionId,
        userId: "user-a",
        projectId,
        source: "test",
        profileId: "default",
        status: "open",
        meta: {},
        openedAt: at,
        lastSeenAt: at,
        updatedAt: at
      });
      runtime.createEpisode({
        id: episodeId,
        sessionId,
        userId: "user-a",
        projectId,
        conversationId: `conversation-${projectId}`,
        status: "open",
        l1MemoryIds: [],
        rawTurnIds: [],
        feedbackIds: [],
        decisionRepairIds: [],
        l2PolicyIds: [],
        l3WorldModelIds: [],
        skillMemoryIds: [],
        turnCount: 0,
        rewardDetail: {},
        pipelineStatus: "idle",
        meta: {},
        openedAt: at,
        updatedAt: at
      });
      runtime.insertRawTurn({
        id: `raw-${projectId}`,
        sessionId,
        episodeId,
        turnId: `turn-${projectId}`,
        userId: "user-a",
        conversationId: `conversation-${projectId}`,
        userText: `user ${projectId}`,
        assistantText: `assistant ${projectId}`,
        toolCalls: [],
        toolResults: [],
        sourceMemoryIds: [],
        usage: {},
        messagePayload: {},
        status: "succeeded",
        createdAt: at
      });
    }
    assert.equal(runtime.countRawTurns({ userId: "user-a" }), 2);
    assert.equal(runtime.countRawTurns({ userId: "user-a", projectIds: ["alpha"] }), 1);
    assert.deepEqual(runtime.rawTurnStats({ userId: "user-a" }), {
      total: 2,
      succeeded: 2,
      captureManaged: 0,
      captureManagedSucceeded: 0
    });
    assert.equal(runtime.countRawTurns({ userId: "user-a", sessionSource: "test" }), 2);
    const alphaTurns = runtime.listRawTurns({ userId: "user-a", projectIds: ["alpha"] }, 10, 0);
    assert.equal(alphaTurns.length, 1);
    assert.equal(alphaTurns[0].projectId, "alpha");
    assert.equal(alphaTurns[0].sessionSource, "test");
    assert.equal(alphaTurns[0].userText, "user alpha");
  } finally {
    db.close();
  }
}

function testStableArtifactMemoryKey() {
  const base = {
    adapterId: "memhub-distill",
    namespace: { tenantId: "acct-a", userId: "user-a", projectId: "memhub" },
    sourceArtifactId: "project-timeline:memhub"
  };
  const first = memoryAddKey({ ...base, requestId: "request-v1", content: "timeline v1" }, "L2", "Project Timeline · memhub");
  const second = memoryAddKey({ ...base, requestId: "request-v2", content: "timeline v2" }, "L2", "Project Timeline · memhub");
  const otherAccount = memoryAddKey({
    ...base,
    namespace: { tenantId: "acct-b", userId: "user-b", projectId: "memhub" },
    requestId: "request-v1",
    content: "timeline v1"
  }, "L2", "Project Timeline · memhub");
  assert.equal(first, second);
  assert.notEqual(first, otherAccount);
  assert.match(first, /^artifact:/);
}

function testUnavailableAssignedModelIsNotConfigured() {
  const llm = createLlmClient({
    provider: "openai",
    vendor: "openai",
    endpoint: "https://example.invalid",
    model: "unavailable-model",
    apiKey: "not-a-real-key",
    selectionError: "model_selection_unavailable",
    enableThinking: false,
    temperature: 0,
    maxTokens: 128,
    timeoutMs: 1_000,
    maxRetries: 0,
    malformedRetries: 0
  });
  assert.equal(llm.isConfigured(), false);
}

function testV7ToV8Migration() {
  const db = new Database(join(root, "v7-to-v8.sqlite"));
  try {
    db.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL, applied_at TEXT NOT NULL, checksum TEXT NOT NULL
      );
      INSERT INTO schema_migrations VALUES ('007_memory_capture_claims', 7, '2026-09-19T00:00:00.000Z', 'legacy');

      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        timeline TEXT NOT NULL,
        user_id TEXT NOT NULL,
        conversation_id TEXT,
        session_id TEXT,
        agent_id TEXT,
        app_id TEXT,
        memory_type TEXT NOT NULL DEFAULT 'LongTermMemory',
        status TEXT NOT NULL DEFAULT 'activated' CHECK (status IN ('activated', 'resolving', 'archived', 'deleted')),
        visibility TEXT NOT NULL DEFAULT 'private',
        memory_key TEXT,
        memory_value TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
        info_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(info_json)),
        properties_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(properties_json)),
        memory_layer TEXT NOT NULL CHECK (memory_layer IN ('L1', 'L2', 'L3', 'Skill')),
        content_hash TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE user_memories (
        id TEXT PRIMARY KEY,
        source_turn_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        memory_types_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(memory_types_json)),
        content TEXT NOT NULL,
        normalized_user_text_hash TEXT NOT NULL,
        source_turn_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_turn_refs_json)),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
        replaces_memory_id TEXT,
        replaced_by_memory_id TEXT,
        archived_at TEXT,
        archive_reason TEXT,
        embedding_json TEXT CHECK (embedding_json IS NULL OR json_valid(embedding_json)),
        embedding_model TEXT,
        embedding_provider TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE evolution_jobs (
        id TEXT PRIMARY KEY,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'leased', 'succeeded', 'failed', 'dead_letter')),
        dedupe_key TEXT,
        user_id TEXT NOT NULL,
        session_id TEXT,
        episode_id TEXT,
        target_memory_id TEXT,
        scope_key TEXT,
        scope_seq INTEGER,
        payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        leased_until TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX uq_evolution_jobs_l3_immutable_dedupe
        ON evolution_jobs (dedupe_key)
        WHERE dedupe_key IS NOT NULL AND job_type IN ('l3_world_model_update', 'project_environment_profile');

      CREATE TABLE embedding_retry_queue (
        id TEXT PRIMARY KEY,
        target_kind TEXT NOT NULL CHECK (target_kind IN ('trace', 'policy', 'world_model', 'skill')),
        target_id TEXT NOT NULL,
        vector_field TEXT NOT NULL CHECK (vector_field IN ('vec_summary', 'vec_action', 'vec')),
        source_text TEXT NOT NULL,
        embed_role TEXT NOT NULL DEFAULT 'document' CHECK (embed_role IN ('document', 'query')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'failed', 'succeeded')),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 6,
        next_attempt_at INTEGER NOT NULL,
        claimed_by TEXT,
        lease_until INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (target_kind, target_id, vector_field)
      );
    `);
    const at = "2026-09-19T00:00:00.000Z";
    const insertMemory = db.prepare(`INSERT INTO memories (
      id, timeline, user_id, memory_value, tags_json, info_json, properties_json,
      memory_layer, created_at, updated_at
    ) VALUES (?, ?, 'test-user', ?, '[]', '{}', ?, ?, ?, ?)`);
    insertMemory.run("legacy-policy", at, "legacy policy", JSON.stringify({ internal_info: { memory_kind: "policy" } }), "L2", at, at);
    insertMemory.run("legacy-world", at, "legacy world", JSON.stringify({ internal_info: { memory_kind: "world_model" } }), "L3", at, at);
    insertMemory.run("trace-current", at, "source turn", JSON.stringify({ internal_info: { memory_kind: "trace" } }), "L1", at, at);
    db.prepare(`INSERT INTO user_memories (
      id, source_turn_id, user_id, content, normalized_user_text_hash, created_at, updated_at
    ) VALUES ('legacy-user', 'turn-1', 'test-user', 'legacy preference', 'hash', ?, ?)`)
      .run(at, at);
    const insertJob = db.prepare(`INSERT INTO evolution_jobs (
      id, job_type, status, dedupe_key, user_id, payload_json, created_at, updated_at
    ) VALUES (?, ?, 'queued', ?, 'test-user', '{}', ?, ?)`);
    insertJob.run("job-world", "l3_world_model_update", "world:1", at, at);
    insertJob.run("job-env", "project_environment_profile", "env:1", at, at);
    insertJob.run("job-reflect", "reflection", null, at, at);
    const insertRetry = db.prepare(`INSERT INTO embedding_retry_queue (
      id, target_kind, target_id, vector_field, source_text, status,
      next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'vec', 'text', 'pending', 1, 1, 1)`);
    insertRetry.run("retry-policy", "policy", "legacy-policy");
    insertRetry.run("retry-world", "world_model", "legacy-world");

    migrate(db);
    assert.equal(db.prepare("SELECT MAX(version) version FROM schema_migrations").get().version, SCHEMA_VERSION);
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(
      db.prepare("SELECT id, status FROM memories WHERE id IN ('legacy-policy','legacy-world') ORDER BY id").all(),
      [
        { id: "legacy-policy", status: "archived" },
        { id: "legacy-world", status: "archived" }
      ]
    );
    assert.equal(
      db.prepare("SELECT json_extract(properties_json, '$.internal_info.legacy_memory_model') value FROM memories WHERE id='legacy-policy'").get().value,
      "v1"
    );
    assert.deepEqual(
      db.prepare("SELECT status, archive_reason FROM user_memories WHERE id='legacy-user'").get(),
      { status: "archived", archive_reason: "replaced_by_memory_layers_v2" }
    );
    assert.deepEqual(
      db.prepare("SELECT id, status FROM evolution_jobs ORDER BY id").all(),
      [
        { id: "job-env", status: "dead_letter" },
        { id: "job-reflect", status: "queued" },
        { id: "job-world", status: "dead_letter" }
      ]
    );
    assert.deepEqual(
      db.prepare("SELECT id, target_kind FROM embedding_retry_queue ORDER BY id").all(),
      [
        { id: "retry-policy", target_kind: "timeline" },
        { id: "retry-world", target_kind: "project_profile" }
      ]
    );
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'").get().sql, /'L4'/);
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='embedding_retry_queue'").get().sql, /'user_profile'/);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='uq_evolution_jobs_l3_immutable_dedupe'").get(), undefined);
    migrate(db);
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    db.close();
  }
}

async function testChineseNoVectorRetrievalAndFtsFallback() {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const repos = new Repositories(db);
    const now = "2026-10-11T00:00:00.000Z";
    db.prepare(`INSERT INTO memories (
      id, timeline, user_id, memory_value, tags_json, info_json, properties_json, memory_layer, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "cjk-memory", "2026-10-11", "cjk-user",
      "这里保存口令白虎 secret，并带旧标记 legacy_old。", "[]",
      JSON.stringify({ project_id: "alpha" }),
      JSON.stringify({ internal_info: { memory_layer: "L3", memory_kind: "project_profile" } }),
      "L3", now, now
    );
    assert.equal(repos.memories.reindexFts(repos.memories.get("cjk-memory")), true);
    assert.equal(repos.memories.hasVectorRows({
      userId: "cjk-user", projectIds: ["alpha"], includeUnscopedProject: true, memoryLayer: ["L3"]
    }), false, "fixture must prove the no-vector fallback path");

    const pool = new IndexedCandidatePool({ repos, memoryHasImportPipeline: () => false });
    const config = {
      tier1TopK: 5, tier2TopK: 5, tier3TopK: 5, candidatePoolFactor: 2, keywordTopK: 10, tagFilter: "off"
    };
    const retrieve = (query) => pool.indexedRetrievalCandidatePool({
      userId: "cjk-user", projectId: "alpha",
      compiledQuery: compileRetrievalQuery(query, null, {}),
      queryVector: undefined, layers: ["L3"], tags: [], config
    });

    const shortCjk = await retrieve("口令");
    assert.deepEqual(shortCjk.memories.map((memory) => memory.id), ["cjk-memory"]);
    assert.deepEqual(shortCjk.status, []);

    db.prepare("UPDATE memories SET memory_value = ?, updated_at = ? WHERE id = ?").run(
      "这里保存口令白虎 secret，并带当前标记 current_new。",
      "2026-10-11T00:01:00.000Z", "cjk-memory"
    );
    assert.equal(repos.memories.reindexFts(repos.memories.get("cjk-memory")), true);
    assert.equal(repos.memories.searchFtsIds("\"legacy_old\"", { userId: "cjk-user", memoryLayer: ["L3"] }, 5).length, 0);
    assert.equal(repos.memories.searchFtsIds("\"current_new\"", { userId: "cjk-user", memoryLayer: ["L3"] }, 5).length, 1);

    db.exec("DROP TABLE memories_fts");
    const degraded = await retrieve("口令 secret");
    assert.deepEqual(degraded.memories.map((memory) => memory.id), ["cjk-memory"],
      "pattern fallback must keep the Chinese result when FTS is unavailable");
    assert.deepEqual(degraded.status, ["fts_search:failed_pattern_fallback"]);
  } finally {
    db.close();
  }
}

async function testAccountWideSkillRetrievalAndIsolation() {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const repos = new Repositories(db);
    const now = "2026-10-18T00:00:00.000Z";

    const insertSkill = (id, userId, projectId, title, snippet) => {
      db.prepare(`INSERT INTO memories (
        id, timeline, user_id, memory_value, tags_json, info_json, properties_json, memory_layer, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'activated', ?, ?)`).run(
        id, "2026-10-18", userId, snippet,
        JSON.stringify(["artifact:skill", `project:${projectId}`]),
        JSON.stringify({ project_id: projectId, title }),
        JSON.stringify({ internal_info: { memory_layer: "Skill", memory_kind: "skill", skill: { status: "active", eta: 1 } } }),
        "Skill", now, now
      );
      repos.memories.reindexFts(repos.memories.get(id));
    };

    insertSkill("skill-alpha-1", "user-alpha", "project-1", "Skill Alpha One", "Alpha diagnostic procedure one for debugging");
    insertSkill("skill-alpha-2", "user-alpha", "project-2", "Skill Alpha Two", "Alpha deployment procedure two for release");
    insertSkill("skill-beta-1", "user-beta", "project-1", "Skill Beta One", "Beta secret procedure one never leak");
    insertSkill("skill-beta-2", "user-beta", "project-3", "Skill Beta Two", "Beta secret procedure two never leak");

    // Insert non-skill memory to test layer protection
    db.prepare(`INSERT INTO memories (
      id, timeline, user_id, memory_value, tags_json, info_json, properties_json, memory_layer, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'activated', ?, ?)`).run(
      "l3-alpha-1", "2026-10-18", "user-alpha", "Project profile of project 1",
      JSON.stringify(["project:project-1"]),
      JSON.stringify({ project_id: "project-1", title: "Project 1 Profile" }),
      JSON.stringify({ internal_info: { memory_layer: "L3", memory_kind: "project_profile" } }),
      "L3", now, now
    );
    repos.memories.reindexFts(repos.memories.get("l3-alpha-1"));

    const pool = new IndexedCandidatePool({ repos, memoryHasImportPipeline: () => false });

    // 1. Candidate count: accountWideSkill finds all skills across projects for that user
    const alphaCount = pool.retrievalCandidateCount({
      userId: "user-alpha", layers: ["Skill"], tags: ["artifact:skill"], accountWideSkill: true
    });
    assert.equal(alphaCount, 2, "user-alpha sees exactly its 2 skills across project-1 and project-2");

    const betaCount = pool.retrievalCandidateCount({
      userId: "user-beta", layers: ["Skill"], tags: ["artifact:skill"], accountWideSkill: true
    });
    assert.equal(betaCount, 2, "user-beta sees exactly its 2 skills");

    const alphaProject1Count = pool.retrievalCandidateCount({
      userId: "user-alpha", projectIds: ["project-1"], layers: ["Skill"], tags: ["artifact:skill"], accountWideSkill: true
    });
    assert.equal(alphaProject1Count, 1, "explicit projectIds restricts to project-1");

    // 2. Candidate retrieval: strict account isolation
    const config = {
      tier1TopK: 60, tier2TopK: 60, tier3TopK: 60, candidatePoolFactor: 2, keywordTopK: 60, tagFilter: "off", minRecallScore: 0, relativeThresholdFloor: 0
    };
    const alphaCandidates = await pool.indexedRetrievalCandidatePool({
      userId: "user-alpha",
      compiledQuery: compileRetrievalQuery("procedure", null, {}),
      layers: ["Skill"],
      tags: ["artifact:skill"],
      accountWideSkill: true,
      config
    });
    const alphaIds = alphaCandidates.memories.map((m) => m.id).sort();
    assert.deepEqual(alphaIds, ["skill-alpha-1", "skill-alpha-2"]);
    assert.ok(!alphaIds.includes("skill-beta-1"), "user-beta skills must NEVER leak into user-alpha candidate pool");
    assert.ok(!alphaIds.includes("skill-beta-2"), "user-beta skills must NEVER leak into user-alpha candidate pool");

    const betaCandidates = await pool.indexedRetrievalCandidatePool({
      userId: "user-beta",
      compiledQuery: compileRetrievalQuery("procedure", null, {}),
      layers: ["Skill"],
      tags: ["artifact:skill"],
      accountWideSkill: true,
      config
    });
    const betaIds = betaCandidates.memories.map((m) => m.id).sort();
    assert.deepEqual(betaIds, ["skill-beta-1", "skill-beta-2"]);
    assert.ok(!betaIds.includes("skill-alpha-1"), "user-alpha skills must NEVER leak into user-beta candidate pool");

    // 3. Post-retrieval filter: memoryMatchesProjectRecallScope
    const alphaSkill1 = repos.memories.get("skill-alpha-1");
    const alphaSkill2 = repos.memories.get("skill-alpha-2");
    const alphaL3 = repos.memories.get("l3-alpha-1");

    assert.equal(memoryMatchesProjectRecallScope(alphaSkill1, undefined, { accountWideSkill: true }), true);
    assert.equal(memoryMatchesProjectRecallScope(alphaSkill2, undefined, { accountWideSkill: true }), true);
    assert.equal(memoryMatchesProjectRecallScope(alphaSkill1, undefined, { accountWideSkill: true, projectIds: ["project-1"] }), true);
    assert.equal(memoryMatchesProjectRecallScope(alphaSkill2, undefined, { accountWideSkill: true, projectIds: ["project-1"] }), false);
    // Non-Skill memories MUST NOT pass without exact project match even if accountWideSkill is true
    assert.equal(memoryMatchesProjectRecallScope(alphaL3, undefined, { accountWideSkill: true }), false,
      "non-Skill memory must not broaden across projects");
    assert.equal(memoryMatchesProjectRecallScope(alphaL3, "project-1", { accountWideSkill: true }), true);

    // 4. End-to-end RetrievalService search: account isolation
    const deps = {
      repos,
      memoryHasImportPipeline: () => false,
      memorySearchEnabled: () => true,
      memoryAddEnabled: () => false,
      resolveContext: (req) => ({
        userId: req.userId ?? req.namespace?.userId ?? "user-alpha",
        namespace: req.namespace ?? { source: "test", profileId: "default", userId: req.userId ?? "user-alpha" }
      }),
      turnStartRetrievalLimit: () => 10,
      queryRewriteEnabled: () => false,
      config: {
        domain: "software_engineering",
        algorithm: {
          retrieval: { ...config, mmrLambda: 0.5, llmFilterEnabled: false },
          l3Abstraction: { minConfidenceForRetrieval: 0.5 },
          reward: { decayHalfLifeDays: 30 }
        }
      },
      llm: { isConfigured: () => false },
      skillLlm: { isConfigured: () => false }
    };
    const retrievalService = new RetrievalService(deps);

    const alphaSearch = await retrievalService.search({
      query: "procedure",
      userId: "user-alpha",
      namespace: { source: "test", profileId: "default", userId: "user-alpha" },
      layers: ["Skill"],
      tags: ["artifact:skill"],
      accountWide: true
    });
    const alphaSearchIds = alphaSearch.hits.map((h) => h.id).sort();
    assert.deepEqual(alphaSearchIds, ["skill-alpha-1", "skill-alpha-2"]);
    assert.ok(!alphaSearchIds.some((id) => id.startsWith("skill-beta")), "account isolation: user-beta skills never returned");

    const betaSearch = await retrievalService.search({
      query: "procedure",
      userId: "user-beta",
      namespace: { source: "test", profileId: "default", userId: "user-beta" },
      layers: ["Skill"],
      tags: ["artifact:skill"],
      accountWide: true
    });
    // A single account-wide request must retain each project's old 24-hit
    // candidate window even when one project alone exceeds the shared limit.
    for (let i = 0; i < 40; i++) {
      insertSkill(`flood-${i}`, "user-alpha", "project-1", `Procedure ${i}`, `Alpha diagnostic procedure for debugging variant ${i}`);
    }
    const searchRequest = {
      query: "procedure", userId: "user-alpha",
      namespace: { source: "test", profileId: "default", userId: "user-alpha" },
      layers: ["Skill"], tags: ["artifact:skill"], limit: 24, includeInjectedContext: false
    };
    const oldResponses = await Promise.all(["project-1", "project-2"].map(projectId => retrievalService.search({
      ...searchRequest, namespace: { ...searchRequest.namespace, projectId }
    })));
    const combined = await retrievalService.search({ ...searchRequest, accountWide: true, projectIds: ["project-1", "project-2"] });
    const oldHits = oldResponses.flatMap(response => response.hits);
    assert.ok(oldHits.length > 24, "fixture exceeds the shared quota");
    assert.deepEqual(combined.hits.map(hit => hit.id), oldHits.map(hit => hit.id), "single Core search preserves per-project candidate quotas");
    let skillRequests = 0;
    const source = new MemoryRestContextSource({ async search(request) {
      if (!request.layers.includes("Skill")) return { debug: { hits: [] } };
      skillRequests++;
      return { debug: { hits: (await retrievalService.search({ ...request, userId: "user-alpha" })).hits } };
    } });
    const recalled = await source.recall({ accountId: "user-alpha", userId: "user-alpha", query: searchRequest.query,
      projectId: null, limit: 6, reusableSkillProjectIds: ["project-1", "project-2"] });
    const oldRankedIds = rankRecallHits(oldHits.sort((a, b) => b.score - a.score), searchRequest.query, 6).hits.map(row => row.hit.id);
    assert.equal(skillRequests, 1);
    assert.deepEqual(recalled.reusableSkills.map(hit => hit.id), oldRankedIds, "Memhub reranking matches the old per-project fan-out");

    const betaSearchIds = betaSearch.hits.map((h) => h.id).sort();
    assert.deepEqual(betaSearchIds, ["skill-beta-1", "skill-beta-2"]);
    assert.ok(!betaSearchIds.some((id) => id.startsWith("skill-alpha")), "account isolation: user-alpha skills never returned");
  } finally {
    db.close();
  }
}
