import { createHash, randomUUID } from "node:crypto";
import { commitArchitectureRevision, prepareArchitectureRevision } from "./architecture-history.js";
import type { MemhubRuntime } from "./runtime.js";

/**
 * Project Architecture governance: architecture_plan -> full-text user review
 * -> architecture_execute. The authorization map is process-affine and
 * one-shot; entries expire after one day.
 */
const architectureMutationAuthorizations = new Map<string, {
  accountId: string;
  projectId: string;
  expectedPath: string;
  expectedFingerprint: string;
  content: string;
  expiresAt: number;
}>();

export type ExplicitProjectResolver = (
  runtime: MemhubRuntime,
  input: { project?: string; workspaceProject?: string }
) => Promise<{ projectId: string | null; resolutionSource: string | null }>;

export async function planArchitectureMutation(input: {
  runtime: MemhubRuntime;
  args: Record<string, unknown>;
  resolveExplicitProjectEvidence: ExplicitProjectResolver;
}): Promise<Record<string, unknown>> {
  const { runtime, args, resolveExplicitProjectEvidence } = input;
  const explicitEvidence = await resolveExplicitProjectEvidence(runtime, {
    project: optionalString(args.project),
    workspaceProject: optionalString(args.workspace_project)
  });
  if (!explicitEvidence.projectId) throw new TypeError("architecture_plan requires project or workspace_project");
  const canonical = explicitEvidence.projectId;
  const current = await runtime.architecture.inspectProjectArchitecture({
    accountId: runtime.accountId,
    projectId: canonical
  });
  if (!current) {
    throw new Error(`no canonical local workspace found for Project Architecture: ${canonical}`);
  }
  const content = normalizeArchitecturePlanContent(requiredString(args.content, "content"));
  if (normalizeArchitecturePlanContent(current.content || "# empty") === content && current.exists) {
    throw new TypeError("Project Architecture plan has no effective content change");
  }
  const authorizationId = randomUUID();
  const expiresAt = Date.now() + 24 * 60 * 60_000;
  architectureMutationAuthorizations.set(authorizationId, {
    accountId: runtime.accountId,
    projectId: canonical,
    expectedPath: current.path,
    expectedFingerprint: current.fingerprint,
    content,
    expiresAt
  });
  return {
    status: "awaiting_user_authorization",
    operation: "replace_project_architecture",
    project: canonical,
    path: current.path,
    existing: current.exists,
    current_fingerprint: current.fingerprint,
    proposed_content: content,
    proposed_sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    impact: "Replace the canonical Project Architecture document only. This does not modify L1/L2/L3/L4, Todo, Project Registry metadata, or legacy normify-* files.",
    authorization_id: authorizationId,
    expires_at: new Date(expiresAt).toISOString(),
    instructions: "Show proposed_content to the user in full and call architecture_execute only after explicit approval of this exact replacement."
  };
}

export async function executeArchitectureMutation(input: {
  stateRoot: string;
  runtime: MemhubRuntime;
  args: Record<string, unknown>;
  resolveExplicitProjectEvidence: ExplicitProjectResolver;
}): Promise<Record<string, unknown>> {
  const { stateRoot, runtime, args, resolveExplicitProjectEvidence } = input;
  const authorizationId = requiredString(args.authorization_id, "authorization_id");
  const plan = architectureMutationAuthorizations.get(authorizationId);
  if (!plan || plan.accountId !== runtime.accountId) throw new Error("invalid or already-used Project Architecture authorization");
  architectureMutationAuthorizations.delete(authorizationId);
  if (plan.expiresAt < Date.now()) throw new Error("Project Architecture authorization expired; create a fresh plan");
  const explicitEvidence = await resolveExplicitProjectEvidence(runtime, {
    project: optionalString(args.project) ?? plan.projectId,
    workspaceProject: optionalString(args.workspace_project)
  });
  if (explicitEvidence.projectId !== plan.projectId) throw new Error("Project Architecture authorization scope changed; create a fresh plan");
  const current = await runtime.architecture.inspectProjectArchitecture({ accountId: runtime.accountId, projectId: plan.projectId });
  if (!current || current.path !== plan.expectedPath || current.fingerprint !== plan.expectedFingerprint) {
    throw new Error("Project Architecture changed after plan; create a fresh plan and ask for approval again");
  }
  const revision = await prepareArchitectureRevision({
    stateRoot,
    accountId: runtime.accountId,
    projectId: plan.projectId,
    path: current.path,
    beforeExists: current.exists,
    beforeFingerprint: current.fingerprint,
    beforeContent: current.content,
    proposedContent: plan.content
  });
  const written = await runtime.architecture.writeProjectArchitecture({
    accountId: runtime.accountId,
    projectId: plan.projectId,
    expectedPath: plan.expectedPath,
    expectedFingerprint: plan.expectedFingerprint,
    content: plan.content
  });
  let audit;
  try {
    audit = await commitArchitectureRevision({
      stateRoot,
      accountId: runtime.accountId,
      projectId: plan.projectId,
      revisionId: revision.revision_id,
      afterFingerprint: written.after.fingerprint
    });
  } catch (error) {
    throw new Error(`Project Architecture was written but audit commit failed; revision ${revision.revision_id} remains prepared for reconciliation: ${String(error)}`);
  }
  return {
    ok: true,
    operation: "replace_project_architecture",
    project: plan.projectId,
    path: written.after.path,
    fingerprint: written.after.fingerprint,
    revision_id: audit.revision_id,
    history_preserved: true,
    rollback_available: true
  };
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

function normalizeArchitecturePlanContent(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized) throw new TypeError("Project Architecture content must be non-empty");
  return `${normalized}\n`;
}
