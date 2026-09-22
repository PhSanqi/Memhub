#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
  toNodeHandler
} from "@modelcontextprotocol/node";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import type { JsonSchemaType } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  addAccount,
  bindCloudflareEmail,
  deleteAccount,
  ensureLocalAdminToken,
  listAccounts,
  resolveCloudflareAccount,
  setAccountRole,
  verifyLocalAdminToken
} from "./auth.js";
import { verifyCloudflareAccessJwt } from "./cloudflare.js";
import {
  authenticateDevice,
  listIdleCaptureGroups,
  createDevice,
  isCaptureIngested,
  listCaptureEvents,
  listDevices,
  markCaptureIngested,
  normalizeCaptureEvent,
  revokeDevice,
  storeCaptureEvent
} from "./capture.js";
import { captureSessionId, ingestCaptureIntoMemory } from "./capture-ingest.js";
import {
  assertActiveDistillationLease,
  completeDistillationJob,
  enqueueDerivedDistillationJob,
  enqueueDistillationJob,
  failDistillationJob,
  getDistillationConfig,
  leaseDistillationJob,
  listDistillationJobs,
  retryDistillationJob,
  setDistillationConfig,
  type DistillationJob
} from "./distillation-jobs.js";
import { createMemhubRuntime, type MemhubRuntime, type MemhubRuntimeOptions } from "./runtime.js";
import type { ProjectDescriptor } from "./project-registry.js";
import {
  DISTILLATION_CONTRACT_VERSION,
  distillationContract,
  validateDistillationCandidate
} from "./distillation-contract.js";
import {
  readMemoryControlData,
  type MemoryControlKind
} from "./memory-control-plane.js";
import { queueLegacyLayerRebuild } from "./legacy-rebuild.js";
import { recentL1Continuity, upsertL1Turn } from "./turn-log.js";
import { asHttpJsonBodyError, readJsonBody } from "./http-json.js";

const VERSION = "0.2.2";
const projectMutationAuthorizations = new Map<string, {
  accountId: string;
  operation: "create" | "update" | "delete" | "merge";
  payload: Record<string, unknown>;
  expiresAt: number;
}>();

export interface MemhubMcpOptions extends MemhubRuntimeOptions {}

export function createMemhubMcpServer(options: MemhubMcpOptions = {}): McpServer {
  const runtime = createMemhubRuntime(options);
  return createMemhubMcpServerForRuntime(runtime, defaultStateRoot());
}

export function createMemhubMcpServerForRuntime(runtime: MemhubRuntime, stateRoot = defaultStateRoot()): McpServer {
  const server = new McpServer({
    name: "memhub",
    version: VERSION,
    description: "Private account/project-scoped long-term memory and project routing. Whenever Memhub is explicitly mentioned or invoked, first call memmy_context with the current request and the current workspace_project/project evidence; include a stable conversation_id when the Harness exposes one. Project-scoped tools should carry workspace_project or project from the current turn. A conversation binding is only a fallback when current-turn workspace/project evidence is unavailable. If explicit project and workspace_project disagree after canonical resolution, Memhub rejects the operation instead of guessing. If the transport does not expose a stable conversation_id, do not invent one. If a project name is unknown, case-variant, or merely similar, call memmy_project_list and compare canonical slug, aliases, and description before creating/binding. Project mutations use memmy_project_manage plan -> explicit user authorization -> execute. Project todos are first-class state. Before the final answer, persist only genuinely durable new facts/decisions/preferences/corrections rather than raw chat noise."
  });

  server.registerTool("memmy_turn", {
    description: "L1 原始对话日志。Harness/Chat 在收到用户消息后先 action=open；需要时 action=checkpoint 写入简短、可公开审计的 reasoning/tool summary；最终回答前 action=commit 写入 assistant final。失败或截断用 failed/truncated。Harness 若没有稳定 conversation_id，不要伪造：Memhub 会为该单轮生成 event-scoped 内部 storage key，并禁止写 conversation binding；跨轮 resume 只有在提供稳定 continuity_id 或 conversation_id 时才可用。不要写隐藏 chain-of-thought。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        action: { type: "string", enum: ["open", "checkpoint", "commit", "failed", "truncated", "resume"] },
        event_id: { type: "string", description: "open 返回的稳定 L1 event id；后续 checkpoint/commit 推荐原样回传" },
        conversation_id: { type: "string", description: "当前 transport 会话/线程稳定 ID；transport 无法提供时省略，不要伪造" },
        continuity_id: { type: "string", description: "逻辑连续对话 ID；跨 Chat 续接时保持不变。省略则退化为 conversation_id。" },
        turn_id: { type: "string", description: "Harness 原生 turn id；有稳定 turn id 时可替代 event_id 做幂等定位" },
        previous_event_id: { type: "string", description: "显式前序 L1 event id" },
        project: { type: "string", description: "明确 canonical project；省略时使用 conversation binding" },
        workspace_project: { type: "string", description: "当前工作区解析出的 project；与 project 不一致时拒绝写入" },
        user_text: { type: "string" },
        assistant_text: { type: "string" },
        reasoning_summary: { type: "string", description: "可公开审计的简短推理/决策摘要，不得包含隐藏 chain-of-thought" },
        tool_summary: { type: "string", description: "关键工具动作与结果摘要" },
        limit: { type: "integer", minimum: 1, maximum: 50 }
      },
      required: ["action"],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    const action = requiredString(args.action, "action");
    const transportConversationId = optionalString(args.conversation_id);
    const requestedContinuityId = optionalString(args.continuity_id);
    if (action === "resume") {
      const continuityId = requestedContinuityId ?? transportConversationId;
      if (!continuityId) throw new TypeError("resume requires continuity_id or conversation_id");
      const turns = await recentL1Continuity({
        stateRoot,
        accountId: runtime.accountId,
        continuityId,
        limit: optionalInteger(args.limit) ?? 12
      });
      return jsonResult({
        continuity_id: continuityId,
        turns,
        incomplete: turns.filter((turn) => turn.status !== "complete")
      });
    }

    const projectEvidence = await resolveExplicitProjectEvidence(runtime, {
      project: optionalString(args.project),
      workspaceProject: optionalString(args.workspace_project)
    });
    const projectId = projectEvidence.projectId ?? undefined;

    const eventId = optionalString(args.event_id);
    const turnId = optionalString(args.turn_id);
    if (action !== "open" && !eventId && !turnId) {
      throw new TypeError(`${action} requires event_id or turn_id`);
    }
    const userText = optionalString(args.user_text);
    const assistantText = optionalString(args.assistant_text);
    const reasoningSummary = optionalString(args.reasoning_summary);
    const toolSummary = optionalString(args.tool_summary);
    if (action === "open" && !userText) throw new TypeError("open requires user_text");
    if (action === "checkpoint" && !reasoningSummary && !toolSummary) {
      throw new TypeError("checkpoint requires reasoning_summary or tool_summary");
    }
    if (action === "commit" && !assistantText) throw new TypeError("commit requires assistant_text");

    const stableEventId = eventId ?? (
      action === "open" && !turnId
        ? `l1_${randomUUID().replaceAll("-", "")}`
        : undefined
    );
    const syntheticConversationId = transportConversationId
      ? undefined
      : stableEventId
        ? `memhub-unbound:${stableEventId}`
        : turnId
          ? `memhub-unbound-turn:${turnId}`
          : undefined;
    const conversationId = transportConversationId ?? syntheticConversationId;
    if (!conversationId) throw new TypeError(`${action} requires conversation_id, event_id, or turn_id`);
    const continuityId = requestedContinuityId ?? conversationId;

    const status =
      action === "commit" ? "complete" :
      action === "failed" ? "failed" :
      action === "truncated" ? "truncated" :
      action === "checkpoint" ? "partial" :
      "open";
    const result = await upsertL1Turn({
      stateRoot,
      runtime,
      actorId: `mcp:${runtime.source.transport}`,
      actorName: runtime.source.platform,
      bindConversation: Boolean(transportConversationId),
      turn: {
        ...(stableEventId ? { event_id: stableEventId } : {}),
        host: runtime.source.platform,
        conversation_id: conversationId,
        continuity_id: continuityId,
        ...(turnId ? { turn_id: turnId } : {}),
        ...(optionalString(args.previous_event_id) ? { previous_event_id: optionalString(args.previous_event_id) } : {}),
        ...(projectId ? { project_hint: projectId } : {}),
        ...(userText ? { user_text: userText } : {}),
        ...(assistantText ? { assistant_text: assistantText } : {}),
        ...(reasoningSummary ? { reasoning_summary: reasoningSummary } : {}),
        ...(toolSummary ? { tool_summary: toolSummary } : {}),
        capture_status: status,
        provenance: {
          platform: runtime.source.platform,
          transport: runtime.source.transport,
          principal: runtime.source.principalId,
          connection: runtime.source.connectionId,
          transport_conversation_id_available: Boolean(transportConversationId),
          conversation_binding: Boolean(transportConversationId)
        }
      }
    });
    return jsonResult({
      ...result,
      binding_available: Boolean(transportConversationId),
      transport_conversation_id: transportConversationId ?? null
    });
  });

  server.registerTool("memmy_context", {
    description: "当 Memhub 被提及或调用时，先用本工具结合当前请求读取相关长期记忆。Harness 若能提供稳定 conversation_id 就传入，并可随后用 memmy_project action=current 核对持久 conversation binding；若 transport 没有稳定 conversation_id，不要伪造，直接使用本工具返回的 resolvedProjectId 与本轮显式 project/workspace 证据。若项目未唯一解析或名称相近，先调用 memmy_project_list 比较 canonical slug、aliases 与 description；不要尝试另一个大小写或盲目新建。当前轮的显式项目、workspace、项目名和 semantic_projects 优先于旧会话绑定；会话绑定只作为无本轮证据时的 fallback。业务记忆/架构只来自唯一 primary project；可复用 Skill 可从其他项目单独召回，不带入其业务 Current Truth。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        query: { type: "string", description: "当前用户请求或需要补充上下文的问题" },
        conversation_id: { type: "string", description: "当前 AI 会话/线程稳定 ID；用于保持项目绑定" },
        continuity_id: { type: "string", description: "逻辑连续对话 ID；跨 Chat 续接时保持不变。用于读取最近 L1 原始对话。" },
        project: { type: "string", description: "明确项目 slug；用户未明确时不要猜" },
        workspace_project: { type: "string", description: "由工作区/仓库确定的项目 slug" },
        semantic_projects: {
          type: "array",
          items: { type: "string" },
          description: "当前 Harness/分类器对本轮 primary project 的候选。唯一候选可覆盖旧 conversation binding；多个冲突候选触发 global-only。"
        },
        capability_projects: {
          type: "array",
          items: { type: "string" },
          description: "可从这些其他项目召回 artifact:skill / Skill-layer 能力；不召回其业务记忆。省略时默认从当前账号已知项目中检索可复用 Skills。"
        },
        cross_project_skills: {
          type: "boolean",
          description: "是否启用跨项目可复用 Skill 召回；默认 true。"
        },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "每类记忆最大召回数量" }
      },
      required: ["query"],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    const query = requiredString(args.query, "query");
    const projectRecords = await knownProjectRecords(runtime);
    const knownProjects = projectRecords.map((project) => project.projectId);
    const requestedCapabilityProjects = stringArray(args.capability_projects) ?? [];
    const crossProjectSkills = optionalBoolean(args.cross_project_skills) ?? true;
    const capsule = await runtime.router.context({
      accountId: runtime.accountId,
      userId: runtime.userId,
      query,
      conversationId: optionalString(args.conversation_id),
      projectId: optionalString(args.project),
      workspaceProjectId: optionalString(args.workspace_project),
      semanticProjectIds: stringArray(args.semantic_projects),
      knownProjectIds: knownProjects,
      reusableSkillProjectIds: crossProjectSkills
        ? (requestedCapabilityProjects.length > 0 ? requestedCapabilityProjects : knownProjects)
        : [],
      limit: optionalInteger(args.limit)
    });
    const continuityId = optionalString(args.continuity_id) ?? optionalString(args.conversation_id);
    const recentTurns = continuityId
      ? await recentL1Continuity({
          stateRoot,
          accountId: runtime.accountId,
          continuityId,
          limit: Math.min(12, optionalInteger(args.limit) ?? 12)
        })
      : [];
    const recentSession = recentTurns
      .filter((turn) => !capsule.resolvedProjectId || !turn.project_hint || turn.project_hint === capsule.resolvedProjectId)
      .map((turn) => ({
        id: turn.event_id,
        content: [
          `status: ${turn.status}`,
          `user: ${turn.user_text ?? ""}`,
          ...(turn.assistant_text ? [`assistant: ${turn.assistant_text}`] : []),
          ...(turn.reasoning_summary ? [`reasoning_summary: ${turn.reasoning_summary}`] : []),
          ...(turn.tool_summary ? [`tool_summary: ${turn.tool_summary}`] : [])
        ].join("\n"),
        authority: "observed" as const,
        scope: "conversation" as const,
        source: "l1-turn-log",
        ...(turn.project_hint ? { projectId: turn.project_hint } : {}),
        createdAt: turn.timestamp,
        provenance: {
          layer: "L1",
          continuity_id: turn.continuity_id,
          conversation_id: turn.conversation_id,
          status: turn.status,
          ingested: turn.ingested
        }
      }));
    const candidateQuery = optionalString(args.project) ?? optionalString(args.workspace_project) ?? query;
    const projectCandidates = capsule.resolvedProjectId === null || optionalString(args.project) || optionalString(args.workspace_project)
      ? await runtime.projects.suggest(runtime.accountId, candidateQuery, 8)
      : [];
    return jsonResult({
      ...capsule,
      recentSession,
      projectCandidates: projectCandidates.map((project) => ({
        project: project.projectId,
        name: project.name,
        description: project.description,
        aliases: project.aliases,
        similarity: project.similarity,
        matchedBy: project.matchedBy,
        descriptionMissing: !project.description
      }))
    });
  });

  server.registerTool("memhub_distill", {
    description: "统一的 L2/L3/L4/Skill 蒸馏入口。L2=项目发展时间线，并可同时产出 evidence-backed project_description；L3=项目内用户长期规则/经验/偏好，L4=跨项目用户画像，Skill=正交的可执行流程。语义整理由当前 Harness 模型完成；Memhub 负责证据边界、scope、版本、provenance 与提交。人工项目描述优先于蒸馏描述。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        action: { type: "string", enum: ["next", "submit", "skip"], description: "next 领取待整理 evidence；submit 提交目标层产物；skip 表示当前证据不足以升级。" },
        kind: { type: "string", enum: ["l2", "l3", "l4", "skill"], description: "目标层。next 可省略以领取任意待办；submit 必须与 job target 一致。" },
        content: { type: "string", description: "完整目标层内容" },
        scope: { type: "string", enum: ["account", "project"], description: "L2/L3 必须 project；L4 必须 account；Skill 可两者。" },
        project: { type: "string", description: "project scope 的明确项目 slug" },
        workspace_project: { type: "string", description: "当前工作区解析出的 project；与 project 不一致时拒绝项目级操作" },
        conversation_id: { type: "string", description: "可继承已绑定项目；不会跨项目猜测" },
        title: { type: "string", description: "可选标题；Skill 必填" },
        tags: { type: "array", items: { type: "string" } },
        source_harness: { type: "string", description: "产生该沉淀的 Harness，例如 codex / claude-code" },
        artifact_id: { type: "string", description: "可覆盖默认 canonical artifact id；通常无需填写" },
        version: { type: "string", description: "Harness 侧产物版本；主要用于 Skill" }
        ,project_description: { type: "string", description: "L2 可附带 1-3 句项目描述，概括目标、范围与当前重点；必须来自同一批证据。人工描述存在时不会被覆盖。" }
        ,evidence_refs: { type: "array", items: { type: "string" }, description: "支持该产物的 Memory/RawTurn/Episode 等稳定引用" }
        ,source_conversations: { type: "array", items: { type: "string" }, description: "产物来源对话 ID；与 distilled_by 分开保存" }
        ,confidence: { type: "number", minimum: 0, maximum: 1 }
        ,job_id: { type: "string", description: "提交通过 next 或 Control Plane 领取的 distillation job" }
        ,lease_seconds: { type: "integer", minimum: 30, maximum: 900 }
        ,evidence_offset: { type: "integer", minimum: 0, description: "大 evidence job 分片读取偏移；action=next + job_id 时继续读取同一 lease" }
        ,evidence_chunk_chars: { type: "integer", minimum: 10000, maximum: 200000, description: "大 evidence 每次最多返回字符数；默认 120000" }
        ,inspect_contract: { type: "boolean", description: "只返回 Memhub 蒸馏规则，不写入任何内容" }
        ,dry_run: { type: "boolean", description: "按当前契约校验候选与 scope，但不写入 Memory Core" }
      },
      required: [],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    if (args.inspect_contract === true) return jsonResult({ contract: distillationContract() });
    const action = optionalString(args.action);
    const sourceHarness = optionalString(args.source_harness) ?? runtime.source.platform ?? "mcp-harness";
    if (action === "next") {
      const requestedJobId = optionalString(args.job_id);
      const evidenceOffset = optionalInteger(args.evidence_offset) ?? 0;
      const evidenceChunkChars = optionalInteger(args.evidence_chunk_chars) ?? 120_000;
      if (evidenceOffset < 0) throw new TypeError("evidence_offset must be non-negative");
      if (evidenceChunkChars < 10_000 || evidenceChunkChars > 200_000) {
        throw new TypeError("evidence_chunk_chars must be between 10000 and 200000");
      }
      if (requestedJobId) {
        const job = (await listDistillationJobs(stateRoot, runtime.accountId)).find((item) => item.job_id === requestedJobId);
        if (!job) throw new Error("distillation job not found for account");
        assertActiveDistillationLease(job, sourceHarness);
        const requestedKind = optionalString(args.kind);
        if (requestedKind && requestedKind !== job.target) throw new Error(`distillation target mismatch: job expects ${job.target}`);
        const requestedScope = optionalString(args.scope);
        if (requestedScope && requestedScope !== job.scope) throw new Error(`distillation scope mismatch: job expects ${job.scope}`);
        return jsonResult(distillationNextPayload(job, evidenceOffset, evidenceChunkChars));
      }
      const requestedScope = optionalString(args.scope);
      let projectFilter: string | null | undefined;
      if (requestedScope === "account") projectFilter = null;
      else if (requestedScope === "project") {
        projectFilter = (await resolveToolScope(runtime, {
          scope: "project",
          project: optionalString(args.project),
          workspaceProject: optionalString(args.workspace_project),
          conversationId: optionalString(args.conversation_id)
        })).projectId;
      }
      const job = await leaseDistillationJob(stateRoot, runtime.accountId, {
        projectId: projectFilter,
        target: optionalString(args.kind) as "l2" | "l3" | "l4" | "skill" | undefined,
        harness: sourceHarness,
        leaseSeconds: optionalInteger(args.lease_seconds)
      });
      if (!job) return jsonResult({
        job: null,
        contract: distillationContract(),
        instructions: "No pending distillation job for this account/scope."
      });
      return jsonResult(distillationNextPayload(job, evidenceOffset, evidenceChunkChars));
    }
    if (action === "skip") {
      const jobId = requiredString(args.job_id, "job_id");
      const job = (await listDistillationJobs(stateRoot, runtime.accountId)).find((item) => item.job_id === jobId);
      if (!job) throw new Error("distillation job not found for account");
      assertActiveDistillationLease(job, sourceHarness);
      await completeDistillationJob(stateRoot, runtime.accountId, jobId, { kind: "noop" }, sourceHarness);
      return jsonResult({ ok: true, job_id: jobId, skipped: true, reason: "no durable artifact justified by evidence" });
    }
    if (action !== undefined && action !== "submit") throw new TypeError("action must be next, submit, or skip");
    const jobId = optionalString(args.job_id);
    const job = jobId
      ? (await listDistillationJobs(stateRoot, runtime.accountId)).find((item) => item.job_id === jobId)
      : undefined;
    if (jobId && !job) throw new Error("distillation job not found for account");
    if (job) assertActiveDistillationLease(job, sourceHarness);
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
    if (kind === "skill" && !title) throw new TypeError("title is required for skill distillation");
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
    if (job && explicitEvidenceRefs.some((ref) => !job.evidence_refs.includes(ref))) {
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
    validateDistillationCandidate({
      kind,
      content,
      evidence: { evidenceRefs, sourceConversations, confidence }
    });
    await validateDistillationEvidenceChain({
      stateRoot,
      runtime,
      kind,
      projectId,
      evidenceRefs: evidenceRefs ?? [],
      job
    });
    if (args.dry_run === true) {
      return jsonResult({
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
      });
    }
    let result: unknown;
    try {
      const canonicalArtifactId = optionalString(args.artifact_id) ??
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
      result = await runtime.memory.distill({
        accountId: runtime.accountId,
        userId: runtime.userId,
        kind,
        content,
        projectId,
        conversationId,
        title: canonicalTitle,
        tags: uniqueStrings(["memory-v2", `layer:${kind}`, ...(stringArray(args.tags) ?? [])]),
        sourceHarness,
        artifactId: canonicalArtifactId,
        version: optionalString(args.version),
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
      });
      if (kind === "l2" && projectId && projectDescription) {
        await runtime.projects.updateDistilledDescription(
          runtime.accountId,
          projectId,
          projectDescription,
          evidenceRefs ?? []
        );
      }
    } catch (error) {
      if (jobId) {
        await failDistillationJob(
          stateRoot,
          runtime.accountId,
          jobId,
          error instanceof Error ? error.message : String(error),
          sourceHarness
        ).catch(() => undefined);
      }
      throw error;
    }
    const resultId = requireMemoryResultId(result);
    let queuedNext: unknown;
    if (jobId) {
      const completed = await completeDistillationJob(stateRoot, runtime.accountId, jobId, {
        kind,
        resultId,
        content
      }, sourceHarness);
      if (kind === "l2" && projectId) {
        queuedNext = await enqueueDerivedDistillationJob({
          stateRoot,
          accountId: runtime.accountId,
          target: "l3",
          projectId,
          evidence: [{
            ref: `l2:${resultId}:${completed.job_id}`,
            kind: "artifact",
            layer: "L2",
            timestamp: completed.completed_at ?? new Date().toISOString(),
            project_id: projectId,
            title: canonicalLayerTitle("l2", projectId),
            content
          }]
        });
      } else if (kind === "l3") {
        const completedL3 = (await listDistillationJobs(stateRoot, runtime.accountId))
          .filter((item) =>
            item.status === "completed" &&
            item.result_kind === "l3" &&
            item.project_id &&
            item.result_id &&
            item.result_content
          );
        const latestByProject = new Map<string, typeof completedL3[number]>();
        for (const item of completedL3) {
          if (!latestByProject.has(item.project_id!)) latestByProject.set(item.project_id!, item);
        }
        if (latestByProject.size >= 2) {
          queuedNext = await enqueueDerivedDistillationJob({
            stateRoot,
            accountId: runtime.accountId,
            target: "l4",
            projectId: null,
            evidence: [...latestByProject.values()].map((item) => ({
              ref: `l3:${item.result_id}:${item.job_id}`,
              kind: "artifact",
              layer: "L3",
              timestamp: item.completed_at ?? item.updated_at,
              project_id: item.project_id!,
              title: canonicalLayerTitle("l3", item.project_id!),
              content: item.result_content!
            }))
          });
        }
      }
    }
    return jsonResult({
      ok: true,
      kind,
      scope,
      project: projectId,
      sourceHarness,
      nativeEvolution: false,
      contract: DISTILLATION_CONTRACT_VERSION,
      job_id: jobId,
      memory: result,
      ...(queuedNext ? { next_layer_job: queuedNext } : {})
    });
  });

  server.registerTool("memmy_project_list", {
    description: "只读列出当前账号的项目注册表。返回 canonical project slug、显示名、description、aliases 和状态；query 可按相似名称检索候选。模型在准备创建项目、绑定一个不确定项目、或发现大小写/近似名称时，应先调用本工具，用名称相似度 + description 判断是否已有同一项目，禁止盲目新建。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        query: { type: "string", description: "可选的项目名称/slug/关键词，用于查找相似项目候选" },
        include_inactive: { type: "boolean", description: "是否包含 merged/deleted 历史项目；默认 false" },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "相似候选最大数量；默认 8" }
      },
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    await knownProjectRecords(runtime);
    const includeInactive = optionalBoolean(args.include_inactive) ?? false;
    const projects = await runtime.projects.list(runtime.accountId, { includeInactive });
    const query = optionalString(args.query);
    const matches = query
      ? await runtime.projects.suggest(runtime.accountId, query, optionalInteger(args.limit) ?? 8)
      : [];
    return jsonResult({
      projects: projects.map(projectForModel),
      matches: matches.map((project) => ({
        ...projectForModel(project),
        similarity: project.similarity,
        matchedBy: project.matchedBy
      })),
      instructions: "Prefer an existing canonical project when name/alias and description describe the same work. If still ambiguous, ask the user. Only create through memmy_project_manage after explicit authorization."
    });
  });

  server.registerTool("memhub_todo", {
    description: "项目待办的一等 MCP 工具。使用 Project Registry 作为唯一事实源，支持 list/add/complete/reopen；不要把待办写进 Project Architecture、项目 description 或 L2/L3 来代替 Todo 状态。list 默认只返回 pending；不指定 project/conversation_id 时列出账号下所有 active project 的待办。add/complete/reopen 必须能解析到一个明确项目。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "complete", "reopen"] },
        project: { type: "string", description: "明确项目 slug/name/alias；写操作建议显式提供。" },
        workspace_project: { type: "string", description: "当前工作区解析出的 project；与 project 不一致时拒绝项目级操作。" },
        conversation_id: { type: "string", description: "可选稳定会话 ID；project 省略时可使用其持久项目 binding。" },
        text: { type: "string", description: "add 时必填的待办内容，最长 2000 字符。" },
        todo_id: { type: "string", description: "complete/reopen 时必填。" },
        status: { type: "string", enum: ["pending", "done", "all"], description: "list 过滤；默认 pending。" }
      },
      required: ["action"],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    const action = requiredString(args.action, "action");
    if (!["list", "add", "complete", "reopen"].includes(action)) throw new TypeError("unsupported todo action");
    await knownProjectRecords(runtime);

    if (action === "list" && !optionalString(args.project) && !optionalString(args.workspace_project) && !optionalString(args.conversation_id)) {
      const status = optionalString(args.status) ?? "pending";
      if (!["pending", "done", "all"].includes(status)) throw new TypeError("todo list status must be pending, done, or all");
      const projects = await runtime.projects.list(runtime.accountId);
      const items = projects.map((project) => {
        const todos = (project.todos ?? []).filter((todo) => status === "all" || todo.status === status);
        return {
          project: project.projectId,
          name: project.name,
          todos,
          pending_count: (project.todos ?? []).filter((todo) => todo.status === "pending").length,
          done_count: (project.todos ?? []).filter((todo) => todo.status === "done").length
        };
      }).filter((project) => project.todos.length > 0 || status === "all");
      return jsonResult({
        scope: "account",
        status,
        projects: items,
        total: items.reduce((count, project) => count + project.todos.length, 0)
      });
    }

    const { projectId } = await resolveToolScope(runtime, {
      scope: "project",
      project: optionalString(args.project),
      workspaceProject: optionalString(args.workspace_project),
      conversationId: optionalString(args.conversation_id)
    });
    if (!projectId) throw new Error("todo operation requires a resolved project");

    if (action === "add") {
      const project = await runtime.projects.addTodo(runtime.accountId, projectId, requiredString(args.text, "text"));
      const todo = (project.todos ?? []).at(-1);
      return jsonResult({
        ok: true,
        action,
        project: project.projectId,
        todo,
        pending_count: (project.todos ?? []).filter((item) => item.status === "pending").length
      });
    }

    if (action === "complete" || action === "reopen") {
      const todoId = requiredString(args.todo_id, "todo_id");
      const project = await runtime.projects.setTodoStatus(
        runtime.accountId,
        projectId,
        todoId,
        action === "complete" ? "done" : "pending"
      );
      const todo = (project.todos ?? []).find((item) => item.id === todoId);
      return jsonResult({
        ok: true,
        action,
        project: project.projectId,
        todo,
        pending_count: (project.todos ?? []).filter((item) => item.status === "pending").length
      });
    }

    const status = optionalString(args.status) ?? "pending";
    if (!["pending", "done", "all"].includes(status)) throw new TypeError("todo list status must be pending, done, or all");
    const project = (await runtime.projects.list(runtime.accountId)).find((item) => item.projectId === projectId);
    if (!project) throw new Error(`unknown or inactive project: ${projectId}`);
    const todos = (project.todos ?? []).filter((todo) => status === "all" || todo.status === status);
    return jsonResult({
      scope: "project",
      project: project.projectId,
      status,
      todos,
      total: todos.length,
      pending_count: (project.todos ?? []).filter((todo) => todo.status === "pending").length,
      done_count: (project.todos ?? []).filter((todo) => todo.status === "done").length
    });
  });

  server.registerTool("memmy_project_manage", {
    description: "受控项目管理工具。支持 create/update/delete/merge，但所有修改都必须先 action=plan；plan 只返回一次性 authorization_id 和影响说明，不修改数据。模型必须把计划展示给用户，并在收到针对该计划的明确授权后才能 action=execute。禁止把 plan 本身、历史授权或模型推断当成授权。delete 是逻辑删除，不物理清空 Memory；merge 将 source 变成 target 的历史 alias，未来写入统一到 target，旧 alias 下的历史记忆仍参与召回。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        action: { type: "string", enum: ["plan", "execute"] },
        operation: { type: "string", enum: ["create", "update", "delete", "merge"] },
        project: { type: "string", description: "create 时为新 canonical slug；其它操作为 source/current project ref" },
        target: { type: "string", description: "merge 的目标 canonical project ref" },
        name: { type: "string", description: "create/update 的显示名；不改变稳定 canonical slug" },
        description: { type: "string", description: "create 必填；update 可修改。用于 AI 项目消歧。" },
        aliases: { type: "array", items: { type: "string" }, description: "create/update 的显式别名集合" },
        authorization_id: { type: "string", description: "execute 时必须使用刚才 plan 返回的一次性授权 ID" }
      },
      required: ["action"],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    const action = requiredString(args.action, "action");
    if (action === "plan") {
      await knownProjectRecords(runtime);
      const operation = requiredString(args.operation, "operation");
      if (!["create", "update", "delete", "merge"].includes(operation)) throw new TypeError("unsupported project management operation");
      const project = requiredString(args.project, "project");
      const payload: Record<string, unknown> = { project };
      let impact: Record<string, unknown>;

      if (operation === "create") {
        const description = requiredString(args.description, "description");
        if (await runtime.projects.resolve(runtime.accountId, project)) {
          throw new Error(`project already exists or aliases to an existing project: ${project}`);
        }
        payload.description = description;
        if (optionalString(args.name)) payload.name = optionalString(args.name);
        if (stringArray(args.aliases)) payload.aliases = stringArray(args.aliases);
        impact = {
          createsCanonicalProject: project,
          similarProjects: (await runtime.projects.suggest(runtime.accountId, project, 6)).map(projectForModel),
          requiresDescription: true
        };
      } else {
        const canonical = await runtime.projects.resolve(runtime.accountId, project);
        if (!canonical) throw new Error(`unknown or inactive project: ${project}`);
        payload.project = canonical;
        if (operation === "update") {
          const hasName = typeof args.name === "string";
          const hasDescription = typeof args.description === "string";
          const hasAliases = Array.isArray(args.aliases);
          if (!hasName && !hasDescription && !hasAliases) throw new TypeError("update requires name, description, or aliases");
          if (hasName) payload.name = String(args.name);
          if (hasDescription) payload.description = String(args.description);
          if (hasAliases) payload.aliases = stringArray(args.aliases) ?? [];
          impact = {
            project: canonical,
            stableCanonicalSlug: canonical,
            changesMetadataOnly: true
          };
        } else if (operation === "delete") {
          const blockers = await unfinishedDistillationJobsForProject(stateRoot, runtime, canonical);
          impact = {
            project: canonical,
            logicalDelete: true,
            memoryPurged: false,
            blockedByDistillationJobs: blockers.map((job) => ({
              job_id: job.job_id,
              status: job.status,
              target: job.target
            })),
            note: "Existing durable evidence is retained; the project becomes unavailable for new routing/writes."
          };
        } else {
          const target = requiredString(args.target, "target");
          const canonicalTarget = await runtime.projects.resolve(runtime.accountId, target);
          if (!canonicalTarget) throw new Error(`unknown merge target: ${target}`);
          if (canonicalTarget === canonical) throw new Error("source and target already resolve to the same project");
          payload.target = canonicalTarget;
          impact = {
            source: canonical,
            target: canonicalTarget,
            logicalMerge: true,
            futureWritesUse: canonicalTarget,
            historicalAliasRecallPreserved: true,
            physicalMemoryRewrite: false
          };
        }
      }

      const authorizationId = randomUUID();
      const expiresAt = Date.now() + 10 * 60_000;
      projectMutationAuthorizations.set(authorizationId, {
        accountId: runtime.accountId,
        operation: operation as "create" | "update" | "delete" | "merge",
        payload,
        expiresAt
      });
      return jsonResult({
        status: "awaiting_user_authorization",
        operation,
        payload,
        impact,
        authorization_id: authorizationId,
        expires_at: new Date(expiresAt).toISOString(),
        instructions: "Show this plan to the user. Call action=execute with authorization_id only after the user explicitly approves this exact plan."
      });
    }
    if (action !== "execute") throw new TypeError("action must be plan or execute");
    const authorizationId = requiredString(args.authorization_id, "authorization_id");
    const authorization = projectMutationAuthorizations.get(authorizationId);
    if (!authorization || authorization.accountId !== runtime.accountId) throw new Error("invalid or already-used project authorization");
    projectMutationAuthorizations.delete(authorizationId);
    if (authorization.expiresAt < Date.now()) throw new Error("project authorization expired; create a new plan");
    const project = requiredString(authorization.payload.project, "project");
    let result: unknown;
    if (authorization.operation === "create") {
      result = await runtime.projects.create(runtime.accountId, {
        projectId: project,
        name: optionalString(authorization.payload.name),
        description: requiredString(authorization.payload.description, "description"),
        aliases: stringArray(authorization.payload.aliases)
      });
    } else if (authorization.operation === "update") {
      result = await runtime.projects.update(runtime.accountId, project, {
        ...(typeof authorization.payload.name === "string" ? { name: authorization.payload.name } : {}),
        ...(typeof authorization.payload.description === "string" ? { description: authorization.payload.description } : {}),
        ...(Array.isArray(authorization.payload.aliases) ? { aliases: stringArray(authorization.payload.aliases) ?? [] } : {})
      });
    } else if (authorization.operation === "delete") {
      const blockers = await unfinishedDistillationJobsForProject(stateRoot, runtime, project);
      if (blockers.length > 0) {
        throw new Error(`project has ${blockers.length} unfinished distillation job(s); complete, skip, or resolve them before delete`);
      }
      result = await runtime.projects.delete(runtime.accountId, project);
    } else {
      result = await runtime.projects.merge(
        runtime.accountId,
        project,
        requiredString(authorization.payload.target, "target")
      );
    }
    return jsonResult({ ok: true, operation: authorization.operation, result });
  });

  server.registerTool("memmy_project", {
    description: "兼容项目上下文工具：列出、查看、绑定或解除当前会话项目，也可只读现有项目架构文件。新的项目发现/消歧优先使用 memmy_project_list；项目修改使用 memmy_project_manage。action=current 在有稳定 conversation_id 时读取持久 binding；没有 conversation_id 时不会报错，也不会伪造会话身份，可用显式 project 做一次 canonical resolve，否则返回 binding_available=false。Memhub 被提及或调用时应先完成 memmy_context；若本轮有明确项目/workspace 证据，以本轮证据或 memmy_context.resolvedProjectId 为准，不要凭旧绑定或模型猜测项目。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "current", "bind", "unbind", "architecture"] },
        conversation_id: { type: "string" },
        project: { type: "string" },
        workspace_project: { type: "string", description: "当前工作区解析出的 project；与 project 不一致时拒绝操作" },
        query: { type: "string", description: "architecture 时用于选择最相关的架构模块" }
      },
      required: ["action"],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    const action = requiredString(args.action, "action");
    if (action === "list") {
      const details = await knownProjectRecords(runtime);
      return jsonResult({ projects: details.map((project) => project.projectId), projectDetails: details.map(projectForModel) });
    }
    const conversationId = optionalString(args.conversation_id);
    if (action === "current") {
      await knownProjectRecords(runtime);
      const explicitEvidence = await resolveExplicitProjectEvidence(runtime, {
        project: optionalString(args.project),
        workspaceProject: optionalString(args.workspace_project)
      });
      if (explicitEvidence.projectId) {
        return jsonResult({
          project: explicitEvidence.projectId,
          conversation_id: conversationId ?? null,
          binding_available: Boolean(conversationId),
          resolution_source: explicitEvidence.resolutionSource,
          persisted: false,
          note: "Current-turn project/workspace evidence takes priority over an older conversation binding."
        });
      }
      if (conversationId) {
        return jsonResult({
          project: await runtime.router.currentProject(runtime.accountId, conversationId),
          conversation_id: conversationId,
          binding_available: true,
          resolution_source: "conversation_binding"
        });
      }
      return jsonResult({
        project: null,
        conversation_id: null,
        binding_available: false,
        resolution_source: "conversation_id_unavailable",
        persisted: false,
        note: "Transport did not provide a stable conversation_id. Use memmy_context.resolvedProjectId or explicit current-turn project/workspace evidence; do not invent a conversation id."
      });
    }
    if (action === "bind") {
      if (!conversationId) throw new TypeError("conversation_id is required for bind");
      const projectId = requiredString(args.project, "project");
      const explicitEvidence = await resolveExplicitProjectEvidence(runtime, {
        project: projectId,
        workspaceProject: optionalString(args.workspace_project)
      });
      const canonical = explicitEvidence.projectId!;
      await runtime.router.bindProject(runtime.accountId, conversationId, canonical);
      return jsonResult({ ok: true, project: canonical, requested: projectId });
    }
    if (action === "unbind") {
      if (!conversationId) throw new TypeError("conversation_id is required for unbind");
      return jsonResult({ ok: true, removed: await runtime.router.unbindProject(runtime.accountId, conversationId) });
    }
    if (action === "architecture") {
      const explicitEvidence = await resolveExplicitProjectEvidence(runtime, {
        project: optionalString(args.project),
        workspaceProject: optionalString(args.workspace_project)
      });
      if (!explicitEvidence.projectId) throw new TypeError("architecture requires project or workspace_project");
      const canonical = explicitEvidence.projectId;
      const query = optionalString(args.query) ?? "project architecture, ownership, dependencies and current constraints";
      return jsonResult({
        project: canonical,
        architecture: await runtime.router.projectArchitecture(runtime.accountId, canonical, query)
      });
    }
    throw new TypeError(`unsupported memmy_project action: ${action}`);
  });

  return server;
}

export function createMemhubMcpHandler(options: MemhubMcpOptions = {}) {
  return createMcpHandler(() => createMemhubMcpServer(options));
}

interface CliOptions extends MemhubRuntimeOptions {
  stateRoot?: string;
  httpPort?: number;
  httpPath?: string;
  capturePath?: string;
  basePath?: string;
  publicHost?: string;
  allowJit?: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--account") options.accountId = value();
    else if (arg === "--state-root") options.stateRoot = value();
    else if (arg === "--memory-url") options.memoryEndpoint = value();
    else if (arg === "--memory-token") options.memoryToken = value();
    else if (arg === "--bindings") options.bindingsPath = value();
    else if (arg === "--architecture-root") options.architectureRoot = value();
    else if (arg === "--no-architecture") options.disableArchitecture = true;
    else if (arg === "--normify-root") options.architectureRoot = value(); // deprecated alias
    else if (arg === "--no-normify") options.disableArchitecture = true; // deprecated alias
    else if (arg === "--owner-account") options.ownerAccountId = value();
    else if (arg === "--owner-user") options.ownerUserId = value();
    else if (arg === "--http") {
      const raw = value();
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --http port: ${raw}`);
      options.httpPort = port;
    }
    else if (arg === "--http-path") {
      const path = value();
      if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
        throw new Error("--http-path must start with / and contain no query/fragment");
      }
      options.httpPath = path.length > 1 ? path.replace(/\/+$/, "") : path;
    }
    else if (arg === "--capture-path") {
      const path = value();
      if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
        throw new Error("--capture-path must start with / and contain no query/fragment");
      }
      options.capturePath = path.length > 1 ? path.replace(/\/+$/, "") : path;
    }
    else if (arg === "--base-path") options.basePath = normalizeBasePath(value());
    else if (arg === "--public-host") {
      const host = value().trim().toLowerCase();
      if (!host || host.includes("/") || host.includes(":")) throw new Error("--public-host must be a hostname");
      options.publicHost = host;
    }
    else if (arg === "--allow-jit") options.allowJit = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write([
        "Usage: memhub-mcp [options]",
        "       memhub-mcp account list|add|bind-email|delete ...",
        "       memhub-mcp device list|add|revoke ...",
        "       memhub-mcp admin-token show|rotate [--state-root PATH]",
        "",
        "Default transport: stdio.",
        "HTTP binds only to 127.0.0.1. Local Control Plane requires the local admin token.",
        "--public-host enables Cloudflare Access JWT identity for public Control Plane/MCP requests.",
        "Unknown Cloudflare emails are denied unless --allow-jit is explicitly set."
      ].join("\n") + "\n");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "account") {
    await runAccountCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "device") {
    await runDeviceCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "admin-token") {
    await runAdminTokenCommand(argv.slice(1));
    return;
  }
  const options = parseArgs(argv);
  const {
    stateRoot = defaultStateRoot(),
    httpPort,
    httpPath = "/mcp",
    capturePath = process.env.MEMHUB_CAPTURE_PATH?.trim() || "/memhub/capture",
    basePath = normalizeBasePath(process.env.MEMHUB_BASE_PATH?.trim() || "/memhub"),
    publicHost = process.env.MEMHUB_PUBLIC_HOST?.trim() || undefined,
    allowJit = process.env.MEMHUB_ALLOW_JIT === "1",
    ...runtimeOptions
  } = options;
  if (httpPort !== undefined) {
    await serveHttp(runtimeOptions, { stateRoot, port: httpPort, path: httpPath, capturePath, basePath, publicHost, allowJit });
    return;
  }
  console.error(`[memhub] serving stdio account=${runtimeOptions.accountId ?? process.env.MEMHUB_ACCOUNT_ID ?? "local"}`);
  await serveStdio(() => createMemhubMcpServerForRuntime(createMemhubRuntime(runtimeOptions), stateRoot));
}

function normalizeBasePath(value: string): string {
  const path = value.trim() || "/";
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw new Error("base path must start with / and contain no query/fragment");
  }
  return path === "/" ? "/" : path.replace(/\/+$/, "");
}

function rewriteHtmlForBasePath(html: string, basePath: string): string {
  if (basePath !== "/") return html;
  return html
    .replaceAll('"/memhub"', '"/"')
    .replaceAll("'/memhub'", "'/'")
    .replaceAll("/memhub/", "/");
}

async function serveHttp(
  runtimeOptions: MemhubRuntimeOptions,
  options: { stateRoot: string; port: number; path: string; capturePath: string; basePath: string; publicHost?: string; allowJit: boolean }
): Promise<void> {
  await ensureLocalAdminToken(options.stateRoot);
  const handlers = new Map<string, ReturnType<typeof toNodeHandler>>();
  const runtimes = new Map<string, MemhubRuntime>();
  const validateHost = options.publicHost === undefined
    ? localhostHostValidation()
    : hostHeaderValidation(["localhost", "127.0.0.1", "[::1]", options.publicHost]);
  const validateOrigin = options.publicHost === undefined
    ? localhostOriginValidation()
    : originValidation(["localhost", "127.0.0.1", "[::1]", options.publicHost]);
  const healthPath = options.basePath === "/" ? "/health" : `${options.basePath}/health`;

  const runtimeFor = (accountId: string, source = runtimeOptions.source): MemhubRuntime => {
    const sourceKey = source
      ? [source.platform, source.transport, source.principalId ?? "", source.connectionId ?? "", source.authenticatedAccount ?? ""].join("|")
      : "default";
    const runtimeKey = `${accountId}|${sourceKey}`;
    let runtime = runtimes.get(runtimeKey);
    if (!runtime) {
      runtime = createMemhubRuntime({ ...runtimeOptions, accountId, source });
      runtimes.set(runtimeKey, runtime);
    }
    return runtime;
  };

  const handlerFor = (accountId: string, source = runtimeOptions.source) => {
    const sourceKey = source
      ? [source.platform, source.transport, source.principalId ?? "", source.connectionId ?? "", source.authenticatedAccount ?? ""].join("|")
      : "default";
    const handlerKey = `${accountId}|${sourceKey}`;
    let handler = handlers.get(handlerKey);
    if (handler) return handler;
    handler = toNodeHandler(
      createMcpHandler(() => createMemhubMcpServerForRuntime(runtimeFor(accountId, source), options.stateRoot)),
      { onerror: (error) => console.error("[memhub] MCP HTTP error:", error.message) }
    );
    handlers.set(handlerKey, handler);
    return handler;
  };

  const http = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!validateHost(request, response) || !validateOrigin(request, response)) return;
      if (url.pathname === healthPath) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { allow: "GET, HEAD" }).end();
          return;
        }
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
          ...webSecurityHeaders()
        });
        response.end(request.method === "HEAD" ? undefined : JSON.stringify({ ok: true, service: "memhub", uptime_seconds: Math.floor(process.uptime()) }));
        return;
      }
      if (options.basePath === "/" && url.pathname !== options.path && url.pathname !== options.capturePath) {
        url.pathname = url.pathname === "/" ? "/memhub" : `/memhub${url.pathname}`;
      }
      if (url.pathname === "/") {
        response.writeHead(302, { location: "/memhub", "cache-control": "no-store" }).end();
        return;
      }
      if (url.pathname === "/memhub") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { allow: "GET, HEAD" }).end();
          return;
        }
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300",
          ...webSecurityHeaders()
        });
        response.end(request.method === "HEAD" ? undefined : rewriteHtmlForBasePath(renderLanding(), options.basePath));
        return;
      }
      if (url.pathname === "/memhub/context") {
        if (request.method !== "POST") {
          response.writeHead(405, { allow: "POST" }).end();
          return;
        }
        const deviceToken = bearerToken(request.headers.authorization) ?? singleHeader(request.headers["x-memhub-device-token"]);
        if (!deviceToken) {
          response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ error: "missing_device_token" }));
          return;
        }
        const device = await authenticateDevice(options.stateRoot, deviceToken);
        if (!device) {
          response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ error: "invalid_or_revoked_device" }));
          return;
        }
        const body = await readJsonBody(request) as Record<string, unknown>;
        const runtime = runtimeFor(device.account_id, {
          platform: device.name || "device",
          transport: "device-context",
          principalId: `device:${device.device_id}`,
          connectionId: device.device_id
        });
        const knownProjects = await knownProjectIds(runtime);
        const requestedCapabilityProjects = stringArray(body.capability_projects) ?? [];
        const crossProjectSkills = optionalBoolean(body.cross_project_skills) ?? true;
        const capsule = await runtime.router.context({
          accountId: runtime.accountId,
          userId: runtime.userId,
          query: requiredString(body.query, "query"),
          conversationId: optionalString(body.conversation_id),
          projectId: optionalString(body.project),
          workspaceProjectId: optionalString(body.workspace_project),
          semanticProjectIds: stringArray(body.semantic_projects),
          knownProjectIds: knownProjects,
          reusableSkillProjectIds: crossProjectSkills
            ? (requestedCapabilityProjects.length > 0 ? requestedCapabilityProjects : knownProjects)
            : [],
          limit: optionalInteger(body.limit)
        });
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(capsule));
        return;
      }
      if (url.pathname === "/memhub/lifecycle") {
        if (request.method !== "POST") {
          response.writeHead(405, { allow: "POST" }).end();
          return;
        }
        const deviceToken = bearerToken(request.headers.authorization) ?? singleHeader(request.headers["x-memhub-device-token"]);
        if (!deviceToken) {
          response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ error: "missing_device_token" }));
          return;
        }
        const device = await authenticateDevice(options.stateRoot, deviceToken);
        if (!device) {
          response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ error: "invalid_or_revoked_device" }));
          return;
        }
        const body = await readJsonBody(request) as Record<string, unknown>;
        const event = requiredString(body.event, "event").toLowerCase();
        if (!new Set(["sessionstart", "postcompact", "sessionend"]).has(event)) {
          response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ error: "unsupported_lifecycle_event" }));
          return;
        }
        const conversationId = requiredString(body.conversation_id, "conversation_id");
        const host = optionalString(body.host) ?? "codex";
        const projectHint = optionalString(body.project_hint);
        const workspacePath = optionalString(body.workspace_path);
        const runtime = runtimeFor(device.account_id, {
          platform: device.name || host,
          transport: "device-lifecycle",
          principalId: `device:${device.device_id}`,
          connectionId: device.device_id
        });
        let projectId = await runtime.router.currentProject(device.account_id, conversationId);
        if (projectHint) {
          await runtime.router.bindProject(device.account_id, conversationId, projectHint);
          projectId = projectHint;
        }
        const sessionId = captureSessionId(runtime.accountId, host, conversationId, projectId);
        const namespace = {
          source: "memhub-lifecycle",
          profileId: "default",
          userId: runtime.userId,
          tenantId: runtime.accountId,
          sessionKey: `${host}:${conversationId}`,
          ...(projectId ? { projectId } : {}),
          ...(workspacePath ? { workspacePath } : {})
        };
        const common = {
          adapterId: "memhub-lifecycle",
          namespace,
          source: "memhub-lifecycle"
        };
        if (event === "sessionend") {
          try {
            await runtime.memoryClient.closeSession(sessionId, {
              ...common,
              requestId: `memhub-lifecycle-close:${sessionId}`
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/404|not found|session/i.test(message)) throw error;
          }
          response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ ok: true, event, session_id: sessionId, project_id: projectId }));
          return;
        }
        await runtime.memoryClient.openSession({
          ...common,
          requestId: `memhub-lifecycle-open:${sessionId}`,
          sessionId,
          ...(projectId ? { projectId } : {}),
          ...(workspacePath ? { workspacePath } : {}),
          meta: { host, conversation_id: conversationId }
        });
        const capsule = await runtime.router.context({
          accountId: runtime.accountId,
          userId: runtime.userId,
          query: event === "postcompact"
            ? "Restore the current project state, durable decisions, constraints, preferences and active context after compaction."
            : "Load current durable project state, decisions, constraints, preferences and relevant long-term context for this session.",
          conversationId,
          ...(projectId ? { projectId } : {}),
          limit: 12
        });
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ ok: true, event, session_id: sessionId, project_id: projectId, context: capsule }));
        return;
      }
      if (url.pathname === options.capturePath) {
        if (request.method !== "POST") {
          response.writeHead(405, { allow: "POST" }).end();
          return;
        }
        const deviceToken = bearerToken(request.headers.authorization) ?? singleHeader(request.headers["x-memhub-device-token"]);
        if (!deviceToken) {
          response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ error: "missing_device_token" }));
          return;
        }
        const device = await authenticateDevice(options.stateRoot, deviceToken);
        if (!device) {
          response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ error: "invalid_or_revoked_device" }));
          return;
        }
        let incomingCapture;
        try {
          incomingCapture = normalizeCaptureEvent(await readJsonBody(request));
        } catch (error) {
          const bodyError = asHttpJsonBodyError(error);
          response.writeHead(bodyError?.statusCode ?? 400, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({
            error: bodyError?.code ?? "invalid_capture",
            message: error instanceof Error ? error.message : String(error)
          }));
          return;
        }
        const runtime = runtimeFor(device.account_id);
        if (incomingCapture.project_hint) {
          try {
            const projects = await runtime.router.listProjects(device.account_id);
            if (projects.length > 0 && !projects.includes(incomingCapture.project_hint)) {
              throw new Error(`unknown project for account: ${incomingCapture.project_hint}`);
            }
          } catch (error) {
            response.writeHead(422, { "content-type": "application/json", "cache-control": "no-store" });
            response.end(JSON.stringify({
              error: "invalid_project_hint",
              event_id: incomingCapture.event_id,
              message: error instanceof Error ? error.message : String(error)
            }));
            return;
          }
        }
        let stored;
        try {
          stored = await storeCaptureEvent(options.stateRoot, device, incomingCapture);
        } catch (error) {
          response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({
            error: "capture_conflict",
            event_id: incomingCapture.event_id,
            message: error instanceof Error ? error.message : String(error)
          }));
          return;
        }
        let projectId: string | null;
        try {
          projectId = await runtime.router.currentProject(device.account_id, stored.event.conversation_id);
          if (!stored.event.project_hint && projectId) {
            const tagged = await storeCaptureEvent(options.stateRoot, device, {
              ...stored.event,
              project_hint: projectId
            });
            stored = {
              created: stored.created,
              updated: stored.updated || tagged.updated,
              event: tagged.event
            };
          }
          if (stored.event.project_hint) {
            await runtime.router.bindProject(device.account_id, stored.event.conversation_id, stored.event.project_hint);
            projectId = stored.event.project_hint;
          }
        } catch (error) {
          response.writeHead(422, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({
            error: "invalid_project_hint",
            event_id: stored.event.event_id,
            message: error instanceof Error ? error.message : String(error)
          }));
          return;
        }
        let ingestion: Awaited<ReturnType<typeof ingestCaptureIntoMemory>> | { ingested: true; duplicate: true; project_id: string | null } = {
          ingested: true,
          duplicate: true,
          project_id: projectId
        };
        if (!(await isCaptureIngested(options.stateRoot, device.account_id, stored.event.event_id))) {
          try {
            ingestion = await ingestCaptureIntoMemory({
              event: stored.event,
              device,
              runtime,
              projectId
            });
            if (ingestion.ingested) {
              await markCaptureIngested(options.stateRoot, device.account_id, stored.event.event_id);
              const distillation = await maybeQueueThresholdDistillation({
                stateRoot: options.stateRoot,
                accountId: device.account_id,
                projectId,
                conversationId: stored.event.conversation_id
              });
              if (distillation) ingestion = { ...ingestion, distillation } as typeof ingestion & { distillation: unknown };
            }
          } catch (error) {
            response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
            response.end(JSON.stringify({
              error: "capture_ingest_failed",
              event_id: stored.event.event_id,
              message: error instanceof Error ? error.message : String(error)
            }));
            return;
          }
        }
        response.writeHead(stored.created ? 201 : 200, {
          "content-type": "application/json",
          "cache-control": "no-store"
        });
        response.end(JSON.stringify({
          accepted: true,
          duplicate: !stored.created && !stored.updated,
          updated: stored.updated,
          event_id: stored.event.event_id,
          device_id: device.device_id,
          ingestion
        }));
        return;
      }

      if (url.pathname.startsWith("/memhub/user") || url.pathname.startsWith("/memhub/admin")) {
        let accounts = await listAccounts(options.stateRoot);
        const localControl = isLocalControlRequest(request);
        let summary: (typeof accounts)[number];
        if (localControl) {
          const token = basicPassword(singleHeader(request.headers.authorization));
          if (!(await verifyLocalAdminToken(options.stateRoot, token))) {
            response.writeHead(401, {
              "content-type": "text/plain; charset=utf-8",
              "cache-control": "no-store",
              "www-authenticate": 'Basic realm="Memhub local admin", charset="UTF-8"'
            }).end("Local administrator token required");
            return;
          }
          summary = localAdminAccount(accounts, runtimeOptions.accountId ?? process.env.MEMHUB_LOCAL_ADMIN_ACCOUNT);
        } else {
          if (options.publicHost === undefined) {
            response.writeHead(404).end();
            return;
          }
          const assertion = singleHeader(request.headers["cf-access-jwt-assertion"]);
          if (!assertion) {
            response.writeHead(401, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("Cloudflare Access authentication required");
            return;
          }
          const identity = await verifyCloudflareAccessJwt(options.stateRoot, options.publicHost, assertion);
          let account;
          try {
            account = await resolveCloudflareAccount(options.stateRoot, identity, { allowJit: options.allowJit });
            if (account.created) accounts = await listAccounts(options.stateRoot);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!options.allowJit && message.includes("未加入 Memhub 本地允许列表")) {
              response.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...webSecurityHeaders() });
              response.end(rewriteHtmlForBasePath(renderUnprovisionedAccount(identity.email), options.basePath));
              return;
            }
            throw error;
          }
          summary = accounts.find((item) => item.account_id === account.account_id)!;
        }
        const isAdmin = summary.role === "admin";
        if (url.pathname.startsWith("/memhub/admin") && !isAdmin) {
          response.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("Administrator access required");
          return;
        }
        const adminView = url.pathname.startsWith("/memhub/admin");
        const selectedRef = adminView ? optionalString(url.searchParams.get("account_id")) : undefined;
        const selectedAccount = selectedRef
          ? accounts.find((item) =>
              item.account_id === selectedRef ||
              item.username === selectedRef ||
              item.cloudflare_email === selectedRef.toLowerCase())
          : summary;
        if (!selectedAccount) {
          response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" })
            .end(JSON.stringify({ error: "account_not_found" }));
          return;
        }
        const runtime = runtimeFor(selectedAccount.account_id);
        const apiPath = adminView ? "/memhub/admin/api" : "/memhub/user/api";
        const actionPath = adminView ? "/memhub/admin/action" : "/memhub/user/action";
        if (url.pathname === apiPath && request.method === "GET") {
          const kindRaw = url.searchParams.get("kind") ?? "overview";
          if (kindRaw === "accounts") {
            if (!adminView) { response.writeHead(403).end(); return; }
            response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
              .end(JSON.stringify({
                items: accounts.map((account) => ({
                  account_id: account.account_id,
                  username: account.username,
                  cloudflare_email: account.cloudflare_email,
                  role: account.role,
                  selected: account.account_id === selectedAccount.account_id
                })),
                total: accounts.length
              }));
            return;
          }
          const allowedKinds = new Set<MemoryControlKind>([
            "overview", "projects", "l1", "l2", "l3", "l4", "skills", "processing"
          ]);
          if (!allowedKinds.has(kindRaw as MemoryControlKind)) {
            response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" })
              .end(JSON.stringify({ error: "unsupported_memory_view" }));
            return;
          }
          const projects = await knownProjectRecords(runtime);
          const projectRef = optionalString(url.searchParams.get("project"));
          const projectId = projectRef
            ? await runtime.projects.resolve(runtime.accountId, projectRef)
            : undefined;
          if (projectRef && !projectId) {
            response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" })
              .end(JSON.stringify({ error: "project_not_found" }));
            return;
          }
          const payload = await readMemoryControlData({
            stateRoot: options.stateRoot,
            runtime,
            kind: kindRaw as MemoryControlKind,
            projects,
            ...(projectId ? { projectId } : {})
          });
          response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
            .end(JSON.stringify({
              ...objectRecord(payload),
              account: {
                account_id: selectedAccount.account_id,
                username: selectedAccount.username,
                role: selectedAccount.role
              }
            }));
          return;
        }
        if (url.pathname === actionPath && request.method === "POST") {
          if (!isJsonRequest(request)) {
            response.writeHead(415, { "content-type": "application/json", "cache-control": "no-store" })
              .end(JSON.stringify({ error: "application_json_required" }));
            return;
          }
          const body = await readJsonBody(request) as Record<string, unknown>;
          const action = optionalString(body.action);
          const id = optionalString(body.id);
          if (!action) { response.writeHead(400).end(); return; }
          if (action === "set-distillation-config") {
            if (!adminView) { response.writeHead(403).end(); return; }
            const config = await setDistillationConfig(options.stateRoot, {
              ...(typeof body.auto_enabled === "boolean" ? { auto_enabled: body.auto_enabled } : {}),
              ...(typeof body.turn_threshold === "number" ? { turn_threshold: body.turn_threshold } : {}),
              ...(typeof body.idle_minutes === "number" ? { idle_minutes: body.idle_minutes } : {})
            });
            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, config }));
            return;
          }
          if (action === "queue-legacy-rebuild") {
            if (!adminView) { response.writeHead(403).end(); return; }
            const projectRef = optionalString(body.project);
            let projectId: string | undefined;
            if (projectRef) {
              await knownProjectRecords(runtime);
              projectId = await runtime.projects.resolve(runtime.accountId, projectRef) ?? undefined;
              if (!projectId) {
                response.writeHead(404, { "content-type": "application/json" })
                  .end(JSON.stringify({ error: "project_not_found" }));
                return;
              }
            }
            const rebuild = await queueLegacyLayerRebuild({
              stateRoot: options.stateRoot,
              runtime,
              ...(projectId ? { projectId } : {})
            });
            response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
              .end(JSON.stringify({ ok: true, rebuild }));
            return;
          }
          if (action === "set-account-role") {
            if (!adminView) { response.writeHead(403).end(); return; }
            const accountRef = optionalString(body.id);
            const role = optionalString(body.role);
            if (!accountRef || (role !== "admin" && role !== "user")) { response.writeHead(400).end(); return; }
            const target = accounts.find((item) => item.account_id === accountRef || item.username === accountRef || item.cloudflare_email === accountRef.toLowerCase());
            if (!target) { response.writeHead(404).end(); return; }
            if (target.role === "admin" && role === "user" && accounts.filter((item) => item.role === "admin").length <= 1) {
              response.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: "cannot_demote_last_admin" }));
              return;
            }
            await setAccountRole(options.stateRoot, accountRef, role);
            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, account_id: target.account_id, role }));
            return;
          }
          if (["create-project", "update-project", "delete-project", "merge-project"].includes(action)) {
            if (!adminView) { response.writeHead(403).end(); return; }
            const projectRef = optionalString(body.project);
            if (!projectRef) { response.writeHead(400).end(); return; }
            let result: unknown;
            if (action === "create-project") {
              result = await runtime.projects.create(runtime.accountId, {
                projectId: projectRef,
                name: optionalString(body.name),
                description: requiredString(body.description, "description"),
                aliases: stringArrayAllowEmpty(body.aliases)
              });
            } else if (action === "update-project") {
              result = await runtime.projects.update(runtime.accountId, projectRef, {
                ...(typeof body.name === "string" ? { name: String(body.name) } : {}),
                ...(typeof body.description === "string" ? { description: String(body.description) } : {}),
                ...(Array.isArray(body.aliases) ? { aliases: stringArrayAllowEmpty(body.aliases) } : {})
              });
            } else if (action === "delete-project") {
              const canonical = await runtime.projects.resolve(runtime.accountId, projectRef);
              if (!canonical) {
                response.writeHead(404, { "content-type": "application/json" })
                  .end(JSON.stringify({ error: "project_not_found" }));
                return;
              }
              const blockers = await unfinishedDistillationJobsForProject(options.stateRoot, runtime, canonical);
              if (blockers.length > 0) {
                response.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" })
                  .end(JSON.stringify({
                    error: "unfinished_distillation_jobs",
                    project: canonical,
                    jobs: blockers.map((job) => ({ job_id: job.job_id, status: job.status, target: job.target }))
                  }));
                return;
              }
              result = await runtime.projects.delete(runtime.accountId, projectRef);
            } else {
              result = await runtime.projects.merge(runtime.accountId, projectRef, requiredString(body.target, "target"));
            }
            response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
              .end(JSON.stringify({ ok: true, action, result }));
            return;
          }
          if (action === "add-project-todo" || action === "set-project-todo-status") {
            if (!adminView) { response.writeHead(403).end(); return; }
            const projectRef = optionalString(body.project);
            if (!projectRef) { response.writeHead(400).end(); return; }
            const result = action === "add-project-todo"
              ? await runtime.projects.addTodo(runtime.accountId, projectRef, requiredString(body.text, "text"))
              : await runtime.projects.setTodoStatus(
                  runtime.accountId,
                  projectRef,
                  requiredString(body.todo_id, "todo_id"),
                  requiredString(body.status, "status") as "pending" | "done"
                );
            response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
              .end(JSON.stringify({ ok: true, action, result }));
            return;
          }
          if (!id) { response.writeHead(400).end(); return; }
          if (action === "retry-distillation") {
            const retried = await retryDistillationJob(options.stateRoot, selectedAccount.account_id, id);
            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, job: retried }));
            return;
          }
          if (action === "delete-memory" || action === "archive-memory" || action === "archive-skill") {
            await assertManagedMemory(runtime, id);
            if (action === "delete-memory") {
              await runtime.memoryClient.viewerDelete(`/api/v1/memory/${encodeURIComponent(id)}`);
            } else if (action === "archive-skill") {
              await runtime.memoryClient.viewerPost("/api/v1/skills/archive", { skillId: id });
            } else {
              await runtime.memoryClient.viewerPost(`/api/v1/memory/${encodeURIComponent(id)}/archive`);
            }
            response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
            return;
          }
          response.writeHead(400).end();
          return;
        }
        const projects = await knownProjectRecords(runtime);
        const visibleAccounts = isAdmin && adminView ? accounts : [];
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...webSecurityHeaders() });
        response.end(rewriteHtmlForBasePath(renderConsole({ account: summary, projects, accounts: visibleAccounts, adminView, localControl, selectedAccountId: selectedAccount.account_id }), options.basePath));
        return;
      }
      // OAuth-capable MCP clients may canonicalize the resource URI with a
      // trailing slash. Cloudflare Managed OAuth protects both forms, so the
      // origin must treat both forms as the same MCP endpoint.
      const mcpPath = url.pathname.endsWith("/") && url.pathname.length > 1
        ? url.pathname.slice(0, -1)
        : url.pathname;
      if (mcpPath !== options.path) {
        response.writeHead(404).end();
        return;
      }

      if (options.publicHost === undefined) {
        handlerFor(runtimeOptions.accountId ?? "local")(request, response);
        return;
      }

      const mcpDeviceToken = singleHeader(request.headers["x-memhub-device-token"]);
      if (mcpDeviceToken) {
        const device = await authenticateDevice(options.stateRoot, mcpDeviceToken);
        if (!device) {
          response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ error: "invalid_or_revoked_device" }));
          return;
        }
        handlerFor(device.account_id, {
          platform: device.name || "device",
          transport: "device-token",
          principalId: `device:${device.device_id}`,
          connectionId: device.device_id
        })(request, response);
        return;
      }

      const assertion = request.headers["cf-access-jwt-assertion"];
      if (typeof assertion !== "string" || !assertion) {
        response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "missing_cloudflare_access_jwt" }));
        return;
      }
      try {
        const identity = await verifyCloudflareAccessJwt(options.stateRoot, options.publicHost, assertion);
        const account = await resolveCloudflareAccount(options.stateRoot, identity, { allowJit: options.allowJit });
        handlerFor(account.account_id, {
          platform: "chatgpt",
          transport: "mcp",
          principalId: identity.sub ? `cloudflare:${identity.sub}` : `cloudflare-email:${identity.email}`,
          connectionId: "cloudflare-managed-oauth",
          authenticatedAccount: identity.email
        })(request, response);
      } catch (error) {
        console.error("[memhub] HTTP identity error:", error);
        if (!response.headersSent) {
          response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({
            error: "identity_rejected",
            message: error instanceof Error ? error.message : String(error)
          }));
        } else {
          response.end();
        }
      }
    })().catch((error) => {
      const bodyError = asHttpJsonBodyError(error);
      const status = bodyError?.statusCode ?? (error instanceof TypeError ? 400 : 500);
      const code = bodyError?.code ?? (error instanceof TypeError ? "invalid_request" : "request_failed");
      console.error("[memhub] HTTP request error:", error);
      if (!response.headersSent) {
        response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({
          error: code,
          message: error instanceof Error ? error.message : String(error)
        }));
      } else {
        response.end();
      }
    });
  });

  http.keepAliveTimeout = 95_000;
  http.headersTimeout = 100_000;
  http.on("connection", (socket) => socket.setKeepAlive(true, 30_000));
  await new Promise<void>((resolveReady, reject) => {
    http.once("error", reject);
    http.listen(options.port, "127.0.0.1", () => resolveReady());
  });
  const address = http.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : options.port;
  console.error(`[memhub] listening on http://127.0.0.1:${actualPort}${options.path}`);
  console.error(`[memhub] capture endpoint http://127.0.0.1:${actualPort}${options.capturePath} (device token required)`);
  if (options.publicHost) {
    console.error(`[memhub] Cloudflare Access allowlist enabled for https://${options.publicHost}${options.path}`);
  }

  const idleTimer = setInterval(() => {
    void queueIdleDistillation(options.stateRoot, runtimeFor).catch((error) => {
      console.error("[memhub] idle distillation scheduler:", error instanceof Error ? error.message : String(error));
    });
  }, 60_000);
  idleTimer.unref();
}

async function maybeQueueThresholdDistillation(input: {
  stateRoot: string;
  accountId: string;
  projectId: string | null;
  conversationId: string;
}): Promise<unknown | null> {
  const config = await getDistillationConfig(input.stateRoot);
  if (!config.auto_enabled || !input.projectId) return null;
  const jobs = await listDistillationJobs(input.stateRoot, input.accountId);
  const used = new Set(jobs.filter((job) => job.conversation_id === input.conversationId && job.project_id === input.projectId).flatMap((job) => job.evidence_refs));
  const allCaptures = (await listCaptureEvents(input.stateRoot, input.accountId, {
    conversationId: input.conversationId,
    ingested: true,
    completeOnly: true
  }))
    .filter((item) => item.user_text && item.assistant_text)
    .filter((item) => input.projectId ? !item.project_hint || item.project_hint === input.projectId : !item.project_hint);
  if (allCaptures.length < config.turn_threshold || allCaptures.length % config.turn_threshold !== 0) return null;
  const captures = allCaptures.filter((item) => !used.has(`l1:${item.event_id}`));
  if (captures.length === 0) return null;
  return enqueueDistillationJob({
    stateRoot: input.stateRoot,
    accountId: input.accountId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    captures,
    reason: "turn_threshold"
  });
}

async function queueIdleDistillation(
  stateRoot: string,
  runtimeForAccount: (accountId: string) => MemhubRuntime
): Promise<void> {
  const config = await getDistillationConfig(stateRoot);
  if (!config.auto_enabled) return;
  const cutoffIso = new Date(Date.now() - config.idle_minutes * 60_000).toISOString();
  const groups = await listIdleCaptureGroups(stateRoot, cutoffIso);
  for (const group of groups) {
    const accountId = group.account_id;
    const conversationId = group.conversation_id;
    const runtime = runtimeForAccount(accountId);
    const projectId = await runtime.projects.resolve(accountId, group.project_id);
    if (!projectId) continue;
    const jobs = await listDistillationJobs(stateRoot, accountId);
    const used = new Set(jobs.filter((job) => job.conversation_id === conversationId && job.project_id === projectId).flatMap((job) => job.evidence_refs));
    const fullConversation = await listCaptureEvents(stateRoot, accountId, {
      conversationId,
      projectId: group.project_id,
      ingested: true,
      completeOnly: true
    });
    const scoped = fullConversation.filter((item) => !used.has(`l1:${item.event_id}`));
    if (scoped.length === 0) continue;
    await enqueueDistillationJob({ stateRoot, accountId, projectId, conversationId, captures: scoped, reason: "idle" });
  }
}

async function runDeviceCommand(argv: string[]): Promise<void> {
  let stateRoot = process.env.MEMHUB_STATE_ROOT ?? defaultStateRoot();
  const args = [...argv];
  for (let i = 0; i < args.length;) {
    if (args[i] === "--state-root") {
      const value = args[i + 1];
      if (!value) throw new Error("--state-root requires a value");
      stateRoot = value;
      args.splice(i, 2);
      continue;
    }
    i += 1;
  }
  const action = args[0];
  if (action === "list") {
    const account = args[1];
    process.stdout.write(JSON.stringify(await listDevices(stateRoot, account), null, 2) + "\n");
    return;
  }
  if (action === "add") {
    const accountRef = args[1];
    const name = args[2];
    if (!accountRef || !name) throw new Error("device add requires account username/account_id and device name");
    const accounts = await listAccounts(stateRoot);
    const account = accounts.find((item) => item.username === accountRef || item.account_id === accountRef);
    if (!account) throw new Error(`account not found: ${accountRef}`);
    const created = await createDevice(stateRoot, account.account_id, name);
    process.stdout.write(JSON.stringify(created, null, 2) + "\n");
    return;
  }
  if (action === "revoke") {
    const deviceId = args[1];
    if (!deviceId) throw new Error("device revoke requires device_id");
    process.stdout.write(JSON.stringify({ revoked: await revokeDevice(stateRoot, deviceId) }, null, 2) + "\n");
    return;
  }
  throw new Error(`unknown device action: ${action ?? "<missing>"}`);
}

async function runAdminTokenCommand(argv: string[]): Promise<void> {
  let stateRoot = process.env.MEMHUB_STATE_ROOT ?? defaultStateRoot();
  const args = [...argv];
  for (let i = 0; i < args.length;) {
    if (args[i] === "--state-root") {
      const value = args[i + 1];
      if (!value) throw new Error("--state-root requires a value");
      stateRoot = value;
      args.splice(i, 2);
      continue;
    }
    i += 1;
  }
  const action = args[0] ?? "show";
  if (action !== "show" && action !== "rotate") throw new Error("admin-token supports show or rotate");
  process.stdout.write(await ensureLocalAdminToken(stateRoot, action === "rotate") + "\n");
}

async function runAccountCommand(argv: string[]): Promise<void> {
  let stateRoot = process.env.MEMHUB_STATE_ROOT ?? defaultStateRoot();
  const args = [...argv];
  for (let i = 0; i < args.length;) {
    if (args[i] === "--state-root") {
      const value = args[i + 1];
      if (!value) throw new Error("--state-root requires a value");
      stateRoot = value;
      args.splice(i, 2);
      continue;
    }
    i += 1;
  }
  const action = args[0];
  if (action === "list") {
    process.stdout.write(JSON.stringify(await listAccounts(stateRoot), null, 2) + "\n");
    return;
  }
  if (action === "add") {
    const username = args[1];
    if (!username) throw new Error("account add requires username");
    process.stdout.write(JSON.stringify(await addAccount(stateRoot, username, args[2]), null, 2) + "\n");
    return;
  }
  if (action === "bind-email") {
    if (!args[1] || !args[2]) throw new Error("account bind-email requires username and email");
    await bindCloudflareEmail(stateRoot, args[1], args[2]);
    process.stdout.write("email bound\n");
    return;
  }
  if (action === "role") {
    if (!args[1] || (args[2] !== "admin" && args[2] !== "user")) throw new Error("account role requires username/account_id/email and admin|user");
    await setAccountRole(stateRoot, args[1], args[2]);
    process.stdout.write("account role updated\n");
    return;
  }
  if (action === "delete") {
    if (!args[1]) throw new Error("account delete requires username");
    await deleteAccount(stateRoot, args[1]);
    process.stdout.write("account deleted; memory/project data preserved\n");
    return;
  }
  throw new Error(`unknown account action: ${action ?? "<missing>"}`);
}

function defaultStateRoot(): string {
  return resolve(process.env.MEMHUB_STATE_ROOT ?? join(homedir(), ".memmy", "memhub"));
}

function isJsonRequest(request: import("node:http").IncomingMessage): boolean {
  const contentType = singleHeader(request.headers["content-type"]);
  return Boolean(contentType && /^application\/json(?:\s*;|$)/i.test(contentType));
}

function webSecurityHeaders(): Record<string, string> {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy": "frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
  };
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || undefined;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function basicPassword(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Basic\s+(.+)$/i.exec(value.trim());
  if (!match?.[1]) return undefined;
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator >= 0 ? decoded.slice(separator + 1) : undefined;
  } catch {
    return undefined;
  }
}

function isLocalControlRequest(request: import("node:http").IncomingMessage): boolean {
  const remote = request.socket.remoteAddress ?? "";
  const loopbackPeer = remote === "127.0.0.1" || remote === "::1" || remote.startsWith("::ffff:127.");
  if (!loopbackPeer) return false;
  const host = (singleHeader(request.headers.host) ?? "").toLowerCase();
  const hostName = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":", 1)[0];
  if (hostName !== "localhost" && hostName !== "127.0.0.1" && hostName !== "::1") return false;
  if (singleHeader(request.headers["cf-access-jwt-assertion"]) || singleHeader(request.headers["cf-ray"]) || singleHeader(request.headers["cf-connecting-ip"])) return false;
  return true;
}

function localAdminAccount(
  accounts: Awaited<ReturnType<typeof listAccounts>>,
  preferred?: string
): Awaited<ReturnType<typeof listAccounts>>[number] {
  const admins = accounts.filter((item) => item.role === "admin");
  if (preferred) {
    const match = admins.find((item) => item.account_id === preferred || item.username === preferred || item.cloudflare_email === preferred.toLowerCase());
    if (match) return match;
    throw new Error(`configured local admin account is not an administrator: ${preferred}`);
  }
  if (admins.length === 1) return admins[0]!;
  if (admins.length === 0) throw new Error("local control plane requires at least one Memhub administrator account");
  throw new Error("multiple administrator accounts exist; set MEMHUB_LOCAL_ADMIN_ACCOUNT to select the local control-plane identity");
}

function renderConsole(input: {
  account: Awaited<ReturnType<typeof listAccounts>>[number];
  projects: ProjectDescriptor[];
  accounts: Awaited<ReturnType<typeof listAccounts>>;
  adminView: boolean;
  localControl: boolean;
  selectedAccountId: string;
}): string {
  const e = escapeHtml;
  const authBoundary = input.localControl ? "Local token + loopback Host" : "Cloudflare Access";
  const logoutLink = input.localControl ? "" : '<a class="logout" href="/cdn-cgi/access/logout" data-zh="退出" data-en="Sign out">退出</a>';
  const accountLabel = e(input.account.cloudflare_email ?? input.account.username);
  const nav = input.account.role === "admin"
    ? `<a class="view-switch${input.adminView ? "" : " active"}" href="/memhub/user" data-zh="工作区" data-en="Workspace">工作区</a><a class="view-switch${input.adminView ? " active" : ""}" href="/memhub/admin" data-zh="管理" data-en="Admin">管理</a><a href="/memhub" data-zh="主页" data-en="About">主页</a>`
    : `<a class="view-switch active" href="/memhub/user" data-zh="工作区" data-en="Workspace">工作区</a><a href="/memhub" data-zh="主页" data-en="About">主页</a>`;
  const accountSelect = input.adminView
    ? `<label class="console-select"><span data-zh="账号" data-en="Account">账号</span><select id="account-select">${input.accounts.map((account) => `<option value="${e(account.account_id)}"${account.account_id === input.selectedAccountId ? " selected" : ""}>${e(account.cloudflare_email ?? account.username)} · ${e(account.role)}</option>`).join("")}</select></label>`
    : "";
  const projectSelect = `<label class="console-select"><span data-zh="项目" data-en="Project">项目</span><select id="project-select"><option value="" data-zh="全部项目" data-en="All projects">全部项目</option>${input.projects.map((project) => `<option value="${e(project.projectId)}">${e(project.name || project.projectId)}</option>`).join("")}</select></label>`;
  const accountButton = input.adminView ? '<button data-view="accounts">♙ <span data-zh="账号" data-en="Accounts">账号</span></button>' : "";
  const title = input.adminView ? "Memhub Control Plane" : "Memhub Workspace";
  return `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title}</title><style>${consoleCss()}${themeCss()}${webUiCss()}</style></head><body class="admin-body memory-console-body"><header class="site-header"><a class="site-brand" href="/memhub"><span class="site-mark">M</span><span>Memhub</span></a><nav>${nav}<span class="account-chip">${accountLabel}</span><div class="ui-controls"><button id="theme-toggle" class="ui-toggle" type="button">亮色</button><button id="lang" class="ui-toggle" type="button">EN</button></div>${logoutLink}</nav></header><main class="admin-main"><div class="admin-shell"><aside class="console-sidebar"><div class="brand"><span>MEMHUB</span><strong>${input.adminView ? "Control Plane" : "Workspace"}</strong></div><div class="nav-group"><small data-zh="工作区" data-en="Workspace">工作区</small><button data-view="overview"><b>◫</b><span data-zh="总览" data-en="Overview">总览</span></button><button data-view="projects"><b>▦</b><span data-zh="项目" data-en="Projects">项目</span></button></div><div class="nav-group"><small data-zh="记忆层" data-en="Memory layers">记忆层</small><button data-view="l1"><b>01</b><span data-zh="L1 原始对话" data-en="L1 Conversation Log">L1 原始对话</span></button><button data-view="l2"><b>02</b><span data-zh="L2 项目时间线" data-en="L2 Project Timeline">L2 项目时间线</span></button><button data-view="l3"><b>03</b><span data-zh="L3 项目规则" data-en="L3 Project Rules">L3 项目规则</span></button><button data-view="l4"><b>04</b><span data-zh="L4 用户画像" data-en="L4 User Profile">L4 用户画像</span></button></div><div class="nav-group"><small data-zh="运行" data-en="Operations">运行</small><button data-view="skills"><b>✦</b><span data-zh="Skills" data-en="Skills">Skills</span></button><button data-view="processing"><b>⌬</b><span data-zh="处理队列" data-en="Processing">处理队列</span></button>${accountButton}</div><div class="aside-foot"><span class="boundary-dot"></span>${e(authBoundary)}<br><small data-zh="身份边界" data-en="Identity boundary">身份边界</small></div></aside><div class="console"><div class="hero"><div><div class="hero-kicker"><small data-zh="MEMORY CONTROL PLANE" data-en="MEMORY CONTROL PLANE">MEMORY CONTROL PLANE</small><span>v2</span></div><h1>${input.adminView ? '<span data-zh="长期记忆控制台" data-en="Memory control plane">长期记忆控制台</span>' : '<span data-zh="我的长期记忆" data-en="My long-term memory">我的长期记忆</span>'}</h1><p data-zh="把原始对话、项目发展、长期规则和跨项目画像放在同一条可追溯链路里。" data-en="One traceable chain from source conversations to project history, durable rules, and cross-project profile.">把原始对话、项目发展、长期规则和跨项目画像放在同一条可追溯链路里。</p></div><div class="hero-actions">${accountSelect}${projectSelect}</div></div><div id="memory-flow" class="memory-flow" aria-label="Memory lifecycle"><button type="button" data-view-target="l1"><span>01</span><div><b>L1</b><small data-zh="原始对话" data-en="Source turns">原始对话</small></div><em id="flow-count-l1">—</em></button><i>→</i><button type="button" data-view-target="l2"><span>02</span><div><b>L2</b><small data-zh="项目时间线" data-en="Project timeline">项目时间线</small></div><em id="flow-count-l2">—</em></button><i>→</i><button type="button" data-view-target="l3"><span>03</span><div><b>L3</b><small data-zh="规则与经验" data-en="Rules & experience">规则与经验</small></div><em id="flow-count-l3">—</em></button><i>→</i><button type="button" data-view-target="l4"><span>04</span><div><b>L4</b><small data-zh="用户画像" data-en="User profile">用户画像</small></div><em id="flow-count-l4">—</em></button></div><div id="data-panel" class="panel"><div class="panel-head"><div><div class="panel-eyebrow" id="view-eyebrow">OVERVIEW</div><h2 id="view-title">总览</h2><p id="view-desc" class="muted" aria-live="polite"></p></div><div class="admin-toolbar"><input id="filter" type="search" aria-label="Search current view" placeholder="搜索"><button id="primary-action" class="primary-action hidden" type="button">＋</button><button id="refresh" class="soft" type="button">↻ 刷新</button></div></div><div id="cards" class="stats"></div><div id="items" class="items" aria-live="polite"></div></div></div></div></main><div id="drawer" class="drawer hidden" role="dialog" aria-modal="true" aria-hidden="true"><button class="drawer-close" type="button" aria-label="Close detail" onclick="closeDrawer()">×</button><div id="drawer-body"></div></div><div id="toast" class="toast hidden" role="status" aria-live="polite"></div><script>${consoleScript(input.adminView)}</script></body></html>`;
}


function renderLanding(): string {
  return `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><meta name="description" content="Memhub is a private, project-aware long-term memory and context hub for AI harnesses."><title>Memhub — durable memory for AI work</title><style>${landingCss()}${themeCss()}${webUiCss()}</style></head><body class="landing-body">
  <header class="landing-header site-header"><a class="landing-brand site-brand" href="/memhub"><span class="landing-mark site-mark">M</span><b>Memhub</b></a><nav><a href="#system" data-zh="系统" data-en="System">System</a><a href="#deploy" data-zh="部署" data-en="Deploy">Deploy</a><a href="https://github.com/PhSanqi/Memhub">GitHub</a><a class="header-cta" href="/memhub/user" data-zh="打开工作区" data-en="Open workspace">Open workspace</a><div class="ui-controls"><button id="theme-toggle" class="ui-toggle">Dark</button><button id="lang-toggle" class="ui-toggle">中文</button></div></nav></header>
  <main class="landing-main">
    <section class="landing-home">
      <div class="landing-copy"><span class="landing-eyebrow" data-zh="项目感知长期记忆" data-en="PROJECT-AWARE LONG-TERM MEMORY">PROJECT-AWARE LONG-TERM MEMORY</span><h1 data-zh="让记忆始终连接到正在进行的工作。" data-en="Memory that stays connected to the work.">Memory that stays connected to the work.</h1><p data-zh="Memhub 为 Codex、Claude Code、ChatGPT 风格 MCP 客户端和其他 AI Harness 提供统一、持久的记忆边界，而不强迫所有宿主采用同一种接入方式。" data-en="Memhub gives Codex, Claude Code, ChatGPT-style MCP clients and other AI harnesses one durable memory boundary without forcing every host into the same integration path.">Memhub gives Codex, Claude Code, ChatGPT-style MCP clients and other AI harnesses one durable memory boundary without forcing every host into the same integration path.</p><div class="landing-actions"><a class="primary-link" href="/memhub/user"><span data-zh="打开工作区" data-en="Open workspace">Open workspace</span> <span>→</span></a><a class="soft-link" href="https://github.com/PhSanqi/Memhub" data-zh="查看源码" data-en="View source">View source</a></div><div class="hero-proof"><span><i></i><span data-zh="账号 + 项目隔离" data-en="Account + project isolation">Account + project isolation</span></span><span><i></i><span data-zh="私有 Memory Core" data-en="Private Memory Core">Private Memory Core</span></span><span><i></i>Linux + Windows</span></div></div>
      <div class="system-preview"><div class="preview-head"><span class="preview-dots"><i></i><i></i><i></i></span><b>memory.lifecycle</b><small data-zh="显式边界" data-en="explicit boundary">explicit boundary</small></div><div class="pipeline"><div><span>01</span><b data-zh="捕获" data-en="Capture">Capture</b><small data-zh="完整轮次通过宿主适配器或 Bridge 进入系统。" data-en="Complete turns enter through host adapters or Bridge.">Complete turns enter through host adapters or Bridge.</small></div><div><span>02</span><b data-zh="解析作用域" data-en="Resolve scope">Resolve scope</b><small data-zh="每轮只确定一个主项目；账号知识保持独立。" data-en="One primary project per turn; account knowledge remains separate.">One primary project per turn; account knowledge remains separate.</small></div><div><span>03</span><b data-zh="蒸馏" data-en="Distill">Distill</b><small data-zh="AI Harness 基于证据完成语义判断。" data-en="AI harnesses perform semantic judgment against evidence.">AI harnesses perform semantic judgment against evidence.</small></div><div><span>04</span><b data-zh="提交" data-en="Commit">Commit</b><small data-zh="L1、L2、L3、L4 与 Skill 都保留来源和验证信息。" data-en="L1, L2, L3, L4 and Skills retain provenance and validation.">L1, L2, L3, L4 and Skills retain provenance and validation.</small></div></div><div class="preview-foot"><code>project: current</code><span>storage → private</span></div></div>
    </section>
    <section class="signal-strip"><span data-zh="持久捕获" data-en="Durable capture">Durable capture</span><span data-zh="项目路由" data-en="Project routing">Project routing</span><span data-zh="可复用技能" data-en="Reusable skills">Reusable skills</span><span data-zh="L1 → L4 递进记忆" data-en="L1 → L4 memory layers">L1 → L4 memory layers</span><span data-zh="L2 / L3 / L4 蒸馏" data-en="L2 / L3 / L4 distillation">L2 / L3 / L4 distillation</span></section>
    <section id="system" class="landing-section"><div class="section-intro"><span class="landing-eyebrow" data-zh="一个记忆系统，边界显式" data-en="ONE MEMORY SYSTEM, EXPLICIT BOUNDARIES">ONE MEMORY SYSTEM, EXPLICIT BOUNDARIES</span><h2 data-zh="保留有用上下文，而不是把所有历史压成一团。" data-en="Keep context useful without flattening everything into one history.">Keep context useful without flattening everything into one history.</h2><p data-zh="Memhub 区分属于个人的内容、属于单一项目的内容，以及可以作为能力跨项目复用的内容。" data-en="Memhub separates what belongs to the person, what belongs to one project, and what can be reused as a capability.">Memhub separates what belongs to the person, what belongs to one project, and what can be reused as a capability.</p></div><div class="feature-grid"><article><span class="feature-index">01</span><h3 data-zh="L1 原始对话" data-en="L1 Original Conversation">L1 Original Conversation</h3><p data-zh="保留用户与助手的原始连续对话，以及有限、可审计的 reasoning/tool summary；它是后续所有沉淀的证据层。" data-en="Preserve continuous source user/assistant turns plus bounded auditable reasoning/tool summaries; L1 is the evidence layer for everything above it.">Preserve continuous source user/assistant turns plus bounded auditable reasoning/tool summaries; L1 is the evidence layer for everything above it.</p><small>SOURCE / EVIDENCE</small></article><article><span class="feature-index">02</span><h3 data-zh="L2 / L3 项目沉淀" data-en="L2 / L3 Project Memory">L2 / L3 Project Memory</h3><p data-zh="L2 把项目过程整理成连续时间线；L3 再从时间线中提取长期规则、偏好、工作方式与经验。" data-en="L2 turns project work into a continuous timeline; L3 distills durable rules, preferences, working habits and experience from that timeline.">L2 turns project work into a continuous timeline; L3 distills durable rules, preferences, working habits and experience from that timeline.</p><small>PROJECT / DURABLE</small></article><article><span class="feature-index">03</span><h3 data-zh="L4 用户画像" data-en="L4 User Profile">L4 User Profile</h3><p data-zh="L4 只从多个项目的 L3 交叉总结稳定的跨项目特征与工作习惯，不把单次项目事件直接升级成人格结论。" data-en="L4 summarizes stable cross-project traits and working patterns from multiple project L3 artifacts instead of promoting one-off events into personality claims.">L4 summarizes stable cross-project traits and working patterns from multiple project L3 artifacts instead of promoting one-off events into personality claims.</p><small>ACCOUNT / CROSS-PROJECT</small></article><article><span class="feature-index">04</span><h3 data-zh="Skill 能力通道" data-en="Skill Capability Channel">Skill Capability Channel</h3><p data-zh="Skill 是与 L1-L4 正交的可执行流程；可以项目内使用，也可以显式跨项目复用，但不会带入其他项目的业务记忆。" data-en="Skills are executable procedures orthogonal to L1-L4. They can be project-scoped or explicitly reused across projects without importing other project business memory.">Skills are executable procedures orthogonal to L1-L4. They can be project-scoped or explicitly reused across projects without importing other project business memory.</p><small>ORTHOGONAL / REUSABLE</small></article></div></section>
    <section class="boundary-section"><div><span class="landing-eyebrow" data-zh="设计边界" data-en="DESIGN BOUNDARY">DESIGN BOUNDARY</span><h2 data-zh="存储保持确定性，语义判断交给 AI Harness。" data-en="Storage stays deterministic. Semantic judgment stays with the AI harness.">Storage stays deterministic. Semantic judgment stays with the AI harness.</h2></div><div class="boundary-grid"><article><b>Memhub</b><p data-zh="负责捕获、作用域、存储、来源、队列、验证和提交。" data-en="Capture, scope, storage, provenance, queues, validation and commit.">Capture, scope, storage, provenance, queues, validation and commit.</p></article><span>↔</span><article><b>AI Harness</b><p data-zh="负责理解、抽象、综合以及依赖模型的演化工作。" data-en="Understanding, abstraction, synthesis and model-dependent evolution work.">Understanding, abstraction, synthesis and model-dependent evolution work.</p></article></div></section>
    <section id="deploy" class="landing-section"><div class="section-intro"><span class="landing-eyebrow" data-zh="四种发布形态" data-en="FOUR RELEASE SURFACES">FOUR RELEASE SURFACES</span><h2 data-zh="让记忆运行在它应该存在的位置。" data-en="Run it where the memory should live.">Run it where the memory should live.</h2><p data-zh="同一套实现发布为 Local/Server × Linux/Windows。Server Edition 把 Memory Core 保持在 Gateway 后的私有边界；Local Edition 不需要 VPS 或 Cloudflare。" data-en="The same implementation is packaged as local/server × Linux/Windows. Server Edition keeps Memory Core private behind the gateway; Local Edition needs no VPS or Cloudflare.">The same implementation is packaged as local/server × Linux/Windows. Server Edition keeps Memory Core private behind the gateway; Local Edition needs no VPS or Cloudflare.</p></div><div class="deploy-grid"><article><div><span class="deploy-tag">LOCAL</span><h3 data-zh="所有能力都在一台机器上" data-en="Everything on one machine">Everything on one machine</h3><p data-zh="MCP、capture、SQLite、项目注册表、检索与蒸馏都留在本地。" data-en="MCP, capture, SQLite, the project registry, retrieval and distillation all stay local.">MCP, capture, SQLite, the project registry, retrieval and distillation all stay local.</p></div><code>bash editions/local/linux/install.sh</code></article><article><div><span class="deploy-tag">SERVER</span><h3 data-zh="一个持久的事实来源" data-en="One durable source of truth">One durable source of truth</h3><p data-zh="设备通过 Bridge 连接，认证后的远程客户端共享同一个服务端记忆边界。" data-en="Devices use Bridge transport while authenticated remote clients share the same server memory boundary.">Devices use Bridge transport while authenticated remote clients share the same server memory boundary.</p></div><code>MEMHUB_USERNAME=owner bash editions/server/linux/install.sh</code></article></div></section>
    <section class="landing-cta"><span class="landing-eyebrow" data-zh="记忆应该比聊天更持久" data-en="MEMORY SHOULD OUTLIVE THE CHAT">MEMORY SHOULD OUTLIVE THE CHAT</span><h2 data-zh="打开工作区，或者直接查看实现。" data-en="Open the workspace, or inspect the implementation.">Open the workspace, or inspect the implementation.</h2><div class="landing-actions"><a class="primary-link" href="/memhub/user"><span data-zh="打开工作区" data-en="Open workspace">Open workspace</span> <span>→</span></a><a class="soft-link" href="/memhub/admin" data-zh="管理 Control Plane" data-en="Admin control plane">Admin control plane</a><a class="soft-link" href="https://github.com/PhSanqi/Memhub">GitHub</a></div></section>
  </main><footer><span>Memhub</span><span data-zh="私有长期记忆网关与项目感知上下文层。" data-en="Private long-term memory gateway and project-aware context layer.">Private long-term memory gateway and project-aware context layer.</span></footer><script>${pagePreferencesScript()}</script></body></html>`;
}

function landingCss(): string {
  return `:root{--bg:#090d12;--surface:#0f151c;--line:#24303d;--soft:#19232d;--text:#edf3f6;--muted:#8b99a6;--accent:#72d0ae}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font:14px ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:var(--bg);color:var(--text)}a{text-decoration:none;color:inherit}.landing-header{height:66px;max-width:1240px;margin:0 auto;padding:0 28px;display:flex;align-items:center;justify-content:space-between}.landing-brand{display:flex;align-items:center;gap:9px}.landing-mark{display:grid;place-items:center;width:29px;height:29px;border:1px solid #305145;border-radius:8px;background:#10231d;color:#8de1c2;font:800 13px ui-monospace,SFMono-Regular,Menlo,monospace}.landing-header nav{display:flex;align-items:center;gap:4px}.landing-header nav a{padding:8px 11px;border-radius:8px;color:#8f9da8}.landing-header nav a:hover{color:#eaf1f3;background:#111820}.landing-header .header-cta{margin-left:5px;border:1px solid #315247;background:#102019;color:#9ce4cb}.landing-main{max-width:1240px;margin:0 auto;padding:0 28px 80px}.landing-home{min-height:675px;display:grid;grid-template-columns:minmax(0,1.05fr) minmax(410px,.95fr);gap:68px;align-items:center;padding:72px 0 84px}.landing-eyebrow{font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.15em;color:#55a488}.landing-copy h1{font-size:clamp(52px,7vw,88px);line-height:.96;letter-spacing:-.065em;max-width:790px;margin:18px 0 24px}.landing-copy>p{max-width:680px;color:#99a6b1;font-size:18px;line-height:1.72}.landing-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:29px}.primary-link,.soft-link{display:inline-flex;align-items:center;gap:9px;padding:11px 15px;border-radius:8px}.primary-link{background:#dcebe5;color:#0a1612;font-weight:700}.primary-link:hover{background:#f0f7f4}.soft-link{border:1px solid var(--line);background:#0d1319;color:#a8b4bd}.soft-link:hover{border-color:#3a4a59;color:#e0e7eb}.hero-proof{display:flex;gap:16px;flex-wrap:wrap;margin-top:26px;color:#657582;font-size:11px}.hero-proof span{display:flex;align-items:center;gap:7px}.hero-proof i{width:5px;height:5px;border-radius:50%;background:#5db797}.system-preview{border:1px solid var(--line);border-radius:13px;background:#0d1319;box-shadow:0 28px 80px rgba(0,0,0,.28);overflow:hidden}.preview-head,.preview-foot{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--soft);font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:#687784}.preview-dots{display:flex;gap:5px}.preview-dots i{width:7px;height:7px;border-radius:50%;background:#29343e}.preview-head b{color:#b9c4cb}.preview-head small{margin-left:auto}.pipeline{padding:16px}.pipeline>div{display:grid;grid-template-columns:34px 118px 1fr;gap:12px;padding:17px 10px;border-bottom:1px solid var(--soft)}.pipeline>div:last-child{border:0}.pipeline span{color:#52645d;font:11px ui-monospace,SFMono-Regular,Menlo,monospace}.pipeline b{font-size:13px}.pipeline small{color:#788793;line-height:1.55}.preview-foot{border-top:1px solid var(--soft);border-bottom:0;justify-content:space-between}.preview-foot code{color:#73d2b0}.signal-strip{display:grid;grid-template-columns:repeat(5,1fr);border-top:1px solid var(--soft);border-bottom:1px solid var(--soft)}.signal-strip span{padding:15px 10px;text-align:center;color:#667683;font:10px ui-monospace,SFMono-Regular,Menlo,monospace;border-right:1px solid var(--soft)}.signal-strip span:last-child{border:0}.landing-section{padding:108px 0}.section-intro{display:grid;grid-template-columns:1.08fr 1fr;gap:58px;align-items:end;margin-bottom:44px}.section-intro .landing-eyebrow{grid-column:1/-1}.section-intro h2{font-size:clamp(34px,4.4vw,58px);line-height:1.02;letter-spacing:-.045em;margin:0}.section-intro p{margin:0;color:#8997a3;font-size:16px;line-height:1.7}.feature-grid{display:grid;grid-template-columns:repeat(2,1fr);border-top:1px solid var(--line)}.feature-grid article{min-height:255px;padding:28px 23px 24px;border-bottom:1px solid var(--line);position:relative}.feature-grid article:nth-child(odd){border-right:1px solid var(--line)}.feature-index{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:#51616d}.feature-grid h3{font-size:22px;margin:40px 0 11px}.feature-grid p{max-width:500px;color:#8c9aa6;line-height:1.7}.feature-grid small{position:absolute;bottom:22px;color:#4e5d68;font:10px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.1em}.boundary-section{display:grid;grid-template-columns:1fr 1fr;gap:68px;padding:80px 0;border-top:1px solid var(--soft);border-bottom:1px solid var(--soft)}.boundary-section h2{font-size:36px;line-height:1.08;letter-spacing:-.035em;margin:12px 0}.boundary-grid{display:grid;grid-template-columns:1fr auto 1fr;gap:16px;align-items:center}.boundary-grid article{padding:20px;border:1px solid var(--line);border-radius:9px;background:#0d1319}.boundary-grid p{color:#81909c;line-height:1.6}.deploy-grid{display:grid;grid-template-columns:1fr 1fr;gap:11px}.deploy-grid article{display:flex;min-height:292px;flex-direction:column;justify-content:space-between;border:1px solid var(--line);border-radius:11px;padding:23px;background:#0d1319}.deploy-tag{display:inline-block;padding:4px 7px;border:1px solid #2c453c;border-radius:6px;color:#70c5a6;font:10px ui-monospace,SFMono-Regular,Menlo,monospace}.deploy-grid h3{font-size:23px;margin:17px 0 10px}.deploy-grid p{color:#87949f;line-height:1.65}.deploy-grid code{padding:12px;border:1px solid var(--soft);border-radius:7px;background:#090e13;color:#83cdb2;overflow-wrap:anywhere;font-size:11px}.landing-cta{padding:108px 0 30px;text-align:center}.landing-cta h2{font-size:clamp(38px,5vw,64px);letter-spacing:-.05em;line-height:1;margin:15px auto 20px;max-width:790px}.landing-cta .landing-actions{justify-content:center}footer{max-width:1240px;margin:0 auto;padding:24px 28px 38px;border-top:1px solid var(--soft);display:flex;justify-content:space-between;gap:20px;color:#53616d;font-size:11px}@media(max-width:980px){.landing-home{grid-template-columns:1fr;gap:40px;min-height:auto}.system-preview{max-width:680px}.section-intro,.boundary-section{grid-template-columns:1fr;gap:26px}}@media(max-width:760px){.landing-header{padding:0 18px}.landing-header nav>a:not(.header-cta){display:none}.landing-main{padding-inline:18px}.landing-home{padding:50px 0 62px}.landing-copy h1{font-size:clamp(44px,14vw,66px)}.pipeline>div{grid-template-columns:28px 98px 1fr}.signal-strip{grid-template-columns:1fr 1fr}.feature-grid,.deploy-grid{grid-template-columns:1fr}.feature-grid article:nth-child(odd){border-right:0}.boundary-grid{grid-template-columns:1fr}.boundary-grid>span{transform:rotate(90deg);justify-self:center}.landing-section{padding:78px 0}footer{padding-inline:18px;flex-direction:column}}`;
}

function pagePreferencesScript(): string {
  return `
const root=document.documentElement;
let uiLang=localStorage.memhubLang||((navigator.language||'').toLowerCase().startsWith('zh')?'zh':'en');
let uiTheme=localStorage.memhubTheme||'light';
function applyUiPreferences(){
  root.lang=uiLang==='zh'?'zh-CN':'en';
  root.dataset.theme=uiTheme;
  document.querySelectorAll('[data-zh][data-en]').forEach((node)=>{node.textContent=node.dataset[uiLang]||node.textContent});
  const langButton=document.getElementById('lang-toggle');
  if(langButton){langButton.textContent=uiLang==='zh'?'EN':'中文';langButton.setAttribute('aria-label',uiLang==='zh'?'Switch to English':'切换到中文')}
  const themeButton=document.getElementById('theme-toggle');
  if(themeButton){themeButton.textContent=uiTheme==='dark'?(uiLang==='zh'?'亮色':'Light'):(uiLang==='zh'?'暗色':'Dark');themeButton.setAttribute('aria-label',themeButton.textContent+' theme')}
}
document.getElementById('lang-toggle')?.addEventListener('click',()=>{uiLang=uiLang==='zh'?'en':'zh';localStorage.memhubLang=uiLang;applyUiPreferences()});
document.getElementById('theme-toggle')?.addEventListener('click',()=>{uiTheme=uiTheme==='dark'?'light':'dark';localStorage.memhubTheme=uiTheme;applyUiPreferences()});
applyUiPreferences();
`;
}

function themeCss(): string {
  return `
html[data-theme="dark"]{color-scheme:dark}html[data-theme="light"]{color-scheme:light}
.ui-controls{display:flex;align-items:center;gap:6px}.ui-toggle{border:1px solid #24303d;background:#0f151c;color:#a9b6c0;border-radius:8px;padding:7px 10px;font:600 11px ui-sans-serif,system-ui;cursor:pointer}.ui-toggle:hover{border-color:#3a4a59;color:#eef4f6}
html[data-theme="light"]{--bg:#f5f7f6;--surface:#fff;--line:#d7e0dc;--soft:#e6ece9;--text:#17221d;--muted:#67766e;--accent:#287b60}
html[data-theme="light"] body.landing-body{background:#f5f7f6;color:#17221d}html[data-theme="light"] .landing-mark{border-color:#bfd7cd;background:#eaf5f0;color:#236b54}html[data-theme="light"] .landing-header nav a{color:#66756d}html[data-theme="light"] .landing-header nav a:hover{color:#17221d;background:#e9eeeb}html[data-theme="light"] .landing-header .header-cta{border-color:#bfd5cc;background:#e8f3ee;color:#245f4b}html[data-theme="light"] .landing-eyebrow{color:#2e7d62}html[data-theme="light"] .landing-copy>p,html[data-theme="light"] .section-intro p,html[data-theme="light"] .feature-grid p,html[data-theme="light"] .boundary-grid p,html[data-theme="light"] .deploy-grid p{color:#64736b}html[data-theme="light"] .hero-proof,html[data-theme="light"] .signal-strip span,html[data-theme="light"] footer{color:#708078}html[data-theme="light"] .system-preview,html[data-theme="light"] .boundary-grid article,html[data-theme="light"] .deploy-grid article,html[data-theme="light"] .soft-link{background:#fff;border-color:#d7e0dc;box-shadow:0 24px 64px rgba(34,58,47,.08)}html[data-theme="light"] .soft-link{color:#52625a;box-shadow:none}html[data-theme="light"] .soft-link:hover{border-color:#aebdb6;color:#17221d}html[data-theme="light"] .primary-link{background:#183c30;color:#f6fbf8}html[data-theme="light"] .primary-link:hover{background:#245341}html[data-theme="light"] .preview-head,html[data-theme="light"] .preview-foot,html[data-theme="light"] .pipeline>div,html[data-theme="light"] .signal-strip,html[data-theme="light"] .feature-grid,html[data-theme="light"] .feature-grid article,html[data-theme="light"] .boundary-section,html[data-theme="light"] footer{border-color:#e0e7e3}html[data-theme="light"] .preview-head b{color:#33423b}html[data-theme="light"] .pipeline small{color:#6d7c74}html[data-theme="light"] .pipeline span,html[data-theme="light"] .feature-index,html[data-theme="light"] .feature-grid small{color:#809087}html[data-theme="light"] .deploy-grid code{background:#f3f6f4;border-color:#dce5e0;color:#286b53}html[data-theme="light"] .ui-toggle{background:#fff;border-color:#d2ddd7;color:#51625a}html[data-theme="light"] .ui-toggle:hover{border-color:#aebdb6;color:#17221d}
html[data-theme="light"] body.user-body{background:#f5f7f6;color:#17221d}html[data-theme="light"] body.user-body header{background:rgba(255,255,255,.94);border-color:#dce4e0}html[data-theme="light"] body.user-body header>b{color:#17221d}html[data-theme="light"] body.user-body header a{color:#62726a}html[data-theme="light"] body.user-body .view-switch.active{background:#e7f2ed;color:#286d56}html[data-theme="light"] body.user-body .logout{border-color:#d2ddd7;background:#fff;color:#51625a}html[data-theme="light"] .user-hero,html[data-theme="light"] .user-stats,html[data-theme="light"] .user-boundary{border-color:#dce4e0}html[data-theme="light"] .user-hero>div:first-child>small,html[data-theme="light"] .user-panel-head small,html[data-theme="light"] .user-boundary small{color:#2f7b62}html[data-theme="light"] .user-hero p,html[data-theme="light"] .user-boundary p{color:#65746c}html[data-theme="light"] .user-identity,html[data-theme="light"] .user-panel{background:#fff;border-color:#d8e1dc;box-shadow:0 18px 50px rgba(34,58,47,.05)}html[data-theme="light"] .user-identity>span,html[data-theme="light"] .user-identity small,html[data-theme="light"] .user-stats span,html[data-theme="light"] .user-stats small,html[data-theme="light"] .user-panel-head>span,html[data-theme="light"] .user-list article span,html[data-theme="light"] .user-list article>small,html[data-theme="light"] .user-empty{color:#718078}html[data-theme="light"] .user-stats article,html[data-theme="light"] .user-panel-head,html[data-theme="light"] .user-list article{border-color:#e1e7e4}html[data-theme="light"] .user-stats b{color:#26362f}html[data-theme="light"] .user-stats b.role-value,html[data-theme="light"] .user-boundary a{color:#28775c}html[data-theme="light"] .user-icon{background:#f0f5f2;border-color:#d5e0da;color:#48705f}
html[data-theme="light"] body.admin-body{background:#f5f7f6;color:#17221d}html[data-theme="light"] body.admin-body header{background:rgba(255,255,255,.94);border-color:#dce4e0}html[data-theme="light"] body.admin-body header b{color:#17221d}html[data-theme="light"] body.admin-body header a{color:#62726a}html[data-theme="light"] body.admin-body .view-switch.active{background:#e7f2ed;color:#286d56}html[data-theme="light"] body.admin-body .logout,html[data-theme="light"] body.admin-body #lang,html[data-theme="light"] body.admin-body .ui-toggle{border-color:#d2ddd7;background:#fff;color:#51625a}html[data-theme="light"] body.admin-body aside{background:#eef3f0;border-color:#dce4e0}html[data-theme="light"] body.admin-body .brand{color:#17221d}html[data-theme="light"] body.admin-body .brand em,html[data-theme="light"] body.admin-body .hero small{color:#2f7b62}html[data-theme="light"] body.admin-body aside button{color:#5f7067}html[data-theme="light"] body.admin-body aside button:hover{background:#e4ece8;color:#22322b}html[data-theme="light"] body.admin-body aside button.active{background:#e2f0e9;border-color:#c9ddd3;color:#286d56}html[data-theme="light"] body.admin-body .aside-foot{border-color:#d9e2dd;color:#74837b}html[data-theme="light"] body.admin-body .hero h1,html[data-theme="light"] body.admin-body .panel-head h2{color:#17221d}html[data-theme="light"] body.admin-body .hero p,html[data-theme="light"] body.admin-body .muted{color:#68776f}html[data-theme="light"] body.admin-body .panel{background:#fff;border-color:#dce4e0;box-shadow:0 18px 50px rgba(34,58,47,.06)}html[data-theme="light"] body.admin-body .panel-head input{background:#fff;border-color:#d5dfda;color:#17221d}html[data-theme="light"] body.admin-body .stats article,html[data-theme="light"] body.admin-body .grid article{background:#f8faf9;border-color:#e0e7e3}html[data-theme="light"] body.admin-body .stats b{color:#26362f}html[data-theme="light"] body.admin-body .stats span,html[data-theme="light"] body.admin-body article small{color:#718078}html[data-theme="light"] body.admin-body .pill{background:#e4f1eb;color:#2d765c}html[data-theme="light"] body.admin-body .items,html[data-theme="light"] body.admin-body .row{border-color:#e1e7e4}html[data-theme="light"] body.admin-body .row:hover{background:#f3f7f5}html[data-theme="light"] body.admin-body .row h3{color:#26362f}html[data-theme="light"] body.admin-body .row p{color:#64736b}html[data-theme="light"] body.admin-body .row small{color:#7a8981}html[data-theme="light"] body.admin-body .soft{background:#f5f8f6;border-color:#d7e0dc;color:#52625a}html[data-theme="light"] body.admin-body .danger{background:#fff5f5;border-color:#eccfd1;color:#9c4148}html[data-theme="light"] body.admin-body .drawer{background:#fff;border-color:#dce4e0;color:#17221d;box-shadow:-24px 0 70px rgba(34,58,47,.12)}html[data-theme="light"] body.admin-body .drawer-close{background:#eef3f0;color:#52625a}html[data-theme="light"] body.admin-body .drawer pre{background:#f5f8f6;border-color:#dce4e0;color:#405149}
@media(max-width:760px){.ui-controls{gap:4px}.ui-toggle{padding:6px 8px}.landing-header .ui-controls{margin-left:4px}}
`;
}

function renderUnprovisionedAccount(email: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Memhub account required</title><style>${consoleCss()}</style></head><body><header><b>Memhub</b><nav><a href="/memhub">About</a><a class="logout" href="/cdn-cgi/access/logout">退出</a></nav></header><main><section class="landing-hero"><small>ACCOUNT NOT PROVISIONED</small><h1>这个身份还没有 Memhub 账号。</h1><p>Cloudflare Access 已完成身份认证，但 Memhub 当前关闭自动开户。管理员需要先为 <b>${escapeHtml(email)}</b> 创建或绑定账号，然后才能进入用户工作区。</p><div class="landing-actions"><a class="primary-link" href="/memhub">返回项目介绍</a><a class="soft-link" href="/cdn-cgi/access/logout">更换登录身份</a></div></section></main></body></html>`;
}

function webUiCss(): string { return `
:root{
  --mh-font:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  --mh-mono:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;
  --mh-header-h:64px;--mh-r-sm:9px;--mh-r-md:14px;--mh-r-lg:20px;--mh-ease:cubic-bezier(.2,.7,.2,1)
}
html[data-theme="light"]{
  --mh-bg:#f6f8f7;--mh-bg-subtle:#eef3f0;--mh-surface:#fff;--mh-surface-soft:#f9fbfa;
  --mh-text:#15231c;--mh-text-soft:#34483e;--mh-muted:#66766e;--mh-faint:#8a9991;
  --mh-line:#dce5e0;--mh-line-strong:#c8d6cf;--mh-accent:#1d7657;--mh-accent-strong:#125f45;--mh-accent-soft:#e9f5ef;
  --mh-danger:#a44149;--mh-danger-soft:#fff1f2;--mh-header-bg:rgba(246,248,247,.88);
  --mh-shadow:0 18px 48px rgba(33,58,47,.08),0 2px 8px rgba(33,58,47,.04);--mh-shadow-sm:0 8px 24px rgba(33,58,47,.06)
}
html[data-theme="dark"]{
  --mh-bg:#0b100e;--mh-bg-subtle:#101814;--mh-surface:#111915;--mh-surface-soft:#0e1612;
  --mh-text:#edf5f1;--mh-text-soft:#c4d2cb;--mh-muted:#91a199;--mh-faint:#66766e;
  --mh-line:#223129;--mh-line-strong:#31473c;--mh-accent:#77d4ad;--mh-accent-strong:#9de2c4;--mh-accent-soft:#14271f;
  --mh-danger:#ff9ca3;--mh-danger-soft:#241417;--mh-header-bg:rgba(11,16,14,.88);
  --mh-shadow:0 20px 56px rgba(0,0,0,.26),0 2px 8px rgba(0,0,0,.18);--mh-shadow-sm:0 10px 26px rgba(0,0,0,.2)
}
html{scroll-behavior:smooth}
body.landing-body,body.user-body,body.admin-body{font-family:var(--mh-font);background:var(--mh-bg);color:var(--mh-text);text-rendering:optimizeLegibility}
body.landing-body *,body.user-body *,body.admin-body *{box-sizing:border-box}
.site-header,body.user-body .site-header,body.admin-body .site-header{
  min-height:var(--mh-header-h);height:var(--mh-header-h);padding:0 clamp(16px,3vw,42px);
  display:flex;align-items:center;justify-content:space-between;gap:24px;position:sticky;top:0;z-index:50;
  background:var(--mh-header-bg);border-bottom:1px solid var(--mh-line);backdrop-filter:blur(18px) saturate(1.2)
}
.site-brand{display:inline-flex;align-items:center;gap:10px;color:var(--mh-text)!important;text-decoration:none;font-weight:720;letter-spacing:-.015em;white-space:nowrap}
.site-mark{width:30px;height:30px;border:1px solid var(--mh-line-strong);border-radius:9px;display:grid;place-items:center;background:var(--mh-surface);color:var(--mh-accent);font:750 11px var(--mh-mono);box-shadow:0 1px 0 rgba(255,255,255,.08)}
.site-header nav{display:flex;align-items:center;gap:6px;min-width:0}
.site-header nav>a:not(.header-cta),.site-header .view-switch,.site-header .logout,.site-header .ui-toggle,.site-header #lang{
  min-height:34px;padding:0 10px;border:1px solid transparent;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;
  color:var(--mh-muted)!important;background:transparent;text-decoration:none;font-size:12px;font-weight:620;white-space:nowrap
}
.site-header nav>a:not(.header-cta):hover,.site-header .ui-toggle:hover,.site-header #lang:hover,.site-header .logout:hover{color:var(--mh-text)!important;background:var(--mh-surface);border-color:var(--mh-line)}
.site-header .view-switch.active{color:var(--mh-accent-strong)!important;background:var(--mh-accent-soft);border-color:transparent}
.account-chip{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mh-faint);font-size:11px;margin:0 4px}
.ui-controls{display:flex;gap:5px;align-items:center}
.header-cta,.primary-link{min-height:38px;padding:0 15px!important;border-radius:10px!important;display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--mh-accent-strong)!important;color:#fff!important;border:1px solid transparent!important;text-decoration:none;font-weight:700!important}
.soft-link,.soft,.danger,.ui-toggle,#lang,.logout,.overview-card,.row,.user-list article,.feature-grid article,.deploy-grid article{transition:transform .16s var(--mh-ease),background-color .16s var(--mh-ease),border-color .16s var(--mh-ease),color .16s var(--mh-ease),box-shadow .16s var(--mh-ease),opacity .16s var(--mh-ease)}
.header-cta:hover,.primary-link:hover{transform:translateY(-1px);box-shadow:0 8px 20px color-mix(in srgb,var(--mh-accent-strong) 22%,transparent)}
.header-cta:active,.primary-link:active,.soft:active,.danger:active,.ui-toggle:active,#lang:active,.overview-card:active{transform:translateY(0) scale(.985)}
a:focus-visible,button:focus-visible,input:focus-visible,[tabindex]:focus-visible{outline:3px solid color-mix(in srgb,var(--mh-accent) 30%,transparent);outline-offset:2px}

.landing-main{max-width:1280px;margin:0 auto;padding:0 clamp(20px,4vw,56px) 80px}
.landing-home{min-height:calc(100vh - var(--mh-header-h));padding:clamp(64px,8vw,104px) 0 72px;display:grid;grid-template-columns:minmax(0,1.12fr) minmax(380px,.88fr);gap:clamp(36px,5vw,72px);align-items:center}
.landing-copy{max-width:700px}.landing-eyebrow{display:inline-flex;align-items:center;min-height:26px;padding:0 9px;border:1px solid var(--mh-line);border-radius:999px;background:var(--mh-surface);color:var(--mh-accent);font:720 10px var(--mh-mono);letter-spacing:.11em}
.landing-copy h1{max-width:820px;margin:18px 0 22px;color:var(--mh-text);font-size:clamp(50px,5.45vw,78px);line-height:.98;letter-spacing:-.055em;text-wrap:balance}
html[lang^="zh"] .landing-copy h1{font-size:clamp(46px,4.9vw,70px);line-height:1.05;letter-spacing:-.05em}
.landing-copy>p{max-width:670px;color:var(--mh-muted);font-size:16px;line-height:1.8}.landing-actions{display:flex;gap:10px;align-items:center;margin-top:28px}
.soft-link{min-height:38px;padding:0 14px;border:1px solid var(--mh-line);border-radius:10px;display:inline-flex;align-items:center;color:var(--mh-text-soft);background:var(--mh-surface);text-decoration:none;font-weight:650}
.soft-link:hover{border-color:var(--mh-line-strong);background:var(--mh-surface-soft);transform:translateY(-1px)}
.hero-proof{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:24px;color:var(--mh-faint);font-size:11px}.hero-proof>span{display:flex;align-items:center;gap:7px}.hero-proof i{width:6px;height:6px;border-radius:50%;background:var(--mh-accent);box-shadow:0 0 0 4px var(--mh-accent-soft)}
.system-preview{border:1px solid var(--mh-line);border-radius:var(--mh-r-lg);background:var(--mh-surface);box-shadow:var(--mh-shadow);overflow:hidden}
.preview-head,.preview-foot{background:var(--mh-surface-soft);border-color:var(--mh-line)!important}.preview-head b,.preview-foot code{font-family:var(--mh-mono);color:var(--mh-text-soft)}.preview-head small,.preview-foot span{color:var(--mh-faint)}
.pipeline>div{border-color:var(--mh-line)!important;padding:19px 20px}.pipeline>div>span{color:var(--mh-faint);font:650 10px var(--mh-mono)}.pipeline>div>b{color:var(--mh-text);font-size:14px}.pipeline>div>small{color:var(--mh-muted);line-height:1.55}
.signal-strip{margin:0 0 96px;padding:18px 0;display:flex;flex-wrap:wrap;gap:8px;border-top:1px solid var(--mh-line);border-bottom:1px solid var(--mh-line)}.signal-strip span{padding:7px 10px;border:1px solid var(--mh-line);border-radius:999px;background:var(--mh-surface);color:var(--mh-muted);font:650 10px var(--mh-mono)}
.landing-section{padding:86px 0}.section-intro{max-width:780px;margin-bottom:34px}.section-intro h2,.boundary-section h2{color:var(--mh-text);font-size:clamp(34px,4vw,52px);line-height:1.04;letter-spacing:-.045em;text-wrap:balance}.section-intro p,.boundary-section p{color:var(--mh-muted);line-height:1.75}
.feature-grid,.deploy-grid{gap:12px}.feature-grid article,.deploy-grid article{border:1px solid var(--mh-line);border-radius:var(--mh-r-md);background:var(--mh-surface);box-shadow:none}.feature-grid article:hover,.deploy-grid article:hover{border-color:var(--mh-line-strong);transform:translateY(-2px);box-shadow:var(--mh-shadow-sm)}.feature-grid h3,.deploy-grid h3{color:var(--mh-text)}.feature-grid p,.deploy-grid p{color:var(--mh-muted)}.feature-index,.deploy-tag{color:var(--mh-accent);font-family:var(--mh-mono)}
.boundary-section{margin:20px 0 56px;padding:40px;border:1px solid var(--mh-line);border-radius:var(--mh-r-lg);background:var(--mh-surface)}.boundary-grid article{border:1px solid var(--mh-line);border-radius:var(--mh-r-md);background:var(--mh-surface-soft)}.boundary-grid>span{color:var(--mh-accent)}
.landing-cta{border:1px solid var(--mh-line)!important;border-radius:var(--mh-r-lg)!important;background:linear-gradient(135deg,var(--mh-surface),var(--mh-accent-soft))!important;color:var(--mh-text)!important}

.user-main{max-width:1280px;margin:0 auto;padding:46px clamp(20px,4vw,56px) 84px}.user-hero{grid-template-columns:minmax(0,1.3fr) minmax(280px,.7fr);gap:48px;padding:34px 0 42px;border-color:var(--mh-line)}
.user-hero>div:first-child>small,.user-panel-head small,.user-boundary small{color:var(--mh-accent);font:720 10px var(--mh-mono);letter-spacing:.12em}
.user-hero h1{margin:12px 0 18px;color:var(--mh-text);font-size:clamp(44px,5.3vw,68px);line-height:1;letter-spacing:-.052em}.user-hero p{color:var(--mh-muted);font-size:15px;line-height:1.75}
.user-identity{padding:20px;border:1px solid var(--mh-line);border-radius:var(--mh-r-md);background:var(--mh-surface);box-shadow:var(--mh-shadow-sm)}.user-identity>span,.user-identity small{color:var(--mh-faint)}.user-identity b{color:var(--mh-text)}
.user-stats{gap:10px;margin:18px 0 0;border:0}.user-stats article{min-height:132px;padding:20px;border:1px solid var(--mh-line)!important;border-radius:var(--mh-r-md);background:var(--mh-surface)}.user-stats span,.user-stats small{color:var(--mh-faint)}.user-stats b{color:var(--mh-text)}.user-stats b.role-value{color:var(--mh-accent-strong)}
.user-grid{gap:14px;padding:34px 0 14px}.user-panel{border-color:var(--mh-line);border-radius:var(--mh-r-md);background:var(--mh-surface);box-shadow:var(--mh-shadow-sm)}.user-panel-head{padding:20px;border-color:var(--mh-line)}.user-panel-head h2{color:var(--mh-text)}.user-panel-head>span{color:var(--mh-faint)}
.user-list article{padding:16px 18px;border-color:var(--mh-line)}.user-list article:hover{background:var(--mh-surface-soft)}.user-list article b{color:var(--mh-text)}.user-list article span,.user-list article>small{color:var(--mh-muted)}.user-icon{border-color:var(--mh-line-strong);background:var(--mh-accent-soft);color:var(--mh-accent-strong)}.user-list .state-live{color:var(--mh-accent-strong)}.user-list .state-revoked{color:var(--mh-danger)}
.user-boundary{margin-top:24px;padding:30px 32px;border:1px solid var(--mh-line);border-radius:var(--mh-r-md);background:var(--mh-surface-soft)}.user-boundary h2{color:var(--mh-text)}.user-boundary p{color:var(--mh-muted)}.user-boundary a{color:var(--mh-accent-strong)}

body.admin-body .admin-shell{grid-template-columns:238px minmax(0,1fr);min-height:calc(100vh - var(--mh-header-h))}
body.admin-body aside{top:var(--mh-header-h);height:calc(100vh - var(--mh-header-h));padding:18px 12px;background:var(--mh-surface);border-color:var(--mh-line)}
body.admin-body .brand{padding:2px 10px 18px;color:var(--mh-text);font-size:15px}body.admin-body .brand em{color:var(--mh-accent);font-style:normal;font-weight:650}
body.admin-body aside button{min-height:38px;padding:0 10px;margin:2px 0;border:1px solid transparent;border-radius:9px;color:var(--mh-muted);background:transparent;font-weight:620}
body.admin-body aside button:hover{color:var(--mh-text);background:var(--mh-surface-soft);border-color:var(--mh-line)}body.admin-body aside button.active{color:var(--mh-accent-strong);background:var(--mh-accent-soft);border-color:transparent}
body.admin-body .aside-foot{border-color:var(--mh-line);color:var(--mh-faint)}body.admin-body .console{max-width:1440px;padding:32px clamp(20px,3vw,48px) 64px}
body.admin-body .hero{padding:4px 0 24px;align-items:flex-start}body.admin-body .hero small{color:var(--mh-accent);font:720 10px var(--mh-mono);letter-spacing:.12em}body.admin-body .hero h1{margin:8px 0 8px;color:var(--mh-text);font-size:clamp(30px,3vw,40px);letter-spacing:-.04em}body.admin-body .hero p{max-width:760px;color:var(--mh-muted)}
body.admin-body .panel{padding:20px;border:1px solid var(--mh-line);border-radius:var(--mh-r-md);background:var(--mh-surface);box-shadow:var(--mh-shadow-sm)}
body.admin-body .panel-head h2{color:var(--mh-text)}body.admin-body .muted{color:var(--mh-muted)}body.admin-body .panel-head input{height:38px;border:1px solid var(--mh-line);border-radius:9px;background:var(--mh-surface-soft);color:var(--mh-text)}body.admin-body .panel-head input:focus{border-color:var(--mh-accent);background:var(--mh-surface)}
body.admin-body .stats{gap:9px;margin:16px 0 18px}body.admin-body .stats article,body.admin-body .grid article{padding:14px;border:1px solid var(--mh-line);border-radius:11px;background:var(--mh-surface-soft)}body.admin-body .stats b{color:var(--mh-text);font:680 24px var(--mh-mono)}body.admin-body .stats span,body.admin-body article small{color:var(--mh-faint)}body.admin-body .pill{background:var(--mh-accent-soft);color:var(--mh-accent-strong)}
body.admin-body .items{border-color:var(--mh-line)}body.admin-body .row{padding:14px 10px;border-color:var(--mh-line);background:transparent}body.admin-body .row:hover{background:var(--mh-surface-soft)}body.admin-body .row h3{color:var(--mh-text)}body.admin-body .row p{color:var(--mh-muted)}body.admin-body .row small{color:var(--mh-faint);font-family:var(--mh-mono)}
body.admin-body .soft{border:1px solid var(--mh-line);border-radius:9px;background:var(--mh-surface-soft);color:var(--mh-text-soft)}body.admin-body .soft:hover{border-color:var(--mh-line-strong);background:var(--mh-surface)}
body.admin-body .soft:disabled{opacity:.5;cursor:wait;transform:none;box-shadow:none}
body.admin-body .danger{border:1px solid color-mix(in srgb,var(--mh-danger) 26%,var(--mh-line));border-radius:9px;background:var(--mh-danger-soft);color:var(--mh-danger)}
body.admin-body .drawer{background:var(--mh-surface);border-color:var(--mh-line);color:var(--mh-text);box-shadow:-24px 0 70px rgba(0,0,0,.16)}body.admin-body .drawer-close{background:var(--mh-surface-soft);color:var(--mh-muted)}body.admin-body .drawer pre{background:var(--mh-surface-soft);border-color:var(--mh-line);color:var(--mh-text-soft)}
body.admin-body .overview-grid{grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px;border:0}body.admin-body .overview-card{min-height:88px;padding:16px;border:1px solid var(--mh-line);border-radius:12px;background:var(--mh-surface);color:var(--mh-text);box-shadow:none}
body.admin-body .overview-card:hover{border-color:var(--mh-line-strong);background:var(--mh-surface-soft);transform:translateY(-1px);box-shadow:var(--mh-shadow-sm)}body.admin-body .overview-card>span{color:var(--mh-accent);font:720 15px var(--mh-mono)}body.admin-body .overview-card small{color:var(--mh-faint);font:10px var(--mh-mono)}body.admin-body .overview-card i{color:var(--mh-faint)}
.overview-todos{grid-column:1/-1;margin-top:4px;padding:16px;border:1px solid var(--mh-line);border-radius:12px;background:var(--mh-surface-soft)}.overview-todos-head{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center;padding-bottom:10px;border-bottom:1px solid var(--mh-line)}.overview-todos-head>span{color:var(--mh-accent);font:720 9px var(--mh-mono);letter-spacing:.12em}.overview-todos-head>b{font-size:13px}.overview-todos-head>small{color:var(--mh-faint);font:700 10px var(--mh-mono)}.overview-todo-list{display:flex;flex-direction:column}.overview-todo-row{display:grid;grid-template-columns:140px minmax(0,1fr) 18px;gap:12px;align-items:center;width:100%;padding:12px 4px;border:0;border-bottom:1px solid var(--mh-line);background:transparent;color:var(--mh-text);text-align:left;cursor:pointer}.overview-todo-row:last-child{border-bottom:0}.overview-todo-row:hover{background:var(--mh-surface)}.overview-todo-row span{color:var(--mh-accent-strong);font:680 10px var(--mh-mono)}.overview-todo-row b{color:var(--mh-text-soft);font-size:12px;line-height:1.5}.overview-todo-row i{color:var(--mh-faint);font-style:normal}

body.admin-body .console-sidebar{padding:14px 10px 16px;background:color-mix(in srgb,var(--mh-surface) 88%,var(--mh-bg));border-right:1px solid var(--mh-line)}
body.admin-body .console-sidebar .brand{display:flex;flex-direction:column;gap:3px;padding:5px 10px 18px;margin-bottom:4px;border-bottom:1px solid var(--mh-line)}
body.admin-body .console-sidebar .brand span{color:var(--mh-faint);font:720 9px var(--mh-mono);letter-spacing:.16em}body.admin-body .console-sidebar .brand strong{color:var(--mh-text-soft);font-size:13px;letter-spacing:-.01em}
.nav-group{display:flex;flex-direction:column;padding:11px 0 2px}.nav-group>small{padding:0 10px 6px;color:var(--mh-faint);font:680 9px var(--mh-mono);letter-spacing:.1em;text-transform:uppercase}
body.admin-body .nav-group button{display:grid;grid-template-columns:27px minmax(0,1fr);gap:5px;align-items:center}body.admin-body .nav-group button>b{width:23px;color:var(--mh-faint);font:680 10px var(--mh-mono);text-align:center}body.admin-body .nav-group button.active>b{color:var(--mh-accent)}
body.admin-body .aside-foot{margin-top:auto;padding:14px 10px 4px;font-size:10px;line-height:1.55}.boundary-dot{display:inline-block;width:6px;height:6px;margin-right:7px;border-radius:50%;background:var(--mh-accent);box-shadow:0 0 0 4px var(--mh-accent-soft)}
body.admin-body .console{max-width:1500px}.hero-kicker{display:flex;align-items:center;gap:8px}.hero-kicker>span{padding:2px 6px;border:1px solid var(--mh-line);border-radius:999px;color:var(--mh-faint);font:700 9px var(--mh-mono);letter-spacing:.04em}.hero-actions{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;justify-content:flex-end}.console-select{display:flex;flex-direction:column;gap:5px;color:var(--mh-faint);font:650 9px var(--mh-mono);letter-spacing:.08em;text-transform:uppercase}.console-select select{min-width:170px;height:38px;padding:0 34px 0 10px;border:1px solid var(--mh-line);border-radius:9px;background:var(--mh-surface);color:var(--mh-text-soft);font:600 12px var(--mh-font);outline:none}.console-select select:focus{border-color:var(--mh-accent)}
.memory-flow{display:grid;grid-template-columns:minmax(0,1fr) 24px minmax(0,1fr) 24px minmax(0,1fr) 24px minmax(0,1fr);align-items:center;margin:0 0 16px;padding:8px;border:1px solid var(--mh-line);border-radius:13px;background:color-mix(in srgb,var(--mh-surface) 82%,var(--mh-bg))}.memory-flow>i{color:var(--mh-faint);font-style:normal;text-align:center}.memory-flow>button{min-width:0;min-height:64px;padding:10px 12px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--mh-text);display:grid;grid-template-columns:26px minmax(0,1fr) auto;gap:9px;align-items:center;text-align:left;cursor:pointer}.memory-flow>button:hover{background:var(--mh-surface);border-color:var(--mh-line)}.memory-flow>button.active{background:var(--mh-accent-soft);border-color:color-mix(in srgb,var(--mh-accent) 25%,var(--mh-line))}.memory-flow>button>span{color:var(--mh-faint);font:680 9px var(--mh-mono)}.memory-flow>button div{display:flex;min-width:0;flex-direction:column;gap:3px}.memory-flow>button b{font-size:12px}.memory-flow>button small{overflow:hidden;color:var(--mh-muted);font-size:10px;text-overflow:ellipsis;white-space:nowrap}.memory-flow>button em{color:var(--mh-accent);font:720 13px var(--mh-mono);font-style:normal}
.panel-eyebrow{margin-bottom:6px;color:var(--mh-accent);font:720 9px var(--mh-mono);letter-spacing:.12em}.admin-toolbar{flex-wrap:wrap;justify-content:flex-end}.primary-action{min-height:38px;padding:0 13px;border:1px solid var(--mh-accent-strong);border-radius:9px;background:var(--mh-accent-strong);color:#fff;font:680 12px var(--mh-font);cursor:pointer}.primary-action:hover{filter:brightness(1.08);transform:translateY(-1px)}
body.admin-body .panel{padding:22px}.project-grid{display:grid!important;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:10px!important;border-top:0!important}.project-card{min-height:218px;padding:17px;border:1px solid var(--mh-line);border-radius:12px;background:var(--mh-surface-soft);color:var(--mh-text);text-align:left;cursor:pointer;display:flex;flex-direction:column}.project-card:hover{border-color:var(--mh-line-strong);background:var(--mh-surface);transform:translateY(-1px);box-shadow:var(--mh-shadow-sm)}.project-card-top,.project-card-foot{display:flex;justify-content:space-between;gap:12px;align-items:center}.project-slug{overflow:hidden;color:var(--mh-faint);font:680 10px var(--mh-mono);text-overflow:ellipsis;white-space:nowrap}.state-dot{display:inline-flex;align-items:center;gap:5px;color:var(--mh-faint);font:650 9px var(--mh-mono);text-transform:uppercase}.state-dot:before{content:'';width:6px;height:6px;border-radius:50%;background:var(--mh-faint)}.state-dot.active:before{background:var(--mh-accent)}.project-card h3{margin:20px 0 8px;color:var(--mh-text);font-size:17px;letter-spacing:-.02em}.project-card p{display:-webkit-box;margin:0 0 14px;overflow:hidden;color:var(--mh-muted);font-size:12px;line-height:1.6;-webkit-box-orient:vertical;-webkit-line-clamp:3}.project-todo-preview{display:flex;flex-direction:column;gap:5px;margin:0 0 14px;padding:9px 10px;border:1px solid var(--mh-line);border-radius:8px;background:var(--mh-surface)}.project-todo-preview>span{color:var(--mh-accent);font:700 9px var(--mh-mono);text-transform:uppercase}.project-todo-preview small{overflow:hidden;color:var(--mh-muted);font-size:10px;text-overflow:ellipsis;white-space:nowrap}.project-todo-preview.empty>span{color:var(--mh-faint)}.project-card-foot{margin-top:auto;padding-top:12px;border-top:1px solid var(--mh-line);color:var(--mh-faint);font:600 9px var(--mh-mono)}.project-card-foot span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.todo-manager{display:flex;flex-direction:column;gap:10px;margin-top:18px}.todo-manager-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.todo-manager-head span{color:var(--mh-faint);font:700 9px var(--mh-mono);text-transform:uppercase}.todo-list{display:flex;flex-direction:column;border-top:1px solid var(--mh-line)}.todo-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:11px 0;border-bottom:1px solid var(--mh-line)}.todo-row div{display:flex;min-width:0;flex-direction:column;gap:4px}.todo-row b{color:var(--mh-text-soft);font-size:12px;line-height:1.45}.todo-row.done b{text-decoration:line-through;color:var(--mh-faint)}.todo-row small{color:var(--mh-faint);font:600 9px var(--mh-mono)}.todo-row button{white-space:nowrap}.todo-add{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;margin-top:12px}.todo-add input{min-width:0}.todo-history{margin-top:10px;padding-top:10px;border-top:1px solid var(--mh-line)}.todo-history summary{cursor:pointer;color:var(--mh-faint);font:700 9px var(--mh-mono);text-transform:uppercase}.todo-history[open] summary{margin-bottom:8px;color:var(--mh-text-soft)}
.turn-list,.memory-list,.job-list{border-top:1px solid var(--mh-line)}.turn-row,.memory-row,.job-row{width:100%;border:0;border-bottom:1px solid var(--mh-line);background:transparent;color:var(--mh-text);cursor:pointer;text-align:left}.turn-row:hover,.memory-row:hover,.job-row:hover{background:var(--mh-surface-soft)}.turn-row{display:grid;grid-template-columns:150px minmax(0,1fr) 130px;gap:18px;padding:16px 9px}.turn-meta{display:flex;flex-direction:column;gap:6px}.turn-meta>span,.layer-token{color:var(--mh-accent);font:720 10px var(--mh-mono)}.turn-meta>b{color:var(--mh-text-soft);font:650 10px var(--mh-mono);text-transform:uppercase}.turn-meta time,.turn-project{color:var(--mh-faint);font:600 9px var(--mh-mono)}.turn-copy{display:flex;min-width:0;flex-direction:column;gap:8px}.turn-copy p{display:-webkit-box;margin:0;overflow:hidden;color:var(--mh-muted);font-size:12px;line-height:1.55;-webkit-box-orient:vertical;-webkit-line-clamp:2}.turn-copy strong{display:inline-grid;width:22px;height:18px;margin-right:8px;place-items:center;border:1px solid var(--mh-line);border-radius:5px;color:var(--mh-text-soft);font:700 9px var(--mh-mono)}.turn-project{padding-top:2px;text-align:right}.memory-row{display:grid;grid-template-columns:56px minmax(0,1fr) 18px;gap:14px;align-items:start;padding:16px 9px}.layer-token{width:max-content;padding:4px 6px;border:1px solid color-mix(in srgb,var(--mh-accent) 24%,var(--mh-line));border-radius:6px;background:var(--mh-accent-soft)}.memory-row-head{display:flex;gap:12px;justify-content:space-between}.memory-row h3{margin:0;color:var(--mh-text);font-size:13px}.memory-row-head>span{color:var(--mh-faint);font:650 9px var(--mh-mono);text-transform:uppercase}.memory-row p{display:-webkit-box;margin:6px 0;overflow:hidden;color:var(--mh-muted);font-size:12px;line-height:1.55;-webkit-box-orient:vertical;-webkit-line-clamp:2}.memory-row small{color:var(--mh-faint);font:600 9px var(--mh-mono)}.memory-row>i{color:var(--mh-faint);font-style:normal}
.artifact-list{display:flex!important;flex-direction:column;gap:16px!important;border-top:0!important}.artifact-card{padding:20px;border:1px solid var(--mh-line);border-radius:14px;background:var(--mh-surface-soft)}.artifact-head{display:grid;grid-template-columns:minmax(120px,.28fr) minmax(0,1fr) auto;gap:18px;align-items:start;padding-bottom:16px;border-bottom:1px solid var(--mh-line)}.artifact-head>div:first-child{display:flex;flex-direction:column;align-items:flex-start;gap:8px}.artifact-head>div:first-child small{color:var(--mh-faint);font:650 10px var(--mh-mono)}.artifact-head h3{margin:1px 0 6px;color:var(--mh-text);font-size:18px;line-height:1.3;letter-spacing:-.02em}.artifact-head time{color:var(--mh-faint);font:600 9px var(--mh-mono)}.artifact-open{align-self:center}.timeline{position:relative;padding:4px 0 0}.timeline:before{content:'';position:absolute;top:18px;bottom:18px;left:91px;width:1px;background:var(--mh-line)}.timeline-event{position:relative;display:grid;grid-template-columns:74px minmax(0,1fr);gap:34px;padding:18px 0}.timeline-event:before{content:'';position:absolute;top:24px;left:86px;width:11px;height:11px;border:2px solid var(--mh-surface-soft);border-radius:50%;background:var(--mh-accent);box-shadow:0 0 0 1px var(--mh-line)}.timeline-date{padding-top:2px;color:var(--mh-accent-strong);font:720 10px var(--mh-mono);text-align:right}.timeline-copy h4{margin:0 0 8px;color:var(--mh-text);font-size:15px;line-height:1.45}.timeline-copy p,.artifact-prose p{margin:0 0 9px;color:var(--mh-muted);font-size:12px;line-height:1.72}.timeline-copy p:last-child,.artifact-prose p:last-child{margin-bottom:0}.artifact-points{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:10px;margin:16px 0 0;padding:0;list-style:none}.artifact-points li{position:relative;padding:13px 14px 13px 30px;border:1px solid var(--mh-line);border-radius:10px;background:var(--mh-surface);color:var(--mh-muted);font-size:12px;line-height:1.65}.artifact-points li:before{content:'•';position:absolute;left:14px;top:12px;color:var(--mh-accent);font-weight:800}.artifact-prose{padding-top:16px}.artifact-empty{margin:16px 0 0;color:var(--mh-faint);font-size:12px}.drawer-artifact{margin-top:16px}.drawer-artifact .artifact-points{grid-template-columns:1fr}.drawer-artifact .timeline:before{left:82px}.drawer-artifact .timeline-event{grid-template-columns:66px minmax(0,1fr);gap:30px}.drawer-artifact .timeline-event:before{left:77px}
.processing-view{gap:14px!important;border:0!important}.policy-card{display:grid;grid-template-columns:minmax(220px,.8fr) minmax(420px,1.2fr);gap:28px;padding:18px;border:1px solid var(--mh-line);border-radius:12px;background:var(--mh-surface-soft)}.policy-card>div:first-child>span{color:var(--mh-accent);font:720 9px var(--mh-mono);letter-spacing:.12em}.policy-card h3{margin:7px 0 6px;font-size:16px}.policy-card p{margin:0;color:var(--mh-muted);font-size:12px;line-height:1.55}.policy-controls{display:grid;grid-template-columns:100px minmax(120px,1fr) minmax(120px,1fr) auto;gap:8px;align-items:end}.policy-controls label{display:flex;flex-direction:column;gap:5px;color:var(--mh-faint);font:650 9px var(--mh-mono);text-transform:uppercase}.policy-controls input[type=number],.project-form input,.project-form textarea,.project-form select{width:100%;min-height:38px;padding:8px 10px;border:1px solid var(--mh-line);border-radius:8px;background:var(--mh-surface);color:var(--mh-text);font:600 12px var(--mh-font);outline:none}.policy-controls input:focus,.project-form input:focus,.project-form textarea:focus,.project-form select:focus{border-color:var(--mh-accent)}.toggle-field{height:38px;padding:0 10px;border:1px solid var(--mh-line);border-radius:8px;background:var(--mh-surface);flex-direction:row!important;align-items:center;gap:8px!important}.toggle-field input{accent-color:var(--mh-accent)}.policy-save{height:38px}.job-list{margin-top:2px}.job-row{display:grid;grid-template-columns:80px minmax(0,1fr) 130px;gap:14px;align-items:center;padding:14px 9px}.job-state{width:max-content;padding:4px 7px;border:1px solid var(--mh-line);border-radius:999px;color:var(--mh-faint);font:680 9px var(--mh-mono);text-transform:uppercase}.job-state.pending,.job-state.leased{border-color:color-mix(in srgb,var(--mh-accent) 35%,var(--mh-line));background:var(--mh-accent-soft);color:var(--mh-accent-strong)}.job-state.failed{border-color:color-mix(in srgb,var(--mh-danger) 35%,var(--mh-line));background:var(--mh-danger-soft);color:var(--mh-danger)}.job-row div{display:flex;min-width:0;flex-direction:column;gap:4px}.job-row b{font-size:12px}.job-row small,.job-row time{color:var(--mh-faint);font:600 9px var(--mh-mono)}.job-row time{text-align:right}
.empty-state{min-height:260px;padding:56px 24px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}.empty-state>span{color:var(--mh-accent);font:720 9px var(--mh-mono);letter-spacing:.12em}.empty-state h3{margin:8px 0 7px;font-size:18px}.empty-state p{max-width:500px;margin:0 0 18px;color:var(--mh-muted);font-size:12px;line-height:1.65}.loading-state{min-height:220px;display:flex;align-items:center;justify-content:center;gap:6px}.loading-state span{width:7px;height:7px;border-radius:50%;background:var(--mh-faint);animation:mh-pulse 1.1s infinite ease-in-out}.loading-state span:nth-child(2){animation-delay:.14s}.loading-state span:nth-child(3){animation-delay:.28s}@keyframes mh-pulse{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-5px)}}
.drawer-kicker{margin:2px 0 8px;color:var(--mh-accent);font:720 9px var(--mh-mono);letter-spacing:.12em}.drawer h2{margin:0 46px 12px 0;font-size:25px;letter-spacing:-.03em}.drawer-summary{color:var(--mh-muted);font-size:13px;line-height:1.7;white-space:pre-wrap}.drawer details{margin-top:24px}.drawer summary{cursor:pointer;color:var(--mh-faint);font:650 10px var(--mh-mono);text-transform:uppercase}.project-form{display:flex;flex-direction:column;gap:14px;margin-top:24px}.project-form label{display:flex;flex-direction:column;gap:6px}.project-form label>span{color:var(--mh-faint);font:650 9px var(--mh-mono);letter-spacing:.07em;text-transform:uppercase}.project-form textarea{resize:vertical;line-height:1.55}.form-note{padding:10px 12px;border:1px solid var(--mh-line);border-radius:8px;background:var(--mh-surface-soft);color:var(--mh-muted);font-size:11px;line-height:1.55}.toast{position:fixed;right:24px;bottom:24px;z-index:100;max-width:360px;padding:11px 14px;border:1px solid var(--mh-line-strong);border-radius:10px;background:var(--mh-text);color:var(--mh-bg);box-shadow:var(--mh-shadow);font:650 12px var(--mh-font)}

@media(max-width:960px){.landing-home{grid-template-columns:1fr;min-height:auto;padding-top:70px}.system-preview{max-width:760px}.landing-copy h1{max-width:850px}.user-hero{grid-template-columns:1fr;gap:22px}.user-identity{max-width:560px}}
@media(max-width:760px){
  :root{--mh-header-h:58px}.site-header,body.user-body .site-header,body.admin-body .site-header{padding:0 14px;gap:10px}.site-header nav{gap:3px}.account-chip{display:none}
  .landing-header nav>a:not(.header-cta){display:none}.landing-header .header-cta{padding:0 10px!important}.landing-header .ui-toggle{padding:0 8px}
  .landing-main{padding:0 18px 60px}.landing-home{padding:52px 0 48px}.landing-copy h1,html[lang^="zh"] .landing-copy h1{font-size:clamp(44px,13vw,62px)}.landing-copy>p{font-size:15px}.signal-strip{margin-bottom:62px}.landing-section{padding:62px 0}.boundary-section{padding:24px}.boundary-grid{grid-template-columns:1fr}.boundary-grid>span{transform:rotate(90deg);justify-self:center}
  .user-main{padding:28px 16px 56px}.user-hero{padding:20px 0 28px}.user-hero h1{font-size:46px}.user-stats{grid-template-columns:1fr}.user-grid{grid-template-columns:1fr}.user-boundary{grid-template-columns:1fr;padding:24px}
  body.admin-body .admin-shell{grid-template-columns:1fr}body.admin-body aside{top:var(--mh-header-h);height:auto;padding:7px;overflow-x:auto}body.admin-body aside button{min-width:max-content}body.admin-body .console{padding:18px 14px 48px}body.admin-body .hero{gap:16px}.admin-toolbar{width:100%}.admin-toolbar #filter{min-width:0;flex:1}
}
@media(max-width:760px){
  body.admin-body .console-sidebar{display:flex;gap:4px;padding:7px;border-right:0;border-bottom:1px solid var(--mh-line)}body.admin-body .console-sidebar .brand,body.admin-body .console-sidebar .aside-foot{display:none}.nav-group{display:flex;flex-direction:row;padding:0}.nav-group>small{display:none}body.admin-body .nav-group button{display:flex;gap:5px;width:auto;padding:0 10px}body.admin-body .nav-group button>b{width:auto}.artifact-head{grid-template-columns:1fr auto}.artifact-head>div:first-child{grid-column:1/-1;flex-direction:row;align-items:center}.artifact-points{grid-template-columns:1fr}.timeline:before{left:7px}.timeline-event{grid-template-columns:1fr;gap:7px;padding:15px 0 15px 24px}.timeline-event:before{left:2px;top:19px}.timeline-date{text-align:left}.drawer-artifact .timeline:before{left:7px}.drawer-artifact .timeline-event{grid-template-columns:1fr;gap:7px}.drawer-artifact .timeline-event:before{left:2px}
  body.admin-body .hero{flex-direction:column}.hero-actions{width:100%;justify-content:flex-start}.console-select{flex:1}.console-select select{width:100%;min-width:0}.memory-flow{display:flex;overflow-x:auto;gap:6px;padding:6px;scroll-snap-type:x proximity}.memory-flow>i{display:none}.memory-flow>button{min-width:172px;flex:0 0 auto;scroll-snap-align:start}.project-grid{grid-template-columns:1fr!important}.turn-row{grid-template-columns:1fr;gap:10px}.turn-meta{display:grid;grid-template-columns:auto auto 1fr;align-items:center}.turn-meta time{text-align:right}.turn-project{text-align:left}.memory-row{grid-template-columns:52px minmax(0,1fr)}.memory-row>i{display:none}.policy-card{grid-template-columns:1fr;gap:16px}.policy-controls{grid-template-columns:1fr 1fr}.toggle-field,.policy-save{grid-column:span 2}.job-row{grid-template-columns:72px minmax(0,1fr)}.job-row time{grid-column:2;text-align:left}.toast{left:14px;right:14px;bottom:14px}.drawer{top:var(--mh-header-h);height:calc(100vh - var(--mh-header-h));width:100vw}.panel-head{align-items:flex-start;flex-direction:column}.admin-toolbar{justify-content:flex-start}.primary-action{white-space:nowrap}
}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}body.landing-body *,body.user-body *,body.admin-body *{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}
`; }

function consoleCss(): string { return `
*{box-sizing:border-box}body{margin:0;font:14px Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;background:#f7fbff;color:#17324d}header{height:54px;display:flex;justify-content:space-between;align-items:center;padding:0 28px;background:rgba(255,255,255,.92);border-bottom:1px solid #dbeaf5}nav{display:flex;gap:12px;align-items:center}a{color:#2877a8;text-decoration:none}.view-switch{padding:7px 10px;border-radius:9px}.view-switch.active{background:#e3f3f8;color:#156f91;font-weight:700}.logout,#lang{border:1px solid #c9dfec;background:white;border-radius:10px;padding:8px 13px;color:#35657e}.admin-main{max-width:none;margin:0;padding:0}.admin-shell{display:grid;grid-template-columns:220px 1fr;min-height:calc(100vh - 54px)}aside{padding:24px 14px;background:#eef8fc;border-right:1px solid #d6eaf3}.brand{font-size:19px;font-weight:750;padding:0 12px 24px}.brand em{font-style:normal;color:#4aa6c6}aside button{width:100%;text-align:left;border:0;background:transparent;padding:11px 12px;margin:3px 0;border-radius:10px;color:#42667a;font-weight:600}aside button:hover,aside button.active{background:#dff2f8;color:#147b9f}.aside-foot{position:sticky;top:calc(100vh - 130px);padding:18px 12px;color:#7595a5}.console{padding:30px 4vw 60px;max-width:1500px}.hero{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;padding:12px 2px 25px}.hero small,.landing-hero small{letter-spacing:.16em;color:#4a9ab8;font-weight:800}.hero h1{font-size:32px;margin:8px 0;color:#153d57}.hero p{margin:0;color:#6c8a9a}.hero-actions{display:flex;gap:9px}.panel{background:white;border:1px solid #dcebf2;box-shadow:0 8px 30px rgba(35,111,143,.06);border-radius:18px;padding:22px;margin-bottom:18px}.panel-head{display:flex;justify-content:space-between;gap:20px;align-items:center}.panel-head input{width:min(320px,40vw);border:1px solid #d3e5ee;border-radius:11px;padding:10px 13px;outline:none}.stats,.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:18px 0}.stats article,.grid article{padding:16px;border:1px solid #deedf3;background:#fbfeff;border-radius:13px;display:flex;flex-direction:column;gap:6px}.stats b{font-size:25px;color:#197b9e}.pill{align-self:flex-start;background:#e1f5f6;color:#237f88;border-radius:999px;padding:3px 8px}.items{display:flex;flex-direction:column;gap:9px}.row{cursor:pointer;border:1px solid #e2edf2;border-radius:12px;padding:14px 16px;background:#fff;display:grid;grid-template-columns:minmax(140px,1fr) minmax(220px,3fr) auto;gap:14px;align-items:start}.row:hover{border-color:#a9d7e7;background:#fbfeff}.row h3{font-size:14px;margin:0 0 5px;color:#24526c}.row p{margin:0;color:#587688;white-space:pre-wrap;overflow-wrap:anywhere;max-height:100px;overflow:hidden}.row small{color:#91a7b3}.empty{padding:48px;text-align:center;color:#8ca3af}.hidden{display:none!important}.muted{color:#7793a2}article small{overflow-wrap:anywhere}.drawer{position:fixed;z-index:20;right:0;top:54px;width:min(600px,94vw);height:calc(100vh - 54px);overflow:auto;background:#fff;border-left:1px solid #d6e8f0;box-shadow:-18px 0 50px rgba(24,86,112,.12);padding:30px}.drawer-close{float:right;border:0;background:#eef7fa;border-radius:50%;width:34px;height:34px;font-size:22px}.drawer pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f7fbfd;border:1px solid #e1edf2;border-radius:12px;padding:14px;font-size:12px}.actions{display:flex;gap:8px;margin:20px 0}.danger,.soft{border:1px solid #d8e7ed;background:#f7fbfc;border-radius:9px;padding:8px 12px}.danger{color:#a43b43;border-color:#efcdd0;background:#fff9f9}main{max-width:1180px;margin:0 auto;padding:46px 28px 70px}.landing-hero{padding:60px 0 48px;max-width:880px}.landing-hero h1{font-size:clamp(38px,7vw,72px);line-height:1.02;margin:16px 0;color:#123a54}.landing-hero p{font-size:18px;line-height:1.7;color:#557487;max-width:780px}.landing-actions{display:flex;gap:12px;margin-top:28px}.primary-link,.soft-link{display:inline-block;padding:11px 16px;border-radius:11px}.primary-link{background:#177b9d;color:white}.soft-link{background:#e8f4f8}.flow{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:18px 0 34px}.flow span{padding:9px 12px;background:#fff;border:1px solid #dbeaf1;border-radius:10px}.flow b{color:#80a5b7}@media(max-width:760px){.admin-shell{grid-template-columns:1fr}aside{display:flex;overflow:auto;padding:8px;position:sticky;top:54px;z-index:2}aside .brand,.aside-foot{display:none}aside button{min-width:max-content}.console{padding:18px}.hero{flex-direction:column}.row{grid-template-columns:1fr}.panel-head{align-items:flex-start;flex-direction:column}.panel-head input{width:100%}header{padding:0 14px}header nav span{display:none}main{padding:32px 18px}.landing-hero{padding-top:32px}}
body.admin-body{background:#090d12;color:#edf3f6}body.admin-body header{background:rgba(9,13,18,.94);border-color:#19232d;backdrop-filter:blur(14px)}body.admin-body header b{color:#edf3f6}body.admin-body header a{color:#8f9da8}body.admin-body .view-switch.active{background:#14231f;color:#91dfc3}body.admin-body .logout,body.admin-body #lang{border-color:#24303d;background:#0f151c;color:#a9b6c0}body.admin-body .admin-shell{grid-template-columns:226px minmax(0,1fr);min-height:calc(100vh - 54px)}body.admin-body aside{position:sticky;top:54px;height:calc(100vh - 54px);padding:22px 12px;background:#0b1016;border-color:#19232d;overflow:auto}body.admin-body .brand{font-size:17px;padding:0 10px 22px}body.admin-body .brand em{color:#72d0ae}body.admin-body aside button{border:1px solid transparent;padding:9px 10px;margin:2px 0;border-radius:8px;color:#8998a4}body.admin-body aside button:hover{background:#111922;color:#e1e9ed}body.admin-body aside button.active{background:#14231f;border-color:#203a32;color:#91dfc3}body.admin-body .aside-foot{position:static;margin:20px 10px 0;padding:16px 0 0;border-top:1px solid #19232d;color:#61707d;font-size:11px}body.admin-body .console{padding:34px clamp(20px,4vw,56px) 60px;max-width:1500px}body.admin-body .hero{padding:5px 0 26px}body.admin-body .hero small{color:#55a488;font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace}body.admin-body .hero h1{font-size:36px;letter-spacing:-.035em;margin:7px 0 8px;color:#edf3f6}body.admin-body .hero p{color:#8b99a6;line-height:1.6}body.admin-body .panel{background:#0f151c;border-color:#19232d;box-shadow:0 20px 60px rgba(0,0,0,.16);border-radius:13px;padding:20px;margin-bottom:18px}body.admin-body .panel-head{align-items:flex-start}body.admin-body .panel-head h2{margin:0 0 6px;color:#edf3f6}body.admin-body .panel-head input{border-color:#24303d;background:#0a1016;color:#edf3f6;border-radius:8px;padding:9px 11px}body.admin-body .muted{color:#8b99a6}body.admin-body .stats{grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px;margin:15px 0 18px}body.admin-body .stats article,body.admin-body .grid article{border-color:#19232d;background:#0c1218;border-radius:9px;padding:13px}body.admin-body .stats b{font:650 23px ui-monospace,SFMono-Regular,Menlo,monospace;color:#e9f2f4}body.admin-body .stats span,body.admin-body article small{color:#70808d}body.admin-body .pill{background:#14251f;color:#82d8b9}body.admin-body .items{gap:0;border-top:1px solid #19232d}body.admin-body .row{border:0;border-bottom:1px solid #19232d;border-radius:0;padding:13px 8px;background:transparent}body.admin-body .row:hover{background:#111820}body.admin-body .row h3{color:#d9e3e8}body.admin-body .row p{color:#8d9ca8;line-height:1.5}body.admin-body .row small{color:#53626e;font:10px ui-monospace,SFMono-Regular,Menlo,monospace}body.admin-body .empty{color:#73818d}body.admin-body .soft{border-color:#24303d;background:#111922;color:#aebac3}body.admin-body .danger{border-color:#563237;background:#1b1113;color:#ff969b}body.admin-body .drawer{background:#0e141b;border-color:#24303d;color:#edf3f6;box-shadow:-24px 0 70px rgba(0,0,0,.35)}body.admin-body .drawer-close{background:#151d25;color:#aeb8c1}body.admin-body .drawer pre{background:#090e13;border-color:#19232d;color:#a8bac4}.admin-toolbar{display:flex;gap:8px;align-items:center}.admin-toolbar #filter{min-width:min(320px,38vw)}body.admin-body .overview-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;border-top:0}body.admin-body .overview-card{appearance:none;border:1px solid #19232d;background:#0c1218;color:#edf3f6;border-radius:10px;padding:18px;text-align:left;display:grid;grid-template-columns:34px 1fr auto;gap:12px;align-items:center;cursor:pointer}body.admin-body .overview-card:hover{border-color:#2d4b40;background:#101a17}body.admin-body .overview-card>span{font:700 15px ui-monospace,SFMono-Regular,Menlo,monospace;color:#72d0ae}body.admin-body .overview-card div{display:flex;flex-direction:column;gap:5px}body.admin-body .overview-card b{font-size:14px}body.admin-body .overview-card small{color:#657582;font:10px ui-monospace,SFMono-Regular,Menlo,monospace}body.admin-body .overview-card i{font-style:normal;color:#52635c}@media(max-width:760px){body.admin-body .admin-shell{grid-template-columns:1fr}body.admin-body aside{position:sticky;top:54px;height:auto;display:flex;padding:7px;border-right:0;border-bottom:1px solid #19232d;z-index:3}body.admin-body aside .brand,body.admin-body .aside-foot{display:none}body.admin-body aside button{width:auto;min-width:max-content;margin:0}body.admin-body .console{padding:18px 14px 48px}.admin-toolbar{width:100%}.admin-toolbar #filter{min-width:0;flex:1}}
body.user-body{background:#090d12;color:#edf3f6;min-height:100vh}body.user-body header{background:rgba(9,13,18,.94);border-color:#19232d;backdrop-filter:blur(14px)}body.user-body header>b{color:#edf3f6}body.user-body header a{color:#8f9da8}body.user-body .view-switch.active{background:#14231f;color:#91dfc3}body.user-body .logout{border-color:#24303d;background:#0f151c;color:#a9b6c0}.user-main{max-width:1240px;padding:52px 28px 86px}.user-hero{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(280px,.65fr);gap:60px;align-items:end;padding:36px 0 42px;border-bottom:1px solid #19232d}.user-hero>div:first-child>small,.user-panel-head small,.user-boundary small{color:#55a488;font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em}.user-hero h1{font-size:clamp(44px,6vw,72px);line-height:.96;letter-spacing:-.055em;margin:12px 0 18px}.user-hero p{max-width:720px;margin:0;color:#8b99a6;font-size:16px;line-height:1.7}.user-identity{padding:18px;border:1px solid #24303d;border-radius:10px;background:#0d1319;display:flex;flex-direction:column;gap:7px}.user-identity>span{color:#61717d;font:10px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em}.user-identity b{font-size:14px;overflow-wrap:anywhere}.user-identity small{color:#667582;font:10px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.user-stats{display:grid;grid-template-columns:repeat(3,1fr);margin:0;border-bottom:1px solid #19232d}.user-stats article{min-height:142px;padding:24px 20px;border-right:1px solid #19232d;display:flex;flex-direction:column;gap:7px;background:transparent}.user-stats article:last-child{border-right:0}.user-stats span{color:#64747f;font:10px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.1em}.user-stats b{font:650 31px ui-monospace,SFMono-Regular,Menlo,monospace;color:#e9f2f4}.user-stats b.role-value{text-transform:uppercase;font-size:23px;color:#8edcbe}.user-stats small{color:#61717d}.user-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:42px 0 12px}.user-panel{margin:0;padding:0;border:1px solid #19232d;border-radius:12px;background:#0d1319;overflow:hidden}.user-panel-head{display:flex;justify-content:space-between;gap:20px;align-items:flex-end;padding:20px;border-bottom:1px solid #19232d}.user-panel-head h2{font-size:20px;margin:7px 0 0}.user-panel-head>span{color:#5f6f7b;font:10px ui-monospace,SFMono-Regular,Menlo,monospace}.user-list{display:flex;flex-direction:column}.user-list article{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:12px;align-items:center;padding:15px 18px;border-bottom:1px solid #19232d}.user-list article:last-child{border-bottom:0}.user-list article>div:nth-child(2){min-width:0;display:flex;flex-direction:column;gap:4px}.user-list article b{font-size:13px}.user-list article span{color:#697986;font-size:11px;overflow-wrap:anywhere}.user-list article>small{font:9px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;color:#61717d}.user-icon{width:30px;height:30px;display:grid;place-items:center;border:1px solid #2a3b47;border-radius:8px;background:#101820;color:#759489;font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace}.user-list .state-live{color:#6bc5a4}.user-list .state-revoked{color:#c2767d}.user-empty{padding:34px 20px;color:#667582;line-height:1.6}.user-boundary{display:grid;grid-template-columns:1fr 1fr;gap:50px;align-items:start;margin-top:12px;padding:38px 2px;border-top:1px solid #19232d}.user-boundary h2{font-size:29px;line-height:1.12;letter-spacing:-.03em;margin:9px 0 0}.user-boundary p{margin:0;color:#84929e;line-height:1.7}.user-boundary a{color:#8edcbe}@media(max-width:820px){.user-hero,.user-boundary{grid-template-columns:1fr;gap:24px}.user-grid{grid-template-columns:1fr}.user-stats{grid-template-columns:1fr}.user-stats article{min-height:auto;border-right:0;border-bottom:1px solid #19232d}.user-stats article:last-child{border-bottom:0}}@media(max-width:760px){body.user-body header nav span{display:none}.user-main{padding:28px 18px 60px}.user-hero{padding-top:22px}.user-hero h1{font-size:47px}.user-panel-head{align-items:flex-start;flex-direction:column;gap:9px}.user-list article{grid-template-columns:32px minmax(0,1fr)}.user-list article>small{grid-column:2}}
`; }

function consoleScript(adminView: boolean): string { return `
const ADMIN=${adminView ? "true" : "false"};
const API=ADMIN?'/memhub/admin/api':'/memhub/user/api';
const ACTION=ADMIN?'/memhub/admin/action':'/memhub/user/action';
const titles={overview:['总览','Overview'],projects:['项目','Projects'],l1:['L1 原始对话','L1 Conversation Log'],l2:['L2 项目时间线','L2 Project Timeline'],l3:['L3 项目规则与经验','L3 Project Rules & Experience'],l4:['L4 用户画像','L4 User Profile'],skills:['Skills','Skills'],processing:['处理队列','Processing'],accounts:['账号','Accounts']};
const descriptions={overview:['从原始对话到跨项目画像的完整状态。','Status across the full path from source turns to cross-project profile.'],projects:['项目是 L2/L3 的边界，也是记忆路由的主上下文。','Projects define L2/L3 boundaries and primary memory routing context.'],l1:['保留原始连续对话；Episode 只作为内部接续机制。','Source conversation evidence. Episodes remain an internal stitching mechanism.'],l2:['按项目整理的发展时间线，保留决策、状态变化与被替代历史。','Project chronology with decisions, state changes, and superseded history.'],l3:['从项目时间线提炼出的长期规则、偏好、经验与工作方式。','Durable project rules, preferences, experience, and working habits distilled from L2.'],l4:['跨多个项目 L3 总结出的稳定用户画像。','Stable cross-project profile derived from multiple project L3 artifacts.'],skills:['可复用的执行能力，与 L1-L4 记忆层正交。','Reusable executable procedures, orthogonal to the L1-L4 memory hierarchy.'],processing:['查看蒸馏队列，并在管理员视图中配置自动蒸馏策略。','Inspect distillation jobs and configure automatic distillation in Admin.'],accounts:['账号角色与当前治理边界。','Account roles and governance boundary.']};
const eyebrows={overview:'SYSTEM',projects:'ROUTING',l1:'SOURCE',l2:'PROJECT MEMORY',l3:'DURABLE RULES',l4:'CROSS-PROJECT',skills:'CAPABILITIES',processing:'PIPELINE',accounts:'ACCESS'};
let lang=localStorage.memhubLang||((navigator.language||'').toLowerCase().startsWith('zh')?'zh':'en');
let theme=localStorage.memhubTheme||'light',current='overview',payload=null,controller=null,requestSeq=0,overviewCounts={};
const filterInput=document.getElementById('filter'),projectSelect=document.getElementById('project-select'),accountSelect=document.getElementById('account-select'),primaryAction=document.getElementById('primary-action');
function esc(v){return String(v??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]))}
function fmtTime(v){if(!v)return'';const d=new Date(v);if(Number.isNaN(d.getTime()))return String(v);return new Intl.DateTimeFormat(lang==='zh'?'zh-CN':'en-US',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(d)}
function bodyOf(x){return String(x?.body||x?.content||'').replace(/^artifact:[^\\n]+\\n?/,'').trim()}
function projectOf(x){const explicit=x?.project_id||x?.projectId;if(explicit)return String(explicit);const tag=(Array.isArray(x?.tags)?x.tags:[]).find(t=>typeof t==='string'&&t.startsWith('project:'));return tag?tag.slice(8):''}
function cleanHeading(v){return String(v||'').replace(/^#+\\s*/,'').trim()}
function paragraphsOf(lines){const out=[];let buffer=[];const flush=()=>{const text=buffer.join(' ').trim();if(text)out.push(text);buffer=[]};for(const raw of lines){const line=String(raw||'').trim();if(!line){flush();continue}if(/^[-*]\\s+/.test(line)){flush();out.push(line.replace(/^[-*]\\s+/,''));continue}buffer.push(line)}flush();return out}
function timelineSections(body){const lines=String(body||'').split(/\\r?\\n/);const sections=[];let currentSection=null;for(const raw of lines){const line=raw.trim();if(/^#\\s+/.test(line))continue;if(/^##\\s+/.test(line)){if(currentSection)sections.push(currentSection);const heading=cleanHeading(line);const m=heading.match(/^(\\d{4}-\\d{2}-\\d{2})(?:[：:\\s—-]+)?(.*)$/);currentSection={date:m?.[1]||'',title:(m?.[2]||heading).trim(),lines:[]};continue}if(currentSection)currentSection.lines.push(raw)}if(currentSection)sections.push(currentSection);if(!sections.length&&body.trim())sections.push({date:'',title:'',lines:lines.filter(line=>!/^#\\s+/.test(line.trim()))});return sections.map(section=>({...section,paragraphs:paragraphsOf(section.lines)}))}
function bulletItems(body){return String(body||'').split(/\\r?\\n/).map(line=>line.trim()).filter(line=>/^[-*]\\s+/.test(line)).map(line=>line.replace(/^[-*]\\s+/,''))}
function artifactBodyHtml(x,layer){const body=bodyOf(x);if(!body)return '<p class="artifact-empty">'+(lang==='zh'?'正文暂不可用':'Artifact body unavailable')+'</p>';if(layer==='l2'){const sections=timelineSections(body);return '<div class="timeline">'+sections.map(section=>'<article class="timeline-event"><div class="timeline-date">'+esc(section.date||'—')+'</div><div class="timeline-copy">'+(section.title?'<h4>'+esc(section.title)+'</h4>':'')+section.paragraphs.map(p=>'<p>'+esc(p)+'</p>').join('')+'</div></article>').join('')+'</div>'}const bullets=bulletItems(body);if(bullets.length)return '<ul class="artifact-points">'+bullets.map(item=>'<li>'+esc(item)+'</li>').join('')+'</ul>';return '<div class="artifact-prose">'+paragraphsOf(body.split(/\\r?\\n/).filter(line=>!/^#/.test(line.trim()))).map(p=>'<p>'+esc(p)+'</p>').join('')+'</div>'}
function l2FeedHtml(items){const events=[];items.forEach((x,itemIndex)=>timelineSections(bodyOf(x)).forEach((section,sectionIndex)=>events.push({itemIndex,sectionIndex,project:projectOf(x)||(lang==='zh'?'未标记项目':'Unscoped project'),updated:x.updatedAt||x.updated_at||'',...section})));events.sort((a,b)=>{const ad=a.date||'9999-99-99',bd=b.date||'9999-99-99';return ad.localeCompare(bd)||a.project.localeCompare(b.project)||a.sectionIndex-b.sectionIndex});return events.length?'<section class="artifact-card l2 timeline-feed-card"><div class="artifact-head timeline-feed-head"><div><span class="layer-token">L2</span><small>'+(lang==='zh'?'跨项目时间流':'Cross-project chronology')+'</small></div><div><h3>'+(lang==='zh'?'按时间顺序发生了什么':'What happened, in chronological order')+'</h3><time>'+esc(events.length)+' '+(lang==='zh'?'个时间节点':'timeline events')+'</time></div></div><div class="timeline global-timeline">'+events.map(event=>'<article class="timeline-event"><div class="timeline-date">'+esc(event.date||'—')+'</div><div class="timeline-copy"><div class="timeline-context"><span>'+esc(event.project)+'</span><button type="button" class="soft" onclick="openItem('+event.itemIndex+')">'+(lang==='zh'?'项目详情':'Project details')+'</button></div>'+(event.title?'<h4>'+esc(event.title)+'</h4>':'')+event.paragraphs.map(p=>'<p>'+esc(p)+'</p>').join('')+'</div></article>').join('')+'</div></section>':emptyState()}
function tr(){document.documentElement.lang=lang==='zh'?'zh-CN':'en';document.documentElement.dataset.theme=theme;document.querySelectorAll('[data-zh][data-en]').forEach(x=>x.textContent=x.dataset[lang]||x.textContent);document.getElementById('lang').textContent=lang==='zh'?'EN':'中文';document.getElementById('theme-toggle').textContent=theme==='dark'?(lang==='zh'?'亮色':'Light'):(lang==='zh'?'暗色':'Dark');filterInput.placeholder=lang==='zh'?'搜索当前视图':'Search current view';document.getElementById('refresh').textContent=lang==='zh'?'↻ 刷新':'↻ Refresh';updateToolbar();renderCurrent()}
function query(kind){const q=new URLSearchParams({kind});if(ADMIN&&accountSelect?.value)q.set('account_id',accountSelect.value);if(projectSelect?.value)q.set('project',projectSelect.value);return API+'?'+q.toString()}
function values(data){if(!data||typeof data!=='object')return[];for(const key of ['items','tasks','memories','skills','records'])if(Array.isArray(data[key]))return data[key];return[]}
function textOf(x){if(current==='l1'){if(x.source_kind==='memory-core')return[x.title,x.summary].filter(Boolean).join('\\n');if(x.source_kind==='raw-turn')return[x.userText,x.assistantText,x.reasoningSummary].filter(Boolean).join('\\n→ ');return[x.user_text,x.assistant_text,x.reasoning_summary,x.tool_summary].filter(Boolean).join('\\n→ ')}if(current==='processing')return (x.target||'').toUpperCase()+' · '+(x.project_id||'account')+'\\n'+(x.evidence_refs||[]).length+' evidence';return x.summary||x.snippet||x.content||x.description||x.title||x.text||JSON.stringify(x)}
function itemId(x){return x.id||x.event_id||x.job_id||x.memoryId||x.skillId||x.project_id||x.account_id||''}
function statusOf(x){return x.status||x.capture_status||x.state||''}
function renderOverview(){const c=payload?.counts||{};const todos=Array.isArray(payload?.todos?.pending)?payload.todos.pending:[];const specs=[['projects','▦','项目','Projects',c.projects],['projects','✓','未完成待办','Pending todos',c.pendingTodo??todos.length],['l1','01','L1 原始对话','L1 Conversation Log',c.L1],['l2','02','L2 项目时间线','L2 Project Timeline',c.L2],['l3','03','L3 项目规则与经验','L3 Project Rules & Experience',c.L3],['l4','04','L4 用户画像','L4 User Profile',c.L4],['skills','✦','Skills','Skills',c.Skill],['processing','⌬','处理队列','Processing',(payload?.processing?.pending||0)+(payload?.processing?.leased||0)]];const box=document.getElementById('items');box.className='items overview-grid';const todoSection=todos.length?'<section class="overview-todos"><div class="overview-todos-head"><span>TODO</span><b>'+(lang==='zh'?'当前未完成事项':'Current pending work')+'</b><small>'+esc(todos.length)+'</small></div><div class="overview-todo-list">'+todos.map(todo=>'<button type="button" class="overview-todo-row" data-todo-project="'+esc(todo.project_id)+'"><span>'+esc(todo.project_name||todo.project_id)+'</span><b>'+esc(todo.text)+'</b><i>→</i></button>').join('')+'</div></section>':'';box.innerHTML=specs.map(s=>'<button type="button" class="overview-card" data-view-target="'+s[0]+'"><span>'+s[1]+'</span><div><b>'+(lang==='zh'?s[2]:s[3])+'</b><small>'+esc(s[4]??0)+' '+(lang==='zh'?'条':'items')+'</small></div><i>→</i></button>').join('')+todoSection;box.querySelectorAll('[data-view-target]').forEach(b=>b.onclick=()=>load(b.dataset.viewTarget));box.querySelectorAll('[data-todo-project]').forEach(b=>b.onclick=()=>{if(projectSelect)projectSelect.value=b.dataset.todoProject||'';load('projects')})}
function updateToolbar(){const canCreate=ADMIN&&current==='projects';primaryAction.classList.toggle('hidden',!canCreate);primaryAction.textContent=lang==='zh'?'＋ 新建项目':'＋ New project';filterInput.classList.toggle('hidden',current==='overview')}
function renderFlow(){const map={l1:'L1',l2:'L2',l3:'L3',l4:'L4'};Object.entries(map).forEach(([key,countKey])=>{const el=document.getElementById('flow-count-'+key);if(el)el.textContent=overviewCounts[countKey]??'—'});document.querySelectorAll('#memory-flow [data-view-target]').forEach(b=>b.classList.toggle('active',b.dataset.viewTarget===current))}
function renderStats(data,items){const c=data?.counts||{};if(current==='overview'){const order=['projects','L1','L2','L3','L4','Skill'];document.getElementById('cards').innerHTML=order.map(k=>'<article><b>'+esc(c[k]??0)+'</b><span>'+esc(k)+'</span></article>').join('');return}if(current==='projects'){const pending=items.reduce((n,x)=>n+Number(x.pending_todo_count||0),0);const withPending=items.filter(x=>Number(x.pending_todo_count||0)>0).length;document.getElementById('cards').innerHTML='<article><b>'+esc(data?.total??items.length)+'</b><span>'+(lang==='zh'?'项目':'Projects')+'</span></article><article><b>'+esc(pending)+'</b><span>'+(lang==='zh'?'待完成事项':'Pending todos')+'</span></article><article><b>'+esc(withPending)+'</b><span>'+(lang==='zh'?'有待办的项目':'Projects with todos')+'</span></article>';return}if(current==='l2'){const events=items.reduce((n,x)=>n+timelineSections(bodyOf(x)).length,0);const projects=new Set(items.map(projectOf).filter(Boolean)).size;document.getElementById('cards').innerHTML='<article><b>'+esc(items.length)+'</b><span>'+(lang==='zh'?'项目时间线':'Project timelines')+'</span></article><article><b>'+esc(events)+'</b><span>'+(lang==='zh'?'时间节点':'Timeline events')+'</span></article><article><b>'+esc(projects)+'</b><span>'+(lang==='zh'?'涉及项目':'Projects represented')+'</span></article>';return}if(current==='l3'){const rules=items.reduce((n,x)=>n+bulletItems(bodyOf(x)).length,0);document.getElementById('cards').innerHTML='<article><b>'+esc(items.length)+'</b><span>'+(lang==='zh'?'项目规则集':'Project profiles')+'</span></article><article><b>'+esc(rules)+'</b><span>'+(lang==='zh'?'规则 / 经验':'Rules / experience')+'</span></article><article><b>'+esc(new Set(items.map(projectOf).filter(Boolean)).size)+'</b><span>'+(lang==='zh'?'涉及项目':'Projects represented')+'</span></article>';return}if(current==='l4'){const traits=items.reduce((n,x)=>n+bulletItems(bodyOf(x)).length,0);const latest=items.map(x=>x.updatedAt||x.updated_at).filter(Boolean).sort().at(-1);document.getElementById('cards').innerHTML='<article><b>'+esc(items.length)+'</b><span>'+(lang==='zh'?'当前画像':'Current profiles')+'</span></article><article><b>'+esc(traits)+'</b><span>'+(lang==='zh'?'稳定特征':'Stable traits')+'</span></article><article><b>'+esc(latest?fmtTime(latest):'—')+'</b><span>'+(lang==='zh'?'最近更新':'Last updated')+'</span></article>';return}const total=data?.total??items.length;const active=items.filter(x=>['pending','leased','open','partial','activated','active'].includes(statusOf(x))).length;const failed=items.filter(x=>statusOf(x)==='failed'||statusOf(x)==='truncated').length;document.getElementById('cards').innerHTML='<article><b>'+esc(total)+'</b><span>'+(lang==='zh'?'总计':'Total')+'</span></article><article><b>'+active+'</b><span>'+(lang==='zh'?'活跃 / 处理中':'Active / running')+'</span></article><article><b>'+failed+'</b><span>'+(lang==='zh'?'异常':'Exceptions')+'</span></article>'}
function emptyState(){const zh={l2:['还没有新的 L2 时间线','完成 L1 蒸馏后，项目的发展过程会在这里形成可读时间线。'],l3:['还没有新的 L3 项目规则','L2 稳定后，这里会沉淀长期规则、偏好、经验与工作方式。'],l4:['还没有新的 L4 用户画像','至少多个项目形成 L3 后，才会生成跨项目稳定画像。'],skills:['还没有可复用 Skill','Skill 独立于 L1-L4，可由稳定流程和经验演化而来。'],processing:['当前没有蒸馏任务','新的 L1 证据达到阈值或空闲条件后会进入队列。']}[current]||['暂无数据','当前视图没有匹配内容。'];const en={l2:['No L2 timeline yet','Project chronology appears here after valid L1 distillation.'],l3:['No L3 project rules yet','Durable rules, preferences, experience, and working habits appear after L2 stabilizes.'],l4:['No L4 user profile yet','Cross-project traits require supported L3 evidence from multiple projects.'],skills:['No reusable Skills yet','Skills evolve independently from stable procedures and experience.'],processing:['No distillation jobs','New jobs appear when L1 evidence reaches the configured threshold or idle condition.']}[current]||['No data','There is no content matching this view.'];const copy=lang==='zh'?zh:en;return '<div class="empty-state"><span>'+esc(eyebrows[current]||'EMPTY')+'</span><h3>'+esc(copy[0])+'</h3><p>'+esc(copy[1])+'</p>'+(current!=='processing'?'<button class="soft" type="button" onclick="load(\\\'processing\\\')">'+(lang==='zh'?'查看处理队列':'Open processing')+'</button>':'')+'</div>'}
function renderProjects(items){const box=document.getElementById('items');box.className='items project-grid';window.visibleItems=items;box.innerHTML=items.length?items.map((x,i)=>{const todos=Array.isArray(x.pending_todos)?x.pending_todos:[];const preview=todos.length?'<div class="project-todo-preview"><span>'+esc(todos.length)+' '+(lang==='zh'?'项待完成':'pending')+'</span>'+todos.slice(0,2).map(t=>'<small>• '+esc(t.text)+'</small>').join('')+'</div>':'<div class="project-todo-preview empty"><span>'+(lang==='zh'?'暂无待办':'No pending todos')+'</span></div>';return '<button type="button" class="project-card" onclick="openItem('+i+')"><div class="project-card-top"><span class="project-slug">'+esc(x.project_id||x.id)+'</span><span class="state-dot '+esc(statusOf(x))+'">'+esc(statusOf(x)||'active')+'</span></div><h3>'+esc(x.title||x.name||x.project_id)+'</h3><p>'+esc(x.description||(lang==='zh'?'暂无项目描述':'No project description'))+'</p>'+preview+'<div class="project-card-foot"><span>'+(Array.isArray(x.aliases)&&x.aliases.length?esc(x.aliases.slice(0,3).join(' · ')):(lang==='zh'?'无别名':'No aliases'))+'</span><time>'+esc((x.updated_at||'').slice(0,10))+'</time></div></button>'}).join(''):emptyState()}
function renderL1(items){const box=document.getElementById('items');box.className='items turn-list';window.visibleItems=items;box.innerHTML=items.length?items.map((x,i)=>{const core=x.source_kind==='memory-core',raw=x.source_kind==='raw-turn';const copy=core?'<p><strong>M</strong>'+esc(x.title||x.summary||'—')+'</p><p><strong>↳</strong>'+esc(x.summary||'—')+'</p>':raw?'<p><strong>U</strong>'+esc(x.userText||'—')+'</p><p><strong>A</strong>'+esc(x.assistantText||'—')+'</p>':'<p><strong>U</strong>'+esc(x.user_text||'—')+'</p><p><strong>A</strong>'+esc(x.assistant_text||'—')+'</p>';const label=core?'L1 · MEMORY':raw?'L1 · RAW TURN':'L1 · TURN';const project=x.project_unresolved?('unresolved · '+(x.raw_project_id||'workspace')):(x.project_hint||x.project_id||x.projectId||'—');return '<button type="button" class="turn-row" onclick="openItem('+i+')"><div class="turn-meta"><span>'+label+'</span><b>'+esc(statusOf(x)||'complete')+'</b><time>'+esc(fmtTime(x.timestamp||x.updated_at||x.updatedAt||x.createdAt))+'</time></div><div class="turn-copy">'+copy+'</div><div class="turn-project">'+esc(project)+'</div></button>'}).join(''):emptyState()}
function renderMemoryRows(items){const box=document.getElementById('items');window.visibleItems=items;if(current==='l2'){box.className='items artifact-list timeline-feed';box.innerHTML=l2FeedHtml(items);return}if(['l3','l4'].includes(current)){box.className='items artifact-list';box.innerHTML=items.length?items.map((x,i)=>{const project=projectOf(x);const label=current==='l3'?(lang==='zh'?'项目规则与经验':'Project rules & experience'):(lang==='zh'?'跨项目用户画像':'Cross-project user profile');return '<section class="artifact-card '+esc(current)+'"><div class="artifact-head"><div><span class="layer-token">'+esc(current.toUpperCase())+'</span><small>'+esc(project||label)+'</small></div><div><h3>'+esc(cleanHeading(x.summary)||x.title||label)+'</h3><time>'+esc(fmtTime(x.updatedAt||x.updated_at||x.createdAt))+'</time></div><button type="button" class="soft artifact-open" onclick="openItem('+i+')">'+(lang==='zh'?'详情':'Details')+'</button></div>'+artifactBodyHtml(x,current)+'</section>'}).join(''):emptyState();return}box.className='items memory-list';box.innerHTML=items.length?items.map((x,i)=>'<button type="button" class="memory-row" onclick="openItem('+i+')"><span class="layer-token">'+esc(current.toUpperCase())+'</span><div><div class="memory-row-head"><h3>'+esc(x.title||x.name||itemId(x)||'(untitled)')+'</h3><span>'+esc(statusOf(x))+'</span></div><p>'+esc(textOf(x))+'</p><small>'+esc(x.project_id||x.projectId||x.updatedAt||x.updated_at||'')+'</small></div><i>→</i></button>').join(''):emptyState()}
function renderProcessing(items){const box=document.getElementById('items');box.className='items processing-view';const cfg=payload?.config||{};const config='<section class="policy-card"><div><span>POLICY</span><h3>'+(lang==='zh'?'自动蒸馏':'Automatic distillation')+'</h3><p>'+(lang==='zh'?'按完成对话数量或空闲时间触发 L1→L2 整理。':'Trigger L1→L2 work by completed-turn threshold or idle time.')+'</p></div><div class="policy-controls"><label class="toggle-field"><input id="cfg-auto" type="checkbox" '+(cfg.auto_enabled?'checked':'')+' '+(ADMIN?'':'disabled')+'><span>'+(lang==='zh'?'自动':'Auto')+'</span></label><label><span>'+(lang==='zh'?'对话阈值':'Turn threshold')+'</span><input id="cfg-threshold" type="number" min="1" max="1000" value="'+esc(cfg.turn_threshold??8)+'" '+(ADMIN?'':'disabled')+'></label><label><span>'+(lang==='zh'?'空闲分钟':'Idle minutes')+'</span><input id="cfg-idle" type="number" min="1" max="10080" value="'+esc(cfg.idle_minutes??30)+'" '+(ADMIN?'':'disabled')+'></label>'+(ADMIN?'<button class="soft policy-save" type="button" onclick="saveDistillationConfig()">'+(lang==='zh'?'保存策略':'Save policy')+'</button>':'')+'</div></section>';window.visibleItems=items;const jobs=items.length?'<div class="job-list">'+items.map((x,i)=>'<button type="button" class="job-row" onclick="openItem('+i+')"><span class="job-state '+esc(statusOf(x))+'">'+esc(statusOf(x))+'</span><div><b>'+esc((x.target||'').toUpperCase())+' · '+esc(x.project_id||'account')+'</b><small>'+esc(x.reason||'manual')+' · '+esc((x.evidence_refs||[]).length)+' evidence</small></div><time>'+esc(fmtTime(x.updated_at||x.created_at))+'</time></button>').join('')+'</div>':emptyState();box.innerHTML=config+jobs}
function renderRows(){const q=filterInput.value.toLowerCase();const all=values(payload);const items=all.filter(x=>JSON.stringify(x).toLowerCase().includes(q));if(current==='projects')return renderProjects(items);if(current==='l1')return renderL1(items);if(current==='processing')return renderProcessing(items);return renderMemoryRows(items)}
function renderCurrent(){const t=titles[current]||[current,current],d=descriptions[current]||['',''];document.getElementById('view-title').textContent=lang==='zh'?t[0]:t[1];document.getElementById('view-desc').textContent=lang==='zh'?d[0]:d[1];document.getElementById('view-eyebrow').textContent=eyebrows[current]||'MEMORY';updateToolbar();renderFlow();if(!payload)return;const items=values(payload);renderStats(payload,items);if(current==='overview')renderOverview();else renderRows()}
function syncProjectSelect(items){const selected=projectSelect.value;projectSelect.innerHTML='<option value="">'+(lang==='zh'?'全部项目':'All projects')+'</option>'+items.map(x=>'<option value="'+esc(x.project_id||x.id)+'">'+esc(x.title||x.name||x.project_id||x.id)+'</option>').join('');if([...projectSelect.options].some(o=>o.value===selected))projectSelect.value=selected}
async function load(view,silent=false){current=view;if(!silent)payload=null;document.querySelectorAll('aside button[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));if(view==='accounts'&&!ADMIN){current='overview';return load('overview',silent)}renderFlow();updateToolbar();if(controller)controller.abort();controller=new AbortController();const seq=++requestSeq;if(!silent){document.getElementById('cards').innerHTML='';document.getElementById('items').innerHTML='<div class="loading-state"><span></span><span></span><span></span></div>'}try{const r=await fetch(query(view),{signal:controller.signal,cache:'no-store'});if(!r.ok)throw Error(await r.text());const data=await r.json();if(seq!==requestSeq)return;payload=data;if(view==='overview'){overviewCounts=data.counts||{};renderFlow()}if(view==='projects')syncProjectSelect(values(data));renderCurrent()}catch(err){if(err?.name==='AbortError')return;if(!silent)document.getElementById('items').innerHTML='<div class="empty-state"><span>ERROR</span><h3>'+(lang==='zh'?'加载失败':'Could not load')+'</h3><p>'+esc(err.message||err)+'</p></div>'}}
function openDrawer(html){document.getElementById('drawer-body').innerHTML=html;const d=document.getElementById('drawer');d.classList.remove('hidden');d.setAttribute('aria-hidden','false')}
window.openItem=i=>{const x=window.visibleItems?.[i];if(!x)return;const id=itemId(x);let actions='';if(current==='projects'&&ADMIN)actions='<div class="actions"><button class="soft" data-project-action="todos">'+(lang==='zh'?'待办':'Todos')+'</button><button class="soft" data-project-action="edit">'+(lang==='zh'?'编辑':'Edit')+'</button><button class="soft" data-project-action="merge">'+(lang==='zh'?'合并':'Merge')+'</button><button class="danger" data-project-action="delete">'+(lang==='zh'?'逻辑删除':'Delete')+'</button></div>';if(['l2','l3','l4'].includes(current)&&id)actions='<div class="actions"><button class="soft" data-action="archive-memory" data-id="'+esc(id)+'">Archive</button><button class="danger" data-action="delete-memory" data-id="'+esc(id)+'">Delete</button></div>';if(current==='skills'&&id)actions='<div class="actions"><button class="soft" data-action="archive-skill" data-id="'+esc(id)+'">Archive</button></div>';if(current==='processing'&&statusOf(x)==='failed'&&id)actions='<div class="actions"><button class="soft" data-action="retry-distillation" data-id="'+esc(id)+'">Retry</button></div>';if(current==='accounts'&&ADMIN&&id)actions='<div class="actions"><button class="soft" data-role="admin" data-id="'+esc(id)+'">Admin</button><button class="soft" data-role="user" data-id="'+esc(id)+'">User</button></div>';const readable=['l2','l3','l4'].includes(current)?'<div class="drawer-artifact">'+artifactBodyHtml(x,current)+'</div>':'<p class="drawer-summary">'+esc(textOf(x))+'</p>';openDrawer('<div class="drawer-kicker">'+esc(eyebrows[current]||'DETAIL')+'</div><h2>'+esc(x.title||x.name||id)+'</h2>'+readable+actions+'<details><summary>'+(lang==='zh'?'原始数据':'Raw data')+'</summary><pre>'+esc(JSON.stringify(x,null,2))+'</pre></details>');document.querySelectorAll('#drawer-body [data-action]').forEach(button=>button.onclick=()=>memoryAction(button.dataset.action,button.dataset.id));document.querySelectorAll('#drawer-body [data-role]').forEach(button=>button.onclick=()=>accountRole(button.dataset.id,button.dataset.role));document.querySelectorAll('#drawer-body [data-project-action]').forEach(button=>button.onclick=()=>button.dataset.projectAction==='delete'?deleteProject(i):openProjectForm(button.dataset.projectAction,i))}
function openProjectTodos(x){const project=x.project_id||x.id;const todos=Array.isArray(x.todos)?[...x.todos]:[];const pending=todos.filter(t=>t.status!=='done').sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||'')));const done=todos.filter(t=>t.status==='done').sort((a,b)=>String(b.completedAt||b.updatedAt||'').localeCompare(String(a.completedAt||a.updatedAt||'')));const row=t=>'<div class="todo-row '+esc(t.status||'pending')+'"><div><b>'+esc(t.text)+'</b><small>'+esc(t.status||'pending')+' · '+esc(fmtTime(t.completedAt||t.updatedAt||t.createdAt))+'</small></div><button class="soft" type="button" data-todo-id="'+esc(t.id)+'" data-todo-status="'+(t.status==='done'?'pending':'done')+'">'+(t.status==='done'?(lang==='zh'?'重新打开':'Reopen'):(lang==='zh'?'完成':'Done'))+'</button></div>';const active=pending.length?'<div class="todo-list">'+pending.map(row).join('')+'</div>':'<div class="empty-state"><span>TODO</span><h3>'+(lang==='zh'?'暂无未完成待办':'No pending todos')+'</h3><p>'+(lang==='zh'?'当前项目没有未完成事项。':'This project has no unfinished work.')+'</p></div>';const history=done.length?'<details class="todo-history"><summary>'+(lang==='zh'?'已完成历史':'Completed history')+' · '+done.length+'</summary><div class="todo-list">'+done.map(row).join('')+'</div></details>':'';openDrawer('<div class="drawer-kicker">PROJECT TODO</div><h2>'+esc(x.title||x.name||project)+'</h2><div class="todo-manager"><div class="todo-manager-head"><span>'+(lang==='zh'?'未完成待办':'Pending todos')+'</span><b>'+esc(pending.length)+' '+(lang==='zh'?'待完成':'pending')+'</b></div><form id="project-todo-form" class="todo-add"><input id="project-todo-text" maxlength="2000" required placeholder="'+(lang==='zh'?'下一步要完成什么？':'What needs to happen next?')+'"><button class="primary-action" type="submit">'+(lang==='zh'?'添加':'Add')+'</button></form>'+active+history+'</div>');document.getElementById('project-todo-form').onsubmit=event=>submitProjectTodo(event,project);document.querySelectorAll('#drawer-body [data-todo-status]').forEach(button=>button.onclick=()=>setProjectTodoStatus(project,button.dataset.todoId,button.dataset.todoStatus))}
window.openProjectForm=(mode,index)=>{if(!ADMIN)return;const x=Number.isInteger(index)?window.visibleItems?.[index]:null;if(mode==='todos'&&x){openProjectTodos(x);return}if(mode==='merge'&&x){const source=x.project_id||x.id;const options=values(payload).filter(p=>(p.project_id||p.id)!==source).map(p=>'<option value="'+esc(p.project_id||p.id)+'">'+esc(p.title||p.name||p.project_id||p.id)+'</option>').join('');openDrawer('<div class="drawer-kicker">PROJECT ROUTING</div><h2>'+(lang==='zh'?'合并项目':'Merge project')+'</h2><p class="drawer-summary">'+esc(source)+' →</p><form id="project-form" class="project-form"><label><span>'+(lang==='zh'?'目标项目':'Target project')+'</span><select id="project-target" required>'+options+'</select></label><p class="form-note">'+(lang==='zh'?'旧项目会成为历史别名；记忆不会被物理重写。':'The source becomes a historical alias; memories are not physically rewritten.')+'</p><div class="actions"><button class="primary-action" type="submit">'+(lang==='zh'?'确认合并':'Merge')+'</button></div></form>');document.getElementById('project-form').onsubmit=event=>submitProjectMerge(event,source);return}const editing=mode==='edit'&&x;const id=editing?(x.project_id||x.id):'';openDrawer('<div class="drawer-kicker">PROJECT REGISTRY</div><h2>'+(editing?(lang==='zh'?'编辑项目':'Edit project'):(lang==='zh'?'新建项目':'New project'))+'</h2><form id="project-form" class="project-form"><label><span>Slug</span><input id="project-slug" value="'+esc(id)+'" '+(editing?'disabled':'required')+' placeholder="my-project"></label><label><span>'+(lang==='zh'?'显示名':'Display name')+'</span><input id="project-name" value="'+esc(editing?(x.title||x.name||''):'')+'" placeholder="My Project"></label><label><span>'+(lang==='zh'?'描述':'Description')+'</span><textarea id="project-description" '+(editing?'':'required')+' rows="5" placeholder="'+(lang==='zh'?'用于路由消歧和项目理解':'Used for routing and project disambiguation')+'">'+esc(editing?(x.description||''):'')+'</textarea></label><label><span>'+(lang==='zh'?'别名':'Aliases')+'</span><input id="project-aliases" value="'+esc(editing&&Array.isArray(x.aliases)?x.aliases.join(', '):'')+'" placeholder="alias-one, Alias Two"></label><div class="actions"><button class="primary-action" type="submit">'+(editing?(lang==='zh'?'保存修改':'Save changes'):(lang==='zh'?'创建项目':'Create project'))+'</button></div></form>');document.getElementById('project-form').onsubmit=event=>submitProjectForm(event,editing?'edit':'create',id)}
window.closeDrawer=()=>{const d=document.getElementById('drawer');d.classList.add('hidden');d.setAttribute('aria-hidden','true')}
async function postAction(body){const q=new URLSearchParams();if(ADMIN&&accountSelect?.value)q.set('account_id',accountSelect.value);const r=await fetch(ACTION+(q.toString()?'?'+q.toString():''),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error(await r.text());return r.json()}
function toast(message){const el=document.getElementById('toast');el.textContent=message;el.classList.remove('hidden');clearTimeout(window.__memhubToast);window.__memhubToast=setTimeout(()=>el.classList.add('hidden'),2600)}
window.memoryAction=async(action,id)=>{if((action==='delete-memory'||action==='archive-memory'||action==='archive-skill')&&!confirm(lang==='zh'?'确认执行？':'Confirm action?'))return;await postAction({action,id});toast(lang==='zh'?'已更新':'Updated');closeDrawer();await load(current)}
window.accountRole=async(id,role)=>{if(!confirm((lang==='zh'?'确认将账号角色改为 ':'Change account role to ')+role+'?'))return;await postAction({action:'set-account-role',id,role});toast(lang==='zh'?'角色已更新':'Role updated');closeDrawer();await load('accounts')}
window.submitProjectForm=async(event,mode,id)=>{event.preventDefault();const aliases=document.getElementById('project-aliases').value.split(/[,\\n]/).map(x=>x.trim()).filter(Boolean);const body={action:mode==='edit'?'update-project':'create-project',project:mode==='edit'?id:document.getElementById('project-slug').value.trim(),name:document.getElementById('project-name').value.trim(),description:document.getElementById('project-description').value.trim(),aliases};await postAction(body);toast(mode==='edit'?(lang==='zh'?'项目已更新':'Project updated'):(lang==='zh'?'项目已创建':'Project created'));closeDrawer();await load('projects')}
window.submitProjectTodo=async(event,project)=>{event.preventDefault();const text=document.getElementById('project-todo-text').value.trim();if(!text)return;await postAction({action:'add-project-todo',project,text});toast(lang==='zh'?'待办已添加':'Todo added');closeDrawer();await load('projects')}
window.setProjectTodoStatus=async(project,todoId,status)=>{await postAction({action:'set-project-todo-status',project,todo_id:todoId,status});toast(status==='done'?(lang==='zh'?'待办已完成':'Todo completed'):(lang==='zh'?'待办已重新打开':'Todo reopened'));closeDrawer();await load('projects')}
window.submitProjectMerge=async(event,source)=>{event.preventDefault();const target=document.getElementById('project-target').value;if(!target||!confirm(lang==='zh'?'确认合并？源项目将转为历史别名。':'Merge these projects? The source becomes a historical alias.'))return;await postAction({action:'merge-project',project:source,target});toast(lang==='zh'?'项目已合并':'Projects merged');closeDrawer();projectSelect.value='';await load('projects')}
window.deleteProject=async index=>{const x=window.visibleItems?.[index];if(!x)return;const project=x.project_id||x.id;if(!confirm(lang==='zh'?'逻辑删除项目 '+project+'？已有记忆会保留。':'Logically delete '+project+'? Existing memories are retained.'))return;await postAction({action:'delete-project',project});toast(lang==='zh'?'项目已删除':'Project deleted');closeDrawer();projectSelect.value='';await load('projects')}
window.saveDistillationConfig=async()=>{if(!ADMIN)return;const body={action:'set-distillation-config',auto_enabled:document.getElementById('cfg-auto').checked,turn_threshold:Number(document.getElementById('cfg-threshold').value),idle_minutes:Number(document.getElementById('cfg-idle').value)};await postAction(body);toast(lang==='zh'?'蒸馏策略已保存':'Distillation policy saved');await load('processing')}
document.querySelectorAll('aside button[data-view]').forEach(b=>b.onclick=()=>load(b.dataset.view));document.querySelectorAll('#memory-flow [data-view-target]').forEach(b=>b.onclick=()=>load(b.dataset.viewTarget));filterInput.oninput=()=>renderCurrent();primaryAction.onclick=()=>openProjectForm('create');document.getElementById('refresh').onclick=()=>load(current);projectSelect.onchange=()=>load(current);if(accountSelect)accountSelect.onchange=()=>{const url=new URL(location.href);url.searchParams.set('account_id',accountSelect.value);location.href=url.toString()};document.getElementById('lang').onclick=()=>{lang=lang==='zh'?'en':'zh';localStorage.memhubLang=lang;tr()};document.getElementById('theme-toggle').onclick=()=>{theme=theme==='dark'?'light':'dark';localStorage.memhubTheme=theme;tr()};document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')load(current,true)});window.addEventListener('focus',()=>load(current,true));clearInterval(window.__memhubAutoRefresh);window.__memhubAutoRefresh=setInterval(()=>{if(document.visibilityState==='visible')load(current,true)},5000);tr();load('overview');
`; }


function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
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

async function assertManagedMemory(runtime: MemhubRuntime, memoryId: string): Promise<void> {
  for (const kind of ["l2", "l3", "l4", "skills"] as const) {
    const payload = objectRecord(await runtime.memoryClient.viewerGet(
      `/api/v1/${kind}?limit=500&userId=${encodeURIComponent(runtime.userId)}`
    ));
    const items = Array.isArray(payload.items) ? payload.items : [];
    if (items.some((item) => objectRecord(item).id === memoryId)) return;
  }
  throw new Error(`managed memory not found for account: ${memoryId}`);
}

async function validateDistillationEvidenceChain(input: {
  stateRoot: string;
  runtime: MemhubRuntime;
  kind: "l2" | "l3" | "l4" | "skill";
  projectId: string | null;
  evidenceRefs: string[];
  job?: DistillationJob;
}): Promise<void> {
  if (input.kind === "skill") return;

  if (input.job) {
    const expectedLayer = input.kind === "l2" ? "L1" : input.kind === "l3" ? "L2" : "L3";
    if (input.job.evidence.length === 0 || input.job.evidence.some((item) => item.layer !== expectedLayer)) {
      throw new Error(`${input.kind.toUpperCase()} job evidence must come from ${expectedLayer}`);
    }
    const projectStorageIds = input.projectId
      ? new Set(await input.runtime.projects.storageIds(input.runtime.accountId, input.projectId))
      : null;
    if (input.kind === "l2") {
      if (!input.projectId || input.job.evidence.some((item) => {
        if (!item.project_id || !projectStorageIds?.has(item.project_id) || item.layer !== "L1") return true;
        if (item.kind === "turn") return !item.user_text?.trim() || !item.assistant_text?.trim();
        if (item.kind === "memory") return !item.content?.trim();
        return true;
      })) throw new Error("L2 job requires project-scoped L1 turn or Memory evidence");
      if (input.job.reason === "migration") {
        await validateMigrationL1EvidenceScope(input.runtime, input.projectId, input.job.evidence);
      }
      return;
    }
    if (input.kind === "l3") {
      if (!input.projectId || input.job.evidence.some((item) => !item.project_id || !projectStorageIds?.has(item.project_id))) {
        throw new Error("L3 job evidence must be L2 from the same project");
      }
      return;
    }
    const projects = new Set(input.job.evidence.map((item) => item.project_id).filter(Boolean));
    if (projects.size < 2) throw new Error("L4 job requires L3 evidence from at least two projects");
    return;
  }

  if (input.kind === "l2") {
    if (!input.projectId) throw new Error("L2 evidence requires a resolved project");
    const projectStorageIds = new Set(await input.runtime.projects.storageIds(input.runtime.accountId, input.projectId));
    const captures = await listCaptureEvents(input.stateRoot, input.runtime.accountId);
    const byId = new Map(captures.map((item) => [item.event_id, item]));
    for (const ref of input.evidenceRefs) {
      const eventId = parseLayerEvidenceRef(ref, "l1");
      const event = byId.get(eventId);
      if (!event || !event.ingested || event.capture_status !== "complete" || !event.user_text?.trim() || !event.assistant_text?.trim()) {
        throw new Error(`L2 evidence does not resolve to a complete ingested L1 turn: ${ref}`);
      }
      if (!event.project_hint || !projectStorageIds.has(event.project_hint)) {
        throw new Error(`L2 evidence belongs to another or unresolved project: ${ref}`);
      }
    }
    return;
  }

  const expectedLayer = input.kind === "l3" ? "L2" : "L3";
  const expectedPrefix = input.kind === "l3" ? "l2" : "l3";
  const layerItems: Array<Record<string, unknown>> = [];
  const storageProjectIds = input.kind === "l3" && input.projectId
    ? await input.runtime.projects.storageIds(input.runtime.accountId, input.projectId)
    : [undefined];
  for (const storageProjectId of storageProjectIds) {
    const params = new URLSearchParams({ limit: "500", userId: input.runtime.userId });
    if (storageProjectId) params.set("projectId", storageProjectId);
    const layerPayload = objectRecord(await input.runtime.memoryClient.viewerGet(
      `/api/v1/${input.kind === "l3" ? "l2" : "l3"}?${params.toString()}`
    ));
    if (Array.isArray(layerPayload.items)) layerItems.push(...layerPayload.items.map(objectRecord));
  }
  const byId = new Map(layerItems
    .filter((item) => typeof item.id === "string")
    .map((item) => [String(item.id), item] as const));
  const projects = new Set<string>();
  const projectStorageIds = input.kind === "l3" && input.projectId
    ? new Set(await input.runtime.projects.storageIds(input.runtime.accountId, input.projectId))
    : null;
  for (const ref of input.evidenceRefs) {
    const memoryId = parseLayerEvidenceRef(ref, expectedPrefix);
    const detail = byId.get(memoryId);
    if (!detail) throw new Error(`${expectedLayer} evidence is not visible in the current account scope: ${ref}`);
    if (detail.memoryLayer !== expectedLayer) {
      throw new Error(`${input.kind.toUpperCase()} evidence must reference ${expectedLayer}: ${ref}`);
    }
    const tags = Array.isArray(detail.tags)
      ? detail.tags.filter((tag): tag is string => typeof tag === "string")
      : [];
    const projectTag = tags.find((tag) => tag.startsWith("project:"));
    const project = projectTag?.slice("project:".length).trim();
    if (!project) throw new Error(`${expectedLayer} evidence is missing project provenance: ${ref}`);
    if (input.kind === "l3" && !projectStorageIds?.has(project)) {
      throw new Error(`L3 evidence belongs to another project: ${ref}`);
    }
    projects.add(project);
  }
  if (input.kind === "l4" && projects.size < 2) {
    throw new Error("L4 requires L3 evidence from at least two distinct projects");
  }
}

function distillationNextPayload(
  job: DistillationJob,
  evidenceOffset: number,
  evidenceChunkChars: number
): Record<string, unknown> {
  const evidenceDocument = distillationEvidenceDocument(job);
  if (evidenceOffset > evidenceDocument.length) {
    throw new TypeError(`evidence_offset exceeds evidence length ${evidenceDocument.length}`);
  }
  const inline = evidenceOffset === 0 && evidenceDocument.length <= 120_000;
  if (inline) {
    return {
      job,
      contract: distillationContract(),
      evidence_transport: {
        mode: "inline",
        total_chars: evidenceDocument.length,
        complete: true
      },
      instructions: `Produce only the requested ${job.target.toUpperCase()} artifact from the supplied evidence. Read current Memhub context first so the result updates the canonical artifact rather than duplicating it. If evidence is insufficient for this layer, call action=skip with job_id.`
    };
  }

  const end = Math.min(evidenceDocument.length, evidenceOffset + evidenceChunkChars);
  const nextOffset = end < evidenceDocument.length ? end : null;
  const manifest = job.evidence.map((item) => {
    const { content, user_text, assistant_text, reasoning_summary, ...metadata } = item;
    return {
      ...metadata,
      text_chars: {
        ...(content !== undefined ? { content: content.length } : {}),
        ...(user_text !== undefined ? { user_text: user_text.length } : {}),
        ...(assistant_text !== undefined ? { assistant_text: assistant_text.length } : {}),
        ...(reasoning_summary !== undefined ? { reasoning_summary: reasoning_summary.length } : {})
      }
    };
  });
  return {
    job: { ...job, evidence: manifest },
    contract: distillationContract(),
    evidence_transport: {
      mode: "chunked",
      offset: evidenceOffset,
      next_offset: nextOffset,
      total_chars: evidenceDocument.length,
      chunk_chars: end - evidenceOffset,
      complete: nextOffset === null
    },
    evidence_chunk: evidenceDocument.slice(evidenceOffset, end),
    instructions: nextOffset === null
      ? `All evidence chunks for ${job.job_id} have been read. Produce only the requested ${job.target.toUpperCase()} artifact, or call action=skip if the evidence is insufficient.`
      : `This job uses chunked evidence. Keep the same lease owner and call action=next with job_id=${job.job_id}, source_harness=${job.leased_by ?? "<same-harness>"}, evidence_offset=${nextOffset}. Do not submit until evidence_transport.complete=true.`
  };
}

function distillationEvidenceDocument(job: DistillationJob): string {
  return job.evidence.map((item, index) => {
    const lines = [
      `--- evidence ${index + 1}/${job.evidence.length} ---`,
      `ref: ${item.ref}`,
      `kind: ${item.kind}`,
      `timestamp: ${item.timestamp}`,
      ...(item.layer ? [`layer: ${item.layer}`] : []),
      ...(item.project_id ? [`project_id: ${item.project_id}`] : []),
      ...(item.conversation_id ? [`conversation_id: ${item.conversation_id}`] : []),
      ...(item.title ? [`title: ${item.title}`] : [])
    ];
    if (item.content !== undefined) lines.push("content:", item.content);
    if (item.user_text !== undefined) lines.push("user_text:", item.user_text);
    if (item.assistant_text !== undefined) lines.push("assistant_text:", item.assistant_text);
    if (item.reasoning_summary !== undefined) lines.push("reasoning_summary:", item.reasoning_summary);
    return lines.join("\n");
  }).join("\n\n");
}

async function unfinishedDistillationJobsForProject(
  stateRoot: string,
  runtime: MemhubRuntime,
  projectId: string
): Promise<DistillationJob[]> {
  const jobs = await listDistillationJobs(stateRoot, runtime.accountId);
  const blockers: DistillationJob[] = [];
  for (const job of jobs) {
    if (job.scope !== "project" || !job.project_id || job.status === "completed") continue;
    const canonical = await runtime.projects.resolve(runtime.accountId, job.project_id);
    if (job.project_id === projectId || canonical === projectId) blockers.push(job);
  }
  return blockers;
}

async function validateMigrationL1EvidenceScope(
  runtime: MemhubRuntime,
  projectId: string,
  evidence: DistillationJob["evidence"]
): Promise<void> {
  const storageIds = await runtime.projects.storageIds(runtime.accountId, projectId);
  const scopedMemoryIds = new Set<string>();
  for (const storageProjectId of storageIds) {
    for (let page = 1; page <= 100; page += 1) {
      const params = new URLSearchParams({
        userId: runtime.userId,
        projectId: storageProjectId,
        page: String(page),
        limit: "200"
      });
      const payload = objectRecord(await runtime.memoryClient.viewerGet(`/api/v1/l1?${params.toString()}`));
      const items = Array.isArray(payload.items) ? payload.items.map(objectRecord) : [];
      for (const item of items) {
        if (typeof item.id === "string" && item.id.trim()) scopedMemoryIds.add(item.id.trim());
      }
      if (payload.hasNext !== true) break;
    }
  }

  const scopedRawTurnIds = new Set<string>();
  for (const storageProjectId of storageIds) {
    for (let page = 1; page <= 100; page += 1) {
      const params = new URLSearchParams({
        userId: runtime.userId,
        projectId: storageProjectId,
        page: String(page),
        limit: "100"
      });
      const payload = objectRecord(await runtime.memoryClient.viewerGet(`/api/v1/raw-turns?${params.toString()}`));
      const items = Array.isArray(payload.items) ? payload.items.map(objectRecord) : [];
      for (const item of items) {
        if (typeof item.rawTurnId === "string" && item.rawTurnId.trim()) scopedRawTurnIds.add(item.rawTurnId.trim());
      }
      if (payload.hasNext !== true) break;
    }
  }

  for (const item of evidence) {
    if (item.kind === "memory") {
      const match = /^l1-memory:(.+)$/.exec(item.ref);
      if (!match?.[1] || !scopedMemoryIds.has(match[1])) {
        throw new Error(`migration L1 memory evidence is outside project scope: ${item.ref}`);
      }
      continue;
    }
    if (item.kind === "turn") {
      const match = /^raw-turn:(.+)$/.exec(item.ref);
      if (!match?.[1] || !scopedRawTurnIds.has(match[1])) {
        throw new Error(`migration raw-turn evidence is outside project scope: ${item.ref}`);
      }
    }
  }
}

function parseLayerEvidenceRef(ref: string, expectedPrefix: "l1" | "l2" | "l3"): string {
  const prefix = `${expectedPrefix}:`;
  if (!ref.startsWith(prefix)) throw new Error(`expected ${expectedPrefix.toUpperCase()} evidence ref: ${ref}`);
  const id = ref.slice(prefix.length).trim();
  if (!id) throw new Error(`invalid ${expectedPrefix.toUpperCase()} evidence ref: ${ref}`);
  return id;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length ? [...new Set(values)] : undefined;
}

function stringArrayAllowEmpty(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError("value must be an array");
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))];
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

async function knownProjectIds(runtime: MemhubRuntime): Promise<string[]> {
  return (await knownProjectRecords(runtime)).map((project) => project.projectId);
}

async function knownProjectRecords(runtime: MemhubRuntime): Promise<ProjectDescriptor[]> {
  return runtime.projects.list(runtime.accountId);
}

function projectForModel(project: ProjectDescriptor): Record<string, unknown> {
  const todos = project.todos ?? [];
  return {
    project: project.projectId,
    name: project.name,
    description: project.description,
    descriptionSource: project.descriptionSource ?? (project.description ? "legacy" : "empty"),
    ...(project.distilledDescription ? { distilledDescription: project.distilledDescription } : {}),
    ...(project.descriptionEvidenceRefs ? { descriptionEvidenceRefs: project.descriptionEvidenceRefs } : {}),
    ...(project.descriptionUpdatedAt ? { descriptionUpdatedAt: project.descriptionUpdatedAt } : {}),
    todos,
    pendingTodos: todos.filter((todo) => todo.status === "pending"),
    pendingTodoCount: todos.filter((todo) => todo.status === "pending").length,
    aliases: project.aliases,
    state: project.state,
    ...(project.mergedInto ? { mergedInto: project.mergedInto } : {}),
    descriptionMissing: !project.description,
    updatedAt: project.updatedAt
  };
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("value must be a finite number");
  return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new TypeError("value must be a boolean");
  return value;
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function resolveToolScope(
  runtime: MemhubRuntime,
  input: { scope: string; project?: string; workspaceProject?: string; conversationId?: string }
): Promise<{ projectId: string | null; conversationId?: string; resolutionSource: string }> {
  if (input.scope !== "global" && input.scope !== "project") {
    throw new TypeError("scope must be global or project");
  }
  if (input.scope === "global") {
    return {
      projectId: null,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      resolutionSource: "global"
    };
  }
  const explicitEvidence = await resolveExplicitProjectEvidence(runtime, {
    project: input.project,
    workspaceProject: input.workspaceProject
  });
  let projectId = explicitEvidence.projectId;
  let resolutionSource = explicitEvidence.resolutionSource ?? "unresolved";
  if (input.scope === "project" && projectId === null && input.conversationId) {
    projectId = await runtime.router.currentProject(runtime.accountId, input.conversationId);
    if (projectId) resolutionSource = "conversation_binding";
  }
  if (input.scope === "project" && projectId === null) {
    throw new Error("project scope requires current workspace_project/project evidence or a stable conversation-bound project");
  }
  return {
    projectId,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    resolutionSource
  };
}

async function resolveExplicitProjectEvidence(
  runtime: MemhubRuntime,
  input: { project?: string; workspaceProject?: string }
): Promise<{ projectId: string | null; resolutionSource: string | null }> {
  const projectRef = input.project?.trim() || undefined;
  const workspaceRef = input.workspaceProject?.trim() || undefined;
  if (!projectRef && !workspaceRef) return { projectId: null, resolutionSource: null };
  await knownProjectRecords(runtime);

  const resolveOne = async (reference: string, field: string): Promise<string> => {
    const canonical = await runtime.projects.resolve(runtime.accountId, reference);
    if (canonical) return canonical;
    const candidates = await runtime.projects.suggest(runtime.accountId, reference, 5);
    throw new Error(`unknown ${field} "${reference}". Use memmy_project_list before project-scoped operations. Similar: ${candidates.map((item) => item.projectId).join(", ") || "none"}`);
  };

  const explicit = projectRef ? await resolveOne(projectRef, "project") : null;
  const workspace = workspaceRef ? await resolveOne(workspaceRef, "workspace_project") : null;
  if (explicit && workspace && explicit !== workspace) {
    throw new Error(`project/workspace conflict: project resolves to "${explicit}" but workspace_project resolves to "${workspace}"`);
  }
  return {
    projectId: workspace ?? explicit,
    resolutionSource: workspace && explicit
      ? "workspace_and_project"
      : workspace
        ? "workspace_project"
        : "explicit_project"
  };
}

const invokedArg = process.argv[1];
const invokedPath = invokedArg && !invokedArg.startsWith("-") && existsSync(resolve(invokedArg))
  ? realpathSync(resolve(invokedArg))
  : "";
if (invokedPath !== "" && invokedPath === fileURLToPath(import.meta.url)) await main();
