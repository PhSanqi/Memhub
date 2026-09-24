import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { memoryAddKey } from "../vendor/memory-core/src/service/import/memory-import-pipeline.js";
import { MemoryRepository } from "../vendor/memory-core/src/storage/repositories.js";

const keyFor = (tenantId, projectId, version) => memoryAddKey({
  namespace: { tenantId, userId: "local-user", projectId },
  sourceAgentId: "chatgpt", sourceSkillId: "shared-audit-id",
  sourceSkillVersion: version, content: "procedure"
}, "Skill", "Audit");
assert.notEqual(keyFor("account-a", "memhub", "1"), keyFor("account-b", "memhub", "1"), "Skill key must separate accounts");
assert.notEqual(keyFor("account-a", "memhub", "1"), keyFor("account-a", "webmaker", "1"), "Skill key must separate projects");
assert.notEqual(keyFor("account-a", "memhub", "1"), keyFor("account-a", "memhub", "2"), "Skill key must separate versions");

const db = new DatabaseSync(":memory:");
try {
  db.exec(`CREATE TABLE memories (
    id TEXT PRIMARY KEY, user_id TEXT, memory_layer TEXT, status TEXT,
    deleted_at TEXT, info_json TEXT, properties_json TEXT, tags_json TEXT
  )`);
  const insert = db.prepare("INSERT INTO memories VALUES (?, ?, 'Skill', 'activated', NULL, ?, ?, ?)");
  const add = (id, { userId = "local-user", project = "memhub", tenant, accountTag, sourceSkillId = "shared-audit-id" } = {}) => {
    insert.run(id, userId, JSON.stringify({ project_id: project }), JSON.stringify({
      internal_info: {
        read_only: true, source_agent_id: "chatgpt", source_skill_id: sourceSkillId,
        ...(tenant ? { source_namespace_tenant_id: tenant } : {})
      }
    }), JSON.stringify(accountTag ? [`provenance:account:${accountTag}`] : []));
  };
  add("new", { tenant: "account-a", accountTag: "account-a" });
  add("same-account-legacy", { accountTag: "account-a" });
  add("other-account-legacy", { accountTag: "account-b" });
  add("other-account-new", { tenant: "account-b", accountTag: "account-b" });
  add("other-project", { tenant: "account-a", project: "webmaker", accountTag: "account-a" });
  add("other-user", { userId: "other-user", tenant: "account-a", accountTag: "account-a" });
  add("other-identity", { tenant: "account-a", sourceSkillId: "other-skill", accountTag: "account-a" });
  add("unknown-legacy-tenant");
  const repository = new MemoryRepository(db, null);
  repository.hydrate = (memory) => memory;
  const archivedIds = [];
  repository.update = (memory) => {
    archivedIds.push(memory.id);
    return memory;
  };
  const result = repository.archivePriorReadOnlySkillVersions({
    currentMemoryId: "new", userId: "local-user", projectId: "memhub",
    tenantId: "account-a", sourceAgentId: "chatgpt", sourceSkillIdentity: "shared-audit-id",
    at: "2026-09-24T00:00:00.000Z"
  });
  assert.deepEqual(archivedIds, ["same-account-legacy"], "only same-account same-project previous identity may be superseded");
  assert.equal(result[0].properties.internal_info.superseded_by_skill_id, "new");
} finally {
  db.close();
}
console.log("memhub-skill-version-scope-e2e: ok");
