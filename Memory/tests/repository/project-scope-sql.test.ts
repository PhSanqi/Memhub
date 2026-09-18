import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { Repositories } from "../../src/storage/repositories.js";
import type { MemoryFilter, MemoryRow } from "../../src/types.js";

describe("SQL account/project recall isolation", () => {
  it("filters list, FTS and vector candidates by user and visible project before Top-K", () => {
    const db = new MemoryDb({ path: ":memory:" });
    try {
      const repos = new Repositories(db.db);
      const rows = [
        memory("a-global", "user-a"),
        memory("a-aide", "user-a", "aide"),
        memory("a-memmy", "user-a", "memmy"),
        memory("b-global", "user-b"),
        memory("b-aide", "user-b", "aide")
      ];
      for (const row of rows) repos.memories.insert(row);

      const globalOnly: MemoryFilter = {
        userId: "user-a",
        projectIds: [],
        includeUnscopedProject: true,
        memoryLayer: "L1",
        status: "activated"
      };
      const aide: MemoryFilter = {
        userId: "user-a",
        projectIds: ["aide"],
        includeUnscopedProject: true,
        memoryLayer: "L1",
        status: "activated"
      };
      const otherUserAide: MemoryFilter = {
        userId: "user-b",
        projectIds: ["aide"],
        includeUnscopedProject: true,
        memoryLayer: "L1",
        status: "activated"
      };

      expect(ids(repos.memories.list(globalOnly, 20))).toEqual(["a-global"]);
      expect(ids(repos.memories.list(aide, 20))).toEqual(["a-aide", "a-global"]);
      expect(ids(repos.memories.list(otherUserAide, 20))).toEqual(["b-aide", "b-global"]);

      expect(hitIds(repos.memories.searchFtsIds('"specialterm"', globalOnly, 20))).toEqual(["a-global"]);
      expect(hitIds(repos.memories.searchFtsIds('"specialterm"', aide, 20))).toEqual(["a-aide", "a-global"]);
      expect(hitIds(repos.memories.searchFtsIds('"specialterm"', otherUserAide, 20))).toEqual(["b-aide", "b-global"]);

      expect(hitIds(repos.memories.searchVectorIds([1, 0], "vec_summary", globalOnly, 20))).toEqual(["a-global"]);
      expect(hitIds(repos.memories.searchVectorIds([1, 0], "vec_summary", aide, 20))).toEqual(["a-aide", "a-global"]);
      expect(hitIds(repos.memories.searchVectorIds([1, 0], "vec_summary", otherUserAide, 20))).toEqual(["b-aide", "b-global"]);
    } finally {
      db.close();
    }
  });
});

function memory(id: string, userId: string, projectId?: string): MemoryRow {
  const at = "2026-09-18T00:00:00.000Z";
  return {
    id,
    timeline: at,
    userId,
    sessionId: `${userId}-session`,
    agentId: "memhub-test",
    appId: "memhub-test",
    memoryType: "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryKey: `trace:${id}`,
    memoryValue: `Summary: specialterm ${id}\nUser:\nspecialterm\nAgent:\n${id}`,
    tags: ["trace", "specialterm"],
    info: {
      summary: `specialterm ${id}`,
      ...(projectId ? { project_id: projectId } : {})
    },
    properties: {
      internal_info: {
        memory_layer: "L1",
        memory_kind: "trace",
        trace: {
          key: `trace:${id}`,
          ts: Date.parse(at),
          episode_id: `${id}-episode`,
          step_index: 0,
          sub_step_total: 1,
          userText: "specialterm",
          agentText: id,
          tool_calls: [],
          reflection: null,
          alpha: 0.5,
          summary: `specialterm ${id}`,
          tags: ["trace", "specialterm"],
          value: 0.8,
          priority: 0.8,
          error_signatures: [],
          vec_summary: [1, 0],
          vec_action: [0, 1],
          embedding_model: "test"
        }
      }
    },
    memoryLayer: "L1",
    contentHash: `${id}-hash`,
    version: 1,
    createdAt: at,
    updatedAt: at,
    deletedAt: null
  };
}

function ids(rows: readonly MemoryRow[]): string[] {
  return rows.map((row) => row.id).sort();
}

function hitIds(rows: readonly { id: string }[]): string[] {
  return rows.map((row) => row.id).sort();
}
