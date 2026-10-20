import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { EmbeddedMemoryCore } from "../dist/embedded-memory-core.js";
import { LocalMemoryRestClient } from "../dist/local-memory-client.js";
import { MemoryRestContextSource } from "../dist/memory-source.js";

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const root = await mkdtemp(join(tmpdir(), "memhub-cjk-retrieval-"));
const memoryDir = join(root, "memory");
const configPath = join(root, "memory-config.yaml");
const dbPath = join(memoryDir, "memory.sqlite");
const port = await freePort();
const token = "cjk-retrieval-token";
let core;

try {
  await mkdir(memoryDir, { recursive: true });
  await writeFile(configPath, JSON.stringify({
    memmyMemory: {
      version: 1,
      userId: "local-user",
      roleRouting: { summary: "follow", evolution: "follow" },
      storage: {
        mode: "local",
        backend: "sqlite",
        sqlitePath: dbPath,
        endpoint: `http://127.0.0.1:${port}`,
        token
      },
      algorithm: {
        enableMemoryAdd: true,
        enableMemorySearch: true,
        enableQueryRewrite: false,
        retrieval: { llmFilterEnabled: false }
      },
      agentAccess: { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false }
    },
    providers: {},
    modelAssignments: {
      default: null,
      memorySummary: null,
      memoryEvolution: null,
      embedding: null,
      asr: null,
      imageGeneration: null
    },
    modelPresets: {},
    app: {}
  }, null, 2) + "\n");

  core = new EmbeddedMemoryCore({
    stateRoot: root,
    port,
    configPath,
    dbPath
  });
  await core.start();

  const client = new LocalMemoryRestClient({ endpoint: core.endpoint, token });
  const source = new MemoryRestContextSource(client);
  const distillBase = {
    accountId: "acct-cjk",
    userId: "local-user",
    kind: "l3",
    projectId: "alpha",
    title: "中文项目规则",
    sourceHarness: "cjk-e2e",
    artifactId: "project-profile:alpha",
    evidenceRefs: ["l2:timeline-alpha:rev-1"],
    contractVersion: "memhub-distill-v3"
  };

  await source.distill({
    ...distillBase,
    content: "# 中文项目规则\n\n- 口令是青龙。\n- 旧标记 legacy_old 只用于索引更新回归。"
  });

  const recall = (query) => source.recall({
    accountId: "acct-cjk",
    userId: "local-user",
    query,
    projectId: "alpha",
    projectStorageIds: ["alpha"],
    limit: 4,
    reusableSkillProjectIds: []
  });

  const pureCjk = await recall("口令");
  assert.equal(pureCjk.projectMemory.length, 1, "two-character pure-CJK query must retrieve without embeddings");
  assert.match(pureCjk.projectMemory[0].content, /口令/);
  assert.equal((pureCjk.diagnostics.coreStatus ?? []).some((status) => /fts_search:failed/.test(status)), false);

  const longerCjk = await recall("中文项目规则");
  assert.equal(longerCjk.projectMemory.length, 1, "pure-CJK query without ASCII must remain retrievable");

  await source.distill({
    ...distillBase,
    evidenceRefs: ["l2:timeline-alpha:rev-2"],
    content: "# 中文项目规则\n\n- 口令改为白虎。\n- 当前标记 current_new。\n- secret 中文回退验证。"
  });

  const stale = await recall("legacy_old");
  assert.equal(stale.projectMemory.length, 0, "canonical replacement must not keep matching the old indexed term");
  const current = await recall("current_new");
  assert.equal(current.projectMemory.length, 1, "canonical replacement must index the new term");

  // Simulate an FTS subsystem failure without disabling ordinary Memory Core
  // retrieval. Pattern fallback must still return the Chinese memory, and the
  // degraded route must remain visible to Memhub instead of looking like an
  // ordinary empty result.
  const db = new Database(dbPath);
  db.exec("DROP TABLE memories_fts");
  db.close();

  const degraded = await recall("口令 secret");
  assert.equal(degraded.projectMemory.length, 1, "pattern fallback must preserve recall when FTS fails");
  assert.ok((degraded.diagnostics.coreStatus ?? []).includes("fts_search:failed_pattern_fallback"));

  console.log("chinese-retrieval-e2e: ok");
} finally {
  await core?.stop().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
