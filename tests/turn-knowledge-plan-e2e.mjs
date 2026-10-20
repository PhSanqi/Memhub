import assert from "node:assert/strict";
import { buildTurnKnowledgePlan } from "../dist/turn-knowledge-plan.js";

const retrieval = (matchedTerms = []) => ({
  rank: 1,
  semanticScore: 0.7,
  lexicalScore: matchedTerms.length > 0 ? 0.8 : 0,
  fusedScore: 0.72,
  diversityPenaltyApplied: 0,
  matchedTerms,
  candidateCount: 2,
  dedupedCount: 2
});

const lane = {
  version: "retrieval-v1",
  semanticWeight: 0.68,
  lexicalWeight: 0.32,
  diversityPenalty: 0.12,
  candidateCount: 2,
  dedupedCount: 2,
  emittedCount: 2,
  queryTerms: ["本轮知识", "使用计划", "current", "truth", "memmy", "context"]
};

const capsule = {
  accountId: "acct",
  conversationId: null,
  resolvedProjectId: "memhub",
  resolutionSource: "explicit_project",
  recallScope: "global_and_project",
  globalMemory: [{
    id: "l4-profile",
    evidenceRef: "l4:l4-profile:r4",
    content: "# Stable preference\n- Prefer minimal sufficient architecture and low runtime overhead.",
    authority: "remembered",
    scope: "global",
    source: "memmy-memory",
    provenance: { memoryLayer: "L4", retrievalV1: retrieval(["minimal"]) }
  }],
  projectMemory: [{
    id: "l3-profile",
    evidenceRef: "l3:l3-profile:r3",
    content: "# Memhub rules\n- Account identity is stable.\n- Harness owns semantic judgment.",
    authority: "remembered",
    scope: "project",
    source: "memmy-memory",
    projectId: "memhub",
    provenance: { memoryLayer: "L3", retrievalV1: retrieval(["harness"]) }
  }, {
    id: "l2-timeline",
    evidenceRef: "l2:l2-timeline:r2",
    content: "# Timeline\n## Earlier\nOld unrelated work.",
    authority: "remembered",
    scope: "project",
    source: "memmy-memory",
    projectId: "memhub",
    provenance: { memoryLayer: "L2", retrievalV1: retrieval(["memmy"]) }
  }],
  reusableSkills: [{
    id: "skill-unrelated",
    content: "Skill candidate: unrelated media workflow",
    authority: "remembered",
    scope: "capability",
    source: "memmy-memory",
    projectId: "other",
    provenance: { memoryLayer: "Skill", retrievalV1: retrieval([]) }
  }],
  projectArchitecture: [{
    id: "architecture:memhub:context",
    content: "# Context Router\nThe memmy_context boundary keeps one primary project and bounded progressive disclosure.\n\n# Other\nUnrelated deployment detail.",
    authority: "authoritative",
    scope: "project",
    source: "project-architecture",
    projectId: "memhub"
  }],
  ambiguities: [],
  branchContext: null,
  contextBudget: {
    maxContentBytes: 96000,
    maxItemContentBytes: 24000,
    emittedContentBytes: 5000,
    truncatedItems: 0,
    droppedItems: 0
  },
  retrievalDiagnostics: {
    version: "retrieval-v1",
    requestedLimit: 4,
    finalLimit: 4,
    candidateLimit: 16,
    lanes: { global: lane, project: lane, skills: lane }
  }
};

const hydrationCalls = [];
const plan = await buildTurnKnowledgePlan({
  query: "实现本轮知识使用计划，让 memmy_context 明确 Current Truth，并保持低开销",
  capsule,
  hydrateEvidence: async (evidenceRef) => {
    hydrationCalls.push(evidenceRef);
    if (evidenceRef.startsWith("l3:")) {
      return { content: "# Memhub rules\n- Account identity is stable.\n- 本轮知识使用计划应把 L3 Current Truth 标成 required，并让 Harness 负责最终语义判断。\n- Do not add a second memory service." };
    }
    if (evidenceRef.startsWith("l2:")) {
      return { content: "# Timeline\n## Earlier\nOld unrelated work.\n\n## Turn Knowledge Plan\nmemmy_context 开始组织本轮知识使用角色，并保持 progressive disclosure。" };
    }
    return null;
  }
});

assert.equal(plan.version, "turn-knowledge-plan-v1");
assert.equal(plan.persistence, "none");
assert.equal(plan.model_calls, 0);
assert.equal(plan.sufficiency, "unknown");
assert.deepEqual(new Set(hydrationCalls), new Set(["l3:l3-profile:r3", "l2:l2-timeline:r2"]));
assert.equal(plan.coverage.hydrated_full_revisions, 2);

const l3 = plan.required.find((entry) => entry.kind === "L3");
assert.ok(l3);
assert.match(l3.passages.map((passage) => passage.text).join("\n"), /本轮知识使用计划/);
const architecture = plan.required.find((entry) => entry.kind === "architecture");
assert.ok(architecture);
assert.match(architecture.passages.map((passage) => passage.text).join("\n"), /memmy_context/);
const l2 = plan.supporting.find((entry) => entry.kind === "L2");
assert.ok(l2);
assert.match(l2.passages.map((passage) => passage.text).join("\n"), /memmy_context|Turn Knowledge Plan/);
assert.equal(plan.supporting.some((entry) => entry.id === "skill-unrelated"), false);
assert.ok(plan.evidence_on_demand.candidate_evidence_refs.includes("l3:l3-profile:r3"));
assert.ok(plan.evidence_on_demand.candidate_evidence_refs.includes("l2:l2-timeline:r2"));

const partial = await buildTurnKnowledgePlan({
  query: "same query",
  capsule: {
    ...capsule,
    contextBudget: { ...capsule.contextBudget, truncatedItems: 1 }
  }
});
assert.equal(partial.sufficiency, "partial");
assert.equal(partial.coverage.context_truncated_items, 1);

const degraded = await buildTurnKnowledgePlan({
  query: "same query",
  capsule: {
    ...capsule,
    retrievalDiagnostics: { ...capsule.retrievalDiagnostics, coreStatus: ["fts_search:failed_pattern_fallback"] }
  }
});
assert.equal(degraded.sufficiency, "partial");
assert.equal(degraded.coverage.retrieval_degraded, true);
assert.deepEqual(degraded.coverage.core_status, ["fts_search:failed_pattern_fallback"]);

console.log("turn-knowledge-plan-e2e: ok");
