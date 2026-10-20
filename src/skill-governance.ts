import { createHash, randomUUID } from "node:crypto";
import {
  DISTILLATION_CONTRACT_VERSION,
  validateDistillationCandidate
} from "./distillation-contract.js";
import { retireDistillationMemory } from "./distillation-jobs.js";
import type { MemhubRuntime } from "./runtime.js";
import { assertNextSkillVersion } from "./skill-version.js";

/**
 * Skill governance: plan -> explicit user authorization -> execute, plus the
 * account-scoped Skill loader used by the MCP Skill tool. The authorization
 * map is process-affine and one-shot; entries expire after one day.
 */
const skillMutationAuthorizations = new Map<string, {
  accountId: string;
  skillId: string;
  operation: "revise" | "retire";
  expectedFingerprint: string;
  content?: string;
  title?: string;
  version?: string;
  tags?: string[];
  note: string;
  expiresAt: number;
}>();

export async function planSkillMutation(input: {
  runtime: MemhubRuntime;
  args: Record<string, unknown>;
  skillId: string;
  skill: Awaited<ReturnType<typeof loadSkillForAccount>>;
}): Promise<Record<string, unknown>> {
  const { runtime, args, skillId, skill } = input;
  if (skill.status !== "activated") throw new Error("only an active Skill can be revised or retired");
  const operation = requiredString(args.operation, "operation");
  if (operation !== "revise" && operation !== "retire") throw new TypeError("operation must be revise or retire");
  const note = requiredString(args.note, "note");
  if (note.length > 2_000) throw new TypeError("note is too long");
  let version: string | undefined;
  let content: string | undefined;
  let title: string | undefined;
  let tags: string[] | undefined;
  if (operation === "revise") {
    if (!skill.sourceAgentId || !skill.sourceSkillId || !skill.sourceSkillVersion) {
      throw new Error("Skill has no stable source identity/version; repair provenance before revision");
    }
    if (!skill.accountProvenanceVerified) throw new Error("Skill account provenance is not verified for revision");
    version = requiredString(args.version, "version");
    assertNextSkillVersion(skill.sourceSkillVersion, version);
    content = requiredString(args.content, "content");
    validateDistillationCandidate({ kind: "skill", content, evidence: {} });
    title = optionalString(args.title) ?? skill.title;
    tags = stringArray(args.tags) ?? skill.tags.filter((tag) =>
      ["audit", "memory-integrity", "project-scoping", "reusable"].includes(tag)
    );
    if (tags.some((tag) => /^(?:artifact:|layer:|project:|global$|provenance:|evidence:|source-conversation:|distill-contract:|revision-of:|source-)/i.test(tag))) {
      throw new Error("Skill business tags cannot override managed scope, provenance or revision identity");
    }
    if (content === skill.body) throw new Error("Skill revision must change the actual procedure");
  }
  const authorizationId = randomUUID();
  // Governance plans require a real user approval round-trip. Ten minutes is
  // too short for chat/MCP transports where the next user turn may arrive
  // well after the plan was rendered. Keep the authorization one-shot and
  // fingerprint-bound, but allow a normal human approval window.
  const expiresAt = Date.now() + 24 * 60 * 60_000;
  skillMutationAuthorizations.set(authorizationId, {
    accountId: runtime.accountId, skillId, operation,
    expectedFingerprint: skillFingerprint(skill),
    ...(content ? { content } : {}), ...(title ? { title } : {}),
    ...(version ? { version } : {}), ...(tags ? { tags } : {}),
    note, expiresAt
  });
  return {
    status: "awaiting_user_authorization", operation, skill_id: skillId,
    source_skill_id: skill.sourceSkillId,
    previous_version: skill.sourceSkillVersion,
    ...(version ? { next_version: version, next_content_sha256: createHash("sha256").update(content!).digest("hex") } : {}),
    impact: operation === "revise"
      ? "Create a new version under the same source skill identity and archive the previous memory id; preserve its history and telemetry."
      : "Archive this Skill so it no longer appears as an active candidate; preserve its history and telemetry.",
    note, authorization_id: authorizationId, expires_at: new Date(expiresAt).toISOString(),
    instructions: "Show this exact plan to the user and call action=execute only after explicit approval."
  };
}

export async function executeSkillMutation(input: {
  stateRoot: string;
  runtime: MemhubRuntime;
  args: Record<string, unknown>;
  skillId: string;
  skill: Awaited<ReturnType<typeof loadSkillForAccount>>;
}): Promise<Record<string, unknown>> {
  const { stateRoot, runtime, args, skillId, skill } = input;
  const authorizationId = requiredString(args.authorization_id, "authorization_id");
  const plan = skillMutationAuthorizations.get(authorizationId);
  if (!plan || plan.accountId !== runtime.accountId || plan.skillId !== skillId) {
    throw new Error("invalid or already-used Skill authorization");
  }
  skillMutationAuthorizations.delete(authorizationId);
  if (plan.expiresAt < Date.now()) throw new Error("Skill authorization expired; create a new plan");
  if (plan.expectedFingerprint !== skillFingerprint(skill) || skill.status !== "activated") {
    throw new Error("Skill changed after plan; review a fresh plan before execution");
  }
  if (plan.operation === "retire") {
    await retireDistillationMemory({ stateRoot, accountId: runtime.accountId, memoryId: skillId,
      operation: "archived", mutateCore: () => runtime.memoryClient.viewerPost("/api/v1/skills/archive", { skillId, reason: plan.note }) });
    return { ok: true, operation: "retire", skill_id: skillId, status: "archived", history_preserved: true };
  }
  if (!skill.sourceAgentId || !skill.sourceSkillId || !plan.content || !plan.version) {
    throw new Error("Skill revision provenance is incomplete");
  }
  const projectId = skill.projectId
    ? await runtime.projects.resolve(runtime.accountId, skill.projectId)
    : null;
  if (skill.projectId && !projectId) throw new Error("Skill project is unknown or inactive");
  const result = await runtime.memory.distill({
    accountId: runtime.accountId, userId: runtime.userId,
    kind: "skill", projectId, content: plan.content,
    title: plan.title, tags: uniqueStrings([...(plan.tags ?? []), `revision-of:${skillId}`]),
    sourceHarness: skill.sourceAgentId, artifactId: skill.sourceSkillId,
    version: plan.version,
    evidenceRefs: skill.tags.filter((tag) => tag.startsWith("evidence:")).map((tag) => tag.slice(9)),
    contractVersion: DISTILLATION_CONTRACT_VERSION,
    provenance: {
      platform: runtime.source.platform, transport: runtime.source.transport,
      principal: runtime.source.principalId, connection: runtime.source.connectionId,
      account: runtime.accountId, authenticated_account: runtime.source.authenticatedAccount
    }
  });
  const newId = requireMemoryResultId(result);
  if (newId === skillId) throw new Error("Skill revision must create a separate version; old history was not archived automatically");
  try {
    await retireDistillationMemory({ stateRoot, accountId: runtime.accountId, memoryId: skillId,
      operation: "archived", mutateCore: () => runtime.memoryClient.viewerPost("/api/v1/skills/archive", { skillId, reason: `superseded by ${newId}: ${plan.note}` }) });
  } catch (error) {
    throw new Error(`new Skill version ${newId} was created but archiving prior ${skillId} failed; reconcile before using both: ${String(error)}`);
  }
  return {
    ok: true, operation: "revise", previous_skill_id: skillId,
    skill_id: newId, source_skill_id: skill.sourceSkillId,
    version: plan.version, previous_status: "archived", history_preserved: true
  };
}

export async function loadSkillForAccount(runtime: MemhubRuntime, skillId: string): Promise<{
  body: string;
  tags: string[];
  projectId?: string;
  title: string;
  status: string;
  sourceAgentId?: string;
  sourceSkillId?: string;
  sourceSkillVersion?: string;
  accountProvenanceVerified: boolean;
}> {
  const payload = objectRecord(await runtime.memoryClient.viewerGet(`/api/v1/memory/${encodeURIComponent(skillId)}`));
  const item = objectRecord(payload.item ?? payload);
  const memoryLayer = optionalString(item.memoryLayer) ?? optionalString(payload.memoryLayer);
  const tags = stringArray(item.tags) ?? stringArray(payload.tags) ?? [];
  if (memoryLayer !== "Skill" || !tags.includes("artifact:skill")) {
    throw new Error("requested memory is not a Memhub reusable Skill");
  }
  const body = optionalString(item.body) ?? optionalString(payload.body);
  if (!body?.trim()) throw new Error("Skill body is unavailable");
  const namespace = objectRecord(item.namespace ?? payload.namespace);
  const tenantId = optionalString(namespace.tenantId);
  if (tenantId && tenantId !== runtime.accountId) throw new Error("Skill is outside current account scope");
  const metadata = objectRecord(item.metadata ?? payload.metadata);
  const info = objectRecord(metadata.info);
  const internal = objectRecord(objectRecord(metadata.properties).internal_info);
  const sourceTenantId = optionalString(internal.source_namespace_tenant_id);
  if (sourceTenantId && sourceTenantId !== runtime.accountId) throw new Error("Skill source belongs to another account");
  const accountTags = tags.filter((tag) => tag.startsWith("provenance:account:"));
  if (accountTags.length > 0 && !accountTags.includes(`provenance:account:${runtime.accountId}`)) {
    throw new Error("Skill provenance belongs to another account");
  }
  const accountProvenanceVerified = tenantId === runtime.accountId ||
    sourceTenantId === runtime.accountId || accountTags.includes(`provenance:account:${runtime.accountId}`);
  if (!accountProvenanceVerified) {
    throw new Error("Skill account ownership is not verifiable; do not load across account boundaries");
  }
  const projectId = optionalString(namespace.projectId) ?? optionalString(info.project_id) ?? projectIdFromSkillTags(tags);
  return {
    body, tags,
    title: optionalString(item.title) ?? optionalString(payload.title) ?? "Reusable Skill",
    status: optionalString(item.status) ?? optionalString(payload.status) ?? "unknown",
    sourceAgentId: optionalString(internal.source_agent_id),
    sourceSkillId: optionalString(internal.source_skill_id),
    sourceSkillVersion: optionalString(internal.source_skill_version),
    accountProvenanceVerified,
    ...(projectId ? { projectId } : {})
  };
}

export function skillFingerprint(skill: Awaited<ReturnType<typeof loadSkillForAccount>>): string {
  return createHash("sha256").update(JSON.stringify([
    skill.body, skill.title, skill.tags, skill.status, skill.projectId,
    skill.sourceAgentId, skill.sourceSkillId, skill.sourceSkillVersion
  ])).digest("hex");
}

export function projectIdFromSkillTags(tags: readonly string[]): string | undefined {
  const tag = tags.find((value) => value.startsWith("project:"));
  const projectId = tag?.slice("project:".length).trim();
  return projectId || undefined;
}

function requiredString(value: unknown, field: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length ? [...new Set(values)] : undefined;
}

function uniqueStrings(values: string[]): string[] | undefined {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return normalized.length ? [...new Set(normalized)] : undefined;
}

function memoryResultId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["id", "memoryId", "skillId"] as const) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function requireMemoryResultId(value: unknown): string {
  const id = memoryResultId(value);
  if (!id) throw new Error("Memory Core did not return a stable result id for history distillation");
  return id;
}
