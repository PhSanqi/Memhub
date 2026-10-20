import { createHash, randomUUID } from "node:crypto";
import commitFs, { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withFileMutationLock } from "./file-mutation-lock.js";
import { MemoryCoreHttpError, withCoreMemoryReconciliation } from "./local-memory-client.js";
import { DISTILLATION_CONTRACT_VERSION, validateDistillationCandidate } from "./distillation-contract.js";
import {
  assertActiveDistillationLease,
  completeDistillationJobAfterCoreCommit,
  enqueueDerivedDistillationJob,
  failDistillationJobForLeaseGeneration,
  latestCompletedL3ByProject,
  listDistillationJobs,
  prepareDistillationLeaseForExternalWrite,
  quarantineDistillationJobAfterCoreCommit,
  recordCompletedDistillationRevision,
  type DistillationEvidenceItem,
  type DistillationJob
} from "./distillation-jobs.js";
import type { MemhubRuntime } from "./runtime.js";
import { assertSkillVersion } from "./skill-version.js";

export async function submitDistillationControl(input: {
  args: Record<string, unknown>;
  stateRoot: string;
  runtime: MemhubRuntime;
  sourceHarness: string;
  leaseToken?: string;
  enqueueDerived?: typeof enqueueDerivedDistillationJob;
  resolveToolScope: (runtime: MemhubRuntime, input: { scope: string; project?: string; workspaceProject?: string; conversationId?: string }) => Promise<{ projectId: string | null; conversationId?: string; resolutionSource: string }>;
  validateDistillationEvidenceChain: (input: { stateRoot: string; runtime: MemhubRuntime; kind: "l2" | "l3" | "l4" | "skill"; projectId: string | null; evidenceRefs: string[]; job?: DistillationJob }) => Promise<DistillationEvidenceItem[]>;
}): Promise<Record<string, unknown>> {
  const { args, stateRoot, runtime, sourceHarness, leaseToken, resolveToolScope, validateDistillationEvidenceChain } = input;
    const jobId = optionalString(args.job_id);
    let jobs = jobId ? await listDistillationJobs(stateRoot, runtime.accountId) : [];
    let job = jobId
      ? jobs.find((item) => item.job_id === jobId)
      : undefined;
    if (jobId && !job) throw new Error("distillation job not found for account");
    const kind = (optionalString(args.kind) ?? job?.target) as "l2" | "l3" | "l4" | "skill" | undefined;
    if (!kind || !["l2", "l3", "l4", "skill"].includes(kind)) {
      throw new TypeError("kind must be l2, l3, l4, or skill");
    }
    if (job && job.target !== kind) throw new Error(`distillation target mismatch: job expects ${job.target}`);
    const scope = optionalString(args.scope) ?? job?.scope;
    if (!scope) throw new TypeError("scope is required");
    if (scope !== "account" && scope !== "project") throw new TypeError("scope must be account or project");
    if ((kind === "l2" || kind === "l3") && scope !== "project") {
      throw new TypeError(`${kind.toUpperCase()} requires project scope`);
    }
    if (kind === "l4" && scope !== "account") throw new TypeError("L4 requires account scope");
    const title = optionalString(args.title);
    const artifactId = optionalString(args.artifact_id);
    const version = optionalString(args.version);
    if (kind === "skill") {
      if (!title) throw new TypeError("title is required for skill distillation");
      if (!artifactId) throw new TypeError("artifact_id is required for Skill distillation and must remain stable across revisions");
      if (!version) throw new TypeError("version is required for Skill distillation");
      assertSkillVersion(version);
    }
    const { projectId, conversationId } = await resolveToolScope(runtime, {
      scope: scope === "account" ? "global" : "project",
      project: optionalString(args.project) ?? job?.project_id ?? undefined,
      workspaceProject: optionalString(args.workspace_project),
      conversationId: optionalString(args.conversation_id) ?? job?.conversation_id
    });
    if (kind === "l4" && projectId !== null) throw new Error("L4 cannot be project-scoped");
    const canonicalJobProjectId = job?.project_id
      ? await runtime.projects.resolve(runtime.accountId, job.project_id)
      : job?.project_id ?? null;
    if (job && (job.scope !== scope || canonicalJobProjectId !== projectId)) {
      throw new Error("distillation job scope mismatch");
    }
    const explicitEvidenceRefs = stringArray(args.evidence_refs) ?? [];
    if (job && explicitEvidenceRefs.some((ref) => !job!.evidence_refs.includes(ref))) {
      throw new Error("job-backed distillation cannot add evidence outside the leased job");
    }
    const evidenceRefs = uniqueStrings(job ? job.evidence_refs : explicitEvidenceRefs);
    const sourceConversations = uniqueStrings([
      ...(job?.conversation_id ? [job.conversation_id] : []),
      ...(stringArray(args.source_conversations) ?? [])
    ]);
    const confidence = optionalNumber(args.confidence);
    const content = requiredString(args.content, "content");
    const projectDescription = optionalString(args.project_description);
    if (projectDescription && kind !== "l2") throw new TypeError("project_description is only valid for L2 distillation");
    if (projectDescription && projectDescription.length > 1200) throw new TypeError("project_description must be at most 1200 characters");
    const canonicalArtifactId = artifactId ??
      (kind === "l2"
        ? `project-timeline:${projectId}`
        : kind === "l3"
          ? `project-profile:${projectId}`
          : kind === "l4"
            ? `user-profile:${runtime.accountId}`
            : undefined);
    const canonicalTitle = title ??
      (kind === "l2"
        ? `Project Timeline · ${projectId}`
        : kind === "l3"
          ? `Project Rules & Experience · ${projectId}`
          : kind === "l4"
            ? "Cross-project User Profile"
            : undefined);
    const commitPath = join(resolve(stateRoot), "distillation", "commits", hashJson([runtime.accountId, kind, projectId, canonicalArtifactId]) + ".json");
    const response = await withArtifactCommitLock(commitPath, async () => {
    const candidateHash = hashJson({ jobId, kind, projectId, conversationId, content, title: canonicalTitle,
      artifactId: canonicalArtifactId, version, evidenceRefs, sourceConversations, confidence,
      tags: stringArray(args.tags), projectDescription, sourceHarness });
    let commit: ArtifactCommit | undefined;
    try { commit = JSON.parse(await readFile(commitPath, "utf8")) as ArtifactCommit; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    jobs = await listDistillationJobs(stateRoot, runtime.accountId);
    job = jobId ? jobs.find((item) => item.job_id === jobId) : undefined;
    if (jobId && !job) throw new Error("distillation job not found for account");
    const replay = commit?.candidateHash === candidateHash && !commit.rejected;
    if (replay && commit?.response && args.dry_run !== true) {
      const resultId = memoryResultId(commit.coreResult);
      const retired = (await listDistillationJobs(stateRoot, runtime.accountId, true))
        .some(item => item.result_id === resultId && item.result_retirement);
      if (retired) throw new Error("recorded artifact result is retired; replay cannot restore it; submit a new approved candidate");
      if (runtime.memoryClient && resultId) {
        const payload = await runtime.memoryClient.viewerGet(`/api/v1/memory/${encodeURIComponent(resultId)}`) as Record<string, unknown>;
        const memory = (payload.item ?? payload) as Record<string, unknown>;
        if (memory.id !== resultId || memory.status === "deleted" || memory.status === "archived") {
          throw new Error("recorded artifact result is no longer live; replay cannot restore it");
        }
      }
      return commit.response;
    }
    if (commit && !commit.response && !commit.rejected && !replay) {
      throw new Error("artifact has an unresolved commit; retry the exact frozen candidate before replacing it");
    }
    if (job && !(replay && commit?.coreResult && job.status === "completed")) {
      assertActiveDistillationLease(job, sourceHarness, leaseToken);
    }
    validateDistillationCandidate({
      kind,
      content,
      evidence: { evidenceRefs, sourceConversations, confidence }
    });
    const resolvedEvidence = replay && commit?.evidence ? commit.evidence : await validateDistillationEvidenceChain({
      stateRoot,
      runtime,
      kind,
      projectId,
      evidenceRefs: evidenceRefs ?? [],
      job
    });
    if (kind === "l2" && projectId && job) {
      assertRoutineL2PreservesCanonicalTimeline({
        jobs,
        projectId,
        jobProjectId: job.project_id,
        content
      });
    }
    if (args.dry_run === true) {
      return {
        ok: true,
        dryRun: true,
        kind,
        scope,
        project: projectId,
        sourceHarness,
        contract: DISTILLATION_CONTRACT_VERSION,
        evidenceRefs,
        sourceConversations,
        confidence
      };
    }
    // Evidence validation can take time; fence enough remaining lease budget
    // immediately before the external write. Local preparation failures are
    // not Memory Core failures and must not be recorded as such.
    if (jobId && job?.status !== "completed") {
      await prepareDistillationLeaseForExternalWrite(
        stateRoot,
        runtime.accountId,
        jobId,
        sourceHarness,
        leaseToken
      );
    }
    const operation: ArtifactCommit = replay && commit ? commit : { candidateHash, generation: randomUUID() };
    const saveCommit = () => writeDistillationCommitFile(commitPath, operation);
    operation.evidence ??= resolvedEvidence;
    operation.args ??= { ...args, source_harness: sourceHarness, dry_run: false };
    operation.createdAt ??= new Date().toISOString();
    if (!operation.payload) operation.payload = {
        accountId: runtime.accountId,
        userId: runtime.userId,
        kind,
        content,
        projectId,
        conversationId,
        title: canonicalTitle,
        tags: uniqueStrings(["memory-v2", `layer:${kind}`, `commit-operation:${operation.generation}`, ...(stringArray(args.tags) ?? [])]),
        sourceHarness,
        artifactId: canonicalArtifactId,
        version,
        evidenceRefs,
        sourceConversations,
        confidence,
        contractVersion: DISTILLATION_CONTRACT_VERSION,
        provenance: {
          platform: runtime.source.platform,
          transport: runtime.source.transport,
          principal: runtime.source.principalId,
          connection: runtime.source.connectionId,
          account: runtime.accountId,
          authenticated_account: runtime.source.authenticatedAccount
        }
      };
    await saveCommit();
    let result = operation.coreResult;
    let coreCommittedAt = operation.committedAt;
    try {
      if (!result) {
        if (replay) {
          result = await withCoreMemoryReconciliation(() => runtime.memory.distill(operation.payload!));
        } else {
          operation.sentAt = new Date().toISOString();
          await saveCommit();
          result = await runtime.memory.distill(operation.payload!);
        }
        coreCommittedAt = new Date().toISOString();
        operation.coreResult = result;
        operation.committedAt = coreCommittedAt;
        await saveCommit();
      }
    } catch (error) {
      const ambiguous = !(error instanceof MemoryCoreHttpError && [400, 401, 403, 409, 422].includes(error.status));
      if (!ambiguous) { operation.rejected = true; operation.terminalAt = new Date().toISOString(); await saveCommit(); }
      if (jobId && !ambiguous) {
        await failDistillationJobForLeaseGeneration(
          stateRoot,
          runtime.accountId,
          jobId,
          error instanceof Error ? error.message : String(error),
          sourceHarness,
          leaseToken
        ).catch(() => undefined);
      }
      throw error;
    }
    let resultId: string;
    try {
      resultId = requireMemoryResultId(result);
    } catch (error) {
      if (jobId) {
        await quarantineDistillationJobAfterCoreCommit(
          stateRoot,
          runtime.accountId,
          jobId,
          "Memory Core returned success without a stable result id; ambiguous commit requires manual reconciliation before retry",
          sourceHarness,
          leaseToken,
          coreCommittedAt
        ).catch((quarantineError) => {
          throw new Error(
            `Memory Core returned an ambiguous success and the lease generation could not be quarantined: ${String(quarantineError)}`
          );
        });
      }
      throw error;
    }
    const committedContent = result && typeof result === "object" && typeof (result as { body?: unknown }).body === "string"
      ? (result as { body: string }).body : content;
    let projectDescriptionError: string | undefined;
    let queuedNext: unknown;
    let nextLayerEnqueueError: string | undefined;
    let completedRevision: DistillationJob | undefined;
    if (jobId) {
      completedRevision = job?.status === "completed" ? job : await completeDistillationJobAfterCoreCommit(stateRoot, runtime.accountId, jobId, {
        kind,
        resultId,
        content: committedContent,
        committedAt: coreCommittedAt!,
        coreBody: result && typeof result === "object" && typeof (result as { body?: unknown }).body === "string" ? committedContent : undefined
      }, sourceHarness, leaseToken);
      try {
      if (kind === "l2" && projectId) {
        queuedNext = await (input.enqueueDerived ?? enqueueDerivedDistillationJob)({
          stateRoot,
          accountId: runtime.accountId,
          target: "l3",
          projectId,
          evidence: [{
            ref: `l2:${resultId}:${completedRevision.job_id}`,
            kind: "artifact",
            layer: "L2",
            timestamp: completedRevision.result_committed_at ?? completedRevision.completed_at ?? new Date().toISOString(),
            project_id: projectId,
            title: canonicalLayerTitle("l2", projectId),
            content: committedContent
          }]
        });
      } else if (kind === "l3") {
        const latestByProject = latestCompletedL3ByProject(
          await listDistillationJobs(stateRoot, runtime.accountId)
        );
        if (latestByProject.length >= 2) {
          queuedNext = await (input.enqueueDerived ?? enqueueDerivedDistillationJob)({
            stateRoot,
            accountId: runtime.accountId,
            target: "l4",
            projectId: null,
            evidence: latestByProject.map((item) => ({
              ref: `l3:${item.result_id}:${item.job_id}`,
              kind: "artifact",
              layer: "L3",
              timestamp: item.result_committed_at ?? item.completed_at ?? item.updated_at,
              project_id: item.project_id!,
              title: canonicalLayerTitle("l3", item.project_id!),
              content: item.result_content!
            }))
          });
        }
      }
      } catch (error) {
        // Upstream L2/L3 and the completed job are durable. Queue failure
        // is a separate recoverable condition, not permission to replay Core.
        nextLayerEnqueueError = error instanceof Error ? error.message : String(error);
        console.error("[memhub] next-layer distillation enqueue failed:", nextLayerEnqueueError);
      }
    } else if (kind !== "skill") {
      try {
        completedRevision = await recordCompletedDistillationRevision({
          stateRoot,
          accountId: runtime.accountId,
          target: kind,
          projectId,
          ...(conversationId ? { conversationId } : {}),
          evidence: resolvedEvidence,
          resultId,
          content: committedContent,
          committedAt: coreCommittedAt!,
          operationId: operation.generation,
          coreBody: result && typeof result === "object" && typeof (result as { body?: unknown }).body === "string" ? committedContent : undefined
        });
      } catch (error) {
        throw new Error(
          `Memory Core committed ${kind.toUpperCase()} but its immutable revision ledger could not be recorded; retry the same idempotent submit for reconciliation: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (!jobId && kind === "l2" && projectId && completedRevision) {
      try {
        queuedNext = await (input.enqueueDerived ?? enqueueDerivedDistillationJob)({
          stateRoot,
          accountId: runtime.accountId,
          target: "l3",
          projectId,
          evidence: [{
            ref: `l2:${resultId}:${completedRevision.job_id}`,
            kind: "artifact",
            layer: "L2",
            timestamp: completedRevision.result_committed_at ?? completedRevision.completed_at ?? new Date().toISOString(),
            project_id: projectId,
            title: canonicalLayerTitle("l2", projectId),
            content: committedContent
          }]
        });
      } catch (error) {
        // The canonical L2 revision is already durable. A downstream queue
        // failure must remain recoverable through reconcile_derived and must
        // never cause the L2 Core write to be replayed.
        nextLayerEnqueueError = error instanceof Error ? error.message : String(error);
        console.error("[memhub] next-layer distillation enqueue failed:", nextLayerEnqueueError);
      }
    }
    const resultEvidenceRef = completedRevision && kind !== "skill"
      ? `${kind}:${resultId}:${completedRevision.job_id}`
      : undefined;
    if (kind === "l2" && projectId && projectDescription) {
      // Complete the source job before optional routing metadata: a slow or
      // failed secondary update must not hold a live distillation lease open
      // after the Core artifact has already been committed.
      try {
        await runtime.projects.updateDistilledDescription(
          runtime.accountId,
          projectId,
          projectDescription,
          evidenceRefs ?? []
        );
      } catch (error) {
        projectDescriptionError = error instanceof Error ? error.message : String(error);
        console.error("[memhub] distilled project description update failed:", projectDescriptionError);
      }
    }
    const response = {
      ok: true,
      kind,
      scope,
      project: projectId,
      sourceHarness,
      nativeEvolution: false,
      contract: DISTILLATION_CONTRACT_VERSION,
      job_id: jobId,
      memory: result,
      ...(resultEvidenceRef ? { result_evidence_ref: resultEvidenceRef } : {}),
      ...(projectDescriptionError ? { project_description_error: projectDescriptionError } : {}),
      ...(nextLayerEnqueueError ? { next_layer_enqueue_error: nextLayerEnqueueError } : {}),
      ...(queuedNext ? { next_layer_job: queuedNext } : {})
    };
    operation.terminalAt = new Date().toISOString();
    operation.response = JSON.parse(JSON.stringify(response)) as Record<string, unknown>;
    await saveCommit();
    return operation.response;
    });
    if (args.dry_run !== true) await pruneDistillationCommitRecords(stateRoot, runtime.accountId);
    return response;
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

function canonicalLayerTitle(kind: "l2" | "l3", projectId: string): string {
  return kind === "l2"
    ? `Project Timeline · ${projectId}`
    : `Project Rules & Experience · ${projectId}`;
}

function assertRoutineL2PreservesCanonicalTimeline(input: {
  jobs: DistillationJob[];
  projectId: string;
  jobProjectId: string | null;
  content: string;
}): void {
  const projectIds = new Set([input.projectId, input.jobProjectId].filter((value): value is string => Boolean(value)));
  const base = input.jobs
    .filter((item) =>
      item.status === "completed" &&
      item.target === "l2" &&
      item.result_kind === "l2" &&
      Boolean(item.result_id) &&
      Boolean(item.result_content?.trim()) &&
      Boolean(item.project_id && projectIds.has(item.project_id))
    )
    .sort((left, right) => completedRevisionAt(left).localeCompare(completedRevisionAt(right)) || left.job_id.localeCompare(right.job_id))
    .at(-1);
  if (!base?.result_content?.trim() || !base.result_id) return;

  const baseHeadings = timelineHeadingKeys(base.result_content);
  if (baseHeadings.length === 0) return;
  const candidateHeadings = new Set(timelineHeadingKeys(input.content));
  const missing = baseHeadings.filter((heading) => !candidateHeadings.has(heading));
  if (missing.length === 0) return;

  const baseRef = `l2:${base.result_id}:${base.job_id}`;
  const examples = missing.slice(0, 3).join(" | ");
  throw new Error(
    `L2 candidate would drop canonical timeline history: ${missing.length}/${baseHeadings.length} prior event headings are missing. ` +
    `Load current canonical L2 ${baseRef} and submit a full timeline replacement, not a delta.` +
    (examples ? ` Missing examples: ${examples}` : "")
  );
}

function timelineHeadingKeys(content: string): string[] {
  const values = [...content.matchAll(/^##\s+(.+?)\s*$/gm)]
    .map((match) => normalizeTimelineHeading(match[1] ?? ""))
    .filter(Boolean);
  return [...new Set(values)];
}

function normalizeTimelineHeading(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function completedRevisionAt(job: DistillationJob): string {
  return job.result_committed_at ?? job.completed_at ?? job.updated_at;
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

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("value must be a finite number");
  return value;
}

export interface ArtifactCommit {
  createdAt?: string;
  sentAt?: string;
  terminalAt?: string;
  args?: Record<string, unknown>;
  evidence?: DistillationEvidenceItem[];
  operatorResolution?: { reason: string; at: string };
  candidateHash: string;
  generation: string;
  payload?: Parameters<MemhubRuntime["memory"]["distill"]>[0];
  coreResult?: unknown;
  committedAt?: string;
  rejected?: boolean;
  response?: Record<string, unknown>;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// Independent 60-second acquisition budget; the shared jobs lock remains short.
async function withArtifactCommitLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let acquired = false;
    try { return await withFileMutationLock(path, () => { acquired = true; return run(); }); }
    catch (error) {
      if (acquired || attempt === 3 || !(error instanceof Error) ||
          error.message !== `timed out waiting for state lock: ${resolve(path)}`) throw error;
    }
  }
}

export async function writeDistillationCommitFile(path: string, record: ArtifactCommit): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    const handle = await commitFs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(record) + "\n", "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    for (let attempt = 0; ; attempt++) {
      try { await commitFs.rename(temporary, path); break; }
      catch (error) {
        if (process.platform !== "win32" || attempt === 5 ||
            !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await new Promise(done => setTimeout(done, 20 * 2 ** attempt));
      }
    }
    if (process.platform !== "win32") {
      const directory = await commitFs.open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
}

/** Only answered/rejected operations are collectible; unknown/corrupt records stay protected. */
export async function pruneDistillationCommitRecords(stateRoot: string, accountId: string): Promise<void> {
  const directory = join(resolve(stateRoot), "distillation", "commits");
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const terminal: { path: string; generation: string; at: number }[] = [];
  for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    const path = join(directory, name);
    try {
      const record = JSON.parse(await readFile(path, "utf8")) as ArtifactCommit;
      if (!record || typeof record.generation !== "string") continue;
      if (record.payload?.accountId === accountId && (record.response || record.rejected)) {
        const at = record.terminalAt ? Date.parse(record.terminalAt) : (await stat(path)).mtimeMs;
        if (Number.isFinite(at)) terminal.push({ path, generation: record.generation, at });
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  terminal.sort((a, b) => b.at - a.at);
  for (const [index, entry] of terminal.entries()) {
    if (index < 256 && Date.now() - entry.at < 7 * 24 * 60 * 60 * 1000) continue;
    await withArtifactCommitLock(entry.path, async () => {
      try {
        const record = JSON.parse(await readFile(entry.path, "utf8")) as ArtifactCommit;
        if (record.generation === entry.generation && (record.response || record.rejected)) await unlink(entry.path);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    });
  }
}

export async function reconcileDistillationCommit(input: {
  stateRoot: string; runtime: MemhubRuntime; commitId?: string;
  mode: "inspect" | "reconcile" | "abandon"; generation?: string; confirmation?: string; reason?: string;
}): Promise<Record<string, unknown>> {
  const directory = join(resolve(input.stateRoot), "distillation", "commits");
  if (!input.commitId) {
    if (input.mode !== "inspect") throw new Error("commit_id is required");
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { commits: [] }; throw error; }
    const commits = [];
    for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const record = JSON.parse(await readFile(join(directory, name), "utf8")) as ArtifactCommit;
      if (record.payload?.accountId === input.runtime.accountId) commits.push({ commit_id: name.slice(0, -5), ...record });
    }
    return { commits };
  }
  if (!/^[a-f0-9]{64}$/.test(input.commitId)) throw new Error("invalid commit_id");
  const path = join(directory, input.commitId + ".json");
  const response = await withArtifactCommitLock(path, async () => {
    const record = JSON.parse(await readFile(path, "utf8")) as ArtifactCommit;
    if (record.payload?.accountId !== input.runtime.accountId) throw new Error("commit belongs to another account");
    if (input.mode === "inspect") return { commit_id: input.commitId, ...record };
    if (record.generation !== input.generation) throw new Error("commit generation changed; inspect again");
    if (record.response || record.rejected) throw new Error("commit is already terminal");
    if (input.mode === "reconcile") {
      const result = record.coreResult ?? await withCoreMemoryReconciliation(() => input.runtime.memory.distill(record.payload!));
      requireMemoryResultId(result);
      record.coreResult = result;
      record.committedAt ??= new Date().toISOString();
      await writeDistillationCommitFile(path, record);
      return { outcome: "committed", memory: result, frozen_args: record.args,
        next: "Resubmit frozen_args using the current lease token to finish the local ledger; Core will not be written again." };
    }
    if (!input.reason?.trim() || input.confirmation !== `abandon:${record.generation}`) {
      throw new Error("abandon requires a reason and explicit operator confirmation abandon:<generation>; Core may already contain this operation");
    }
    record.rejected = true;
    record.terminalAt = new Date().toISOString();
    record.operatorResolution = { reason: input.reason.trim(), at: record.terminalAt };
    await writeDistillationCommitFile(path, record);
    return { outcome: "abandoned", generation: record.generation, core_mutated: false };
  });
  if (input.mode === "abandon") await pruneDistillationCommitRecords(input.stateRoot, input.runtime.accountId);
  return response;
}
