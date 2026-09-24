import assert from "node:assert/strict";
import { compactSkillContextItem, skillSelectionMetadataFromBody } from "../dist/skill-router.js";

const body = `skill.import:abc123
# Memhub Long-Term Content Audit

Use a bounded read-first audit to diagnose missing durable state without mutating memory.

## When to use
Use when Memhub appears to be missing memories, projects, architecture, skills, bindings, or long-term evolution state.

## Procedure
SECRET FULL PROCEDURE THAT MUST NOT BE EAGERLY INJECTED.
`;

const item = compactSkillContextItem({
  id: "skill-1",
  content: body,
  authority: "remembered",
  scope: "capability",
  source: "memmy-memory",
  projectId: "memhub",
  provenance: { tags: ["artifact:skill", "project:memhub", "audit", "memory-integrity", "confidence:0.8"] }
});

assert.match(item.content, /Skill candidate: Memhub Long-Term Content Audit/);
assert.match(item.content, /When to use: Use when Memhub appears/);
assert.match(item.content, /Load: memhub_skill action=load skill_id=skill-1/);
assert.doesNotMatch(item.content, /SECRET FULL PROCEDURE/);
assert.equal(item.provenance.skillRouter.reliability, 0.8);
assert.equal(item.provenance.skillRouter.scope, "project:memhub");
assert.ok(item.provenance.skillRouter.triggers.includes("audit"));

const metadata = skillSelectionMetadataFromBody(body, { projectId: "memhub", tags: ["reliability:0.9", "executor:codex"] });
assert.equal(metadata.reliability, 0.9);
assert.equal(metadata.executor, "codex");
assert.equal(metadata.loadRequired, true);

const flattened = compactSkillContextItem({
  id: "skill-flat",
  content: "Memhub Long-Term Content Audit # Memhub Long-Term Content Audit ## When to use Use when project memory appears missing or misrouted. ## Procedure SECRET FULL PROCEDURE",
  authority: "remembered", scope: "capability", source: "memory-core", projectId: "memhub",
  provenance: { tags: ["artifact:skill", "project:memhub", "audit", "memory-v2", "layer:skill"] }
});
assert.equal(flattened.provenance.skillRouter.title, "Memhub Long-Term Content Audit");
assert.equal(flattened.provenance.skillRouter.whenToUse, "Use when project memory appears missing or misrouted.");
assert.equal(flattened.provenance.skillRouter.summary, "Use when project memory appears missing or misrouted.");
assert.doesNotMatch(flattened.content, /SECRET FULL PROCEDURE/);
assert.ok(!flattened.provenance.skillRouter.triggers.includes("memory-v2"));

const recallHitShape = compactSkillContextItem({
  id: "skill-recall-hit",
  content: "Memhub Long-Term Content Audit\n# Memhub Long-Term Content Audit A bounded, read-first audit of durable memory. ## When to use Use when memory appears missing. ## Procedure SECRET",
  authority: "remembered", scope: "capability", source: "memory-core", projectId: "memhub",
  provenance: { tags: ["artifact:skill", "project:memhub", "audit"] }
});
assert.equal(recallHitShape.provenance.skillRouter.title, "Memhub Long-Term Content Audit");
assert.doesNotMatch(recallHitShape.provenance.skillRouter.title, /bounded/i);

console.log("memhub-skill-router-e2e: ok");
