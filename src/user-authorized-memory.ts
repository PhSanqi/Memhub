import { createHash, randomUUID } from "node:crypto";
import { validateDurableMemoryContent } from "./distillation-contract.js";
import {
  recordCompletedDistillationRevision,
  type DistillationEvidenceItem
} from "./distillation-jobs.js";
import { hydrateMemoryEvidence } from "./memory-hydration.js";
import type { MemhubRuntime } from "./runtime.js";

export const USER_AUTHORIZED_MEMORY_CONTRACT_VERSION = "memhub-user-authorized-memory-v1";

interface UserAuthorizedMemoryPlan {
  accountId: string;
  kind: "l3" | "l4";
  projectId: string | null;
  content: string;
  note?: string;
  expectedRevisionRef: string | null;
  expectedMemoryId: string | null;
  expectedCoreContentHash: string | null;
  createdAtMs: number;
  expiresAt: number;
}

const authorizations = new Map<string, UserAuthorizedMemoryPlan>();

export async function planUserAuthorizedMemory(input: {
  stateRoot: string;
  runtime: MemhubRuntime;
  kind: "l3" | "l4";
  projectId: string | null;
  content: string;
  baseEvidenceRef?: string;
  note?: string;
}): Promise<Record<string, unknown>> {
  assertScope(input.kind, input.projectId);
  const content = normalizeContent(input.content);
  const activeCoreItems = await activeLayerItems(input.runtime, input.kind, input.projectId);
  const baseRef = input.baseEvidenceRef?.trim();
  let expectedRevisionRef: string | null = null;
  let expectedMemoryId: string | null = null;
  let expectedCoreContentHash: string | null = null;
  let currentContent: string | null = null;
  if (baseRef) {
    const base = await hydrateMemoryEvidence({
      stateRoot: input.stateRoot,
      accountId: input.runtime.accountId,
      evidenceRef: baseRef
    });
    if (base.layer !== input.kind.toUpperCase()) {
      throw new Error(`base_evidence_ref must point to current ${input.kind.toUpperCase()}`);
    }
    if (input.kind === "l3" && base.project_id !== input.projectId) {
      throw new Error("L3 base_evidence_ref must belong to the same canonical project");
    }
    if (input.kind === "l4" && base.project_id !== null) {
      throw new Error("L4 base_evidence_ref must be account-scoped");
    }
    const core = activeCoreItems.find((item) => item.id === base.memory_id);
    if (!core) throw new Error("base_evidence_ref is not the current active Core memory; refresh memmy_context before planning");
    const coreContent = coreMemoryContent(core);
    if (!coreContent || sha256(normalizeContent(coreContent)) !== sha256(normalizeContent(base.content))) {
      throw new Error("base_evidence_ref no longer matches the current Core memory body; refresh memmy_context before planning");
    }
    expectedRevisionRef = base.evidence_ref;
    expectedMemoryId = base.memory_id;
    expectedCoreContentHash = sha256(normalizeContent(coreContent));
    currentContent = normalizeContent(base.content);
  } else if (activeCoreItems.length > 0) {
    throw new Error(`current ${input.kind.toUpperCase()} exists; base_evidence_ref from memmy_context is required for a governed replacement`);
  }
  if (currentContent === content) {
    throw new TypeError("proposed L3/L4 content is identical to the current canonical revision");
  }

  const authorizationId = randomUUID();
  const createdAtMs = Date.now();
  const expiresAt = createdAtMs + 24 * 60 * 60_000;
  authorizations.set(authorizationId, {
    accountId: input.runtime.accountId,
    kind: input.kind,
    projectId: input.projectId,
    content,
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    expectedRevisionRef,
    expectedMemoryId,
    expectedCoreContentHash,
    createdAtMs,
    expiresAt
  });

  return {
    status: "awaiting_user_authorization",
    operation: "replace_canonical_memory",
    kind: input.kind,
    scope: input.kind === "l3" ? "project" : "account",
    project: input.projectId,
    current_evidence_ref: expectedRevisionRef,
    proposed_content: content,
    proposed_sha256: sha256(content),
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    authorization_id: authorizationId,
    expires_at: new Date(expiresAt).toISOString(),
    contract: USER_AUTHORIZED_MEMORY_CONTRACT_VERSION,
    instructions: [
      "Show proposed_content to the user in full, without shortening, paraphrasing, or hiding unchanged sections.",
      "Ask the user to explicitly confirm writing this exact full replacement.",
      "After confirmation, open/capture that confirmation turn as L1 and call memhub_memory action=execute with this authorization_id and confirmation_evidence_ref=l1:<event-id>.",
      "Do not execute from implied consent, an earlier approval, or a different proposed_content."
    ]
  };
}

export async function executeUserAuthorizedMemory(input: {
  stateRoot: string;
  runtime: MemhubRuntime;
  authorizationId: string;
  confirmationEvidenceRef: string;
}): Promise<Record<string, unknown>> {
  const authorizationId = requireNonEmpty(input.authorizationId, "authorizationId");
  const plan = authorizations.get(authorizationId);
  if (!plan || plan.accountId !== input.runtime.accountId) {
    throw new Error("invalid or already-used L3/L4 authorization");
  }
  authorizations.delete(authorizationId);
  if (plan.expiresAt < Date.now()) throw new Error("L3/L4 authorization expired; create and show a fresh plan");

  const activeCoreItems = await activeLayerItems(input.runtime, plan.kind, plan.projectId);
  if (plan.expectedMemoryId) {
    const core = activeCoreItems.find((item) => item.id === plan.expectedMemoryId);
    const coreContent = core ? coreMemoryContent(core) : undefined;
    if (!coreContent || sha256(normalizeContent(coreContent)) !== plan.expectedCoreContentHash) {
      throw new Error("canonical L3/L4 changed after plan; show the new full replacement and obtain fresh user confirmation");
    }
  } else if (activeCoreItems.length > 0) {
    throw new Error("canonical L3/L4 was created after plan; show the current full content and obtain fresh user confirmation");
  }

  const confirmationRef = requireNonEmpty(input.confirmationEvidenceRef, "confirmationEvidenceRef");
  if (!/^l1:[^:]+$/.test(confirmationRef)) {
    throw new TypeError("confirmation_evidence_ref must be an exact l1:<event-id> from the user's confirmation turn");
  }
  const confirmation = await hydrateMemoryEvidence({
    stateRoot: input.stateRoot,
    accountId: input.runtime.accountId,
    evidenceRef: confirmationRef
  });
  if (confirmation.layer !== "L1") throw new Error("user confirmation evidence must be L1");
  const confirmationTimestampMs = Date.parse(confirmation.committed_at);
  if (!Number.isFinite(confirmationTimestampMs) || confirmationTimestampMs < plan.createdAtMs) {
    throw new Error("confirmation_evidence_ref must come from a user turn captured after this plan was created");
  }
  if (plan.kind === "l3" && confirmation.project_id !== plan.projectId) {
    throw new Error("L3 confirmation L1 must be captured under the same canonical project");
  }

  const evidence: DistillationEvidenceItem = {
    ref: confirmation.evidence_ref,
    kind: "turn",
    layer: "L1",
    timestamp: confirmation.committed_at,
    ...(confirmation.project_id ? { project_id: confirmation.project_id } : {}),
    ...(confirmation.source_conversation_id ? { conversation_id: confirmation.source_conversation_id } : {}),
    content: confirmation.content
  };
  const artifactId = plan.kind === "l3"
    ? `project-profile:${plan.projectId}`
    : `user-profile:${input.runtime.accountId}`;
  const title = plan.kind === "l3"
    ? `Project Rules & Experience · ${plan.projectId}`
    : "Cross-project User Profile";
  const committedAt = new Date().toISOString();
  const result = await input.runtime.memory.distill({
    accountId: input.runtime.accountId,
    userId: input.runtime.userId,
    kind: plan.kind,
    content: plan.content,
    projectId: plan.projectId,
    ...(confirmation.source_conversation_id ? { conversationId: confirmation.source_conversation_id } : {}),
    title,
    tags: ["manual", "user-authorized-direct", `authority:explicit-user-confirmation`],
    sourceHarness: "user-authorized-direct",
    artifactId,
    evidenceRefs: [confirmationRef],
    sourceConversations: confirmation.source_conversation_id ? [confirmation.source_conversation_id] : [],
    confidence: 1,
    contractVersion: USER_AUTHORIZED_MEMORY_CONTRACT_VERSION,
    provenance: {
      platform: input.runtime.source.platform,
      transport: input.runtime.source.transport,
      principal: input.runtime.source.principalId,
      connection: input.runtime.source.connectionId,
      account: input.runtime.accountId,
      authenticated_account: input.runtime.source.authenticatedAccount,
      authority: "explicit-user-confirmation",
      confirmation_evidence_ref: confirmationRef
    }
  });
  const resultId = requireMemoryResultId(result);
  const revision = await recordCompletedDistillationRevision({
    stateRoot: input.stateRoot,
    accountId: input.runtime.accountId,
    target: plan.kind,
    projectId: plan.projectId,
    ...(confirmation.source_conversation_id ? { conversationId: confirmation.source_conversation_id } : {}),
    evidence: [evidence],
    resultId,
    content: plan.content,
    committedAt
  });
  const resultEvidenceRef = `${plan.kind}:${resultId}:${revision.job_id}`;

  return {
    ok: true,
    operation: "replace_canonical_memory",
    kind: plan.kind,
    scope: plan.kind === "l3" ? "project" : "account",
    project: plan.projectId,
    previous_evidence_ref: plan.expectedRevisionRef,
    confirmation_evidence_ref: confirmationRef,
    result_evidence_ref: resultEvidenceRef,
    memory: result,
    contract: USER_AUTHORIZED_MEMORY_CONTRACT_VERSION,
    derived_jobs_enqueued: 0,
    note: "Explicit user-authorized L3/L4 replacements do not auto-promote to another layer."
  };
}

async function activeLayerItems(
  runtime: MemhubRuntime,
  kind: "l3" | "l4",
  projectId: string | null
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({ limit: "100", page: "1", userId: runtime.userId, includeBody: "1" });
  if (kind === "l3" && projectId) params.set("projectId", projectId);
  const payload = objectRecord(await runtime.memoryClient.viewerGet(`/api/v1/${kind}?${params.toString()}`));
  const items = Array.isArray(payload.items) ? payload.items.map(objectRecord) : [];
  return items.filter((item) => item.status === undefined || item.status === "activated");
}

function coreMemoryContent(item: Record<string, unknown>): string | undefined {
  for (const key of ["body", "content", "memory_value", "memoryValue", "summary"] as const) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function normalizeContent(content: string): string {
  const normalized = validateDurableMemoryContent(content).replace(/\r\n/g, "\n").trim();
  return `${normalized}\n`;
}

function assertScope(kind: "l3" | "l4", projectId: string | null): void {
  if (kind === "l3" && !projectId) throw new Error("L3 user-authorized update requires a canonical project");
  if (kind === "l4" && projectId) throw new Error("L4 user-authorized update must be account-scoped");
}

function requireMemoryResultId(result: unknown): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Memory Core returned no stable result id");
  const id = (result as Record<string, unknown>).id;
  if (typeof id !== "string" || !id.trim()) throw new Error("Memory Core returned no stable result id");
  return id.trim();
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be non-empty`);
  return normalized;
}
