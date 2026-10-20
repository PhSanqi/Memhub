import assert from "node:assert/strict";
import { MemoryRestContextSource } from "../dist/memory-source.js";

const requests = [];
const makeHit = (id, layer, score, snippet, tags, title = "") => ({
  id,
  kind: layer === "Skill" ? "skill" : "profile",
  memoryLayer: layer,
  status: "activated",
  title,
  snippet,
  score,
  tags,
  source: "search",
  retrievalRoutes: ["agent_memory"]
});

const client = {
  async search(request) {
    requests.push(request);
    const layers = request.layers ?? [];
    const project = request.namespace?.projectId;
    if (layers.includes("L4")) {
      return { debug: { hits: [
        makeHit("global-1", "L4", 0.9, "Cross-project stable profile", ["global"]),
        makeHit("bad-global", "L4", 1.0, "Wrongly tagged global candidate", ["project:other"])
      ] } };
    }
    if (layers.includes("Skill")) {
      return { debug: { hits: [
        makeHit(
          `skill-${project}`,
          "Skill",
          0.8,
          `# Retrieval Audit\nUse a bounded diagnostic pass.\n## When to use\nUse when retrieval quality drops in ${project}.\n## Procedure\nSECRET FULL SKILL PROCEDURE`,
          ["artifact:skill", `project:${project}`, "retrieval", "audit", "confidence:0.85"],
          "Retrieval Audit"
        ),
        makeHit("wrong-skill", "Skill", 1.0, "must not cross scope", ["artifact:skill", "project:other"])
      ] } };
    }
    if (layers.includes("L3") || layers.includes("L2")) {
      return { debug: { status: ["fts_search:failed_pattern_fallback"], hits: [
        makeHit("project-keyword", "L3", 0.55, "BM25 keyword retrieval diagnostics and compact top-k", [`project:${project}`]),
        makeHit("project-semantic", "L3", 1.4, "general project architecture", [`project:${project}`]),
        makeHit("project-duplicate", "L3", 0.5, "BM25   keyword retrieval diagnostics and compact top-k", [`project:${project}`]),
        makeHit("wrong-project", "L3", 2.0, "BM25 keyword retrieval diagnostics", ["project:other"])
      ] } };
    }
    return { debug: { hits: [] } };
  }
};

const source = new MemoryRestContextSource(client);
const recalled = await source.recall({
  accountId: "acct",
  userId: "user",
  query: "BM25 keyword retrieval audit",
  projectId: "memhub",
  projectStorageIds: ["memhub"],
  limit: 6,
  reusableSkillProjectIds: ["memhub"]
});

assert.deepEqual(recalled.globalMemory.map((item) => item.id), ["global-1"]);
assert.equal(recalled.projectMemory[0].id, "project-keyword");
assert.ok(recalled.projectMemory.every((item) => item.projectId === "memhub"));
assert.ok(recalled.projectMemory.every((item) => item.id !== "wrong-project"));
assert.equal(recalled.reusableSkills.length, 1);
assert.equal(recalled.reusableSkills[0].id, "skill-memhub");
assert.match(recalled.reusableSkills[0].content, /Skill candidate: Retrieval Audit/);
assert.match(recalled.reusableSkills[0].content, /Load: memhub_skill action=load/);
assert.doesNotMatch(recalled.reusableSkills[0].content, /SECRET FULL SKILL PROCEDURE/);
assert.equal(recalled.reusableSkills[0].provenance.skillRouter.reliability, 0.85);
assert.equal(recalled.diagnostics.version, "retrieval-v1");
assert.equal(recalled.diagnostics.finalLimit, 6);
assert.equal(recalled.diagnostics.candidateLimit, 24);
assert.deepEqual(recalled.diagnostics.coreStatus, ["fts_search:failed_pattern_fallback"]);
assert.ok(recalled.diagnostics.lanes.project.candidateCount >= 2);
assert.ok(recalled.projectMemory[0].provenance.retrievalV1.fusedScore > 0);
assert.ok(requests.every((request) => request.limit <= 24));

// Project merge/alias regression: storageIds may contain both the active
// canonical project and historical merged project namespaces. Historical L3
// remains stored for audit/provenance, but must never compete with the active
// canonical project's L3 for Current Truth. Historical L2 chronology remains
// eligible so merge history is not lost.
const mergedRequests = [];
const mergedClient = {
  async search(request) {
    mergedRequests.push(request);
    const layers = request.layers ?? [];
    const project = request.namespace?.projectId;
    if (layers.includes("L4") || layers.includes("Skill")) return { debug: { hits: [] } };
    if (project === "LegacyWorkbench" && layers.includes("L3")) {
      return { debug: { hits: [
        makeHit(
          "canonical-legacyworkbench-l3",
          "L3",
          0.2,
          "Current LegacyWorkbench rules and complete canonical project truth.",
          ["artifact:l3", "project:LegacyWorkbench"]
        ),
        makeHit(
          "canonical-legacyworkbench-l2",
          "L2",
          0.1,
          "Current LegacyWorkbench chronology.",
          ["artifact:l2", "project:LegacyWorkbench"]
        )
      ] } };
    }
    if (project === "devspace" && layers.includes("L2") && !layers.includes("L3")) {
      return { debug: { hits: [
        makeHit(
          "historical-devspace-l2",
          "L2",
          0.8,
          "Historical devspace chronology retained after merge.",
          ["artifact:l2", "project:devspace"]
        )
      ] } };
    }
    if (project === "devspace" && layers.includes("L3")) {
      return { debug: { hits: [
        makeHit(
          "historical-devspace-l3",
          "L3",
          9.9,
          "Obsolete devspace rules that must never become Current Truth again.",
          ["artifact:l3", "project:devspace"]
        )
      ] } };
    }
    return { debug: { hits: [] } };
  }
};

const mergedSource = new MemoryRestContextSource(mergedClient);
const mergedRecall = await mergedSource.recall({
  accountId: "acct",
  userId: "user",
  query: "LegacyWorkbench current project truth",
  projectId: "LegacyWorkbench",
  projectStorageIds: ["LegacyWorkbench", "devspace"],
  limit: 6,
  reusableSkillProjectIds: []
});

assert.ok(mergedRecall.projectMemory.some((item) => item.id === "canonical-legacyworkbench-l3"));
assert.ok(mergedRecall.projectMemory.some((item) => item.id === "historical-devspace-l2"));
assert.ok(mergedRecall.projectMemory.every((item) => item.id !== "historical-devspace-l3"));
assert.equal(
  mergedRequests.some((request) =>
    request.namespace?.projectId === "devspace" &&
    (request.layers ?? []).includes("L3")
  ),
  false,
  "merged historical project namespaces must not be queried for L3 Current Truth"
);

console.log("memhub-memory-source-retrieval-e2e: ok");
