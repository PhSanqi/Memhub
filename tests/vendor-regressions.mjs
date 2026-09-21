import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLlmClient } from "../vendor/memory-core/src/model/llm.js";
import { memoryAddKey } from "../vendor/memory-core/src/service/import/memory-import-pipeline.js";
import { PanelReadModel } from "../vendor/memory-core/src/service/read-model/panel-read.js";
import { RuntimeRepository } from "../vendor/memory-core/src/storage/repositories.js";
import { migrate } from "../vendor/memory-core/src/storage/schema.js";

const root = await mkdtemp(join(tmpdir(), "memhub-vendor-regression-"));
try {
  testUnavailableAssignedModelIsNotConfigured();
  testStableArtifactMemoryKey();
  testV7ToV8Migration();
  testRawTurnProjectFilter();
  testPanelItemsProjectFilterPropagation();
  console.log("memhub-vendor-regressions: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

function testPanelItemsProjectFilterPropagation() {
  const seen = [];
  const model = new PanelReadModel({
    repos: {
      memories: {
        count(filter) { seen.push({ phase: "count", filter }); return 0; },
        list(filter) { seen.push({ phase: "list", filter }); return []; }
      },
      processing: { get() { return undefined; } },
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
    for (const projectId of ["aide", "memhub"]) {
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
    assert.equal(runtime.countRawTurns({ userId: "user-a", projectIds: ["aide"] }), 1);
    assert.deepEqual(runtime.rawTurnStats({ userId: "user-a" }), {
      total: 2,
      succeeded: 2,
      captureManaged: 0,
      captureManagedSucceeded: 0
    });
    assert.equal(runtime.countRawTurns({ userId: "user-a", sessionSource: "test" }), 2);
    const aideTurns = runtime.listRawTurns({ userId: "user-a", projectIds: ["aide"] }, 10, 0);
    assert.equal(aideTurns.length, 1);
    assert.equal(aideTurns[0].projectId, "aide");
    assert.equal(aideTurns[0].sessionSource, "test");
    assert.equal(aideTurns[0].userText, "user aide");
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
    assert.equal(db.prepare("SELECT MAX(version) version FROM schema_migrations").get().version, 8);
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
