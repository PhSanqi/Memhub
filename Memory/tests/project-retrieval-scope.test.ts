import { describe, expect, it } from "vitest";
import type { MemoryRow } from "../src/types.js";
import {
  filterMemoriesForProjectRecallScope,
  memoryMatchesProjectRecallScope
} from "../src/service/retrieval/project-scope-filter.js";

function memory(id: string, projectId?: string): MemoryRow {
  return {
    id,
    timeline: "2026-09-18T00:00:00.000Z",
    userId: "account-a",
    memoryType: "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryValue: id,
    tags: [],
    info: projectId === undefined ? {} : { project_id: projectId },
    properties: {
      internal_info: { memory_layer: "L1" }
    },
    memoryLayer: "L1",
    version: 1,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z"
  };
}

describe("project-scoped memory retrieval", () => {
  const global = memory("global");
  const aide = memory("aide", "aide");
  const memmy = memory("memmy", "memmy");

  it("returns only global memory when no project is resolved", () => {
    expect(filterMemoriesForProjectRecallScope([global, aide, memmy], undefined).map((item) => item.id))
      .toEqual(["global"]);
  });

  it("returns global plus the one resolved project", () => {
    expect(filterMemoriesForProjectRecallScope([global, aide, memmy], "aide").map((item) => item.id))
      .toEqual(["global", "aide"]);
  });

  it("never exposes another project's memory", () => {
    expect(memoryMatchesProjectRecallScope(memmy, "aide")).toBe(false);
  });
});
