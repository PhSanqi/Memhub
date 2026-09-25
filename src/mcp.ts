#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, realpathSync, readFileSync } from "node:fs";
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
  listCaptureIndexEntries,
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
import { discoverDistillationJobs } from "./distillation-discovery.js";
import {
  assertActiveDistillationLease,
  completeDistillationJob,
  enqueueDerivedDistillationJob,
  failDistillationJob,
  getDistillationConfig,
  leaseDistillationJob,
  listDistillationJobs,
  renewDistillationJobLease,
  retryDistillationJob,
  setDistillationConfig,
  type DistillationJob
} from "./distillation-jobs.js";
import { createMemhubRuntime, type MemhubRuntime, type MemhubRuntimeOptions } from "./runtime.js";
import type { ProjectDescriptor, ProjectTodo } from "./project-registry.js";
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
import {
  readSkillExecution,
  recordSkillExecutionEvent,
  recordSkillLoad,
  skillTelemetrySummary,
  type SkillExecutionStage
} from "./skill-telemetry.js";
import { enrichSkillCandidateReliability, skillSelectionMetadataFromBody } from "./skill-router.js";
import { tokenizeRetrievalText } from "./retrieval-ranker.js";
import { JsonResultTransport } from "./result-transport.js";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
const projectMutationAuthorizations = new Map<string, {
  accountId: string;
  operation: "create" | "update" | "delete" | "merge";
  payload: Record<string, unknown>;
  expiresAt: number;
}>();
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
  const resultTransport = new JsonResultTransport(stateRoot, runtime.accountId);
  const jsonResult = (value: unknown) => inlineJsonResult(resultTransport.wrap(value));

  server.registerTool("memhub_result", {
    description: "续取被 Memhub 通用大结果 transport 分片的 MCP JSON 结果。原工具返回 result_transport.mode=chunked 时，按同一个 result_id 和 next_offset 继续读取；按 offset 顺序拼接 result_chunk 后再解析原始 JSON。短结果不会经过此工具。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        result_id: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        chunk_chars: { type: "integer", minimum: 10000, maximum: 200000, description: "每次续取字符数；默认 100000" }
      },
      required: ["result_id", "offset"],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => inlineJsonResult(resultTransport.read(
    requiredString(args.result_id, "result_id"),
    optionalInteger(args.offset) ?? 0,
    optionalInteger(args.chunk_chars) ?? 100_000
  )));

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
    let distillation: unknown;
    let distillation_queue_error: string | undefined;
    if (action === "commit" && result.turn.ingested && result.project_id) {
      try {
        distillation = await maybeQueueThresholdDistillation({
          stateRoot,
          accountId: runtime.accountId,
          projectId: result.project_id,
          conversationId
        });
      } catch (error) {
        distillation_queue_error = error instanceof Error ? error.message : String(error);
        console.error("[memhub] turn distillation queue:", distillation_queue_error);
      }
    }
    return jsonResult({
      ...result,
      ...(distillation ? { distillation } : {}),
      ...(distillation_queue_error ? { distillation_queue_error } : {}),
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
        branch: { type: "string", description: "可选项目内 Branch id/name；只收窄当前任务 retrieval，不建立新的记忆层。" },
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
      branchId: optionalString(args.branch),
      semanticProjectIds: stringArray(args.semantic_projects),
      knownProjectIds: knownProjects,
      reusableSkillProjectIds: crossProjectSkills
        ? (requestedCapabilityProjects.length > 0 ? requestedCapabilityProjects : knownProjects)
        : [],
      limit: optionalInteger(args.limit)
    });
    if (capsule.reusableSkills.length > 0) {
      capsule.reusableSkills = await Promise.all(capsule.reusableSkills.map(async (item) => {
        const summary = await skillTelemetrySummary(stateRoot, runtime.accountId, item.id);
        return summary.executions > 0
          ? enrichSkillCandidateReliability(item, summary.reliability)
          : item;
      }));
    }
    const continuityId = optionalString(args.continuity_id) ?? optionalString(args.conversation_id);
    const recentTurns = continuityId
      ? await recentL1Continuity({
          stateRoot,
          accountId: runtime.accountId,
          continuityId,
          limit: Math.min(12, optionalInteger(args.limit) ?? 12)
        })
      : [];
    const branchTerms = capsule.branchContext
      ? new Set(tokenizeRetrievalText(`${capsule.branchContext.name} ${capsule.branchContext.goal}`))
      : null;
    const branchScopedRecentTurns = branchTerms
      ? recentTurns.filter((turn) => {
          const turnTerms = tokenizeRetrievalText([
            turn.user_text,
            turn.assistant_text,
            turn.reasoning_summary,
            turn.tool_summary
          ].filter((value): value is string => Boolean(value)).join("\n"));
          const overlap = turnTerms.reduce((count, term) => count + Number(branchTerms.has(term)), 0);
          return overlap >= Math.min(2, branchTerms.size);
        })
      : recentTurns;
    const recentSession = branchScopedRecentTurns
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
    const relevantTodoQuery = capsule.branchContext
      ? `${query}\n${capsule.branchContext.name}\n${capsule.branchContext.goal}`
      : query;
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
        descriptionMissing: !project.description,
        ...(project.projectId === capsule.resolvedProjectId
          ? { relevantTodos: relevantProjectTodos(project.todos, relevantTodoQuery) }
          : {})
      }))
    });
  });

  server.registerTool("memhub_branch", {
    description: "项目内 Branch Context。用于同一 project 并行多个 task/workstream 时收窄 retrieval；不新增 L1/L2/L3/L4，也不复制原始对话。create/list 管理 Branch 元数据；switch 将稳定 conversation_id 绑定到 active Branch；current 查看当前绑定；close 会关闭 Branch 并解除其 conversation bindings；reopen 可恢复；unbind 仅解除当前 conversation 的 Branch。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "create", "current", "switch", "unbind", "close", "reopen"] },
        project: { type: "string", description: "项目 slug/name/alias" },
        workspace_project: { type: "string", description: "当前工作区解析出的 project；与 project 不一致时拒绝" },
        conversation_id: { type: "string", description: "switch/current/unbind 使用稳定 conversation_id" },
        branch: { type: "string", description: "Branch id/name；switch/close/reopen 必填" },
        name: { type: "string", description: "create 时的 Branch 名称" },
        goal: { type: "string", description: "create 时明确当前 workstream 要完成什么；用于 retrieval filtering" },
        include_closed: { type: "boolean", description: "list 时是否包含 closed Branch；默认 false" }
      },
      required: ["action"],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    const action = requiredString(args.action, "action");
    const conversationId = optionalString(args.conversation_id);
    if (action === "unbind") {
      if (!conversationId) throw new TypeError("conversation_id is required for branch unbind");
      return jsonResult({ ok: true, removed: await runtime.branches.unbind(runtime.accountId, conversationId) });
    }
    if (action === "current") {
      if (!conversationId) throw new TypeError("conversation_id is required for branch current");
      const explicit = await resolveExplicitProjectEvidence(runtime, {
        project: optionalString(args.project),
        workspaceProject: optionalString(args.workspace_project)
      });
      const projectId = explicit.projectId ?? await runtime.router.currentProject(runtime.accountId, conversationId);
      if (!projectId) return jsonResult({ project: null, branch: null, conversation_id: conversationId });
      return jsonResult({
        project: projectId,
        branch: await runtime.branches.current(runtime.accountId, conversationId, projectId),
        conversation_id: conversationId
      });
    }

    const explicit = await resolveExplicitProjectEvidence(runtime, {
      project: optionalString(args.project),
      workspaceProject: optionalString(args.workspace_project)
    });
    const projectId = explicit.projectId ?? (conversationId
      ? await runtime.router.currentProject(runtime.accountId, conversationId)
      : null);
    if (!projectId) throw new TypeError(`${action} requires one resolved project`);

    if (action === "list") {
      return jsonResult({
        project: projectId,
        branches: await runtime.branches.list(runtime.accountId, projectId, {
          includeClosed: optionalBoolean(args.include_closed) ?? false
        })
      });
    }
    if (action === "create") {
      const branch = await runtime.branches.create(runtime.accountId, projectId, {
        name: requiredString(args.name, "name"),
        goal: requiredString(args.goal, "goal")
      });
      return jsonResult({ ok: true, project: projectId, branch });
    }
    if (action === "switch") {
      if (!conversationId) throw new TypeError("conversation_id is required for branch switch");
      const binding = await runtime.branches.bind(
        runtime.accountId,
        conversationId,
        projectId,
        requiredString(args.branch, "branch")
      );
      return jsonResult({
        ok: true,
        project: projectId,
        conversation_id: conversationId,
        branch: await runtime.branches.resolve(runtime.accountId, projectId, binding.branchId)
      });
    }
    if (action === "close") {
      return jsonResult({
        ok: true,
        project: projectId,
        branch: await runtime.branches.close(runtime.accountId, projectId, requiredString(args.branch, "branch"))
      });
    }
    if (action === "reopen") {
      return jsonResult({
        ok: true,
        project: projectId,
        branch: await runtime.branches.reopen(runtime.accountId, projectId, requiredString(args.branch, "branch"))
      });
    }
    throw new TypeError(`unsupported memhub_branch action: ${action}`);
  });

  server.registerTool("memhub_skill", {
    description: "Skill Router / Execution Bridge。memmy_context 返回精简候选；action=load 加载 Skill 与 execution_id，真正执行后 action=record 记录 invoked、success/failure、user_correction；status 查看 telemetry。修订或退役现有 Skill 必须 action=plan（operation=revise/retire）并向用户展示精确影响，取得针对该计划的明确批准后才 action=execute；保留稳定 source_skill_id，版本替换归档旧 memory id，不创建同名并行现行 Skill。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        action: { type: "string", enum: ["load", "record", "status", "plan", "execute"] },
        skill_id: { type: "string", description: "memmy_context 返回的 Skill memory id" },
        execution_id: { type: "string", description: "load 返回；record 时必须原样回传" },
        stage: { type: "string", enum: ["invoked", "success", "failure", "user_correction"], description: "action=record 的执行阶段" },
        executor: { type: "string", description: "实际执行 Harness/MCP/tool executor，例如 codex / chatgpt / claude-code" },
        note: { type: "string", description: "简短执行结果、修订理由或用户纠正摘要；不要写隐藏 chain-of-thought" },
        operation: { type: "string", enum: ["revise", "retire"], description: "action=plan 的治理操作" },
        content: { type: "string", description: "revise 时的完整新版 Skill 过程" },
        title: { type: "string", description: "revise 时的 Skill 标题" },
        version: { type: "string", description: "revise 时严格递增的 numeric dotted 版本，例如 1.1.0" },
        tags: { type: "array", items: { type: "string" }, description: "新版的业务检索标签（不可自行声明 scope/provenance）" },
        authorization_id: { type: "string", description: "plan 返回的一次性治理授权；仅在用户明确批准后执行" }
      },
      required: ["action", "skill_id"],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    const action = requiredString(args.action, "action");
    const skillId = requiredString(args.skill_id, "skill_id");
    const skill = await loadSkillForAccount(runtime, skillId);
    if (action === "status") {
      const summary = await skillTelemetrySummary(stateRoot, runtime.accountId, skillId);
      const executionId = optionalString(args.execution_id);
      const execution = executionId ? await readSkillExecution(stateRoot, runtime.accountId, executionId) : undefined;
      if (execution && execution.some((event) => event.skill_id !== skillId)) {
        throw new Error("skill execution id belongs to another skill");
      }
      return jsonResult({
        summary,
        status: skill.status,
        source_skill_id: skill.sourceSkillId,
        source_skill_version: skill.sourceSkillVersion,
        ...(execution ? { execution } : {})
      });
    }
    if (action === "plan") {
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
      const expiresAt = Date.now() + 10 * 60_000;
      skillMutationAuthorizations.set(authorizationId, {
        accountId: runtime.accountId, skillId, operation,
        expectedFingerprint: skillFingerprint(skill),
        ...(content ? { content } : {}), ...(title ? { title } : {}),
        ...(version ? { version } : {}), ...(tags ? { tags } : {}),
        note, expiresAt
      });
      return jsonResult({
        status: "awaiting_user_authorization", operation, skill_id: skillId,
        source_skill_id: skill.sourceSkillId,
        previous_version: skill.sourceSkillVersion,
        ...(version ? { next_version: version, next_content_sha256: createHash("sha256").update(content!).digest("hex") } : {}),
        impact: operation === "revise"
          ? "Create a new version under the same source skill identity and archive the previous memory id; preserve its history and telemetry."
          : "Archive this Skill so it no longer appears as an active candidate; preserve its history and telemetry.",
        note, authorization_id: authorizationId, expires_at: new Date(expiresAt).toISOString(),
        instructions: "Show this exact plan to the user and call action=execute only after explicit approval."
      });
    }
    if (action === "execute") {
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
        await runtime.memoryClient.viewerPost("/api/v1/skills/archive", { skillId, reason: plan.note });
        return jsonResult({ ok: true, operation: "retire", skill_id: skillId, status: "archived", history_preserved: true });
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
        await runtime.memoryClient.viewerPost("/api/v1/skills/archive", { skillId, reason: `superseded by ${newId}: ${plan.note}` });
      } catch (error) {
        throw new Error(`new Skill version ${newId} was created but archiving prior ${skillId} failed; reconcile before using both: ${String(error)}`);
      }
      return jsonResult({
        ok: true, operation: "revise", previous_skill_id: skillId,
        skill_id: newId, source_skill_id: skill.sourceSkillId,
        version: plan.version, previous_status: "archived", history_preserved: true
      });
    }
    if (skill.status !== "activated" && action === "load") {
      throw new Error("archived or inactive Skill cannot be loaded for new execution");
    }
    if (action === "load") {
      const before = await skillTelemetrySummary(stateRoot, runtime.accountId, skillId);
      const loaded = await recordSkillLoad({
        stateRoot,
        accountId: runtime.accountId,
        skillId,
        executionId: optionalString(args.execution_id),
        executor: optionalString(args.executor) ?? runtime.source.platform,
        projectId: skill.projectId
      });
      return jsonResult({
        skill_id: skillId,
        execution_id: loaded.executionId,
        metadata: skillSelectionMetadataFromBody(skill.body, {
          projectId: skill.projectId,
          tags: skill.tags,
          ...(before.executions > 0 ? { telemetryReliability: before.reliability } : {})
        }),
        content: skill.body,
        telemetry: before
      });
    }
    if (action === "record") {
      const stage = requiredString(args.stage, "stage") as SkillExecutionStage;
      if (!(["invoked", "success", "failure", "user_correction"] as const).includes(stage as never)) {
        throw new TypeError("stage must be invoked, success, failure, or user_correction");
      }
      const event = await recordSkillExecutionEvent({
        stateRoot,
        accountId: runtime.accountId,
        skillId,
        executionId: requiredString(args.execution_id, "execution_id"),
        stage: stage as Exclude<SkillExecutionStage, "selected" | "loaded">,
        executor: optionalString(args.executor) ?? runtime.source.platform,
        projectId: skill.projectId,
        note: optionalString(args.note)
      });
      return jsonResult({
        event,
        summary: await skillTelemetrySummary(stateRoot, runtime.accountId, skillId)
      });
    }
    throw new TypeError("action must be load, record, or status");
  });

  server.registerTool("memhub_distill", {
    description: "统一的 L2/L3/L4/Skill 蒸馏入口。L2=项目发展时间线，并可同时产出 evidence-backed project_description；L3=项目内用户长期规则/经验/偏好，L4=跨项目用户画像，Skill=正交的可执行流程。语义整理由当前 Harness 模型完成；Memhub 负责证据边界、scope、版本、provenance 与提交。人工项目描述优先于蒸馏描述。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        action: { type: "string", enum: ["discover", "next", "renew", "submit", "skip"], description: "discover 扫描完整 L1；next 领取；renew 续租；submit 提交；skip 证据不足。" },
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
        ,lease_token_supported: { type: "boolean", description: "新客户端显式启用 opaque lease token；旧客户端默认保持原有 harness lease 协议" }
        ,lease_token: { type: "string", description: "next 返回的 opaque lease token；启用后 next 续取、renew、submit、skip 均须原样提供" }
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
    const leaseToken = optionalString(args.lease_token);
    if (action === "discover") {
      const report = await discoverDistillationJobs({
        stateRoot,
        accountId: runtime.accountId,
        resolveProject: (hint) => runtime.projects.resolve(runtime.accountId, hint),
        enqueue: args.dry_run !== true,
        ...(optionalString(args.conversation_id) ? { conversationId: optionalString(args.conversation_id) } : {})
      });
      return jsonResult({ ...report, instructions: "Discover scans only completed, ingested, project-resolved captures. It cannot read uncaptured ChatGPT history or invoke a model." });
    }
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
        assertActiveDistillationLease(job, sourceHarness, leaseToken);
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
      const leaseInput = {
        projectId: projectFilter,
        target: optionalString(args.kind) as "l2" | "l3" | "l4" | "skill" | undefined,
        harness: sourceHarness,
        leaseSeconds: optionalInteger(args.lease_seconds)
        ,useLeaseToken: args.lease_token_supported === true
      };
      let job = await leaseDistillationJob(stateRoot, runtime.accountId, leaseInput);
      let discovery: Awaited<ReturnType<typeof discoverDistillationJobs>> | undefined;
      let discovery_error: string | undefined;
      if (!job && (await getDistillationConfig(stateRoot)).auto_enabled) {
        try {
          discovery = await discoverDistillationJobs({
            stateRoot,
            accountId: runtime.accountId,
            resolveProject: (hint) => runtime.projects.resolve(runtime.accountId, hint),
            enqueue: true
          });
        } catch (error) {
          discovery_error = error instanceof Error ? error.message : String(error);
          console.error("[memhub] on-demand distillation discovery:", discovery_error);
        }
        job = await leaseDistillationJob(stateRoot, runtime.accountId, leaseInput);
      }
      if (!job) {
        const config = await getDistillationConfig(stateRoot);
        return jsonResult({
          job: null,
          queue_state: "idle",
          auto_enabled: config.auto_enabled,
          discovery_available: true,
          ...(discovery ? { discovery } : {}),
          ...(discovery_error ? { discovery_error } : {}),
          contract: distillationContract(),
          instructions: "No pending job. This does not establish that all conversations were captured or ingested. Call action=discover to reconcile eligible L1 evidence, then call next again."
        });
      }
      return jsonResult({ ...distillationNextPayload(job, evidenceOffset, evidenceChunkChars), ...(discovery ? { discovery } : {}) });
    }
    if (action === "renew") {
      const jobId = requiredString(args.job_id, "job_id");
      if (!leaseToken) throw new TypeError("lease_token is required for renewal");
      const renewed = await renewDistillationJobLease(stateRoot, runtime.accountId, jobId, sourceHarness, leaseToken, optionalInteger(args.lease_seconds) ?? 300);
      return jsonResult({ ok: true, job_id: jobId, leased_until: renewed.leased_until, lease_token: renewed.lease_token });
    }
    if (action === "skip") {
      const jobId = requiredString(args.job_id, "job_id");
      const job = (await listDistillationJobs(stateRoot, runtime.accountId)).find((item) => item.job_id === jobId);
      if (!job) throw new Error("distillation job not found for account");
      assertActiveDistillationLease(job, sourceHarness, leaseToken);
      await completeDistillationJob(stateRoot, runtime.accountId, jobId, { kind: "noop" }, sourceHarness, leaseToken);
      return jsonResult({ ok: true, job_id: jobId, skipped: true, reason: "no durable artifact justified by evidence" });
    }
    if (action !== undefined && action !== "submit") throw new TypeError("action must be discover, next, renew, submit, or skip");
    const jobId = optionalString(args.job_id);
    const job = jobId
      ? (await listDistillationJobs(stateRoot, runtime.accountId)).find((item) => item.job_id === jobId)
      : undefined;
    if (jobId && !job) throw new Error("distillation job not found for account");
    if (job) assertActiveDistillationLease(job, sourceHarness, leaseToken);
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
      // Evidence validation can take time; recheck the durable lease immediately before the external write.
      if (jobId) {
        const currentLease = (await listDistillationJobs(stateRoot, runtime.accountId)).find((item) => item.job_id === jobId);
        if (!currentLease) throw new Error("distillation job not found for account");
        assertActiveDistillationLease(currentLease, sourceHarness, leaseToken);
      }
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
          sourceHarness,
          leaseToken
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
      }, sourceHarness, leaseToken);
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

const WEB_ASSETS = {
  "logo-mark.png": readFileSync(fileURLToPath(new URL("../web-assets/logo-mark.png", import.meta.url))),
  "logo-lockup.png": readFileSync(fileURLToPath(new URL("../web-assets/logo-lockup.png", import.meta.url)))
} as const;

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
    const requestId = randomUUID();
    const startedAt = Date.now();
    response.setHeader("x-memhub-request-id", requestId);
    response.once("finish", () => {
      if (response.statusCode < 400) return;
      console.error(JSON.stringify({
        component: "memhub-gateway", request_id: requestId,
        method: request.method, route: (request.url ?? "/").split("?", 1)[0],
        status: response.statusCode, duration_ms: Date.now() - startedAt
      }));
    });
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!validateHost(request, response) || !validateOrigin(request, response)) return;
      const forwardedProto = singleHeader(request.headers["x-forwarded-proto"])?.split(",", 1)[0]?.trim().toLowerCase();
      const requestHost = singleHeader(request.headers.host)?.split(":", 1)[0]?.toLowerCase();
      if (options.publicHost && requestHost === options.publicHost.toLowerCase() && forwardedProto === "http") {
        response.writeHead(308, {
          location: `https://${options.publicHost}${request.url ?? "/"}`,
          "cache-control": "no-store"
        }).end();
        return;
      }
      response.setHeader("strict-transport-security", "max-age=3600");
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
      if (url.pathname.startsWith("/memhub/assets/")) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { allow: "GET, HEAD" }).end();
          return;
        }
        const assetName = url.pathname.slice("/memhub/assets/".length) as keyof typeof WEB_ASSETS;
        const asset = WEB_ASSETS[assetName];
        if (!asset) {
          response.writeHead(404, { "cache-control": "no-store" }).end();
          return;
        }
        response.writeHead(200, {
          "content-type": "image/png",
          "cache-control": "public, max-age=86400, immutable",
          ...webSecurityHeaders()
        });
        response.end(request.method === "HEAD" ? undefined : asset);
        return;
      }
      if (url.pathname === "/memhub/docs" || url.pathname.startsWith("/memhub/docs/")) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { allow: "GET, HEAD" }).end();
          return;
        }
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300",
          ...webSecurityHeaders()
        });
        response.end(request.method === "HEAD" ? undefined : rewriteHtmlForBasePath(renderDocs(url.pathname), options.basePath));
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
        let distillation_queue_error: string | undefined;
        if (ingestion.ingested && projectId) {
          try {
            const distillation = await maybeQueueThresholdDistillation({
              stateRoot: options.stateRoot,
              accountId: device.account_id,
              projectId,
              conversationId: stored.event.conversation_id
            });
            if (distillation) ingestion = { ...ingestion, distillation } as typeof ingestion & { distillation: unknown };
          } catch (error) {
            distillation_queue_error = error instanceof Error ? error.message : String(error);
            console.error("[memhub] capture distillation queue:", distillation_queue_error);
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
          ingestion,
          ...(distillation_queue_error ? { distillation_queue_error } : {})
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
  return discoverDistillationJobs({
    stateRoot: input.stateRoot,
    accountId: input.accountId,
    conversationId: input.conversationId,
    resolveProject: async (hint) => hint === input.projectId ? input.projectId : null,
    enqueue: true
  });
}

async function queueIdleDistillation(
  stateRoot: string,
  runtimeForAccount: (accountId: string) => MemhubRuntime
): Promise<void> {
  const config = await getDistillationConfig(stateRoot);
  if (!config.auto_enabled) return;
  const entries = await listCaptureIndexEntries(stateRoot, undefined, { ingested: true, completeOnly: true });
  const failures: Error[] = [];
  for (const accountId of new Set(entries.map((item) => item.account_id))) {
    try {
      const runtime = runtimeForAccount(accountId);
      await discoverDistillationJobs({
        stateRoot,
        accountId,
        resolveProject: (hint) => runtime.projects.resolve(accountId, hint),
        enqueue: true
      });
    } catch (error) {
      failures.push(new Error(`account ${accountId}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  if (failures.length) throw new AggregateError(failures, "distillation discovery failed for one or more accounts");
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
  const authBoundary = input.localControl ? "Local token · loopback" : "Cloudflare Access";
  const logoutLink = input.localControl ? "" : '<a class="logout" href="/cdn-cgi/access/logout" data-zh="退出" data-en="Sign out">退出</a>';
  const accountLabel = e(input.account.cloudflare_email ?? input.account.username);
  const topNav = input.account.role === "admin"
    ? `<a class="view-switch${input.adminView ? "" : " active"}" href="/memhub/user"${input.adminView ? "" : ' aria-current="page"'} data-zh="我的记忆" data-en="My memory">我的记忆</a><a class="view-switch${input.adminView ? " active" : ""}" href="/memhub/admin"${input.adminView ? ' aria-current="page"' : ""} data-zh="管理" data-en="Admin">管理</a><a href="/memhub/docs" data-zh="文档" data-en="Docs">文档</a>`
    : `<a class="view-switch active" href="/memhub/user" aria-current="page" data-zh="我的记忆" data-en="My memory">我的记忆</a><a href="/memhub/docs" data-zh="文档" data-en="Docs">文档</a>`;
  const accountSelect = input.adminView
    ? `<label class="console-select account-scope"><span data-zh="账号范围" data-en="Account scope">账号范围</span><select id="account-select" name="account" autocomplete="off">${input.accounts.map((account) => `<option value="${e(account.account_id)}" data-role="${e(account.role)}"${account.account_id === input.selectedAccountId ? " selected" : ""}>${e(account.cloudflare_email ?? account.username)}</option>`).join("")}</select></label>`
    : "";
  const projectSelect = `<label class="console-select project-scope"><span data-zh="项目范围" data-en="Project scope">项目范围</span><select id="project-select" name="project" autocomplete="off"><option value="" data-zh="全部项目" data-en="All projects">全部项目</option>${input.projects.map((project) => `<option value="${e(project.projectId)}">${e(project.name || project.projectId)} · ${e(project.projectId)}</option>`).join("")}</select></label>`;
  const userNav = `<div class="nav-group"><small data-zh="继续工作" data-en="Continue">继续工作</small><button data-view="overview"><b>00</b><span data-zh="总览" data-en="Overview">总览</span></button><button data-view="projects"><b>P</b><span data-zh="项目" data-en="Projects">项目</span></button></div><div class="nav-group"><small data-zh="记忆" data-en="Memory">记忆</small><button data-view="l1"><b>01</b><span data-zh="原始证据" data-en="Source evidence">原始证据</span></button><button data-view="l2"><b>02</b><span data-zh="项目时间线" data-en="Project chronology">项目时间线</span></button><button data-view="l3"><b>03</b><span data-zh="项目规则" data-en="Project rules">项目规则</span></button><button data-view="l4"><b>04</b><span data-zh="用户画像" data-en="User profile">用户画像</span></button><button data-view="skills"><b>S</b><span>Skills</span></button></div><div class="nav-group advanced-nav"><small data-zh="高级" data-en="Advanced">高级</small><button data-view="processing"><b>Q</b><span data-zh="处理状态" data-en="Processing status">处理状态</span></button></div>`;
  const adminNav = `<div class="nav-group"><small data-zh="运行" data-en="Operations">运行</small><button data-view="overview"><b>00</b><span data-zh="系统总览" data-en="System overview">系统总览</span></button><button data-view="processing"><b>Q</b><span data-zh="处理队列" data-en="Processing">处理队列</span></button><button data-view="accounts"><b>A</b><span data-zh="账号" data-en="Accounts">账号</span></button><button data-view="projects"><b>P</b><span data-zh="项目边界" data-en="Project boundaries">项目边界</span></button></div><div class="nav-group"><small data-zh="证据检查" data-en="Evidence inspection">证据检查</small><button data-view="l1"><b>01</b><span data-zh="L1 证据" data-en="L1 evidence">L1 证据</span></button><button data-view="l2"><b>02</b><span data-zh="L2 时间线" data-en="L2 chronology">L2 时间线</span></button><button data-view="l3"><b>03</b><span data-zh="L3 项目规则" data-en="L3 project rules">L3 项目规则</span></button><button data-view="l4"><b>04</b><span data-zh="L4 账号画像" data-en="L4 account profile">L4 账号画像</span></button><button data-view="skills"><b>S</b><span>Skills</span></button></div>`;
  const mobileOptions = input.adminView
    ? [["overview","系统总览","System overview"],["processing","处理队列","Processing"],["accounts","账号","Accounts"],["projects","项目边界","Project boundaries"],["l1","L1 证据","L1 evidence"],["l2","L2 时间线","L2 chronology"],["l3","L3 项目规则","L3 project rules"],["l4","L4 账号画像","L4 account profile"],["skills","Skills","Skills"]]
    : [["overview","总览","Overview"],["projects","项目","Projects"],["l1","原始证据","Source evidence"],["l2","项目时间线","Project chronology"],["l3","项目规则","Project rules"],["l4","用户画像","User profile"],["skills","Skills","Skills"],["processing","处理状态","Processing status"]];
  const mobileView = `<label class="mobile-view-control"><span data-zh="当前视图" data-en="Current view">当前视图</span><select id="mobile-view-select" name="mobile-view" autocomplete="off">${mobileOptions.map(([value, zh, en]) => `<option value="${value}" data-zh="${zh}" data-en="${en}">${zh}</option>`).join("")}</select></label>`;
  const mobileTopNav = input.account.role === "admin"
    ? `<a href="/memhub/user" data-zh="我的记忆" data-en="My memory">我的记忆</a><a href="/memhub/admin" data-zh="管理" data-en="Admin">管理</a><a href="/memhub/docs" data-zh="文档" data-en="Docs">文档</a><a href="/memhub" data-zh="产品主页" data-en="Product">产品主页</a>`
    : `<a href="/memhub/user" data-zh="我的记忆" data-en="My memory">我的记忆</a><a href="/memhub/docs" data-zh="文档" data-en="Docs">文档</a><a href="/memhub" data-zh="产品主页" data-en="Product">产品主页</a>`;
  const title = input.adminView ? "Memhub Admin" : "Memhub Memory";
  return `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#f5f6f8"><title>${title}</title><style>${webUiCss()}</style></head><body class="admin-body memory-console-body ${input.adminView ? "admin-mode" : "workspace-mode"}"><a class="skip-link" href="#main-content">Skip to content</a>
  <header class="site-header console-topbar"><a class="site-brand" href="/memhub"><img class="site-logo-mark" src="/memhub/assets/logo-mark.png" width="639" height="609" fetchpriority="high" alt=""><span class="brand-copy"><b>Memhub</b><small>${input.adminView ? "Admin" : "Memory"}</small></span></a><nav class="topbar-center">${topNav}</nav><div class="topbar-actions"><span class="account-chip">${accountLabel}</span><button id="console-menu-toggle" class="mobile-menu-toggle" type="button" aria-expanded="false" aria-controls="console-mobile-menu" aria-label="打开导航" data-zh-aria-label="打开导航" data-en-aria-label="Open navigation">☰</button><div class="ui-controls"><button id="theme-toggle" class="ui-toggle" type="button">暗色</button><button id="lang" class="ui-toggle" type="button">EN</button></div>${logoutLink}</div></header><div id="console-mobile-menu" class="mobile-menu hidden">${mobileTopNav}</div>
  <main id="main-content" class="admin-main"><div class="admin-shell"><aside class="console-sidebar" aria-label="${input.adminView ? "Admin navigation" : "Memory navigation"}"><a class="console-sidebar-brand" href="/memhub"><img src="/memhub/assets/logo-mark.png" width="639" height="609" alt=""><span><b>Memhub</b><small>${input.adminView ? "Admin" : "Memory"}</small></span></a><div class="sidebar-context"><span class="boundary-dot" aria-hidden="true"></span><div><b>${e(authBoundary)}</b><small data-zh="身份边界" data-en="Identity boundary">身份边界</small></div></div>${input.adminView ? adminNav : userNav}<div class="aside-foot"><span>${input.adminView ? "ADMIN" : "MEMORY"}</span><small data-zh="账号和项目决定记忆边界" data-en="Account and project define the memory boundary">账号和项目决定记忆边界</small></div></aside><section class="console">${mobileView}
    <section id="workspace-head" class="workspace-head ${input.adminView ? "admin-head" : "user-head"}"><div><span id="workspace-kicker" class="page-kicker">${input.adminView ? "ADMIN / OPERATIONS" : "MY MEMORY"}</span><h1 id="workspace-title">${input.adminView ? '<span data-zh="管理后台" data-en="Admin">管理后台</span>' : '<span data-zh="继续工作" data-en="Continue working">继续工作</span>'}</h1><p id="workspace-description">${input.adminView ? '<span data-zh="先确认操作范围，再处理失败、队列、账号和项目边界。" data-en="Confirm scope first, then handle failures, queues, accounts, and project boundaries.">先确认操作范围，再处理失败、队列、账号和项目边界。</span>' : '<span data-zh="先看当前项目的下一步和最近连续性，需要时再深入记忆层。" data-en="Start with the next step and recent continuity for the current project; inspect deeper memory only when needed.">先看当前项目的下一步和最近连续性，需要时再深入记忆层。</span>'}</p></div></section>
    <section class="scope-controls" aria-label="Account and project scope">${accountSelect}${projectSelect}</section>
    <div class="scope-status"><span data-zh="身份与权限" data-en="Identity and role">身份与权限</span><b id="scope-summary" data-default-role="${e(input.account.role)}">${e(input.account.role)}</b><i aria-hidden="true"></i><small>${e(authBoundary)}</small></div>
    <section id="data-panel" class="panel"><div class="panel-head"><div><div class="panel-eyebrow" id="view-eyebrow">OVERVIEW</div><h2 id="view-title">总览</h2><p id="view-desc" class="muted" aria-live="polite"></p></div><div class="admin-toolbar"><input id="filter" name="memory-filter" type="search" aria-label="搜索当前视图" autocomplete="off" placeholder="搜索当前视图…"><button id="primary-action" class="primary-action hidden" type="button">＋</button><button id="refresh" class="soft" type="button">↻ <span data-zh="刷新" data-en="Refresh">刷新</span></button><small id="last-refreshed" class="last-refreshed" aria-live="polite"></small></div></div><div id="items" class="items" aria-live="polite"></div><div id="cards" class="stats"></div></section>
    <section class="lifecycle-section"><div class="lifecycle-heading"><span data-zh="证据链" data-en="Evidence chain">证据链</span><small data-zh="需要深入时，从结论回到来源" data-en="Trace conclusions back to source when needed">需要深入时，从结论回到来源</small></div><div id="memory-flow" class="memory-flow" aria-label="Memory lifecycle"><button type="button" data-view-target="l1"><span class="flow-index">01</span><div><b>L1</b><small data-zh="原始证据" data-en="Source evidence">原始证据</small></div><em id="flow-count-l1">—</em></button><i aria-hidden="true">→</i><button type="button" data-view-target="l2"><span class="flow-index">02</span><div><b>L2</b><small data-zh="项目时间线" data-en="Project chronology">项目时间线</small></div><em id="flow-count-l2">—</em></button><i aria-hidden="true">→</i><button type="button" data-view-target="l3"><span class="flow-index">03</span><div><b>L3</b><small data-zh="项目规则" data-en="Project rules">项目规则</small></div><em id="flow-count-l3">—</em></button><i aria-hidden="true">→</i><button type="button" data-view-target="l4"><span class="flow-index">04</span><div><b>L4</b><small data-zh="用户画像" data-en="User profile">用户画像</small></div><em id="flow-count-l4">—</em></button></div></section>
  </section></div></main><div id="drawer" class="drawer hidden" role="dialog" aria-modal="true" aria-hidden="true" aria-labelledby="drawer-title" tabindex="-1"><button class="drawer-close" type="button" aria-label="关闭详情" data-zh-aria-label="关闭详情" data-en-aria-label="Close detail" onclick="closeDrawer()">×</button><div id="drawer-body"></div></div><div id="toast" class="toast hidden" role="status" aria-live="polite"></div><script>${consoleScript(input.adminView)}</script></body></html>`;
}


const WEB_DOC_ORDER = ["getting-started", "install", "workflows", "privacy", "troubleshooting"] as const;
type WebDocSlug = typeof WEB_DOC_ORDER[number];
const WEB_DOC_META: Record<WebDocSlug, { zh: string; en: string; leadZh: string; leadEn: string; goalZh: string; goalEn: string; eta: string }> = {
  "getting-started": { zh: "从安装到第一次连续记忆", en: "From install to your first continuous memory", leadZh: "完成一次真实的安装、连接、捕获、切换会话与连续性验证。", leadEn: "Complete one real install, connection, capture, session switch, and continuity verification.", goalZh: "在新会话中不重复全部背景，也能继续一个具体项目。", goalEn: "Continue one project in a fresh session without restating the full background.", eta: "20–35 min" },
  install: { zh: "安装与部署", en: "Installation & deployment", leadZh: "覆盖 Local / Server × Linux / Windows，并明确公网认证、备份和升级验证。", leadEn: "Local / Server × Linux / Windows with explicit ingress, backup, and upgrade verification.", goalZh: "服务、端口、认证入口和恢复证据全部经过验证。", goalEn: "Verify services, ports, authenticated ingress, and recovery evidence.", eta: "25–45 min" },
  workflows: { zh: "日常工作流", en: "Everyday workflows", leadZh: "用 Scope、TODO、continuity、L1–L4 与 Skill 把长期记忆变成每天可用的恢复能力。", leadEn: "Use scope, TODOs, continuity, L1–L4, and Skills as a practical recovery workflow.", goalZh: "能正确继续、切换、追溯和结束项目，而不发生跨项目污染。", goalEn: "Continue, switch, trace, and pause projects without cross-project contamination.", eta: "20–30 min" },
  privacy: { zh: "隐私与数据边界", en: "Privacy & data boundaries", leadZh: "区分存储、网络、模型、身份、项目与设备边界，并给出实际验证方法。", leadEn: "Separate storage, network, model, identity, project, and device boundaries and verify them in practice.", goalZh: "明确谁能看到什么、数据会去哪里、哪些边界必须保持私有。", goalEn: "Know who can see what, where data can go, and which boundaries must remain private.", eta: "20–30 min" },
  troubleshooting: { zh: "排错与恢复", en: "Troubleshooting & recovery", leadZh: "按确定性链路定位入口、身份、项目、L1、Processing、Memory Core 与 UI 问题。", leadEn: "Diagnose transport, identity, project scope, L1, Processing, Memory Core, and UI failures layer by layer.", goalZh: "在不扩大影响范围的前提下定位根因、修复并复验。", goalEn: "Find the root cause, recover with bounded impact, and verify the original scenario.", eta: "15–40 min" }
};

function webDocSource(slug: WebDocSlug, lang: "zh" | "en"): string {
  return readFileSync(fileURLToPath(new URL(`../docs/site/${slug}.${lang}.md`, import.meta.url)), "utf8");
}
function chineseCharacterCount(value: string): number {
  return (value.match(/[\u3400-\u9fff]/g) ?? []).length;
}
function validateWebDocChinese(slug: WebDocSlug, source: string): number {
  const count = chineseCharacterCount(source);
  const requirements: Array<[string, RegExp]> = [
    ["preconditions", /前置条件|安装前|适用场景/i],
    ["steps-or-examples", /步骤|第一步|工作流|示例|```/i],
    ["verification", /验证|成功/i],
    ["failure-diagnosis", /失败|故障|异常/i],
    ["recovery", /恢复|回滚/i],
    ["platform-differences", /平台差异|Linux|Windows/i],
    ["faq", /## FAQ/i]
  ];
  const missing = requirements.filter(([, pattern]) => !pattern.test(source)).map(([name]) => name);
  if (count < 3000 || missing.length) {
    throw new Error(`web docs ${slug} failed content contract: chineseChars=${count}; missing=${missing.join(",") || "none"}`);
  }
  return count;
}
function docsInline(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}
function renderDocsMarkdown(markdown: string, idPrefix: string): { html: string; toc: Array<{ id: string; title: string }> } {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  const toc: Array<{ id: string; title: string }> = [];
  let paragraph: string[] = [];
  let list: { type: "ul" | "ol"; items: string[] } | null = null;
  let fence: { lang: string; lines: string[] } | null = null;
  let sectionIndex = 0;
  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    if (text) html.push(`<p>${docsInline(text)}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    html.push(`<${list.type}>${list.items.map((item) => `<li>${docsInline(item)}</li>`).join("")}</${list.type}>`);
    list = null;
  };
  for (const raw of lines) {
    if (fence) {
      if (/^```/.test(raw.trim())) {
        html.push(`<div class="docs-code"><span>${escapeHtml(fence.lang || "text")}</span><pre><code>${escapeHtml(fence.lines.join("\n"))}</code></pre></div>`);
        fence = null;
      } else fence.lines.push(raw);
      continue;
    }
    const fenceMatch = raw.trim().match(/^```([^\s]*)/);
    if (fenceMatch) { flushParagraph(); flushList(); fence = { lang: fenceMatch[1] || "text", lines: [] }; continue; }
    if (/^#\s+/.test(raw)) { flushParagraph(); flushList(); continue; }
    const heading = raw.match(/^(##|###)\s+(.+)$/);
    if (heading) {
      flushParagraph(); flushList(); sectionIndex += 1;
      const id = `${idPrefix}-${sectionIndex}`;
      const level = heading[1] === "##" ? "h2" : "h3";
      if (level === "h2") toc.push({ id, title: heading[2]!.trim() });
      html.push(`<${level} id="${id}">${docsInline(heading[2]!.trim())}</${level}>`);
      continue;
    }
    const bullet = raw.match(/^\s*-\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      if (list?.type !== "ul") { flushList(); list = { type: "ul", items: [] }; }
      list.items.push(bullet[1]!);
      continue;
    }
    const ordered = raw.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      if (list?.type !== "ol") { flushList(); list = { type: "ol", items: [] }; }
      list.items.push(ordered[1]!);
      continue;
    }
    if (!raw.trim()) { flushParagraph(); flushList(); continue; }
    paragraph.push(raw.trim());
  }
  flushParagraph(); flushList();
  if (fence) html.push(`<div class="docs-code"><span>${escapeHtml(fence.lang || "text")}</span><pre><code>${escapeHtml(fence.lines.join("\n"))}</code></pre></div>`);
  return { html: html.join(""), toc };
}
function renderDocs(pathname: string): string {
  const requested = pathname.replace(/^\/memhub\/docs\/?/, "") || "getting-started";
  const slug = (WEB_DOC_ORDER.includes(requested as WebDocSlug) ? requested : "getting-started") as WebDocSlug;
  const meta = WEB_DOC_META[slug];
  const zhSource = webDocSource(slug, "zh");
  const enSource = webDocSource(slug, "en");
  const zhChars = validateWebDocChinese(slug, zhSource);
  const zh = renderDocsMarkdown(zhSource, `zh-${slug}`);
  const en = renderDocsMarkdown(enSource, `en-${slug}`);
  const index = WEB_DOC_ORDER.indexOf(slug);
  const previous = index > 0 ? WEB_DOC_ORDER[index - 1] : null;
  const next = index < WEB_DOC_ORDER.length - 1 ? WEB_DOC_ORDER[index + 1] : null;
  const nav = WEB_DOC_ORDER.map((id) => ({ id, ...WEB_DOC_META[id] }));
  const route = (id: WebDocSlug) => `/memhub/docs${id === "getting-started" ? "" : `/${id}`}`;
  const tocHtml = (items: Array<{ id: string; title: string }>) => `<details class="docs-page-toc"><summary data-zh="本页目录" data-en="On this page">本页目录</summary><nav aria-label="On this page">${items.map((item) => `<a href="#${escapeHtml(item.id)}">${escapeHtml(item.title)}</a>`).join("")}</nav></details>`;
  const tocRail = (items: Array<{ id: string; title: string }>) => `<nav aria-label="On this page">${items.map((item) => `<a href="#${escapeHtml(item.id)}">${escapeHtml(item.title)}</a>`).join("")}</nav>`;
  return `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#f5f6f8"><title>Memhub Docs — ${escapeHtml(meta.en)}</title><style>${webUiCss()}</style></head><body class="docs-body"><a class="skip-link" href="#main-content">Skip to content</a><header class="site-header docs-header"><a class="site-brand" href="/memhub"><img class="site-logo-mark" src="/memhub/assets/logo-mark.png" width="639" height="609" fetchpriority="high" alt=""><span class="brand-copy"><b>Memhub</b><small>Docs</small></span></a><nav class="desktop-nav"><a href="/memhub" data-zh="产品" data-en="Product">产品</a><a class="active" href="/memhub/docs" aria-current="page" data-zh="文档" data-en="Docs">文档</a><a href="/memhub/user" data-zh="我的记忆" data-en="My memory">我的记忆</a><button class="mobile-menu-toggle" id="docs-menu-toggle" type="button" aria-expanded="false" aria-controls="docs-mobile-menu" aria-label="打开导航">☰</button><div class="ui-controls"><button id="theme-toggle" class="ui-toggle" type="button">暗色</button><button id="lang-toggle" class="ui-toggle" type="button">EN</button></div></nav></header><div id="docs-mobile-menu" class="mobile-menu hidden"><a href="/memhub" data-zh="产品" data-en="Product">产品</a><a href="/memhub/docs" data-zh="文档" data-en="Docs">文档</a><a href="/memhub/user" data-zh="我的记忆" data-en="My memory">我的记忆</a></div><main id="main-content" class="docs-main"><aside class="docs-sidebar" aria-label="Documentation"><a class="docs-sidebar-brand" href="/memhub/docs"><img src="/memhub/assets/logo-mark.png" width="639" height="609" alt=""><span><b>Memhub</b><small>Docs</small></span></a><span>MEMHUB DOCS</span>${nav.map((item) => `<a${slug === item.id ? ' class="active" aria-current="page"' : ""} href="${route(item.id)}" data-zh="${escapeHtml(item.zh)}" data-en="${escapeHtml(item.en)}">${escapeHtml(item.zh)}</a>`).join("")}</aside><article class="docs-content"><div class="docs-kicker">DOCS / ${escapeHtml(slug.toUpperCase())}</div><h1 data-zh="${escapeHtml(meta.zh)}" data-en="${escapeHtml(meta.en)}">${escapeHtml(meta.zh)}</h1><p class="docs-lead" data-zh="${escapeHtml(meta.leadZh)}" data-en="${escapeHtml(meta.leadEn)}">${escapeHtml(meta.leadZh)}</p><section class="docs-task-meta"><div><span data-zh="完成目标" data-en="Outcome">完成目标</span><b data-zh="${escapeHtml(meta.goalZh)}" data-en="${escapeHtml(meta.goalEn)}">${escapeHtml(meta.goalZh)}</b></div><div><span data-zh="预计时间" data-en="Estimated time">预计时间</span><b>${escapeHtml(meta.eta)}</b></div><div><span data-zh="中文正文" data-en="Chinese source">中文正文</span><b>${zhChars} 字</b></div></section><div data-lang-block="zh">${tocHtml(zh.toc)}<div class="docs-markdown">${zh.html}</div></div><div data-lang-block="en" hidden>${tocHtml(en.toc)}<div class="docs-markdown">${en.html}</div></div><nav class="docs-pagination">${previous ? `<a href="${route(previous)}"><span data-zh="上一页" data-en="Previous">上一页</span><b data-zh="${escapeHtml(WEB_DOC_META[previous].zh)}" data-en="${escapeHtml(WEB_DOC_META[previous].en)}">${escapeHtml(WEB_DOC_META[previous].zh)}</b></a>` : '<span></span>'}${next ? `<a href="${route(next)}"><span data-zh="下一页" data-en="Next">下一页</span><b data-zh="${escapeHtml(WEB_DOC_META[next].zh)}" data-en="${escapeHtml(WEB_DOC_META[next].en)}">${escapeHtml(WEB_DOC_META[next].zh)}</b></a>` : '<span></span>'}</nav><div class="docs-footer-links"><a href="https://github.com/PhSanqi/Memhub">GitHub</a><a href="/memhub/docs/privacy" data-zh="隐私与数据边界" data-en="Privacy & data boundary">隐私与数据边界</a><a href="/memhub/docs/troubleshooting" data-zh="排错" data-en="Troubleshooting">排错</a></div></article><aside class="docs-section-rail" aria-label="Page contents"><div class="docs-rail-heading" data-zh="本页目录" data-en="On this page">本页目录</div><div data-lang-block="zh">${tocRail(zh.toc)}</div><div data-lang-block="en" hidden>${tocRail(en.toc)}</div><div class="docs-reading-progress"><span id="docs-reading-progress"></span></div></aside></main><script>${pagePreferencesScript()}const dm=document.getElementById('docs-mobile-menu'),dt=document.getElementById('docs-menu-toggle');if(dm&&dt)dt.onclick=()=>{const open=!dm.classList.toggle('hidden');dt.setAttribute('aria-expanded',String(open));dt.textContent=open?'×':'☰'};function updateDocsReading(){const section=document.querySelector('.docs-content [data-lang-block]:not([hidden])'),heads=[...(section?.querySelectorAll('.docs-markdown h2')||[])];let active=heads[0]?.id||'';for(const head of heads){if(head.getBoundingClientRect().top<=155)active=head.id;else break}document.querySelectorAll('.docs-section-rail [data-lang-block]:not([hidden]) a').forEach(a=>{if(a.getAttribute('href')==='#'+active)a.setAttribute('aria-current','location');else a.removeAttribute('aria-current')});const progress=document.getElementById('docs-reading-progress'),range=Math.max(1,document.documentElement.scrollHeight-innerHeight);if(progress)progress.style.width=Math.min(100,Math.round(scrollY/range*100))+'%'}addEventListener('scroll',updateDocsReading,{passive:true});addEventListener('resize',updateDocsReading);document.getElementById('lang-toggle')?.addEventListener('click',()=>requestAnimationFrame(updateDocsReading));updateDocsReading();</script></body></html>`;
}


function renderLanding(): string {
  return `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><meta name="theme-color" content="#f5f6f8"><meta name="description" content="Memhub is private, project-aware, traceable long-term memory for AI work."><title>Memhub — durable memory for AI work</title><style>${webUiCss()}</style></head><body class="landing-body"><a class="skip-link" href="#main-content">Skip to content</a>
  <header class="landing-header site-header"><a class="landing-brand site-brand" href="/memhub"><img class="site-logo-mark" src="/memhub/assets/logo-mark.png" width="639" height="609" fetchpriority="high" alt=""><span class="brand-copy"><b>Memhub</b><small data-zh="长期 AI 记忆" data-en="Durable AI memory">长期 AI 记忆</small></span></a><nav class="desktop-nav"><a href="/memhub/docs" data-zh="文档" data-en="Docs">文档</a><a href="/memhub/docs/install" data-zh="安装" data-en="Install">安装</a><a href="/memhub/docs/workflows" data-zh="工作流" data-en="Workflows">工作流</a><a href="https://github.com/PhSanqi/Memhub">GitHub</a><a class="header-cta" href="/memhub/user" data-zh="打开我的记忆" data-en="Open my memory">打开我的记忆</a><button class="mobile-menu-toggle" id="mobile-menu-toggle" type="button" aria-expanded="false" aria-controls="mobile-menu" aria-label="打开导航">☰</button><div class="ui-controls"><button id="theme-toggle" class="ui-toggle" type="button">暗色</button><button id="lang-toggle" class="ui-toggle" type="button">EN</button></div></nav></header>
  <div id="mobile-menu" class="mobile-menu hidden"><a href="/memhub/docs" data-zh="文档" data-en="Docs">文档</a><a href="/memhub/docs/install" data-zh="安装" data-en="Install">安装</a><a href="/memhub/docs/workflows" data-zh="工作流" data-en="Workflows">工作流</a><a href="/memhub/docs/privacy" data-zh="隐私" data-en="Privacy">隐私</a><a href="https://github.com/PhSanqi/Memhub">GitHub</a></div>
  <main id="main-content" class="landing-main">
    <section class="landing-hero-v2">
      <div class="landing-copy"><span class="landing-eyebrow">DURABLE AI MEMORY</span><h1 data-zh="让下一次 AI 对话，<em>知道项目做到哪里。</em>" data-en="Let the next AI session <em>know where the project left off.</em>">让下一次 AI 对话，<em>知道项目做到哪里。</em></h1><p data-zh="Memhub 把跨对话、跨工具、跨设备的工作整理成有项目边界、有时间顺序、能回到证据的长期记忆。不是把所有历史塞进一个摘要，而是让当前工作拿到正确上下文。" data-en="Memhub turns work across chats, tools, and devices into durable memory with project boundaries, chronology, and traceable evidence. It does not flatten every history into one summary; it gives current work the right context.">Memhub 把跨对话、跨工具、跨设备的工作整理成有项目边界、有时间顺序、能回到证据的长期记忆。</p><div class="landing-actions"><a class="primary-link" href="/memhub/user" data-zh="打开我的记忆" data-en="Open my memory">打开我的记忆</a><a class="soft-link" href="/memhub/docs" data-zh="5 分钟开始" data-en="Start in 5 minutes">5 分钟开始</a></div><div class="hero-proof"><span><b>01</b><span data-zh="跨对话继续" data-en="Continue across chats">跨对话继续</span></span><span><b>02</b><span data-zh="项目不串台" data-en="Keep project boundaries">项目不串台</span></span><span><b>03</b><span data-zh="结论可追溯" data-en="Trace conclusions">结论可追溯</span></span></div></div>
      <div class="hero-product-proof" aria-label="Memhub system and product proof">
        <div class="memory-topology"><div class="topology-title"><span>SYSTEM FLOW</span><small data-zh="从入口到可追溯记忆" data-en="From ingress to traceable memory">从入口到可追溯记忆</small></div><div class="topology-stage ingress"><span class="topology-node">Harness</span><span class="topology-node">MCP</span><span class="topology-node">Hook</span></div><div class="topology-arrow" aria-hidden="true">↓</div><div class="topology-core"><div class="core-brand"><img src="/memhub/assets/logo-mark.png" width="639" height="609" alt=""><div><b>Memhub</b><small>Gateway · Scope · Provenance</small></div></div><div class="topology-core-row"><span>L1 Capture</span><i aria-hidden="true">→</i><span>Distillation Queue</span></div></div><div class="topology-arrow" aria-hidden="true">↓</div><div class="topology-layers"><span><b>L2</b><small data-zh="时间线" data-en="Chronology">时间线</small></span><span><b>L3</b><small data-zh="项目规则" data-en="Project rules">项目规则</small></span><span><b>L4</b><small data-zh="账号画像" data-en="Profile">账号画像</small></span></div><div class="topology-outputs"><span>Project Registry</span><span>Evidence Trace</span></div></div>
        <div class="workspace-preview"><div class="preview-top"><div><span>PROJECT SCOPE</span><b>Memhub</b></div><small>updated 2m ago</small></div><div class="preview-next"><span data-zh="下一步" data-en="NEXT">下一步</span><b data-zh="继续完成移动端审计并生成 clean review pack" data-en="Finish the mobile audit and generate a clean review pack">继续完成移动端审计并生成 clean review pack</b></div><div class="preview-continuity"><span data-zh="最近连续性" data-en="RECENT CONTINUITY">最近连续性</span><p data-zh="上一轮完成了真实 Chromium 交互 gate，并修复 drawer 打开期间的 silent-refresh race。" data-en="The previous round completed the real Chromium interaction gate and fixed the silent-refresh race while the drawer is open.">上一轮完成了真实 Chromium 交互 gate，并修复 drawer 打开期间的 silent-refresh race。</p></div><div class="preview-status"><span><b>L2</b><small data-zh="时间线已更新" data-en="Chronology updated">时间线已更新</small></span><span><b>TODO</b><small data-zh="3 项待继续" data-en="3 follow-ups">3 项待继续</small></span><span><b>TRACE</b><small data-zh="证据可回溯" data-en="Evidence ready">证据可回溯</small></span></div><div class="preview-foot"><span>trace: project → chronology → evidence</span><b>private</b></div></div>
      </div>
    </section>
    <section class="continuity-value"><div class="section-heading"><span>CONTINUE, NOT RESTART</span><h2 data-zh="真正有用的不是“存了多少”，而是下一次能直接接着做。" data-en="What matters is not how much was stored, but whether the next session can continue immediately.">真正有用的不是“存了多少”，而是下一次能直接接着做。</h2></div><div class="value-strip"><article><b data-zh="当前范围" data-en="Current scope">当前范围</b><p data-zh="先确定账号与项目，避免把别的项目业务记忆带进当前工作。" data-en="Resolve account and project first so another project's business memory does not leak into current work.">先确定账号与项目，避免把别的项目业务记忆带进当前工作。</p></article><article><b data-zh="下一步" data-en="Next work">下一步</b><p data-zh="项目 TODO 与 recent continuity 告诉下一次 AI 会话应该从哪里继续。" data-en="Project todos and recent continuity tell the next AI session where to continue.">项目 TODO 与 recent continuity 告诉下一次 AI 会话应该从哪里继续。</p></article><article><b data-zh="证据来源" data-en="Evidence source">证据来源</b><p data-zh="长期结论可以沿时间线回到 L1，而不是变成无法核对的黑盒摘要。" data-en="Durable conclusions can trace through chronology back to L1 instead of becoming opaque summaries.">长期结论可以沿时间线回到 L1，而不是变成无法核对的黑盒摘要。</p></article></div></section>
    <section class="memory-model-v2"><div class="section-heading"><span>MEMORY MODEL</span><h2 data-zh="四层记忆，一条证据链。" data-en="Four memory layers, one evidence chain.">四层记忆，一条证据链。</h2><p data-zh="四层不是四个功能卡，而是从原始证据到稳定用户画像的递进关系；每一层都有明确来源和使用边界。" data-en="The layers are not four unrelated features; they form a progression from source evidence to a stable account profile, each with a defined source and scope.">四层不是四个功能卡，而是从原始证据到稳定用户画像的递进关系。</p></div><div class="memory-model-system"><div class="model-rail"><article><span>01</span><b>L1</b><h3 data-zh="原始对话证据" data-en="Source evidence">原始对话证据</h3><dl><dt data-zh="是什么" data-en="What">是什么</dt><dd data-zh="连续对话与来源证据" data-en="Conversation turns and provenance">连续对话与来源证据</dd><dt data-zh="从哪里来" data-en="From">从哪里来</dt><dd data-zh="Harness / Capture" data-en="Harness / Capture">Harness / Capture</dd><dt data-zh="给谁用" data-en="Used by">给谁用</dt><dd data-zh="审计与后续蒸馏" data-en="Audit and later distillation">审计与后续蒸馏</dd></dl></article><i aria-hidden="true">→</i><article><span>02</span><b>L2</b><h3 data-zh="项目时间线" data-en="Project chronology">项目时间线</h3><dl><dt data-zh="是什么" data-en="What">是什么</dt><dd data-zh="按时间组织的项目事实" data-en="Time-ordered project truth">按时间组织的项目事实</dd><dt data-zh="从哪里来" data-en="From">从哪里来</dt><dd>L1</dd><dt data-zh="给谁用" data-en="Used by">给谁用</dt><dd data-zh="恢复项目上下文" data-en="Project continuity">恢复项目上下文</dd></dl></article><i aria-hidden="true">→</i><article><span>03</span><b>L3</b><h3 data-zh="项目规则与经验" data-en="Project rules & experience">项目规则与经验</h3><dl><dt data-zh="是什么" data-en="What">是什么</dt><dd data-zh="稳定的项目内规则与偏好" data-en="Stable project rules and preferences">稳定的项目内规则与偏好</dd><dt data-zh="从哪里来" data-en="From">从哪里来</dt><dd>L2</dd><dt data-zh="给谁用" data-en="Used by">给谁用</dt><dd data-zh="当前项目长期工作" data-en="Durable project work">当前项目长期工作</dd></dl></article><i aria-hidden="true">→</i><article><span>04</span><b>L4</b><h3 data-zh="跨项目用户画像" data-en="Cross-project profile">跨项目用户画像</h3><dl><dt data-zh="是什么" data-en="What">是什么</dt><dd data-zh="跨项目重复出现的稳定特征" data-en="Stable traits repeated across projects">跨项目重复出现的稳定特征</dd><dt data-zh="从哪里来" data-en="From">从哪里来</dt><dd data-zh="多个项目的 L3" data-en="L3 from multiple projects">多个项目的 L3</dd><dt data-zh="给谁用" data-en="Used by">给谁用</dt><dd data-zh="账号级长期上下文" data-en="Account-level context">账号级长期上下文</dd></dl></article></div><div class="skill-plane"><div class="skill-plane-brand"><img src="/memhub/assets/logo-mark.png" width="639" height="609" alt=""><b>SKILL</b></div><div><strong data-zh="Skill 不是第五层：它是可复用能力平面。" data-en="Skill is not a fifth layer: it is an orthogonal capability plane.">Skill 不是第五层：它是可复用能力平面。</strong><p data-zh="方法可以被不同项目显式复用，但不会把某个项目的业务记忆一起带过去。" data-en="A method can be explicitly reused across projects without carrying one project's business memory into another.">方法可以被不同项目显式复用，但不会把某个项目的业务记忆一起带过去。</p></div><div class="skill-plane-links"><span>L1</span><span>L2</span><span>L3</span><span>L4</span></div></div></div></section>
    <section class="workflow-section"><div class="section-heading"><span>EVERYDAY WORK</span><h2 data-zh="把长期记忆变成每天都能用的工作恢复能力。" data-en="Turn durable memory into practical work recovery every day.">把长期记忆变成每天都能用的工作恢复能力。</h2></div><div class="workflow-list"><article><span>CONTINUE</span><div><h3 data-zh="项目做到哪里" data-en="Where the project left off">项目做到哪里</h3><p data-zh="先看 Recent continuity，再决定是否需要打开完整时间线。" data-en="Start with recent continuity; open the full chronology only when needed.">先看 Recent continuity，再决定是否需要打开完整时间线。</p></div></article><article><span>TODO</span><div><h3 data-zh="下一步是什么" data-en="What needs to happen next">下一步是什么</h3><p data-zh="Todo 和项目绑定，让下一次 AI 会话知道应该继续什么。" data-en="Project-scoped todos tell the next AI session what should continue.">Todo 和项目绑定，让下一次 AI 会话知道应该继续什么。</p></div></article><article><span>TRACE</span><div><h3 data-zh="为什么会记住这个结论" data-en="Why this conclusion exists">为什么会记住这个结论</h3><p data-zh="从 L3/L4 沿时间线回到 L1 证据，而不是相信一个孤立摘要。" data-en="Trace L3/L4 through chronology back to L1 evidence instead of trusting an isolated summary.">从 L3/L4 沿时间线回到 L1 证据，而不是相信一个孤立摘要。</p></div></article></div></section>
    <section class="quickstart" aria-labelledby="quickstart-title"><div class="section-heading"><span>INSTALL & CONNECT</span><h2 id="quickstart-title" data-zh="先跑起来，再让记忆从真实工作自然形成。" data-en="Get it running, then let memory form from real work.">先跑起来，再让记忆从真实工作自然形成。</h2></div><div class="quickstart-steps"><article><span>01</span><h3 data-zh="选择运行方式" data-en="Choose where it runs">选择运行方式</h3><p data-zh="Local 单机私有；Server 多设备长期在线。" data-en="Local for one machine; Server for multi-device always-on use.">Local 单机私有；Server 多设备长期在线。</p><a href="/memhub/docs/install" data-zh="安装说明 →" data-en="Installation →">安装说明 →</a></article><article><span>02</span><h3 data-zh="连接 Harness" data-en="Connect a harness">连接 Harness</h3><p data-zh="通过 MCP 或 Bridge 把当前账号与项目上下文接入 Memhub。" data-en="Connect account and project context through MCP or Bridge.">通过 MCP 或 Bridge 把当前账号与项目上下文接入 Memhub。</p><a href="/memhub/docs" data-zh="入门说明 →" data-en="Getting started →">入门说明 →</a></article><article><span>03</span><h3 data-zh="换个对话继续" data-en="Continue in another session">换个对话继续</h3><p data-zh="验证项目时间线、待办和证据在下一次会话里仍可用。" data-en="Verify chronology, follow-up, and evidence remain available in the next session.">验证项目时间线、待办和证据在下一次会话里仍可用。</p><a href="/memhub/docs/workflows" data-zh="日常工作流 →" data-en="Workflows →">日常工作流 →</a></article></div></section>
    <section class="landing-support"><a href="/memhub/docs/privacy"><span>PRIVACY / BOUNDARY</span><b data-zh="本机、服务端、Cloudflare 与模型分别处在什么边界，文档中明确说明。" data-en="Understand the distinct boundaries of local storage, server storage, Cloudflare, and model processing.">本机、服务端、Cloudflare 与模型分别处在什么边界，文档中明确说明。</b><i aria-hidden="true">→</i></a><a href="/memhub/docs/troubleshooting"><span>MAINTAIN / RECOVER</span><b data-zh="安装后的健康检查、备份、升级、失败诊断与恢复都有明确路径。" data-en="Health checks, backup, upgrades, failure diagnosis, and recovery have explicit paths.">安装后的健康检查、备份、升级、失败诊断与恢复都有明确路径。</b><i aria-hidden="true">→</i></a></section>
    <section class="landing-cta"><div><span>MEMHUB</span><h2 data-zh="下一次对话，不必从零开始。" data-en="The next session should not start from zero.">下一次对话，不必从零开始。</h2></div><div class="landing-actions"><a class="primary-link" href="/memhub/user" data-zh="打开我的记忆" data-en="Open my memory">打开我的记忆</a><a class="soft-link" href="/memhub/docs" data-zh="阅读文档" data-en="Read docs">阅读文档</a></div></section>
  </main><footer><a class="footer-brand" href="/memhub"><img src="/memhub/assets/logo-lockup.png" width="874" height="843" loading="lazy" alt="Memhub"></a><nav><a href="/memhub/docs">Docs</a><a href="/memhub/docs/install">Install</a><a href="/memhub/docs/privacy">Privacy</a><a href="/memhub/docs/troubleshooting">Troubleshooting</a><a href="https://github.com/PhSanqi/Memhub">GitHub</a></nav></footer><script>${pagePreferencesScript()}const mm=document.getElementById('mobile-menu'),mt=document.getElementById('mobile-menu-toggle');if(mt&&mm)mt.onclick=()=>{const open=!mm.classList.toggle('hidden');mt.setAttribute('aria-expanded',String(open));mt.textContent=open?'×':'☰'};</script></body></html>`;
}


function pagePreferencesScript(): string {
  return `
const root=document.documentElement;
let uiLang=localStorage.memhubLang||((navigator.language||'').toLowerCase().startsWith('zh')?'zh':'en');
let uiTheme=localStorage.memhubTheme||'light';
function applyUiPreferences(){
  root.lang=uiLang==='zh'?'zh-CN':'en';
  root.dataset.theme=uiTheme;
  const themeMeta=document.querySelector('meta[name="theme-color"]');
  if(themeMeta)themeMeta.setAttribute('content',uiTheme==='dark'?'#101216':'#f5f6f8');
  document.querySelectorAll('[data-zh][data-en]').forEach((node)=>{node.innerHTML=node.dataset[uiLang]||node.innerHTML});
  document.querySelectorAll('[data-lang-block]').forEach((node)=>{node.hidden=node.dataset.langBlock!==uiLang});
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

function renderUnprovisionedAccount(email: string): string {
  return `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f5f6f8"><title>Memhub account required</title><style>${webUiCss()}</style></head><body class="landing-body"><header class="site-header"><a class="site-brand" href="/memhub"><img class="site-logo-mark" src="/memhub/assets/logo-mark.png" width="639" height="609" fetchpriority="high" alt=""><span class="brand-copy"><b>Memhub</b><small>Memory Observatory</small></span></a><nav><a href="/memhub">About</a><a class="logout" href="/cdn-cgi/access/logout">退出</a></nav></header><main class="landing-main"><section class="observatory-hero"><div class="landing-copy"><span class="landing-eyebrow">ACCOUNT NOT PROVISIONED</span><h1>这个身份还没有 <em>Memhub 账号。</em></h1><p>Cloudflare Access 已完成身份认证，但 Memhub 当前关闭自动开户。管理员需要先为 <b>${escapeHtml(email)}</b> 创建或绑定账号，然后才能进入用户工作区。</p><div class="landing-actions"><a class="primary-link" href="/memhub">返回项目介绍</a><a class="soft-link" href="/cdn-cgi/access/logout">更换登录身份</a></div></div></section></main></body></html>`;
}

function webUiCss(): string { return `
:root{--font-sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif;--font-mono:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;--font-serif:"Iowan Old Style","Palatino Linotype",Georgia,serif;--header-h:64px;--r:8px;--r-sm:6px;--ease:cubic-bezier(.2,.7,.2,1)}
html[data-theme="light"]{color-scheme:light;--canvas:#f5f6f8;--surface:#fff;--surface-2:#f0f2f5;--surface-3:#e9ecf1;--ink:#171a21;--text:#343a46;--muted:#626a78;--line:#d8dce3;--line-strong:#bcc2cc;--accent:#4b61b8;--accent-soft:#edf0fb;--warn:#8a5b16;--warn-soft:#f7eedf;--danger:#a34235;--danger-soft:#f8e9e6;--success:#337454;--success-soft:#e7f2ec;--header-bg:rgba(245,246,248,.94);--shadow:0 18px 54px rgba(22,28,39,.12)}
html[data-theme="dark"]{color-scheme:dark;--canvas:#101216;--surface:#171a20;--surface-2:#1d2128;--surface-3:#252a33;--ink:#f2f4f7;--text:#d8dce4;--muted:#a4abb7;--line:#343943;--line-strong:#4a515e;--accent:#91a2ea;--accent-soft:#202947;--warn:#e3b763;--warn-soft:#352b1b;--danger:#ef9a8d;--danger-soft:#3b201d;--success:#79bf98;--success-soft:#1d3327;--header-bg:rgba(16,18,22,.94);--shadow:0 18px 54px rgba(0,0,0,.34)}
*{box-sizing:border-box}html{scroll-behavior:smooth;-webkit-tap-highlight-color:transparent}body{margin:0;background:var(--canvas);color:var(--ink);font:14px/1.55 var(--font-sans);text-rendering:optimizeLegibility}button,input,select,textarea{font:inherit;color:inherit}a{color:inherit}button,a,select,input,textarea,summary{touch-action:manipulation}.hidden{display:none!important}.sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}.skip-link{position:fixed;top:8px;left:8px;z-index:999;min-height:44px;padding:0 14px;display:flex;align-items:center;background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--r-sm);text-decoration:none;font-weight:700;transform:translateY(-150%)}.skip-link:focus{transform:translateY(0)}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 38%,transparent);outline-offset:2px}
.site-header{height:var(--header-h);min-height:var(--header-h);padding:0 clamp(16px,3vw,44px);position:sticky;top:0;z-index:70;display:flex;align-items:center;justify-content:space-between;gap:18px;background:var(--header-bg);border-bottom:1px solid var(--line);backdrop-filter:blur(14px)}.site-brand{min-height:44px;display:flex;align-items:center;gap:9px;text-decoration:none;min-width:0}.site-logo-mark{width:30px;height:30px;display:block;object-fit:contain}.brand-copy{display:flex;flex-direction:column;line-height:1.05}.brand-copy>b{font-size:14px}.brand-copy>small{margin-top:3px;color:var(--muted);font-size:11px}.site-header nav,.topbar-actions,.ui-controls{display:flex;align-items:center;gap:5px}.site-header nav>a,.ui-toggle,.logout,.mobile-menu-toggle{min-height:38px;padding:0 10px;display:inline-flex;align-items:center;border:1px solid transparent;border-radius:var(--r-sm);background:transparent;color:var(--muted);text-decoration:none;font-size:12px;font-weight:650;white-space:nowrap}.site-header nav>a:hover,.ui-toggle:hover,.logout:hover,.mobile-menu-toggle:hover{border-color:var(--line);background:var(--surface);color:var(--ink)}.site-header nav>a.active,.site-header nav>a[aria-current="page"]{background:var(--surface);border-color:var(--line);color:var(--ink)}.ui-toggle,.mobile-menu-toggle{cursor:pointer}.account-chip{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font:11px var(--font-mono)}.mobile-menu-toggle{display:none;font-size:18px}.mobile-menu{position:fixed;z-index:69;top:var(--header-h);left:0;right:0;padding:10px 16px 14px;display:flex;flex-direction:column;background:var(--surface);border-bottom:1px solid var(--line);box-shadow:var(--shadow)}.mobile-menu a{min-height:46px;padding:0 10px;display:flex;align-items:center;border-bottom:1px solid var(--line);text-decoration:none;font-weight:650}
/* Landing */
.landing-header{max-width:1480px;margin:0 auto}.landing-header .header-cta{margin-left:5px;background:var(--ink);color:var(--canvas);border-color:var(--ink)}.landing-main{max-width:1360px;margin:0 auto;padding:0 clamp(20px,4vw,58px) 80px}.landing-hero-v2{min-height:690px;padding:74px 0 82px;display:grid;grid-template-columns:minmax(0,1fr) minmax(430px,.82fr);gap:clamp(46px,7vw,100px);align-items:center}.landing-copy{max-width:760px}.landing-eyebrow,.section-heading>span,.landing-cta>div>span,.preview-top span,.preview-next>span,.preview-continuity>span,.model-rail>aside>b,.quickstart-steps article>span,.workflow-list article>span,.docs-kicker,.docs-sidebar>span,.docs-step>span{color:var(--accent);font:700 11px var(--font-mono);letter-spacing:.07em;text-transform:uppercase}.landing-copy h1{max-width:790px;margin:17px 0 22px;font:650 clamp(48px,5.3vw,70px)/1.06 var(--font-sans);letter-spacing:-.045em;text-wrap:balance}.landing-copy h1 em{color:var(--accent);font-style:normal}.landing-copy>p{max-width:680px;margin:0;color:var(--text);font-size:16px;line-height:1.78}.landing-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:28px}.primary-link,.soft-link{min-height:44px;padding:0 15px;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--r-sm);text-decoration:none;font-size:13px;font-weight:700}.primary-link{background:var(--accent);border:1px solid var(--accent);color:#fff}.soft-link{background:var(--surface);border:1px solid var(--line-strong);color:var(--text)}.hero-proof{display:flex;gap:18px;flex-wrap:wrap;margin-top:30px;color:var(--muted);font-size:12px}.hero-proof>span{display:flex;align-items:center;gap:7px}.hero-proof b{color:var(--accent);font:700 11px var(--font-mono)}
.workspace-preview{overflow:hidden;background:var(--surface);border:1px solid var(--line-strong);border-radius:10px;box-shadow:var(--shadow)}.preview-top{padding:17px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line)}.preview-top>div{display:flex;flex-direction:column;gap:4px}.preview-top b{font-size:15px}.preview-top small{color:var(--muted);font-size:11px}.preview-next,.preview-continuity{padding:22px 20px;border-bottom:1px solid var(--line)}.preview-next{background:var(--accent-soft)}.preview-next b{display:block;margin-top:8px;font-size:15px;line-height:1.5}.preview-continuity p{margin:8px 0 0;color:var(--text);font-size:13px;line-height:1.7}.preview-layers{padding:18px 20px;display:grid;grid-template-columns:1fr auto 1fr auto 1fr auto 1fr;gap:8px;align-items:center}.preview-layers>span{min-width:0;display:flex;flex-direction:column;gap:3px}.preview-layers b{font:700 12px var(--font-mono);color:var(--accent)}.preview-layers small{font-size:11px;color:var(--muted)}.preview-layers i{color:var(--line-strong);font-style:normal}.preview-foot{padding:11px 18px;display:flex;justify-content:space-between;gap:12px;background:var(--surface-2);color:var(--muted);font:11px var(--font-mono)}.preview-foot b{color:var(--success)}
.quickstart,.workflow-section,.memory-model-v2{padding:86px 0;border-top:1px solid var(--line)}.section-heading{max-width:820px;margin-bottom:38px}.section-heading h2{margin:9px 0 0;font-size:clamp(30px,3.4vw,46px);line-height:1.12;letter-spacing:-.035em;text-wrap:balance}.section-heading p{max-width:680px;margin:13px 0 0;color:var(--muted);font-size:14px}.quickstart-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.quickstart-steps article{padding:24px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r)}.quickstart-steps h3,.workflow-list h3,.model-rail h3{margin:9px 0 8px;font-size:18px;line-height:1.3}.quickstart-steps p,.workflow-list p,.model-rail p{margin:0;color:var(--muted);line-height:1.7}.quickstart-steps a{display:inline-flex;margin-top:20px;color:var(--accent);font-weight:700;text-decoration:none}.workflow-list{display:flex;flex-direction:column;border-top:1px solid var(--line)}.workflow-list article{padding:21px 4px;display:grid;grid-template-columns:120px minmax(0,1fr);gap:28px;border-bottom:1px solid var(--line)}.workflow-list article>div{max-width:760px}.memory-model-v2{display:grid;grid-template-columns:minmax(280px,.7fr) minmax(0,1.3fr);gap:70px}.memory-model-v2 .section-heading{margin:0}.model-rail{position:relative;display:flex;flex-direction:column}.model-rail::before{content:"";position:absolute;left:20px;top:32px;bottom:108px;width:2px;background:var(--accent)}.model-rail article{position:relative;min-height:98px;padding:16px 10px 16px 58px;display:grid;grid-template-columns:44px minmax(0,1fr);gap:12px;border-bottom:1px solid var(--line)}.model-rail article>b{position:absolute;left:0;top:24px;width:42px;height:28px;display:grid;place-items:center;background:var(--surface);border:1px solid var(--accent);border-radius:999px;color:var(--accent);font:700 11px var(--font-mono)}.model-rail h3{grid-column:2;margin-top:0}.model-rail p{grid-column:2}.model-rail aside{margin:20px 0 0 58px;padding:18px 20px;background:var(--surface-2);border-left:3px solid var(--warn)}.model-rail aside>b{color:var(--warn)}.landing-support{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:0 0 86px}.landing-support>a{min-height:120px;padding:22px;display:grid;grid-template-columns:1fr auto;gap:8px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);text-decoration:none}.landing-support span{grid-column:1;color:var(--muted);font:700 11px var(--font-mono)}.landing-support b{max-width:520px;font-size:15px;line-height:1.5}.landing-support i{grid-column:2;grid-row:1/3;align-self:center;color:var(--accent);font-style:normal}.landing-cta{margin-bottom:70px;padding:34px 36px;display:flex;align-items:center;justify-content:space-between;gap:30px;background:var(--ink);color:var(--canvas);border-radius:10px}.landing-cta h2{margin:8px 0 0;font-size:30px;line-height:1.15}.landing-cta .landing-actions{margin:0}.landing-cta .soft-link{background:transparent;color:var(--canvas);border-color:color-mix(in srgb,var(--canvas) 34%,transparent)}footer{max-width:1360px;margin:0 auto;padding:26px clamp(20px,4vw,58px) 40px;display:flex;justify-content:space-between;gap:20px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}footer nav{display:flex;gap:18px;flex-wrap:wrap}footer a{text-decoration:none}footer a:hover{color:var(--ink)}.footer-brand img{width:112px;height:auto;display:block}
/* Landing audit upgrade */
.hero-product-proof{position:relative;min-height:610px;display:grid;grid-template-rows:minmax(0,1fr) auto;gap:14px}.memory-topology{min-height:390px;padding:18px;display:flex;flex-direction:column;background:linear-gradient(180deg,color-mix(in srgb,var(--surface) 96%,var(--accent-soft)),var(--surface));border:1px solid var(--line-strong);border-radius:10px;box-shadow:var(--shadow)}.topology-title{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-bottom:13px;border-bottom:1px solid var(--line)}.topology-title>span{color:var(--accent);font:700 11px var(--font-mono);letter-spacing:.07em}.topology-title>small{color:var(--muted);font-size:11px}.topology-stage{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:18px}.topology-node,.topology-outputs span,.topology-core-row span{min-height:38px;padding:0 10px;display:flex;align-items:center;justify-content:center;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r-sm);color:var(--text);font:650 11px var(--font-mono);text-align:center}.topology-arrow{height:28px;display:grid;place-items:center;color:var(--line-strong);font-size:15px}.topology-core{padding:13px;background:var(--surface);border:1px solid color-mix(in srgb,var(--accent) 42%,var(--line));border-radius:var(--r)}.core-brand{display:flex;align-items:center;justify-content:center;gap:10px;padding-bottom:12px}.core-brand img{width:38px;height:38px;object-fit:contain}.core-brand>div{display:flex;flex-direction:column}.core-brand b{font-size:14px}.core-brand small{color:var(--muted);font:10px var(--font-mono)}.topology-core-row{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center}.topology-core-row i{color:var(--accent);font-style:normal}.topology-layers{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}.topology-layers>span{padding:9px;display:flex;flex-direction:column;background:var(--accent-soft);border-radius:var(--r-sm)}.topology-layers b{color:var(--accent);font:700 11px var(--font-mono)}.topology-layers small{margin-top:2px;color:var(--text);font-size:11px}.topology-outputs{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:auto;padding-top:13px;border-top:1px dashed var(--line)}.hero-product-proof .workspace-preview{position:relative;margin:-52px 18px 0 54px;z-index:2;box-shadow:0 18px 45px rgba(22,28,39,.14)}
.continuity-value{padding:76px 0;border-top:1px solid var(--line)}.value-strip{display:grid;grid-template-columns:repeat(3,1fr);background:var(--surface);border:1px solid var(--line);border-radius:var(--r);overflow:hidden}.value-strip article{min-height:150px;padding:22px;border-right:1px solid var(--line)}.value-strip article:last-child{border-right:0}.value-strip b{font-size:15px}.value-strip p{margin:9px 0 0;color:var(--muted);line-height:1.7}
.memory-model-v2{display:block;padding:86px 0;border-top:1px solid var(--line)}.memory-model-v2 .section-heading{max-width:900px;margin-bottom:34px}.memory-model-system{position:relative}.model-rail{display:grid;grid-template-columns:minmax(0,1fr) 28px minmax(0,1fr) 28px minmax(0,1fr) 28px minmax(0,1fr);gap:0;align-items:stretch}.model-rail::before{display:none}.model-rail>i{display:grid;place-items:center;color:var(--accent);font-style:normal}.model-rail article{min-height:270px;padding:20px;display:block;background:var(--surface);border:1px solid var(--line);border-radius:var(--r)}.model-rail article>b{position:static;width:auto;height:auto;display:inline;color:var(--accent);background:transparent;border:0;border-radius:0;font:750 17px var(--font-mono)}.model-rail article>span{float:right;color:var(--muted);font:700 11px var(--font-mono)}.model-rail h3{margin:10px 0 18px;font-size:17px}.model-rail dl{margin:0;display:grid;grid-template-columns:70px minmax(0,1fr);row-gap:9px;column-gap:8px}.model-rail dt{color:var(--muted);font-size:11px}.model-rail dd{margin:0;color:var(--text);font-size:12px;line-height:1.5}.skill-plane{position:relative;margin:18px 56px 0;padding:18px 20px;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:18px;align-items:center;background:var(--surface-2);border:1px solid var(--line);border-top:3px solid var(--warn);border-radius:var(--r)}.skill-plane::before{content:"";position:absolute;left:7%;right:7%;top:-20px;height:18px;border-left:1px dashed var(--warn);border-right:1px dashed var(--warn);border-top:1px dashed var(--warn);opacity:.55}.skill-plane-brand{display:flex;align-items:center;gap:8px}.skill-plane-brand img{width:34px;height:34px;object-fit:contain}.skill-plane-brand b{color:var(--warn);font:750 12px var(--font-mono)}.skill-plane strong{font-size:14px}.skill-plane p{margin:4px 0 0;color:var(--muted);font-size:12px}.skill-plane-links{display:flex;gap:5px}.skill-plane-links span{min-width:32px;padding:5px 6px;text-align:center;background:var(--surface);border:1px solid var(--line);border-radius:999px;color:var(--muted);font:700 10px var(--font-mono)}
/* Docs */
.docs-main{max-width:1320px;margin:0 auto;padding:44px clamp(20px,4vw,54px) 90px;display:grid;grid-template-columns:220px minmax(0,1fr);gap:58px}.docs-sidebar{position:sticky;top:calc(var(--header-h) + 28px);align-self:start;display:flex;flex-direction:column;gap:3px;max-height:calc(100vh - var(--header-h) - 48px);overflow:auto}.docs-sidebar-brand{margin-bottom:8px;padding:7px 9px;display:flex!important;align-items:center;gap:8px;background:transparent!important;text-decoration:none}.docs-sidebar-brand img{width:26px;height:26px;object-fit:contain}.docs-sidebar-brand span{display:flex;flex-direction:column}.docs-sidebar-brand b{font-size:12px}.docs-sidebar-brand small{color:var(--muted);font-size:10px}.docs-sidebar>span{margin:0 9px 10px;color:var(--muted);font:700 10px var(--font-mono);letter-spacing:.06em}.docs-sidebar a{min-height:44px;padding:0 10px;display:flex;align-items:center;border-radius:var(--r-sm);text-decoration:none;color:var(--muted);font-size:13px}.docs-sidebar a:hover,.docs-sidebar a.active{background:var(--surface);color:var(--ink)}.docs-content{max-width:830px;min-width:0}.docs-kicker{margin-bottom:12px;color:var(--accent);font:700 11px var(--font-mono);letter-spacing:.07em}.docs-content>h1{margin:0;font-size:40px;line-height:1.1;letter-spacing:-.038em;text-wrap:balance}.docs-lead{max-width:760px;margin:14px 0 24px;color:var(--text);font-size:16px;line-height:1.78}.docs-task-meta{margin:0 0 30px;padding:14px 16px;display:grid;grid-template-columns:minmax(0,1.4fr) 130px 120px;gap:14px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r)}.docs-task-meta>div{min-width:0;display:flex;flex-direction:column;gap:4px}.docs-task-meta span{color:var(--muted);font:700 10px var(--font-mono);letter-spacing:.04em}.docs-task-meta b{font-size:12px;line-height:1.45}.docs-page-toc{margin:0 0 34px;padding:16px 18px;display:grid;grid-template-columns:150px minmax(0,1fr);gap:4px 16px;background:var(--surface-2);border-left:3px solid var(--accent);border-radius:var(--r-sm)}.docs-page-toc>span{grid-row:1/-1;padding-top:3px;color:var(--accent);font:700 10px var(--font-mono);letter-spacing:.06em}.docs-page-toc>a{min-height:44px;display:flex;align-items:center;color:var(--text);font-size:12px;text-decoration:none}.docs-page-toc>a:hover{color:var(--accent)}.docs-markdown{max-width:780px}.docs-markdown h2{scroll-margin-top:calc(var(--header-h) + 24px);margin:54px 0 14px;padding-top:3px;font-size:24px;line-height:1.25;letter-spacing:-.02em}.docs-markdown h2:first-child{margin-top:8px}.docs-markdown h3{scroll-margin-top:calc(var(--header-h) + 24px);margin:34px 0 10px;font-size:18px;line-height:1.35}.docs-markdown p{margin:0 0 18px;color:var(--text);font-size:14px;line-height:1.9}.docs-markdown ul,.docs-markdown ol{margin:0 0 22px;padding-left:24px;color:var(--text)}.docs-markdown li{margin:7px 0;line-height:1.75}.docs-markdown code{padding:2px 5px;background:var(--surface-2);border:1px solid var(--line);border-radius:4px;font:12px var(--font-mono)}.docs-code{max-width:100%;margin:20px 0 26px;overflow:hidden;background:var(--ink);border-radius:var(--r)}.docs-code>span{height:34px;padding:0 14px;display:flex;align-items:center;color:color-mix(in srgb,var(--canvas) 68%,transparent);border-bottom:1px solid color-mix(in srgb,var(--canvas) 16%,transparent);font:700 10px var(--font-mono);text-transform:uppercase}.docs-code pre{max-width:100%;margin:0;padding:16px 18px;overflow-x:auto;color:var(--canvas);font:12px/1.7 var(--font-mono)}.docs-code code{padding:0;background:transparent;border:0;color:inherit;font:inherit}.docs-pagination{margin-top:56px;padding-top:22px;display:grid;grid-template-columns:1fr 1fr;gap:10px;border-top:1px solid var(--line)}.docs-pagination>a{min-height:72px;padding:13px 15px;display:flex;flex-direction:column;justify-content:center;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-sm);text-decoration:none}.docs-pagination>a:last-child{text-align:right;align-items:flex-end}.docs-pagination span{color:var(--muted);font:700 10px var(--font-mono)}.docs-pagination b{margin-top:4px;font-size:12px}.docs-footer-links{margin-top:28px;padding-top:20px;display:flex;gap:18px;flex-wrap:wrap;border-top:1px solid var(--line)}.docs-footer-links a{min-height:44px;display:inline-flex;align-items:center;color:var(--accent);font-weight:700;text-decoration:none}
/* Console */
.console-topbar{padding-left:18px}.topbar-center{margin-left:auto}.topbar-actions{margin-left:8px}.admin-main{max-width:none;padding:0}.admin-shell{display:grid;grid-template-columns:228px minmax(0,1fr);min-height:calc(100vh - var(--header-h))}.console-sidebar{position:sticky;top:var(--header-h);height:calc(100vh - var(--header-h));padding:18px 12px;display:flex;flex-direction:column;overflow:auto;background:var(--surface);border-right:1px solid var(--line)}.console-sidebar-brand{min-height:52px;margin:0 5px 10px;padding:7px 8px;display:flex;align-items:center;gap:9px;border-bottom:1px solid var(--line);text-decoration:none}.console-sidebar-brand img{width:28px;height:28px;object-fit:contain}.console-sidebar-brand span{display:flex;flex-direction:column}.console-sidebar-brand b{font-size:13px}.console-sidebar-brand small{color:var(--muted);font-size:10px}.sidebar-context{margin:0 5px 12px;padding:11px 8px;display:grid;grid-template-columns:12px minmax(0,1fr);gap:8px;align-items:start;background:var(--surface-2);border-radius:var(--r)}.boundary-dot{width:7px;height:7px;margin-top:5px;border-radius:50%;background:var(--success)}.sidebar-context div{min-width:0;display:flex;flex-direction:column}.sidebar-context b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);font:11px var(--font-mono)}.sidebar-context small{margin-top:3px;color:var(--muted);font-size:11px}.nav-group{display:flex;flex-direction:column;margin-top:10px}.nav-group>small{padding:0 9px 5px;color:var(--muted);font-size:11px;font-weight:700}.console-sidebar button{width:100%;min-height:40px;margin:1px 0;padding:0 8px;display:grid;grid-template-columns:30px minmax(0,1fr);gap:5px;align-items:center;border:1px solid transparent;border-radius:var(--r-sm);background:transparent;color:var(--text);text-align:left;cursor:pointer}.console-sidebar button>b{color:var(--muted);font:700 11px var(--font-mono);text-align:center}.console-sidebar button:hover{background:var(--surface-2)}.console-sidebar button.active{background:var(--accent-soft);color:var(--ink)}.console-sidebar button.active>b{color:var(--accent)}.advanced-nav{margin-top:auto;padding-top:12px;border-top:1px solid var(--line)}.aside-foot{margin-top:14px;padding:13px 8px 2px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:3px}.aside-foot>span{color:var(--muted);font:700 11px var(--font-mono)}.aside-foot small{color:var(--muted);font-size:11px}.console{min-width:0;padding:0 clamp(24px,4vw,58px) 70px}.mobile-view-control{display:none}.workspace-head{padding:36px 0 23px;display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,.55fr);gap:42px;align-items:end}.workspace-head>div:first-child{max-width:760px}.page-kicker{color:var(--accent);font:700 11px var(--font-mono);letter-spacing:.06em}.admin-head .page-kicker{color:var(--warn)}.workspace-head h1{margin:7px 0 8px;font-size:34px;line-height:1.15;letter-spacing:-.035em}.workspace-head p{margin:0;color:var(--muted);font-size:14px}.workspace-head.compact{padding:18px 0 12px;align-items:center}.workspace-head.compact h1{margin:4px 0 0;font-size:24px}.workspace-head.compact p{display:none}.workspace-head.compact+.scope-status+.panel .panel-head>div:first-child{display:none}.scope-controls{display:flex;justify-content:flex-end;gap:8px;align-items:end;flex-wrap:wrap}.console-select{min-width:0;display:flex;flex:1;flex-direction:column;gap:6px;color:var(--muted);font-size:11px;font-weight:700}.console-select select{width:100%;min-width:180px;height:44px;padding:0 34px 0 10px;background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--r-sm);outline:none;font-size:12px}.console-select select:focus{border-color:var(--accent)}.scope-status{min-height:42px;padding:0 2px;display:grid;grid-template-columns:auto auto minmax(28px,1fr) auto;gap:10px;align-items:center;border-top:1px solid var(--line);border-bottom:1px solid var(--line);color:var(--muted);font-size:12px}.scope-status>b{color:var(--ink);font-weight:700}.scope-status>i{height:1px;background:var(--line)}.scope-status>small{font:11px var(--font-mono)}
.panel{padding-top:28px}.panel-head{padding-bottom:16px;display:flex;align-items:end;justify-content:space-between;gap:24px}.panel-eyebrow{margin-bottom:5px;color:var(--accent);font:700 11px var(--font-mono);letter-spacing:.05em}.admin-mode .panel-eyebrow{color:var(--warn)}.panel-head h2{margin:0;font-size:24px;line-height:1.2}.muted{max-width:700px;margin:6px 0 0;color:var(--muted);font-size:13px}.admin-toolbar{display:flex;align-items:center;justify-content:flex-end;gap:7px;flex-wrap:wrap}.admin-toolbar input{width:min(300px,30vw);height:44px;padding:0 11px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-sm);outline:none}.admin-toolbar input:focus{border-color:var(--accent)}.soft,.danger,.primary-action{min-height:44px;padding:0 12px;border-radius:var(--r-sm);cursor:pointer;font-size:12px;font-weight:700}.soft{background:var(--surface);border:1px solid var(--line);color:var(--text)}.primary-action{background:var(--accent);border:1px solid var(--accent);color:#fff}.danger{background:var(--danger-soft);border:1px solid color-mix(in srgb,var(--danger) 44%,var(--line));color:var(--danger)}.last-refreshed{min-width:78px;color:var(--muted);font-size:11px;text-align:right}.items{min-width:0}.stats{margin:18px 0 0;display:flex;gap:8px;flex-wrap:wrap}.stats article{min-width:130px;padding:12px 14px;background:var(--surface-2);border-radius:var(--r)}.stats b{display:block;font-size:18px}.stats span{display:block;margin-top:2px;color:var(--muted);font-size:11px}
/* Overview */
.personal-overview,.governance-overview{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(260px,.8fr);gap:16px}.continuity-card,.admin-health-card,.overview-todos,.overview-links{background:var(--surface);border:1px solid var(--line);border-radius:var(--r)}.continuity-card,.admin-health-card{padding:22px}.continuity-card>span,.admin-health-card>span,.overview-todos-head>span{color:var(--accent);font:700 11px var(--font-mono)}.admin-health-card>span,.admin-mode .overview-todos-head>span{color:var(--warn)}.continuity-card h3,.admin-health-card h3{margin:7px 0 8px;font-size:18px}.continuity-card p,.admin-health-card p{margin:0;color:var(--muted);line-height:1.7}.continuity-meta{margin-top:18px;display:flex;gap:10px;flex-wrap:wrap;color:var(--muted);font-size:11px}.overview-todos{overflow:hidden}.overview-todos-head{padding:14px 16px;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center;background:var(--accent-soft)}.admin-mode .overview-todos-head{background:var(--warn-soft)}.overview-todos-head>b{font-size:13px}.overview-todo-list{display:flex;flex-direction:column}.overview-todo-row{width:100%;min-height:58px;padding:10px 15px;display:grid;grid-template-columns:140px minmax(0,1fr) 18px;gap:12px;align-items:center;background:transparent;border:0;border-bottom:1px solid var(--line);text-align:left;cursor:pointer}.overview-todo-row:last-child{border-bottom:0}.overview-todo-row:hover{background:var(--surface-2)}.overview-todo-row span{color:var(--accent);font:700 11px var(--font-mono)}.overview-todo-row b{font-size:12px}.overview-todo-row i{font-style:normal;color:var(--muted)}.overview-empty{padding:18px 16px;color:var(--muted);font-size:12px}.health-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:16px 0}.health-metric{min-height:72px;padding:10px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r-sm);text-align:left;cursor:pointer}.health-metric b{display:block;font-size:22px}.health-metric small{font-size:11px}.health-metric.failed b{color:var(--danger)}.health-metric.pending b,.health-metric.leased b{color:var(--warn)}.processing-note{padding:16px 18px;background:var(--surface-2);border-radius:var(--r);color:var(--text)}.processing-note b{font-size:13px}.processing-note p{margin:4px 0 0;color:var(--muted);font-size:12px}.project-record-main{min-width:0}.loading-state{min-height:180px;display:flex;align-items:center;justify-content:center;gap:7px;color:var(--muted)}.loading-state>span{width:8px;height:8px;border-radius:50%;background:var(--accent);animation:mh-pulse 1s infinite ease-in-out}.loading-state>span:nth-child(2){animation-delay:.12s}.loading-state>span:nth-child(3){animation-delay:.24s}.loading-state>b{margin-left:6px;font-size:12px}@keyframes mh-pulse{0%,100%{opacity:.25;transform:translateY(0)}50%{opacity:1;transform:translateY(-3px)}}.overview-links{grid-column:1/-1;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));overflow:hidden}.overview-card{min-height:86px;padding:14px;display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:9px;align-items:center;border:0;border-right:1px solid var(--line);border-bottom:1px solid var(--line);background:transparent;text-align:left;cursor:pointer}.overview-card:nth-child(3n){border-right:0}.overview-card:hover{background:var(--surface-2)}.overview-card>span{color:var(--accent);font:700 11px var(--font-mono)}.admin-mode .overview-card>span{color:var(--warn)}.overview-card>div{display:flex;flex-direction:column;gap:3px}.overview-card b{font-size:13px}.overview-card small{color:var(--muted);font-size:11px}.overview-card i{color:var(--muted);font-style:normal}
/* Admin overview: status is an at-a-glance strip; follow-up owns the reading width. */
.admin-mode .governance-overview{grid-template-columns:minmax(0,1fr);gap:12px}
.admin-mode .admin-health-card{padding:14px 18px;display:grid;grid-template-columns:minmax(0,1fr) minmax(310px,1.15fr);grid-template-rows:auto auto auto;gap:0 18px;align-items:center}
.admin-mode .admin-health-card>span{grid-column:1;grid-row:1}
.admin-mode .admin-health-card h3{grid-column:1;grid-row:2;margin:2px 0;font-size:15px}
.admin-mode .admin-health-card p{grid-column:1;grid-row:3;font-size:11px}
.admin-mode .admin-health-card .health-grid{grid-column:2;grid-row:1/4;margin:0}
.admin-mode .health-metric{min-height:62px;padding:8px 11px}
.admin-mode .health-metric b{font-size:20px}
.admin-mode .overview-todo-columns,.admin-mode .overview-todo-row{display:grid;grid-template-columns:minmax(110px,155px) 80px minmax(0,1fr) 128px 20px;gap:12px;align-items:center}
.admin-mode .overview-todo-columns{min-height:36px;padding:0 15px;border-bottom:1px solid var(--line);color:var(--muted);font:700 10px var(--font-mono);letter-spacing:.03em}
.admin-mode .overview-todo-row{min-height:66px}
.admin-mode .overview-todo-row>span{min-width:0;overflow-wrap:anywhere}
.admin-mode .overview-todo-row em{color:var(--warn);font:700 10px var(--font-mono);font-style:normal}
.admin-mode .overview-todo-row b{min-width:0;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;line-height:1.55}
.admin-mode .overview-todo-row time{color:var(--muted);font:10px var(--font-mono);text-align:right}
.overview-todo-more{width:100%;min-height:44px;padding:8px 15px;border:0;background:var(--surface-2);color:var(--accent);font-size:12px;font-weight:700;text-align:left;cursor:pointer}
.overview-todo-more:hover{background:var(--accent-soft)}
.overview-todo-detail{white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:1080px){.admin-mode .admin-health-card{grid-template-columns:1fr;gap:7px}.admin-mode .admin-health-card .health-grid{grid-column:1;grid-row:4}.admin-mode .overview-todo-columns,.admin-mode .overview-todo-row{grid-template-columns:minmax(95px,130px) 68px minmax(0,1fr) 92px 16px;gap:7px}}
@media(max-width:760px){.admin-mode .overview-todo-columns{display:none}.admin-mode .overview-todo-row{grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;align-items:start}.admin-mode .overview-todo-row>span{grid-column:1;grid-row:1}.admin-mode .overview-todo-row em{grid-column:2;grid-row:1}.admin-mode .overview-todo-row b{grid-column:1/-1;grid-row:2}.admin-mode .overview-todo-row time{grid-column:1;grid-row:3;text-align:left}.admin-mode .overview-todo-row i{grid-column:2;grid-row:3;text-align:right}}
/* Portfolio / project records */
.portfolio-overview{display:flex;flex-direction:column;gap:12px}.portfolio-head{padding:18px 20px;display:flex;align-items:flex-end;justify-content:space-between;gap:20px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r)}.portfolio-head>div>span{color:var(--accent);font:700 11px var(--font-mono)}.portfolio-head h3{margin:5px 0 4px;font-size:19px}.portfolio-head p{max-width:720px;margin:0;color:var(--muted);font-size:12px}.portfolio-head>b{font-size:28px}.portfolio-list{display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);overflow:hidden}.portfolio-record{width:100%;min-height:142px;padding:0;display:grid;grid-template-columns:210px minmax(0,1fr) 28px;grid-template-rows:1fr auto;column-gap:18px;background:transparent;border:0;border-bottom:1px solid var(--line);text-align:left;cursor:pointer}.portfolio-record:last-child{border-bottom:0}.portfolio-record:hover{background:var(--surface-2)}.portfolio-identity{grid-row:1/3;padding:18px;border-right:1px solid var(--line);display:flex;flex-direction:column;justify-content:space-between}.portfolio-identity>div:first-child{display:flex;flex-direction:column;gap:3px}.portfolio-identity b{font-size:15px}.portfolio-identity>div:first-child span{color:var(--accent);font:700 11px var(--font-mono)}.portfolio-meta{display:flex;flex-direction:column;gap:4px;color:var(--muted);font-size:11px}.portfolio-overview{padding:16px 0 10px}.portfolio-overview p{margin:6px 0 10px;color:var(--text);font-size:12px;line-height:1.55;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.record-label{color:var(--muted);font:700 10px var(--font-mono);letter-spacing:.04em}.layer-status{display:flex;gap:6px;flex-wrap:wrap}.layer-status span{padding:3px 6px;background:var(--surface-2);border-radius:999px;color:var(--muted);font:700 10px var(--font-mono)}.layer-status .ok{color:var(--success);background:var(--success-soft)}.layer-status .warn{color:var(--warn);background:var(--warn-soft)}.layer-status .bad{color:var(--danger);background:var(--danger-soft)}.portfolio-todos{padding:10px 0 16px;border-top:1px dashed var(--line);display:flex;flex-direction:column;gap:4px}.portfolio-todos>span{color:var(--text);font-size:11px}.portfolio-record>i{grid-column:3;grid-row:1/3;align-self:center;color:var(--accent);font-style:normal}.project-overview-detail{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(260px,.75fr);gap:14px}.project-truth,.project-next{background:var(--surface);border:1px solid var(--line);border-radius:var(--r)}.project-truth{padding:20px}.detail-heading{display:flex;justify-content:space-between;gap:12px;color:var(--accent);font:700 10px var(--font-mono)}.detail-heading small{color:var(--muted)}.project-truth h3{margin:7px 0 8px;font-size:19px}.project-truth>p{margin:0;color:var(--text);line-height:1.7}.provenance-strip{margin-top:18px;padding-top:12px;display:flex;gap:7px;flex-wrap:wrap;border-top:1px solid var(--line)}.provenance-strip span{padding:5px 7px;background:var(--surface-2);border-radius:var(--r-sm);color:var(--muted);font:10px var(--font-mono)}.provenance-strip b{color:var(--text)}.provenance-strip .bad{color:var(--danger);background:var(--danger-soft)}.project-layer-links{grid-column:1/-1;display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.project-layer-links button{min-height:58px;padding:10px 12px;display:flex;flex-direction:column;align-items:flex-start;gap:2px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-sm);cursor:pointer}.project-layer-links b{color:var(--accent);font:700 11px var(--font-mono)}.project-layer-links span{font-size:11px}
.project-ledger{display:flex!important;flex-direction:column;gap:0!important;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);overflow:hidden}.project-ledger-record{width:100%;min-height:150px;padding:0;display:grid;grid-template-columns:220px minmax(0,1fr) 28px;grid-template-rows:1fr auto;column-gap:18px;background:transparent;border:0;border-bottom:1px solid var(--line);text-align:left;cursor:pointer}.project-ledger-record:last-child{border-bottom:0}.project-ledger-record:hover{background:var(--surface-2)}.project-ledger-identity{grid-row:1/3;padding:18px;border-right:1px solid var(--line);display:flex;flex-direction:column;justify-content:space-between}.project-ledger-identity h3{margin:0 0 5px;font-size:16px}.project-identity-meta{display:flex;flex-direction:column;gap:4px;color:var(--muted);font-size:11px}.project-ledger-overview{padding:16px 0 10px}.project-ledger-overview p{margin:6px 0 7px;color:var(--text);font-size:12px;line-height:1.55;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.project-ledger-overview small{color:var(--muted);font-size:10px}.project-ledger-todos{padding:10px 0 15px;border-top:1px dashed var(--line);display:grid;grid-template-columns:92px minmax(0,1fr);gap:10px}.project-ledger-todos>div:first-child{display:flex;align-items:center;gap:7px}.project-ledger-todos b{font-size:14px}.project-todo-lines{display:flex;flex-direction:column;gap:3px}.project-todo-lines span{color:var(--text);font-size:11px}.project-ledger-record>i{grid-column:3;grid-row:1/3;align-self:center;color:var(--accent);font-style:normal}
/* Records */
.project-grid{display:flex!important;flex-direction:column;gap:0!important;border-top:1px solid var(--line)}.project-card{width:100%;min-height:128px;padding:18px 8px;display:grid;grid-template-columns:170px minmax(0,1fr) 180px;gap:22px;align-items:start;background:transparent;border:0;border-bottom:1px solid var(--line);text-align:left;cursor:pointer}.project-card:hover{background:var(--surface)}.project-card-top{display:flex;flex-direction:column;gap:7px}.project-slug{color:var(--accent);font:700 11px var(--font-mono)}.state-dot{color:var(--muted);font:11px var(--font-mono)}.project-card h3{margin:0 0 6px;font-size:17px}.project-card>p{margin:0;color:var(--muted);font-size:12px;line-height:1.65}.project-todo-preview{display:flex;flex-direction:column;gap:4px;color:var(--text)}.project-todo-preview>span{font-size:12px;font-weight:700}.project-todo-preview small{color:var(--muted);font-size:11px}.project-card-foot{grid-column:2/4;margin-top:8px;padding-top:8px;display:flex;justify-content:space-between;gap:12px;color:var(--muted);font-size:11px}.turn-list,.memory-list,.job-list{border-top:1px solid var(--line)}.turn-row{width:100%;padding:16px 6px;display:grid;grid-template-columns:160px minmax(0,1fr) 160px;gap:18px;border:0;border-bottom:1px solid var(--line);background:transparent;text-align:left;cursor:pointer}.turn-row:hover,.memory-row:hover,.job-row:hover{background:var(--surface)}.turn-meta{display:flex;flex-direction:column;gap:4px;color:var(--muted);font:11px var(--font-mono)}.turn-meta span{color:var(--accent)}.turn-copy p{margin:0 0 7px;color:var(--text);font-size:12px;line-height:1.6}.turn-copy strong{display:inline-block;width:20px;color:var(--accent);font:700 11px var(--font-mono)}.turn-project{color:var(--muted);font:11px var(--font-mono);text-align:right}.artifact-list{display:flex;flex-direction:column;gap:12px}.artifact-card{padding:20px 22px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r)}.artifact-head{display:grid;grid-template-columns:140px minmax(0,1fr) auto;gap:18px;align-items:start;padding-bottom:15px;border-bottom:1px solid var(--line)}.layer-token{color:var(--accent);font:700 11px var(--font-mono)}.artifact-card.l4 .layer-token{color:var(--warn)}.artifact-head h3{margin:0;font-size:18px}.artifact-head time,.artifact-head small{color:var(--muted);font:11px var(--font-mono)}.artifact-prose p,.artifact-points li,.timeline-copy p{color:var(--text);font-size:13px;line-height:1.72}.artifact-points{padding-left:20px}.timeline-event{display:grid;grid-template-columns:130px minmax(0,1fr);gap:20px;padding:15px 0;border-bottom:1px solid var(--line)}.timeline-date{color:var(--accent);font:700 11px var(--font-mono)}.timeline-copy h4{margin:0 0 7px;font-size:13px}.timeline-copy p{margin:0}.timeline-context{display:flex;justify-content:space-between;gap:12px;margin-bottom:7px;color:var(--muted);font-size:11px}.memory-row{width:100%;padding:15px 6px;display:grid;grid-template-columns:56px minmax(0,1fr) 20px;gap:14px;border:0;border-bottom:1px solid var(--line);background:transparent;text-align:left;cursor:pointer}.memory-row h3{margin:0;font-size:14px}.memory-row p{margin:5px 0;color:var(--muted);font-size:12px;line-height:1.6}.memory-row small{color:var(--muted);font:11px var(--font-mono)}
/* Processing/admin */
.account-list{display:flex!important;flex-direction:column;gap:0!important;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);overflow:hidden}.account-record{min-width:0;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line)}.account-record:last-child{border-bottom:0}.account-record-main{min-width:0;min-height:60px;display:flex;flex-direction:column;justify-content:center;gap:5px;padding:0;text-align:left;background:none;border:0;cursor:pointer}.account-record-main:hover .account-identity{color:var(--accent)}.account-identity{font-size:15px;overflow-wrap:anywhere}.account-record-meta{display:flex;align-items:center;gap:9px;flex-wrap:wrap;color:var(--muted);font-size:11px}.account-record-meta code{font:11px var(--font-mono);overflow-wrap:anywhere}.account-role{padding:2px 7px;border-radius:var(--r-sm);background:var(--surface-2);color:var(--text);font:700 10px var(--font-mono);text-transform:uppercase}.account-selected{color:var(--success);font-size:11px;font-weight:700}.account-copy{min-height:44px;white-space:nowrap}
.processing-view{display:flex;flex-direction:column;gap:16px}.policy-card{padding:18px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);display:grid;grid-template-columns:minmax(190px,.55fr) minmax(0,1.45fr);gap:24px}.policy-card>div:first-child>span{color:var(--warn);font:700 11px var(--font-mono)}.policy-card h3{margin:7px 0;font-size:16px}.policy-card p{margin:0;color:var(--muted);font-size:12px}.policy-controls{display:grid;grid-template-columns:minmax(132px,1.2fr) repeat(2,minmax(108px,.8fr)) auto;gap:10px;align-items:end}.policy-controls label{min-width:0;display:flex;flex-direction:column;gap:6px;color:var(--muted);font-size:11px;font-weight:700}.policy-controls input[type=number]{width:100%;height:44px;padding:0 9px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r-sm)}.policy-controls .toggle-field{min-height:44px;padding-bottom:2px;flex-direction:row;align-items:center;justify-content:flex-start;gap:10px;color:var(--text);font-size:12px;cursor:pointer}.toggle-field input[type=checkbox]{appearance:none;-webkit-appearance:none;position:relative;flex:none;width:40px;height:24px;margin:0;border:1px solid var(--line-strong);border-radius:999px;background:var(--surface-3);cursor:pointer;transition:background .16s var(--ease)}.toggle-field input[type=checkbox]::before{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:var(--surface);box-shadow:0 1px 3px rgba(0,0,0,.18);transition:transform .16s var(--ease)}.toggle-field input[type=checkbox]:checked{background:var(--accent);border-color:var(--accent)}.toggle-field input[type=checkbox]:checked::before{transform:translateX(16px)}.policy-save{min-height:44px;white-space:nowrap}.job-row{width:100%;min-height:68px;padding:10px 7px;display:grid;grid-template-columns:90px minmax(0,1fr) 170px;gap:14px;align-items:center;border:0;border-bottom:1px solid var(--line);background:transparent;text-align:left;cursor:pointer}.job-state{font:700 11px var(--font-mono);text-transform:uppercase}.job-state.failed{color:var(--danger)}.job-state.pending,.job-state.leased{color:var(--warn)}.job-state.complete,.job-state.completed,.job-state.succeeded{color:var(--success)}.job-row>div{display:flex;flex-direction:column}.job-row b{font-size:12px}.job-row small,.job-row time{color:var(--muted);font:11px var(--font-mono)}.job-row time{text-align:right}.empty-state{padding:50px 20px;text-align:center;background:var(--surface);border:1px solid var(--line);border-radius:var(--r)}.empty-state>span{color:var(--accent);font:700 11px var(--font-mono)}.empty-state h3{margin:9px 0 6px;font-size:20px}.empty-state p{max-width:540px;margin:0 auto 16px;color:var(--muted)}.load-error>span{color:var(--danger)}.load-error-details{max-width:650px;margin:18px auto 0;text-align:left}.load-error-details pre{overflow:auto;white-space:pre-wrap;color:var(--muted);font:11px var(--font-mono)}
.lifecycle-section{margin-top:34px;padding-top:20px;border-top:1px solid var(--line)}.lifecycle-heading{display:flex;justify-content:space-between;gap:14px;margin-bottom:10px}.lifecycle-heading>span{font-weight:700}.lifecycle-heading>small{color:var(--muted);font-size:12px}.memory-flow{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 26px minmax(0,1fr) 26px minmax(0,1fr) 26px minmax(0,1fr);align-items:center}.memory-flow::before{content:"";position:absolute;left:5%;right:5%;top:50%;height:1px;background:var(--line-strong)}.memory-flow>i{position:relative;z-index:1;display:grid;place-items:center;background:var(--canvas);color:var(--muted);font-style:normal}.memory-flow>button{position:relative;z-index:1;min-height:64px;padding:9px 11px;display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:7px;align-items:center;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-sm);text-align:left;cursor:pointer}.memory-flow>button:hover{border-color:var(--line-strong)}.memory-flow>button.active{border-color:var(--accent);background:var(--accent-soft)}.flow-index{color:var(--accent);font:700 11px var(--font-mono)}.memory-flow>button>div{display:flex;flex-direction:column}.memory-flow b{font-size:12px}.memory-flow small{color:var(--muted);font-size:11px}.memory-flow em{color:var(--accent);font:700 12px var(--font-mono);font-style:normal}
/* Recoverable processing failures are readable and actionable without opening raw JSON. */
.job-entry{min-width:0;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:stretch;border-bottom:1px solid var(--line)}
.job-entry .job-row{min-width:0;border-bottom:0}
.job-entry:not(.is-failed) .job-row{grid-column:1/-1}
.job-entry .job-row>div{min-width:0}
.job-error{margin-top:5px;color:var(--danger)!important;font-family:var(--font-sans)!important;line-height:1.5!important;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.job-quick-retry{align-self:center;min-height:44px;margin:8px 8px 8px 0;white-space:nowrap}
@media(max-width:500px){.job-entry{grid-template-columns:minmax(0,1fr)}.job-quick-retry{justify-self:start;margin:0 0 10px 7px}}
.account-detail,.job-detail{display:grid;gap:0;margin:18px 0;border:1px solid var(--line);border-radius:var(--r-sm);overflow:hidden}.account-detail>div,.job-detail>div{display:grid;grid-template-columns:130px minmax(0,1fr);gap:12px;padding:12px;border-bottom:1px solid var(--line)}.account-detail>div:last-child,.job-detail>div:last-child{border-bottom:0}.account-detail span,.job-detail span{color:var(--muted);font-size:11px}.account-detail b,.job-detail b,.account-detail code{min-width:0;overflow-wrap:anywhere;font-size:12px}.account-detail code{font-family:var(--font-mono)}.job-detail .job-failure-detail{display:block;background:var(--danger-soft)}.job-failure-detail p{margin:5px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--danger);font-size:12px}
@media(max-width:500px){.account-detail>div,.job-detail>div{grid-template-columns:1fr;gap:4px}}
/* Drawer/forms */
.drawer{position:fixed;z-index:110;top:var(--header-h);right:0;width:min(620px,100vw);height:calc(100vh - var(--header-h));padding:30px;overflow:auto;background:var(--surface);border-left:1px solid var(--line);box-shadow:-18px 0 54px rgba(0,0,0,.18);overscroll-behavior:contain}.memory-console-body:has(.drawer:not(.hidden))::before{content:"";position:fixed;inset:var(--header-h) 0 0;z-index:100;background:rgba(8,10,14,.28)}.drawer-close{float:right;width:44px;height:44px;border:1px solid var(--line);border-radius:50%;background:transparent;cursor:pointer}.drawer-kicker{padding-top:4px;color:var(--accent);font:700 11px var(--font-mono)}.drawer h2{margin:9px 54px 16px 0;font-size:25px}.drawer-summary{color:var(--muted);line-height:1.7}.impact-box{margin:14px 0 20px;padding:15px 16px;background:var(--surface-2);border-left:3px solid var(--warn);border-radius:var(--r-sm)}.impact-box>span{display:block;color:var(--muted);font-size:11px}.impact-box>b{display:block;margin-top:3px;font:700 13px var(--font-mono)}.impact-box>p{margin:8px 0 0;color:var(--muted);font-size:12px;line-height:1.65}.danger-impact{border-left-color:var(--danger);background:var(--danger-soft)}.drawer details{margin-top:22px;padding-top:14px;border-top:1px solid var(--line)}.drawer summary{cursor:pointer;font-size:12px;font-weight:700}.drawer pre{padding:13px;overflow:auto;background:var(--surface-2);border:1px solid var(--line);white-space:pre-wrap;font:11px/1.6 var(--font-mono)}.actions{display:flex;flex-wrap:wrap;gap:7px;margin:18px 0}.project-form,.todo-manager{display:flex;flex-direction:column;gap:14px}.project-form label{display:flex;flex-direction:column;gap:6px;color:var(--muted);font-size:12px}.project-form input,.project-form select,.project-form textarea,.todo-add input{width:100%;min-height:44px;padding:10px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r-sm);outline:none}.project-form input:focus,.project-form select:focus,.project-form textarea:focus,.todo-add input:focus{border-color:var(--accent)}.todo-add{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}.todo-manager-head{display:flex;justify-content:space-between;gap:12px;padding-bottom:9px;border-bottom:1px solid var(--line)}.todo-manager-head span{color:var(--muted);font-size:12px}.todo-manager-head b{font:700 11px var(--font-mono)}.todo-row{min-height:56px;padding:10px 0;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;border-bottom:1px solid var(--line)}.todo-row b{font-size:12px}.todo-row small{color:var(--muted);font:11px var(--font-mono)}.toast{position:fixed;z-index:130;right:18px;bottom:18px;padding:11px 14px;background:var(--ink);color:var(--canvas);border-radius:var(--r-sm);font-size:12px;box-shadow:var(--shadow)}button[aria-busy="true"],input[aria-busy="true"],select[aria-busy="true"],textarea[aria-busy="true"]{cursor:wait!important;opacity:.62}
/* Account and project scope are a single, full-width control plane, not a narrow hero sidebar. */
.workspace-head{display:block;padding-bottom:16px}.workspace-head.compact{padding-bottom:12px}.scope-controls{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);max-width:900px;margin:0 0 14px;gap:14px;justify-content:start;align-items:end}.scope-controls>.console-select:only-child{max-width:420px}.console-select select{min-width:0;height:44px;font-size:13px;text-overflow:clip}.account-scope{min-width:0}.scope-status{min-height:36px}.scope-status>b{font:700 11px var(--font-mono);text-transform:uppercase}.workspace-head.compact~.panel .panel-head>div:first-child,.admin-mode .panel-head.overview-head>div:first-child{display:none}.admin-mode .panel-head.overview-head{padding-bottom:0}
@media(max-width:1100px){.landing-hero-v2{grid-template-columns:1fr;min-height:auto}.workspace-preview{max-width:760px}.memory-model-v2{grid-template-columns:1fr;gap:34px}.workspace-head{grid-template-columns:1fr;gap:20px}.scope-controls{justify-content:flex-start}.personal-overview,.governance-overview{grid-template-columns:1fr}.policy-card{grid-template-columns:1fr}.project-card{grid-template-columns:150px minmax(0,1fr) 160px}.admin-shell{grid-template-columns:210px minmax(0,1fr)}}
@media(max-width:900px){.landing-header .desktop-nav>a:not(.header-cta),.docs-header .desktop-nav>a{display:none}.landing-header .mobile-menu-toggle,.docs-header .mobile-menu-toggle,.console-topbar .mobile-menu-toggle{display:inline-flex}.site-header nav>a,.ui-toggle,.mobile-menu-toggle{min-height:44px}.ui-toggle,.mobile-menu-toggle{min-width:44px}.quickstart-steps{grid-template-columns:1fr}.memory-model-v2{padding-top:70px}.landing-support{grid-template-columns:1fr}.docs-main{grid-template-columns:1fr;gap:24px}.docs-sidebar{position:static;display:flex;flex-direction:row;overflow-x:auto;padding-bottom:6px}.docs-sidebar>span{display:none}.docs-sidebar a{min-width:max-content}.admin-shell{display:block}.console-sidebar{display:none}.console{padding-inline:clamp(18px,4vw,34px)}.mobile-view-control{margin:18px 0 0;display:flex;flex-direction:column;gap:6px;color:var(--muted);font-size:11px;font-weight:700}.mobile-view-control select{height:46px;padding:0 38px 0 12px;background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--r-sm);font-size:13px}.workspace-head{padding-top:24px}.topbar-center>a:not([aria-current="page"]){display:none}.project-card{grid-template-columns:130px minmax(0,1fr)}.project-todo-preview{grid-column:2}.project-card-foot{grid-column:2}.policy-card{grid-template-columns:1fr}.policy-controls{grid-template-columns:1fr 1fr}.overview-links{grid-template-columns:repeat(2,minmax(0,1fr))}.overview-card:nth-child(3n){border-right:1px solid var(--line)}.overview-card:nth-child(2n){border-right:0}}
@media(max-width:760px){.site-header{padding:0 12px;gap:8px}.site-mark,.ui-toggle,.mobile-menu-toggle,.site-header nav>a{min-width:44px;min-height:44px}.brand-copy>small,.account-chip,.logout{display:none}.landing-main{padding-inline:18px}.landing-hero-v2{padding:48px 0 56px;gap:38px}.landing-copy h1{font-size:clamp(38px,10vw,46px);line-height:1.1;letter-spacing:-.035em}.landing-copy>p{font-size:15px}.workspace-preview{box-shadow:none}.preview-layers{grid-template-columns:1fr 1fr;gap:8px}.preview-layers i{display:none}.preview-layers>span{min-height:55px;padding:8px;background:var(--surface-2);border-radius:var(--r-sm)}.quickstart,.workflow-section,.memory-model-v2{padding:64px 0}.section-heading h2{font-size:30px}.workflow-list article{grid-template-columns:1fr;gap:5px}.model-rail{padding-left:0}.landing-cta{align-items:flex-start;flex-direction:column;padding:28px 24px}.landing-cta h2{font-size:25px}footer{align-items:flex-start;flex-direction:column}.docs-content>h1{font-size:30px}.docs-step{grid-template-columns:42px minmax(0,1fr)}.workspace-head h1{font-size:28px}.scope-controls{width:100%;flex-direction:column;align-items:stretch}.console-select{width:100%}.scope-status{grid-template-columns:auto minmax(0,1fr);padding:9px 0}.scope-status>i,.scope-status>small{display:none}.panel-head{align-items:flex-start;flex-direction:column}.admin-toolbar{width:100%;justify-content:flex-start}.admin-toolbar input{width:auto;min-width:0;flex:1}.last-refreshed{width:100%;text-align:left}.overview-links{grid-template-columns:1fr}.overview-card:nth-child(n){border-right:0}.overview-todo-row{grid-template-columns:1fr 18px}.overview-todo-row span,.overview-todo-row b{grid-column:1}.overview-todo-row i{grid-column:2;grid-row:1/3}.project-card{grid-template-columns:1fr;gap:8px}.project-card-top{flex-direction:row;justify-content:space-between}.project-todo-preview,.project-card-foot{grid-column:1}.turn-row{grid-template-columns:1fr;gap:8px}.turn-meta{display:grid;grid-template-columns:auto auto 1fr}.turn-meta time{text-align:right}.turn-project{text-align:left}.artifact-head{grid-template-columns:1fr;gap:8px}.timeline-event{grid-template-columns:92px minmax(0,1fr)}.memory-row{grid-template-columns:48px minmax(0,1fr)}.memory-row>i{display:none}.policy-controls{grid-template-columns:1fr}.policy-controls>*{grid-column:1!important}.job-row{grid-template-columns:80px minmax(0,1fr)}.job-row time{grid-column:2;text-align:left}.lifecycle-heading{align-items:flex-start;flex-direction:column}.memory-flow{grid-template-columns:repeat(4,minmax(0,1fr));gap:5px}.memory-flow::before{left:8%;right:8%}.memory-flow>i{display:none}.memory-flow>button{min-width:0;min-height:70px;padding:8px;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:2px}.memory-flow .flow-index{display:none}.memory-flow small{white-space:normal;line-height:1.25}.memory-flow em{margin-top:2px}.drawer{width:100vw;padding:22px}.todo-add{grid-template-columns:1fr}.toast{left:14px;right:14px;bottom:14px}}
@media(max-width:500px){.topbar-center{display:none}.brand-copy>b{font-size:13px}.landing-header .header-cta{display:none}.landing-header .ui-controls{margin-left:auto}.hero-proof{gap:9px 14px}.preview-top{align-items:flex-start}.preview-top small{display:none}.landing-support>a{min-height:104px}.console{padding-inline:14px}.workspace-head{padding-top:20px}.workspace-head p{font-size:13px}.panel{padding-top:22px}.panel-head h2{font-size:22px}.admin-toolbar{display:grid;grid-template-columns:minmax(0,1fr) auto auto}.admin-toolbar input{width:100%}.last-refreshed{grid-column:1/-1}.stats article{min-width:calc(50% - 4px);flex:1}.memory-flow>button{font-size:11px}.memory-flow b{font-size:11px}.memory-flow small{font-size:10px}.memory-flow em{font-size:11px}}
@media(max-width:1100px){.hero-product-proof{max-width:820px}.project-overview-detail{grid-template-columns:1fr}.project-layer-links{grid-column:1}.portfolio-record{grid-template-columns:190px minmax(0,1fr) 26px}.project-ledger-record{grid-template-columns:190px minmax(0,1fr) 26px}}
@media(max-width:900px){.value-strip{grid-template-columns:1fr}.value-strip article{min-height:auto;border-right:0;border-bottom:1px solid var(--line)}.value-strip article:last-child{border-bottom:0}.model-rail{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.model-rail>i{display:none}.model-rail article{min-height:240px}.skill-plane{margin:18px 0 0}.skill-plane::before{left:12%;right:12%}.portfolio-record,.project-ledger-record{grid-template-columns:170px minmax(0,1fr) 24px}.console-sidebar-brand{display:none}.docs-sidebar-brand{display:none!important}}
@media(max-width:760px){.hero-product-proof{min-height:0}.memory-topology{min-height:360px;padding:14px;box-shadow:none}.hero-product-proof .workspace-preview{margin:-30px 10px 0 24px}.continuity-value{padding:60px 0}.model-rail{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.model-rail article{min-height:230px;padding:15px}.model-rail dl{grid-template-columns:62px minmax(0,1fr);row-gap:7px}.skill-plane{grid-template-columns:1fr;gap:10px}.skill-plane-links{justify-content:flex-start}.portfolio-head{align-items:flex-start}.portfolio-record,.project-ledger-record{min-height:0;grid-template-columns:1fr;grid-template-rows:auto auto auto;padding:0}.portfolio-identity,.project-ledger-identity{grid-row:auto;padding:14px;border-right:0;border-bottom:1px solid var(--line);flex-direction:row;align-items:flex-end;gap:12px}.portfolio-meta,.project-identity-meta{align-items:flex-end}.portfolio-overview,.project-ledger-overview{padding:14px}.portfolio-todos,.project-ledger-todos{padding:12px 14px;border-top:1px dashed var(--line)}.portfolio-record>i,.project-ledger-record>i{display:none}.project-layer-links{grid-template-columns:repeat(2,1fr)}.project-ledger-todos{grid-template-columns:82px minmax(0,1fr)}}
@media(max-width:500px){.topology-stage{grid-template-columns:1fr 1fr 1fr}.topology-node,.topology-outputs span,.topology-core-row span{padding-inline:6px;font-size:10px}.hero-product-proof .workspace-preview{margin:-18px 0 0 10px}.model-rail article{min-height:0}.model-rail dl{display:block}.model-rail dt{margin-top:8px}.model-rail dd{margin-top:2px}.portfolio-head{padding:15px}.portfolio-head>b{font-size:22px}.portfolio-identity,.project-ledger-identity{align-items:flex-start;flex-direction:column}.portfolio-meta,.project-identity-meta{align-items:flex-start}.project-layer-links{grid-template-columns:1fr 1fr}}
@media(max-width:1080px){.docs-main{grid-template-columns:190px minmax(0,1fr);gap:34px;padding-inline:28px}.docs-task-meta{grid-template-columns:minmax(0,1fr) 120px}.docs-task-meta>div:last-child{grid-column:1/-1}.docs-page-toc{grid-template-columns:125px minmax(0,1fr)}}
@media(max-width:900px){.docs-main{grid-template-columns:1fr;gap:26px;padding-top:26px}.docs-sidebar{position:static;max-height:none;display:flex;flex-direction:row;overflow-x:auto;padding-bottom:6px;scrollbar-width:thin}.docs-sidebar-brand,.docs-sidebar>span{display:none!important}.docs-sidebar>a{min-width:max-content}.docs-content{max-width:none}.docs-markdown{max-width:780px}.docs-page-toc{max-width:780px}}
@media(max-width:760px){.docs-main{padding:22px 18px 68px}.docs-content>h1{font-size:31px}.docs-lead{margin-bottom:20px;font-size:15px}.docs-task-meta{grid-template-columns:1fr;gap:10px}.docs-task-meta>div:last-child{grid-column:auto}.docs-page-toc{grid-template-columns:1fr;padding:14px}.docs-page-toc>span{grid-row:auto;margin-bottom:4px}.docs-page-toc>a{min-height:44px}.docs-markdown h2{margin-top:44px;font-size:22px}.docs-markdown p{font-size:14px;line-height:1.82}.docs-code{margin-inline:0}.docs-pagination{grid-template-columns:1fr}.docs-pagination>a:last-child{text-align:left;align-items:flex-start}}
@media(max-width:420px){.docs-main{padding-inline:14px}.docs-task-meta{padding:13px}.docs-page-toc{margin-bottom:28px}.docs-code pre{padding:14px}.docs-footer-links{gap:12px}}
/* Docs section navigation: a sticky reading rail on desktop and a disclosure on narrower screens. */
.docs-page-toc{display:block;max-width:none;padding:0;overflow:hidden}.docs-page-toc summary{min-height:48px;padding:12px 17px;display:flex;align-items:center;cursor:pointer;color:var(--accent);font:700 12px var(--font-sans);list-style-position:inside}.docs-page-toc summary::marker{color:var(--accent)}.docs-page-toc nav{display:grid;padding:0 16px 12px;gap:1px}.docs-page-toc nav a{min-height:44px;display:flex;align-items:center;text-decoration:none;color:var(--text);font-size:12px}.docs-page-toc nav a:hover{color:var(--accent)}
.docs-section-rail{display:none;min-width:0}.docs-rail-heading{color:var(--accent);font:700 11px var(--font-mono);letter-spacing:.05em}.docs-section-rail nav{display:flex;flex-direction:column;gap:3px;margin-top:13px}.docs-section-rail nav a{min-height:37px;padding:8px 11px;display:flex;align-items:center;border-left:2px solid transparent;color:var(--muted);font-size:12px;line-height:1.45;text-decoration:none;overflow-wrap:anywhere}.docs-section-rail nav a:hover{background:var(--surface-2);color:var(--ink)}.docs-section-rail nav a[aria-current="location"]{border-left-color:var(--accent);background:var(--accent-soft);color:var(--accent);font-weight:700}.docs-reading-progress{height:3px;margin-top:18px;background:var(--surface-3);border-radius:4px;overflow:hidden}.docs-reading-progress>span{display:block;height:100%;width:0;background:var(--accent);transition:width .12s linear}
@media(min-width:1000px){.docs-main{max-width:1490px;padding-inline:26px;grid-template-columns:175px minmax(0,1fr) 175px;gap:24px}.docs-content{max-width:none}.docs-markdown{max-width:80ch}.docs-page-toc{display:none}.docs-section-rail{position:sticky;top:calc(var(--header-h) + 28px);align-self:start;display:block;max-height:calc(100vh - var(--header-h) - 50px);overflow-y:auto;scrollbar-width:thin}}
@media(min-width:1250px){.docs-main{grid-template-columns:205px minmax(0,1fr) 205px;gap:34px;padding-inline:38px}.docs-markdown{max-width:80ch}}
/* Minor polish after the fresh-eye pass: denser proof, fewer divider-heavy scope cues,
   and more consistent desktop hit areas without changing the established visual system. */
.site-header nav>a,.ui-toggle,.logout,.mobile-menu-toggle{min-height:40px}
.console-sidebar button{min-height:42px}
.docs-section-rail nav a{min-height:40px}
.console-select select,.mobile-view-control select{background-color:var(--surface);color:var(--text)}
.health-metric b,.stats b,.memory-flow em,.overview-todo-row time,.job-row time,.last-refreshed{font-variant-numeric:tabular-nums}
.workspace-head h1,.panel-head h2,.drawer h2,.docs-content>h1{text-wrap:balance}
.turn-row,.memory-row,.job-entry,.project-ledger-record,.portfolio-record,.artifact-card{content-visibility:auto;contain-intrinsic-size:auto 96px}
.preview-status{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));background:var(--surface-2);border-bottom:1px solid var(--line)}
.preview-status>span{min-width:0;padding:11px 12px;display:flex;flex-direction:column;gap:3px;border-right:1px solid var(--line)}
.preview-status>span:last-child{border-right:0}.preview-status b{color:var(--accent);font:700 10px var(--font-mono)}.preview-status small{color:var(--muted);font-size:10px;line-height:1.35}
.scope-status{min-height:38px;padding:7px 10px;background:var(--surface-2);border:0;border-radius:var(--r-sm)}
.scope-status>i{background:var(--line-strong)}
@media(max-width:900px){.site-header nav>a,.ui-toggle,.logout,.mobile-menu-toggle{min-height:44px}}
@media(max-width:500px){.preview-status>span{padding:9px 8px}.preview-status small{font-size:9px}}
/* Keep a 44px actual input hit target while rendering the 40x24 switch inside it. */
.toggle-field input[type=checkbox],.toggle-field input[type=checkbox]:checked{width:44px;height:44px;background:transparent;border:0;border-radius:var(--r-sm)}
.toggle-field input[type=checkbox]::before{top:10px;left:2px;width:40px;height:24px;box-sizing:border-box;border:1px solid var(--line-strong);border-radius:999px;background:var(--surface-3);box-shadow:none;transform:none;transition:background .16s var(--ease)}
.toggle-field input[type=checkbox]::after{content:"";position:absolute;top:14px;left:6px;width:16px;height:16px;border-radius:50%;background:var(--surface);box-shadow:0 1px 3px rgba(0,0,0,.18);transition:transform .16s var(--ease)}
.toggle-field input[type=checkbox]:checked::before{background:var(--accent);border-color:var(--accent);transform:none}
.toggle-field input[type=checkbox]:checked::after{transform:translateX(16px)}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}
`; }


function consoleScript(adminView: boolean): string { return `
const ADMIN=${adminView ? "true" : "false"};
const API=ADMIN?'/memhub/admin/api':'/memhub/user/api';
const ACTION=ADMIN?'/memhub/admin/action':'/memhub/user/action';
const titles=ADMIN?{overview:['系统总览','System overview'],projects:['项目边界','Project boundaries'],l1:['L1 证据','L1 evidence'],l2:['L2 项目时间线','L2 project chronology'],l3:['L3 项目规则','L3 project rules'],l4:['L4 账号画像','L4 account profile'],skills:['Skills','Skills'],processing:['处理队列','Processing'],accounts:['账号与角色','Accounts & roles']}:{overview:['继续工作','Continue working'],projects:['项目','Projects'],l1:['原始证据','Source evidence'],l2:['项目时间线','Project chronology'],l3:['项目规则与经验','Project rules & experience'],l4:['用户画像','User profile'],skills:['Skills','Skills'],processing:['处理状态','Processing status'],accounts:['账号','Accounts']};
const descriptions=ADMIN?{overview:['先确认账号/项目范围，再处理失败、队列与边界。','Confirm account/project scope first, then handle failures, queues, and boundaries.'],projects:['管理项目注册、别名、合并、删除与项目待办。','Manage the project registry, aliases, merge/delete operations, and project todos.'],l1:['检查进入系统的原始证据与来源。','Inspect source evidence entering the system and its provenance.'],l2:['检查项目时间线、状态变化与被替代历史。','Inspect project chronology, state changes, and superseded history.'],l3:['检查项目内长期规则、经验与工作方式。','Inspect durable project rules, experience, and working patterns.'],l4:['检查由多个项目稳定证据形成的账号级画像。','Inspect account-level profile derived from stable evidence across projects.'],skills:['检查可复用能力及其作用域。','Inspect reusable capabilities and their scope.'],processing:['优先处理 failed，再看 pending/leased；自动蒸馏策略也在这里配置。','Handle failed jobs first, then pending/leased; configure automatic distillation here.'],accounts:['管理账号角色与当前操作边界。','Manage account roles and the active administrative boundary.']}:{overview:['先看下一步和最近连续性，再决定是否深入记忆层。','Start with the next step and recent continuity, then inspect deeper memory only when needed.'],projects:['项目是记忆路由与 L2/L3 的边界；近期、有待办的项目优先。','Projects define routing and L2/L3 boundaries; recent projects and those with follow-up come first.'],l1:['查看原始连续对话与可追溯证据。','Inspect source conversation evidence and provenance.'],l2:['按项目查看决策、状态变化和发展时间线。','Review decisions, state changes, and chronology by project.'],l3:['查看项目内稳定规则、偏好、经验和工作方式。','Review stable project-scoped rules, preferences, experience, and working patterns.'],l4:['查看跨多个项目重复出现的稳定用户特征。','Review stable user traits supported across multiple projects.'],skills:['查看可复用的方法，不带入其他项目业务记忆。','Review reusable methods without importing business memory from another project.'],processing:['查看当前处理状态；策略配置只在 Admin 中提供。','Inspect processing status; policy configuration is available only in Admin.'],accounts:['账号','Account']};
const eyebrows={overview:'SYSTEM',projects:'ROUTING',l1:'SOURCE',l2:'PROJECT MEMORY',l3:'DURABLE RULES',l4:'CROSS-PROJECT',skills:'CAPABILITIES',processing:'PIPELINE',accounts:'ACCESS'};
let lang=localStorage.memhubLang||((navigator.language||'').toLowerCase().startsWith('zh')?'zh':'en');
let theme=localStorage.memhubTheme||'light',current='overview',payload=null,controller=null,requestSeq=0,overviewCounts={},lastDrawerTrigger=null,lastDrawerReturnSelector='',lastRefreshAt=0;
const filterInput=document.getElementById('filter'),projectSelect=document.getElementById('project-select'),accountSelect=document.getElementById('account-select'),primaryAction=document.getElementById('primary-action'),mobileViewSelect=document.getElementById('mobile-view-select'),refreshButton=document.getElementById('refresh'),lastRefreshed=document.getElementById('last-refreshed'),workspaceHead=document.getElementById('workspace-head'),workspaceTitle=document.getElementById('workspace-title'),workspaceDescription=document.getElementById('workspace-description'),workspaceKicker=document.getElementById('workspace-kicker');
const validViews=new Set(['overview','projects','l1','l2','l3','l4','skills','processing',...(ADMIN?['accounts']:[])]);
const pendingMutations=new Set();
function syncThemeColor(){const meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.setAttribute('content',theme==='dark'?'#101216':'#f5f6f8')}
function syncUrl(mode='push'){const url=new URL(location.href);url.searchParams.set('view',current);if(projectSelect?.value)url.searchParams.set('project',projectSelect.value);else url.searchParams.delete('project');if(url.href===location.href)return;if(mode==='replace')history.replaceState({view:current,project:projectSelect?.value||''},'',url);else history.pushState({view:current,project:projectSelect?.value||''},'',url)}
function readUrlState(){const url=new URL(location.href);const view=validViews.has(url.searchParams.get('view'))?url.searchParams.get('view'):'overview';const project=url.searchParams.get('project')||'';if(projectSelect){const option=[...projectSelect.options].find(item=>item.value===project);projectSelect.value=option?project:''}return view}
function updateNavAffordance(){const sidebar=document.querySelector('.console-sidebar');if(!sidebar)return;const canRight=sidebar.scrollWidth-sidebar.clientWidth-sidebar.scrollLeft>3;sidebar.classList.toggle('can-scroll-right',innerWidth<=820&&canRight)}
function scrollActiveNav(){const sidebar=document.querySelector('.console-sidebar'),active=sidebar?.querySelector('button.active');if(!sidebar||!active)return;setTimeout(()=>{if(innerWidth<=900)active.scrollIntoView({block:'nearest',inline:'center',behavior:'auto'});updateNavAffordance()},0)}
function drawerFocusables(){const d=document.getElementById('drawer');return [...d.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])')].filter(el=>!el.hidden&&el.getClientRects().length)}
function drawerIsOpen(){const d=document.getElementById('drawer');return !!d&&!d.classList.contains('hidden')}
async function runMutation(key,trigger,task){if(pendingMutations.has(key))return;pendingMutations.add(key);const form=trigger?.form||trigger?.closest?.('form');const controls=form?[...form.querySelectorAll('button,input,select,textarea')]:trigger?[trigger]:[];const state=controls.map(el=>[el,el.disabled,el.getAttribute('aria-busy')]);controls.forEach(el=>{el.disabled=true;el.setAttribute('aria-busy','true')});try{return await task()}finally{state.forEach(([el,disabled,busy])=>{el.disabled=disabled;if(busy===null)el.removeAttribute('aria-busy');else el.setAttribute('aria-busy',busy)});pendingMutations.delete(key)}}
function esc(v){return String(v??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]))}
function fmtTime(v){if(!v)return'';const d=new Date(v);if(Number.isNaN(d.getTime()))return String(v);return new Intl.DateTimeFormat(lang==='zh'?'zh-CN':'en-US',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(d)}
function bodyOf(x){return String(x?.body||x?.content||'').replace(/^artifact:[^\\n]+\\n?/,'').trim()}
function projectOf(x){const explicit=x?.project_id||x?.projectId;if(explicit)return String(explicit);const tag=(Array.isArray(x?.tags)?x.tags:[]).find(t=>typeof t==='string'&&t.startsWith('project:'));return tag?tag.slice(8):''}
function firstParagraph(value){const text=String(value||'').replace(/^#+\\s*/gm,'').trim();return text.split(/\\n\\s*\\n|\\n/).map(x=>x.trim()).find(Boolean)||''}
function syncScopeSummary(){const el=document.getElementById('scope-summary');if(!el)return;el.textContent=accountSelect?.selectedOptions?.[0]?.dataset.role||el.dataset.defaultRole||'user'}
function renderFreshness(){if(!lastRefreshed)return;if(!lastRefreshAt){lastRefreshed.textContent='';return}const sec=Math.max(0,Math.round((Date.now()-lastRefreshAt)/1000));lastRefreshed.textContent=sec<5?(lang==='zh'?'刚刚更新':'Updated now'):sec<60?(lang==='zh'?sec+' 秒前更新':'Updated '+sec+'s ago'):(lang==='zh'?Math.floor(sec/60)+' 分钟前更新':'Updated '+Math.floor(sec/60)+'m ago')}
function cleanHeading(v){return String(v||'').replace(/^#+\\s*/,'').trim()}
function paragraphsOf(lines){const out=[];let buffer=[];const flush=()=>{const text=buffer.join(' ').trim();if(text)out.push(text);buffer=[]};for(const raw of lines){const line=String(raw||'').trim();if(!line){flush();continue}if(/^[-*]\\s+/.test(line)){flush();out.push(line.replace(/^[-*]\\s+/,''));continue}buffer.push(line)}flush();return out}
function timelineSections(body){const lines=String(body||'').split(/\\r?\\n/);const sections=[];let currentSection=null;for(const raw of lines){const line=raw.trim();if(/^#\\s+/.test(line))continue;if(/^##\\s+/.test(line)){if(currentSection)sections.push(currentSection);const heading=cleanHeading(line);const m=heading.match(/^(\\d{4}-\\d{2}-\\d{2})(?:[：:\\s—-]+)?(.*)$/);currentSection={date:m?.[1]||'',title:(m?.[2]||heading).trim(),lines:[]};continue}if(currentSection)currentSection.lines.push(raw)}if(currentSection)sections.push(currentSection);if(!sections.length&&body.trim())sections.push({date:'',title:'',lines:lines.filter(line=>!/^#\\s+/.test(line.trim()))});return sections.map(section=>({...section,paragraphs:paragraphsOf(section.lines)}))}
function bulletItems(body){return String(body||'').split(/\\r?\\n/).map(line=>line.trim()).filter(line=>/^[-*]\\s+/.test(line)).map(line=>line.replace(/^[-*]\\s+/,''))}
function artifactBodyHtml(x,layer){const body=bodyOf(x);if(!body)return '<p class="artifact-empty">'+(lang==='zh'?'正文暂不可用':'Artifact body unavailable')+'</p>';if(layer==='l2'){const sections=timelineSections(body);return '<div class="timeline">'+sections.map(section=>'<article class="timeline-event"><div class="timeline-date">'+esc(section.date||'—')+'</div><div class="timeline-copy">'+(section.title?'<h4>'+esc(section.title)+'</h4>':'')+section.paragraphs.map(p=>'<p>'+esc(p)+'</p>').join('')+'</div></article>').join('')+'</div>'}const bullets=bulletItems(body);if(bullets.length)return '<ul class="artifact-points">'+bullets.map(item=>'<li>'+esc(item)+'</li>').join('')+'</ul>';return '<div class="artifact-prose">'+paragraphsOf(body.split(/\\r?\\n/).filter(line=>!/^#/.test(line.trim()))).map(p=>'<p>'+esc(p)+'</p>').join('')+'</div>'}
function l2FeedHtml(items){const events=[];items.forEach((x,itemIndex)=>timelineSections(bodyOf(x)).forEach((section,sectionIndex)=>events.push({itemIndex,sectionIndex,project:projectOf(x)||(lang==='zh'?'未标记项目':'Unscoped project'),updated:x.updatedAt||x.updated_at||'',...section})));events.sort((a,b)=>{const ad=a.date||'9999-99-99',bd=b.date||'9999-99-99';return ad.localeCompare(bd)||a.project.localeCompare(b.project)||a.sectionIndex-b.sectionIndex});return events.length?'<section class="artifact-card l2 timeline-feed-card"><div class="artifact-head timeline-feed-head"><div><span class="layer-token">L2</span><small>'+(lang==='zh'?'跨项目时间流':'Cross-project chronology')+'</small></div><div><h3>'+(lang==='zh'?'按时间顺序发生了什么':'What happened, in chronological order')+'</h3><time>'+esc(events.length)+' '+(lang==='zh'?'个时间节点':'timeline events')+'</time></div></div><div class="timeline global-timeline">'+events.map(event=>'<article class="timeline-event"><div class="timeline-date">'+esc(event.date||'—')+'</div><div class="timeline-copy"><div class="timeline-context"><span>'+esc(event.project)+'</span><button type="button" class="soft" data-item-index="'+event.itemIndex+'" onclick="openItem('+event.itemIndex+')">'+(lang==='zh'?'项目详情':'Project details')+'</button></div>'+(event.title?'<h4>'+esc(event.title)+'</h4>':'')+event.paragraphs.map(p=>'<p>'+esc(p)+'</p>').join('')+'</div></article>').join('')+'</div></section>':emptyState()}
function tr(){document.documentElement.lang=lang==='zh'?'zh-CN':'en';document.documentElement.dataset.theme=theme;syncThemeColor();document.querySelectorAll('[data-zh][data-en]').forEach(x=>x.textContent=x.dataset[lang]||x.textContent);document.querySelectorAll('[data-zh-aria-label][data-en-aria-label]').forEach(x=>x.setAttribute('aria-label',x.dataset[lang+'AriaLabel']||x.getAttribute('aria-label')||''));document.getElementById('lang').textContent=lang==='zh'?'EN':'中文';document.getElementById('theme-toggle').textContent=theme==='dark'?(lang==='zh'?'亮色':'Light'):(lang==='zh'?'暗色':'Dark');filterInput.placeholder=lang==='zh'?'搜索当前视图…':'Search current view…';filterInput.setAttribute('aria-label',filterInput.placeholder);const rs=refreshButton?.querySelector('span');if(rs)rs.textContent=lang==='zh'?'刷新':'Refresh';updateToolbar();syncScopeSummary();renderFreshness();renderCurrent()}
function query(kind){const q=new URLSearchParams({kind});if(ADMIN&&accountSelect?.value)q.set('account_id',accountSelect.value);if(projectSelect?.value)q.set('project',projectSelect.value);return API+'?'+q.toString()}
function values(data){if(!data||typeof data!=='object')return[];for(const key of ['items','tasks','memories','skills','records'])if(Array.isArray(data[key]))return data[key];return[]}
function textOf(x){if(current==='l1'){if(x.source_kind==='memory-core')return[x.title,x.summary].filter(Boolean).join('\\n');if(x.source_kind==='raw-turn')return[x.userText,x.assistantText,x.reasoningSummary].filter(Boolean).join('\\n→ ');return[x.user_text,x.assistant_text,x.reasoning_summary,x.tool_summary].filter(Boolean).join('\\n→ ')}if(current==='processing')return (x.target||'').toUpperCase()+' · '+(x.project_id||'account')+'\\n'+(x.evidence_refs||[]).length+' evidence';return x.summary||x.snippet||x.content||x.description||x.title||x.text||JSON.stringify(x)}
function itemId(x){return x.id||x.event_id||x.job_id||x.memoryId||x.skillId||x.project_id||x.account_id||''}
function statusOf(x){return x.status||x.capture_status||x.state||''}
function recentForProject(items,project){return [...(items||[])].filter(x=>projectOf(x)===project).sort((a,b)=>String(b.updatedAt||b.updated_at||b.timestamp||b.createdAt||'').localeCompare(String(a.updatedAt||a.updated_at||a.timestamp||a.createdAt||'')))[0]||null}
function projectPortfolioRecord(project){const id=project.project_id||project.id||'',l2=recentForProject(payload?._l2Items,id),l3=recentForProject(payload?._l3Items,id),jobs=(payload?._processingItems||[]).filter(x=>(x.project_id||'')===id),failed=jobs.filter(x=>statusOf(x)==='failed').length,pending=jobs.filter(x=>['pending','leased'].includes(statusOf(x))).length,todos=Array.isArray(project.pending_todos)?project.pending_todos:[],truth=l2?(l2.summary||firstParagraph(bodyOf(l2))||textOf(l2)):(project.description||''),updated=project.updated_at||project.updatedAt||l2?.updatedAt||l2?.updated_at||'';return '<button type="button" class="portfolio-record" data-project-scope="'+esc(id)+'"><div class="portfolio-identity"><div><b>'+esc(project.title||project.name||id)+'</b><span>'+esc(id)+'</span></div><div class="portfolio-meta"><time>'+esc(fmtTime(updated))+'</time><span class="state-dot '+esc(statusOf(project)||'active')+'">'+esc(statusOf(project)||'active')+'</span></div></div><div class="portfolio-overview"><div class="record-label">'+(lang==='zh'?'最近 continuity / Current Truth':'Recent continuity / Current Truth')+'</div><p>'+esc(truth||(lang==='zh'?'尚未形成 L2 项目时间线。':'No L2 project chronology yet.'))+'</p><div class="layer-status"><span class="ok">L1 · '+(lang==='zh'?'已路由':'routed')+'</span><span class="'+(l2?'ok':'muted')+'">L2 · '+(l2?(lang==='zh'?'有时间线':'ready'):'—')+'</span><span class="'+(l3?'ok':'muted')+'">L3 · '+(l3?(lang==='zh'?'有规则':'ready'):'—')+'</span>'+(failed?'<span class="bad">'+failed+' failed</span>':pending?'<span class="warn">'+pending+' processing</span>':'')+'</div></div><div class="portfolio-todos"><div class="record-label">'+(lang==='zh'?'待办':'TODO')+' · '+esc(todos.length)+'</div>'+(todos.length?todos.slice(0,2).map(t=>'<span>• '+esc(t.text)+'</span>').join(''):'<span class="muted">'+(lang==='zh'?'当前没有待办':'No pending todos')+'</span>')+'</div><i aria-hidden="true">→</i></button>'}
function renderPortfolioOverview(box){const projects=Array.isArray(payload?._projects)?payload._projects:[],sorted=[...projects].sort((a,b)=>{const ap=Number(a.pending_todo_count||a.pending_todos?.length||0)>0?1:0,bp=Number(b.pending_todo_count||b.pending_todos?.length||0)>0?1:0;if(ap!==bp)return bp-ap;return String(b.updated_at||b.updatedAt||'').localeCompare(String(a.updated_at||a.updatedAt||''))});box.className='items portfolio-overview';box.innerHTML='<div class="portfolio-head"><div><span>ALL PROJECTS</span><h3>'+(lang==='zh'?'项目组合概览':'Project portfolio')+'</h3><p>'+(lang==='zh'?'按待办优先、最近更新排序。选择一个项目后再展开 Current Truth、TODO、记忆层与 provenance。':'Sorted by pending work and recency. Select a project to expand Current Truth, TODOs, memory layers, and provenance.')+'</p></div><b>'+esc(sorted.length)+'</b></div><div class="portfolio-list">'+(sorted.length?sorted.map(projectPortfolioRecord).join(''):'<div class="overview-empty">'+(lang==='zh'?'暂无项目。':'No projects yet.')+'</div>')+'</div>';box.querySelectorAll('[data-project-scope]').forEach(button=>button.onclick=()=>{projectSelect.value=button.dataset.projectScope||'';syncScopeSummary();load('overview')})}
function renderProjectOverview(box){const project=(payload?._projects||[])[0]||null,l2=(payload?._l2Items||[])[0]||null,l3=(payload?._l3Items||[])[0]||null,todos=project&&Array.isArray(project.pending_todos)?project.pending_todos:(Array.isArray(payload?.todos?.pending)?payload.todos.pending:[]),jobs=payload?._processingItems||[],truth=l2?(l2.summary||firstParagraph(bodyOf(l2))||textOf(l2)):(project?.description||''),recentTime=l2?fmtTime(l2.updatedAt||l2.updated_at||l2.timestamp||l2.createdAt):fmtTime(project?.updated_at||project?.updatedAt),failed=jobs.filter(x=>statusOf(x)==='failed').length;box.className='items project-overview-detail';box.innerHTML='<section class="project-truth"><div class="detail-heading"><span>CURRENT TRUTH</span><small>'+esc(recentTime)+'</small></div><h3>'+esc(project?.title||project?.name||projectSelect?.selectedOptions?.[0]?.textContent||'Project')+'</h3><p>'+esc(truth||(lang==='zh'?'尚未形成项目时间线；可以先从 L1 证据开始。':'No project chronology yet; start from L1 evidence.'))+'</p><div class="provenance-strip"><span><b>L2</b> '+(l2?(lang==='zh'?'项目时间线':'project chronology'):'—')+'</span><span><b>L3</b> '+(l3?(lang==='zh'?'项目规则已形成':'project rules available'):'—')+'</span><span><b>source</b> '+(l2?'Memory Core / project:'+esc(projectSelect.value):(lang==='zh'?'项目注册表':'Project registry'))+'</span>'+(failed?'<span class="bad"><b>failed</b> '+failed+'</span>':'')+'</div></section><section class="project-next"><div class="overview-todos-head"><span>NEXT</span><b>'+(lang==='zh'?'下一步':'Next work')+'</b><small>'+esc(todos.length)+'</small></div><div class="overview-todo-list">'+(todos.length?todos.slice(0,5).map(todo=>'<button type="button" class="overview-todo-row" data-todo-project="'+esc(projectSelect.value)+'"><span>'+esc(project?.title||projectSelect.value)+'</span><b>'+esc(todo.text)+'</b><i aria-hidden="true">→</i></button>').join(''):'<div class="overview-empty">'+(lang==='zh'?'当前没有待办。':'No pending work.')+'</div>')+'</div></section><section class="project-layer-links"><button data-view-target="l1"><b>L1</b><span>'+(lang==='zh'?'原始证据':'Source evidence')+'</span></button><button data-view-target="l2"><b>L2</b><span>'+(lang==='zh'?'完整时间线':'Full chronology')+'</span></button><button data-view-target="l3"><b>L3</b><span>'+(lang==='zh'?'项目规则':'Project rules')+'</span></button><button data-view-target="processing"><b>Q</b><span>'+(lang==='zh'?'处理状态':'Processing')+'</span></button></section>';box.querySelectorAll('[data-view-target]').forEach(b=>b.onclick=()=>load(b.dataset.viewTarget))}
function renderOverview(){const c=payload?.counts||{};const todos=Array.isArray(payload?.todos?.pending)?payload.todos.pending:[];const box=document.getElementById('items');if(!ADMIN){if(!projectSelect?.value){renderPortfolioOverview(box);return}renderProjectOverview(box);return}box.className='items overview-grid governance-overview';window.overviewTodos=todos;const todoSection='<section class="overview-todos"><div class="overview-todos-head"><span>FOLLOW-UP</span><b>'+(lang==='zh'?'需要关注的未完成事项':'Pending work needing attention')+'</b><small>'+esc(todos.length)+'</small></div><div class="overview-todo-columns" aria-hidden="true"><span>'+(lang==='zh'?'项目':'Project')+'</span><span>'+(lang==='zh'?'状态':'Status')+'</span><span>'+(lang==='zh'?'事项':'Summary')+'</span><span>'+(lang==='zh'?'更新':'Updated')+'</span><span></span></div><div class="overview-todo-list">'+(todos.length?todos.slice(0,5).map((todo,i)=>'<button type="button" class="overview-todo-row" data-overview-todo="'+i+'" onclick="openOverviewTodo('+i+')" title="'+esc(todo.text)+'"><span>'+esc(todo.project_name||todo.project_id)+'</span><em>'+(lang==='zh'?'待完成':'Pending')+'</em><b>'+esc(todo.text)+'</b><time>'+esc(fmtTime(todo.updatedAt||todo.createdAt))+'</time><i aria-hidden="true">→</i></button>').join(''):'<div class="overview-empty">'+(lang==='zh'?'当前没有未完成事项。':'No pending follow-up right now.')+'</div>')+'</div>'+(todos.length>5?'<button type="button" class="overview-todo-more" data-view-target="projects">'+(lang==='zh'?'查看全部 '+todos.length+' 项 · 项目待办':'View all '+todos.length+' · Project todos')+' →</button>':'')+'</section>';const ps=payload?._processingSummary||{};const health='<section class="admin-health-card"><span>PROCESSING</span><h3>'+(lang==='zh'?'处理状态':'Processing state')+'</h3><div class="health-grid"><button type="button" data-view-target="processing" class="health-metric failed"><b>'+esc(ps.failed||0)+'</b><small>failed</small></button><button type="button" data-view-target="processing" class="health-metric pending"><b>'+esc(ps.pending||0)+'</b><small>pending</small></button><button type="button" data-view-target="processing" class="health-metric leased"><b>'+esc(ps.leased||0)+'</b><small>leased</small></button></div><p>'+(lang==='zh'?'先处理失败任务，再检查等待与租约中的任务。':'Resolve failures first, then inspect pending and leased jobs.')+'</p></section>';const links=[['accounts','A','账号与角色','Accounts & roles',payload?._accountCount??'—'],['projects','P','项目边界','Project boundaries',c.projects],['l1','01','L1 证据','L1 evidence',c.L1],['l2','02','L2 时间线','L2 chronology',c.L2],['l3','03','L3 项目规则','L3 project rules',c.L3],['l4','04','L4 账号画像','L4 account profile',c.L4]].map(s=>'<button type="button" class="overview-card" data-view-target="'+s[0]+'"><span>'+s[1]+'</span><div><b>'+(lang==='zh'?s[2]:s[3])+'</b><small>'+esc(s[4]??0)+'</small></div><i aria-hidden="true">→</i></button>').join('');box.innerHTML=health+todoSection+'<section class="overview-links">'+links+'</section>';box.querySelectorAll('[data-view-target]').forEach(b=>b.onclick=()=>load(b.dataset.viewTarget));box.querySelectorAll('[data-todo-project]').forEach(b=>b.onclick=()=>{if(projectSelect)projectSelect.value=b.dataset.todoProject||'';syncScopeSummary();load('projects')})}
window.openOverviewTodo=i=>{const todo=window.overviewTodos?.[i];if(!todo)return;lastDrawerReturnSelector='[data-overview-todo="'+i+'"]';openDrawer('<div class="drawer-kicker">FOLLOW-UP</div><h2>'+esc(todo.project_name||todo.project_id)+'</h2><p class="drawer-summary overview-todo-detail">'+esc(todo.text)+'</p><div class="account-record-meta"><span class="account-role">'+(lang==='zh'?'待完成':'Pending')+'</span><span>'+(lang==='zh'?'更新于 ':'Updated ')+esc(fmtTime(todo.updatedAt||todo.createdAt))+'</span></div><div class="actions"><button type="button" class="soft" id="overview-open-project">'+(lang==='zh'?'查看项目全部待办':'Open project todos')+'</button></div>');document.getElementById('overview-open-project').onclick=()=>{closeDrawer();if(projectSelect)projectSelect.value=todo.project_id||'';load('projects')}}
function updateToolbar(){const canCreate=ADMIN&&current==='projects';primaryAction.classList.toggle('hidden',!canCreate);primaryAction.textContent=lang==='zh'?'＋ 新建项目':'＋ New project';filterInput.classList.toggle('hidden',current==='overview');document.querySelector('.panel-head')?.classList.toggle('overview-head',current==='overview')}
function renderFlow(){const map={l1:'L1',l2:'L2',l3:'L3',l4:'L4'};Object.entries(map).forEach(([key,countKey])=>{const el=document.getElementById('flow-count-'+key);if(el)el.textContent=overviewCounts[countKey]??'—'});document.querySelectorAll('#memory-flow [data-view-target]').forEach(b=>b.classList.toggle('active',b.dataset.viewTarget===current))}
function renderStats(data,items){const c=data?.counts||{};if(current==='overview'){const order=['projects','L1','L2','L3','L4','Skill'];document.getElementById('cards').innerHTML=order.map(k=>'<article><b>'+esc(c[k]??0)+'</b><span>'+esc(k)+'</span></article>').join('');return}if(current==='projects'){const pending=items.reduce((n,x)=>n+Number(x.pending_todo_count||0),0);const withPending=items.filter(x=>Number(x.pending_todo_count||0)>0).length;document.getElementById('cards').innerHTML='<article><b>'+esc(data?.total??items.length)+'</b><span>'+(lang==='zh'?'项目':'Projects')+'</span></article><article><b>'+esc(pending)+'</b><span>'+(lang==='zh'?'待完成事项':'Pending todos')+'</span></article><article><b>'+esc(withPending)+'</b><span>'+(lang==='zh'?'有待办的项目':'Projects with todos')+'</span></article>';return}if(current==='l2'){const events=items.reduce((n,x)=>n+timelineSections(bodyOf(x)).length,0);const projects=new Set(items.map(projectOf).filter(Boolean)).size;document.getElementById('cards').innerHTML='<article><b>'+esc(items.length)+'</b><span>'+(lang==='zh'?'项目时间线':'Project timelines')+'</span></article><article><b>'+esc(events)+'</b><span>'+(lang==='zh'?'时间节点':'Timeline events')+'</span></article><article><b>'+esc(projects)+'</b><span>'+(lang==='zh'?'涉及项目':'Projects represented')+'</span></article>';return}if(current==='l3'){const rules=items.reduce((n,x)=>n+bulletItems(bodyOf(x)).length,0);document.getElementById('cards').innerHTML='<article><b>'+esc(items.length)+'</b><span>'+(lang==='zh'?'项目规则集':'Project profiles')+'</span></article><article><b>'+esc(rules)+'</b><span>'+(lang==='zh'?'规则 / 经验':'Rules / experience')+'</span></article><article><b>'+esc(new Set(items.map(projectOf).filter(Boolean)).size)+'</b><span>'+(lang==='zh'?'涉及项目':'Projects represented')+'</span></article>';return}if(current==='l4'){const traits=items.reduce((n,x)=>n+bulletItems(bodyOf(x)).length,0);const latest=items.map(x=>x.updatedAt||x.updated_at).filter(Boolean).sort().at(-1);document.getElementById('cards').innerHTML='<article><b>'+esc(items.length)+'</b><span>'+(lang==='zh'?'当前画像':'Current profiles')+'</span></article><article><b>'+esc(traits)+'</b><span>'+(lang==='zh'?'稳定特征':'Stable traits')+'</span></article><article><b>'+esc(latest?fmtTime(latest):'—')+'</b><span>'+(lang==='zh'?'最近更新':'Last updated')+'</span></article>';return}const total=data?.total??items.length;const active=items.filter(x=>['pending','leased','open','partial','activated','active'].includes(statusOf(x))).length;const failed=items.filter(x=>statusOf(x)==='failed'||statusOf(x)==='truncated').length;document.getElementById('cards').innerHTML='<article><b>'+esc(total)+'</b><span>'+(lang==='zh'?'总计':'Total')+'</span></article><article><b>'+active+'</b><span>'+(lang==='zh'?'活跃 / 处理中':'Active / running')+'</span></article><article><b>'+failed+'</b><span>'+(lang==='zh'?'异常':'Exceptions')+'</span></article>'}
function emptyState(){const zh={l2:['还没有新的 L2 时间线','完成 L1 蒸馏后，项目的发展过程会在这里形成可读时间线。'],l3:['还没有新的 L3 项目规则','L2 稳定后，这里会沉淀长期规则、偏好、经验与工作方式。'],l4:['还没有新的 L4 用户画像','至少多个项目形成 L3 后，才会生成跨项目稳定画像。'],skills:['还没有可复用 Skill','Skill 独立于 L1-L4，可由稳定流程和经验演化而来。'],processing:['当前没有蒸馏任务','新的 L1 证据达到阈值或空闲条件后会进入队列。']}[current]||['暂无数据','当前视图没有匹配内容。'];const en={l2:['No L2 timeline yet','Project chronology appears here after valid L1 distillation.'],l3:['No L3 project rules yet','Durable rules, preferences, experience, and working habits appear after L2 stabilizes.'],l4:['No L4 user profile yet','Cross-project traits require supported L3 evidence from multiple projects.'],skills:['No reusable Skills yet','Skills evolve independently from stable procedures and experience.'],processing:['No distillation jobs','New jobs appear when L1 evidence reaches the configured threshold or idle condition.']}[current]||['No data','There is no content matching this view.'];const copy=lang==='zh'?zh:en;return '<div class="empty-state"><span>'+esc(eyebrows[current]||'EMPTY')+'</span><h3>'+esc(copy[0])+'</h3><p>'+esc(copy[1])+'</p>'+(current!=='processing'?'<button class="soft" type="button" onclick="load(\\\'processing\\\')">'+(lang==='zh'?'查看处理队列':'Open processing')+'</button>':'')+'</div>'}
function renderProjects(items){const box=document.getElementById('items');box.className='items project-ledger';const sorted=[...items].sort((a,b)=>{const ap=(a.pending_todo_count||a.pending_todos?.length||0)>0?1:0,bp=(b.pending_todo_count||b.pending_todos?.length||0)>0?1:0;if(ap!==bp)return bp-ap;return String(b.updated_at||b.updatedAt||'').localeCompare(String(a.updated_at||a.updatedAt||''))});window.visibleItems=sorted;box.innerHTML=sorted.length?sorted.map((x,i)=>{const todos=Array.isArray(x.pending_todos)?x.pending_todos:[],id=x.project_id||x.id||'',summary=x.description||(lang==='zh'?'暂无项目描述；打开详情可查看注册信息与记忆范围。':'No project description; open details for registry and memory scope.');return '<button type="button" class="project-ledger-record" data-item-index="'+i+'" onclick="openItem('+i+')"><div class="project-ledger-identity"><div><h3>'+esc(x.title||x.name||id)+'</h3><span class="project-slug">'+esc(id)+'</span></div><div class="project-identity-meta"><span class="state-dot '+esc(statusOf(x)||'active')+'">'+esc(statusOf(x)||'active')+'</span><time>'+esc(fmtTime(x.updated_at||x.updatedAt))+'</time></div></div><div class="project-ledger-overview"><span class="record-label">'+(lang==='zh'?'概览 / Current Truth':'Overview / Current Truth')+'</span><p>'+esc(summary)+'</p><small>'+(Array.isArray(x.aliases)&&x.aliases.length?(lang==='zh'?'别名：':'Aliases: ')+esc(x.aliases.slice(0,3).join(' · ')):(lang==='zh'?'无别名':'No aliases'))+'</small></div><div class="project-ledger-todos"><div><span class="record-label">TODO</span><b>'+esc(todos.length)+'</b></div><div class="project-todo-lines">'+(todos.length?todos.slice(0,2).map(t=>'<span>• '+esc(t.text)+'</span>').join(''):'<span class="muted">'+(lang==='zh'?'当前没有待办':'No pending todos')+'</span>')+'</div></div><i aria-hidden="true">→</i></button>'}).join(''):emptyState()}
function renderL1(items){const box=document.getElementById('items');box.className='items turn-list';window.visibleItems=items;box.innerHTML=items.length?items.map((x,i)=>{const core=x.source_kind==='memory-core',raw=x.source_kind==='raw-turn';const copy=core?'<p><strong>M</strong>'+esc(x.title||x.summary||'—')+'</p><p><strong>↳</strong>'+esc(x.summary||'—')+'</p>':raw?'<p><strong>U</strong>'+esc(x.userText||'—')+'</p><p><strong>A</strong>'+esc(x.assistantText||'—')+'</p>':'<p><strong>U</strong>'+esc(x.user_text||'—')+'</p><p><strong>A</strong>'+esc(x.assistant_text||'—')+'</p>';const label=core?'L1 · MEMORY':raw?'L1 · RAW TURN':'L1 · TURN';const project=x.project_unresolved?('unresolved · '+(x.raw_project_id||'workspace')):(x.project_hint||x.project_id||x.projectId||'—');return '<button type="button" class="turn-row" data-item-index="'+i+'" onclick="openItem('+i+')"><div class="turn-meta"><span>'+label+'</span><b>'+esc(statusOf(x)||'complete')+'</b><time>'+esc(fmtTime(x.timestamp||x.updated_at||x.updatedAt||x.createdAt))+'</time></div><div class="turn-copy">'+copy+'</div><div class="turn-project">'+esc(project)+'</div></button>'}).join(''):emptyState()}
function renderMemoryRows(items){const box=document.getElementById('items');window.visibleItems=items;if(current==='l2'){box.className='items artifact-list timeline-feed';box.innerHTML=l2FeedHtml(items);return}if(['l3','l4'].includes(current)){box.className='items artifact-list';box.innerHTML=items.length?items.map((x,i)=>{const project=projectOf(x);const label=current==='l3'?(lang==='zh'?'项目规则与经验':'Project rules & experience'):(lang==='zh'?'跨项目用户画像':'Cross-project user profile');return '<section class="artifact-card '+esc(current)+'"><div class="artifact-head"><div><span class="layer-token">'+esc(current.toUpperCase())+'</span><small>'+esc(project||label)+'</small></div><div><h3>'+esc(cleanHeading(x.summary)||x.title||label)+'</h3><time>'+esc(fmtTime(x.updatedAt||x.updated_at||x.createdAt))+'</time></div><button type="button" class="soft artifact-open" data-item-index="'+i+'" onclick="openItem('+i+')">'+(lang==='zh'?'详情':'Details')+'</button></div>'+artifactBodyHtml(x,current)+'</section>'}).join(''):emptyState();return}box.className='items memory-list';box.innerHTML=items.length?items.map((x,i)=>'<button type="button" class="memory-row" data-item-index="'+i+'" onclick="openItem('+i+')"><span class="layer-token">'+esc(current.toUpperCase())+'</span><div><div class="memory-row-head"><h3>'+esc(x.title||x.name||itemId(x)||'(untitled)')+'</h3><span>'+esc(statusOf(x))+'</span></div><p>'+esc(textOf(x))+'</p><small>'+esc(x.project_id||x.projectId||x.updatedAt||x.updated_at||'')+'</small></div><i aria-hidden="true">→</i></button>').join(''):emptyState()}
function renderProcessing(items){const box=document.getElementById('items');box.className='items processing-view';const cfg=payload?.config||{};const config=ADMIN?'<section class="policy-card"><div><span>POLICY</span><h3>'+(lang==='zh'?'自动蒸馏':'Automatic distillation')+'</h3><p>'+(lang==='zh'?'管理员在这里配置 L1→L2 自动整理触发条件。':'Configure automatic L1→L2 triggers here.')+'</p></div><div class="policy-controls"><label class="toggle-field"><input id="cfg-auto" name="auto-enabled" type="checkbox" role="switch" '+(cfg.auto_enabled?'checked':'')+'><span>'+(lang==='zh'?'自动蒸馏':'Automatic distillation')+'</span></label><label><span>'+(lang==='zh'?'完成轮数':'Completed turns')+'</span><input id="cfg-threshold" name="turn-threshold" autocomplete="off" inputmode="numeric" type="number" min="1" max="10000" value="'+esc(cfg.turn_threshold??8)+'"></label><label><span>'+(lang==='zh'?'空闲分钟':'Idle minutes')+'</span><input id="cfg-idle" name="idle-minutes" autocomplete="off" inputmode="numeric" type="number" min="1" max="10080" value="'+esc(cfg.idle_minutes??30)+'"></label><button class="soft policy-save" type="button" onclick="saveDistillationConfig(this)">'+(lang==='zh'?'保存策略':'Save policy')+'</button></div></section>':'<section class="processing-note"><b>'+(lang==='zh'?'高级状态':'Advanced status')+'</b><p>'+(lang==='zh'?'这里只显示处理结果；自动蒸馏策略由 Admin 管理。':'This view shows processing results only. Automatic distillation policy is managed in Admin.')+'</p></section>';window.visibleItems=items;const order={failed:0,pending:1,leased:2,complete:3,completed:3,succeeded:3};const sorted=[...items].sort((a,b)=>(order[statusOf(a)]??9)-(order[statusOf(b)]??9)||String(b.updated_at||b.created_at||'').localeCompare(String(a.updated_at||a.created_at||'')));const jobs=sorted.length?'<div class="job-list">'+sorted.map((x,i)=>{const failed=statusOf(x)==='failed',error=String(x.failure||'').trim(),id=itemId(x);return '<article class="job-entry'+(failed?' is-failed':'')+'"><button type="button" class="job-row" data-item-index="'+i+'" onclick="openItem('+i+')"><span class="job-state '+esc(statusOf(x))+'">'+esc(statusOf(x))+'</span><div><b>'+esc((x.target||'').toUpperCase())+' · '+esc(x.project_id||'account')+'</b><small>'+esc(x.reason||'manual')+' · '+esc((x.evidence_refs||[]).length)+' evidence'+(failed?' · '+esc(x.attempts??0)+' attempts':'')+'</small>'+(failed?'<small class="job-error" title="'+esc(error)+'">'+esc(error||(lang==='zh'?'未记录失败原因':'No failure reason recorded'))+'</small>':'')+'</div><time>'+esc(fmtTime((failed&&x.failed_at)||x.updated_at||x.created_at))+'</time></button>'+(failed&&ADMIN&&id?'<button type="button" class="soft job-quick-retry" data-retry-index="'+i+'" onclick="retryProcessingJob('+i+',this)">'+(lang==='zh'?'重试':'Retry')+'</button>':'')+'</article>'}).join('')+'</div>':emptyState();window.visibleItems=sorted;box.innerHTML=config+jobs}
window.retryProcessingJob=async(i,trigger)=>{const job=window.visibleItems?.[i],id=itemId(job);if(!ADMIN||!id||statusOf(job)!=='failed')return;try{await runMutation('retry-distillation:'+id,trigger,async()=>{await postAction({action:'retry-distillation',id});toast(lang==='zh'?'任务已重新入队':'Job queued for retry');await load('processing')})}catch(err){toast((lang==='zh'?'重试失败：':'Retry failed: ')+String(err.message||err))}}
function renderAccounts(items){const box=document.getElementById('items');box.className='items account-list';const sorted=[...items].sort((a,b)=>Number(!!b.selected)-Number(!!a.selected)||String(a.cloudflare_email||a.username||a.account_id).localeCompare(String(b.cloudflare_email||b.username||b.account_id)));window.visibleItems=sorted;box.innerHTML=sorted.length?sorted.map((x,i)=>{const identity=x.cloudflare_email||x.username||x.account_id;return '<article class="account-record"><button type="button" class="account-record-main" data-item-index="'+i+'" onclick="openItem('+i+')"><b class="account-identity">'+esc(identity)+'</b><span class="account-record-meta"><span class="account-role">'+esc(x.role||'user')+'</span>'+(x.selected?'<span class="account-selected">'+(lang==='zh'?'当前账号':'Active account')+'</span>':'')+(x.cloudflare_email&&x.username&&x.username!==x.cloudflare_email?'<span>'+esc(x.username)+'</span>':'')+'<code>'+esc(x.account_id)+'</code></span></button><button type="button" class="soft account-copy" onclick="copyAccountId('+i+')">'+(lang==='zh'?'复制 ID':'Copy ID')+'</button></article>'}).join(''):emptyState()}
window.copyAccountId=async i=>{const id=window.visibleItems?.[i]?.account_id;if(!id)return;try{await navigator.clipboard.writeText(id);toast(lang==='zh'?'账号 ID 已复制':'Account ID copied')}catch{toast(lang==='zh'?'复制不可用，请打开详情复制 ID':'Copy unavailable; open details for ID')}}
function renderRows(){const q=filterInput.value.toLowerCase();const all=values(payload);const items=all.filter(x=>JSON.stringify(x).toLowerCase().includes(q));if(current==='projects')return renderProjects(items);if(current==='accounts')return renderAccounts(items);if(current==='l1')return renderL1(items);if(current==='processing')return renderProcessing(items);return renderMemoryRows(items)}
function updateWorkspaceShell(){const t=titles[current]||[current,current],d=descriptions[current]||['',''];if(ADMIN){workspaceTitle.textContent=lang==='zh'?t[0]:t[1];workspaceDescription.textContent=lang==='zh'?d[0]:d[1];workspaceKicker.textContent=current==='overview'?'ADMIN / OPERATIONS':'ADMIN / '+String(eyebrows[current]||current).toUpperCase();workspaceHead.classList.toggle('compact',current!=='overview');return}const overview=current==='overview';workspaceTitle.textContent=overview?(lang==='zh'?'继续工作':'Continue working'):(lang==='zh'?t[0]:t[1]);workspaceDescription.textContent=overview?(lang==='zh'?'先看当前范围、下一步与最近连续性，需要时再深入记忆层。':'Start with current scope, next work, and recent continuity; inspect deeper memory only when needed.'):(lang==='zh'?d[0]:d[1]);workspaceKicker.textContent=overview?'MY MEMORY':String(eyebrows[current]||current).toUpperCase();workspaceHead.classList.toggle('compact',!overview)}
function renderCurrent(){const t=titles[current]||[current,current],d=descriptions[current]||['',''];document.getElementById('view-title').textContent=lang==='zh'?t[0]:t[1];document.getElementById('view-desc').textContent=lang==='zh'?d[0]:d[1];document.getElementById('view-eyebrow').textContent=eyebrows[current]||'MEMORY';updateWorkspaceShell();if(mobileViewSelect)mobileViewSelect.value=current;document.querySelectorAll('aside button[data-view]').forEach(b=>{const active=b.dataset.view===current;b.classList.toggle('active',active);if(active){b.setAttribute('aria-current','page');b.setAttribute('aria-pressed','true')}else{b.removeAttribute('aria-current');b.setAttribute('aria-pressed','false')}});updateToolbar();renderFlow();syncScopeSummary();if(!payload)return;const items=values(payload);renderStats(payload,items);if(current==='overview')renderOverview();else renderRows()}
function syncProjectSelect(items){const selected=projectSelect.value;projectSelect.innerHTML='<option value="">'+(lang==='zh'?'全部项目':'All projects')+'</option>'+items.map(x=>'<option value="'+esc(x.project_id||x.id)+'">'+esc(x.title||x.name||x.project_id||x.id)+'</option>').join('');if([...projectSelect.options].some(o=>o.value===selected))projectSelect.value=selected}
async function load(view,silent=false,historyMode='push'){if(!validViews.has(view))view='overview';current=view;if(view==='accounts'&&!ADMIN){current='overview';return load('overview',silent,historyMode)}if(!silent)payload=null;document.querySelectorAll('aside button[data-view]').forEach(b=>{const active=b.dataset.view===current;b.classList.toggle('active',active);if(active){b.setAttribute('aria-current','page');b.setAttribute('aria-pressed','true')}else{b.removeAttribute('aria-current');b.setAttribute('aria-pressed','false')}});if(mobileViewSelect)mobileViewSelect.value=current;renderFlow();updateToolbar();syncScopeSummary();if(!silent&&historyMode!=='none')syncUrl(historyMode);if(controller)controller.abort();controller=new AbortController();const seq=++requestSeq;if(!silent){document.getElementById('cards').innerHTML='';document.getElementById('items').innerHTML='<div class="loading-state" role="status"><span></span><span></span><span></span><b>'+(lang==='zh'?'正在加载…':'Loading…')+'</b></div>'}try{const r=await fetch(query(current),{signal:controller.signal,cache:'no-store'});if(!r.ok)throw Error(await r.text());const data=await r.json();if(seq!==requestSeq)return;if(current==='overview'){if(ADMIN){try{const [jobsRes,accountsRes]=await Promise.all([fetch(query('processing'),{signal:controller.signal,cache:'no-store'}),fetch(query('accounts'),{signal:controller.signal,cache:'no-store'})]);if(jobsRes.ok){const jobs=values(await jobsRes.json());data._processingSummary=jobs.reduce((acc,x)=>{const s=statusOf(x)||'unknown';acc[s]=(acc[s]||0)+1;return acc},{})}if(accountsRes.ok)data._accountCount=values(await accountsRes.json()).length}catch(err){if(err?.name==='AbortError')throw err}}else{try{const [projectsRes,l2Res,l3Res,processingRes]=await Promise.all([fetch(query('projects'),{signal:controller.signal,cache:'no-store'}),fetch(query('l2'),{signal:controller.signal,cache:'no-store'}),fetch(query('l3'),{signal:controller.signal,cache:'no-store'}),fetch(query('processing'),{signal:controller.signal,cache:'no-store'})]);data._projects=projectsRes.ok?values(await projectsRes.json()):[];data._l2Items=l2Res.ok?values(await l2Res.json()):[];data._l3Items=l3Res.ok?values(await l3Res.json()):[];data._processingItems=processingRes.ok?values(await processingRes.json()):[];data._recentItem=[...data._l2Items].sort((a,b)=>String(b.updatedAt||b.updated_at||b.timestamp||b.createdAt||'').localeCompare(String(a.updatedAt||a.updated_at||a.timestamp||a.createdAt||'')))[0]||null}catch(err){if(err?.name==='AbortError')throw err}}}if(seq!==requestSeq)return;if(silent&&drawerIsOpen())return;payload=data;if(current==='overview'){overviewCounts=data.counts||{};renderFlow()}if(current==='projects')syncProjectSelect(values(data));lastRefreshAt=Date.now();renderFreshness();renderCurrent();updateNavAffordance()}catch(err){if(err?.name==='AbortError')return;if(!silent)document.getElementById('items').innerHTML='<div class="empty-state load-error"><span>ERROR</span><h3>'+(lang==='zh'?'加载失败':'Could not load')+'</h3><p>'+(lang==='zh'?'请重试；如果问题持续，再查看技术详情。':'Retry the request; inspect technical details if it keeps failing.')+'</p><button class="soft" type="button" onclick="load(current)">'+(lang==='zh'?'重试':'Retry')+'</button><details class="load-error-details"><summary>'+(lang==='zh'?'技术详情':'Technical details')+'</summary><pre>'+esc(err.message||err)+'</pre></details></div>'}}
function openDrawer(html){const d=document.getElementById('drawer'),wasHidden=d.classList.contains('hidden');if(wasHidden)lastDrawerTrigger=document.activeElement instanceof HTMLElement?document.activeElement:null;const body=document.getElementById('drawer-body');body.innerHTML=html;const title=body.querySelector('h2');if(title)title.id='drawer-title';d.classList.remove('hidden');d.setAttribute('aria-hidden','false');document.querySelectorAll('.site-header,#main-content,.skip-link').forEach(el=>el.setAttribute('inert',''));setTimeout(()=>{const first=drawerFocusables()[0]||d;first.focus()},0)}
window.openItem=i=>{const x=window.visibleItems?.[i];if(!x)return;lastDrawerReturnSelector='[data-item-index=\"'+i+'\"]';const id=itemId(x);let actions='';if(current==='projects'&&ADMIN)actions='<div class="actions"><button class="soft" data-project-action="todos">'+(lang==='zh'?'待办':'Todos')+'</button><button class="soft" data-project-action="edit">'+(lang==='zh'?'编辑':'Edit')+'</button><button class="soft" data-project-action="merge">'+(lang==='zh'?'合并':'Merge')+'</button><button class="danger" data-project-action="delete">'+(lang==='zh'?'逻辑删除':'Delete')+'</button></div>';if(['l2','l3','l4'].includes(current)&&id)actions='<div class="actions"><button class="soft" data-action="archive-memory" data-id="'+esc(id)+'">Archive</button><button class="danger" data-action="delete-memory" data-id="'+esc(id)+'">Delete</button></div>';if(current==='skills'&&id)actions='<div class="actions"><button class="soft" data-action="archive-skill" data-id="'+esc(id)+'">Archive</button></div>';if(current==='processing'&&statusOf(x)==='failed'&&id&&ADMIN)actions='<div class="actions"><button class="soft" data-retry-index="'+i+'">'+(lang==='zh'?'重新入队':'Retry job')+'</button></div>';if(current==='accounts'&&ADMIN&&id)actions='<div class="actions"><button class="soft" data-role="admin" data-id="'+esc(id)+'">Admin</button><button class="soft" data-role="user" data-id="'+esc(id)+'">User</button></div>';const readable=current==='accounts'?'<div class="account-detail"><div><span>'+(lang==='zh'?'账号身份':'Account identity')+'</span><b>'+esc(x.cloudflare_email||x.username||id)+'</b></div><div><span>'+(lang==='zh'?'角色':'Role')+'</span><b>'+esc(x.role||'user')+'</b></div><div><span>Account ID</span><code>'+esc(id)+'</code></div></div>':current==='processing'?'<div class="job-detail"><div><span>'+(lang==='zh'?'状态 / 尝试次数':'Status / attempts')+'</span><b>'+esc(statusOf(x))+' · '+esc(x.attempts??0)+'</b></div><div><span>'+(lang==='zh'?'触发原因 / 证据':'Reason / evidence')+'</span><b>'+esc(x.reason||'manual')+' · '+esc((x.evidence_refs||[]).length)+'</b></div><div><span>'+(lang==='zh'?'最近失败':'Last failure')+'</span><b>'+esc(fmtTime(x.failed_at||x.updated_at))+'</b></div>'+(x.failure?'<div class="job-failure-detail"><span>'+(lang==='zh'?'失败原因':'Failure reason')+'</span><p>'+esc(x.failure)+'</p></div>':'')+'</div>':['l2','l3','l4'].includes(current)?'<div class="drawer-artifact">'+artifactBodyHtml(x,current)+'</div>':'<p class="drawer-summary">'+esc(textOf(x))+'</p>';openDrawer('<div class="drawer-kicker">'+esc(eyebrows[current]||'DETAIL')+'</div><h2>'+esc(current==='accounts'?(x.cloudflare_email||x.username||id):current==='processing'?((x.target||'').toUpperCase()+' · '+(x.project_id||'account')):(x.title||x.name||id))+'</h2>'+readable+actions+'<details><summary>'+(lang==='zh'?'原始数据':'Raw data')+'</summary><pre>'+esc(JSON.stringify(x,null,2))+'</pre></details>');document.querySelectorAll('#drawer-body [data-action]').forEach(button=>button.onclick=()=>memoryAction(button.dataset.action,button.dataset.id,button));document.querySelectorAll('#drawer-body [data-retry-index]').forEach(button=>button.onclick=()=>retryProcessingJob(Number(button.dataset.retryIndex),button));document.querySelectorAll('#drawer-body [data-role]').forEach(button=>button.onclick=()=>accountRole(button.dataset.id,button.dataset.role,button));document.querySelectorAll('#drawer-body [data-project-action]').forEach(button=>button.onclick=()=>openProjectForm(button.dataset.projectAction,i))}
function openProjectTodos(x){const project=x.project_id||x.id;const todos=Array.isArray(x.todos)?[...x.todos]:[];const pending=todos.filter(t=>t.status!=='done').sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||'')));const done=todos.filter(t=>t.status==='done').sort((a,b)=>String(b.completedAt||b.updatedAt||'').localeCompare(String(a.completedAt||a.updatedAt||'')));const row=t=>'<div class="todo-row '+esc(t.status||'pending')+'"><div><b>'+esc(t.text)+'</b><small>'+esc(t.status||'pending')+' · '+esc(fmtTime(t.completedAt||t.updatedAt||t.createdAt))+'</small></div><button class="soft" type="button" data-todo-id="'+esc(t.id)+'" data-todo-status="'+(t.status==='done'?'pending':'done')+'">'+(t.status==='done'?(lang==='zh'?'重新打开':'Reopen'):(lang==='zh'?'完成':'Done'))+'</button></div>';const active=pending.length?'<div class="todo-list">'+pending.map(row).join('')+'</div>':'<div class="empty-state"><span>TODO</span><h3>'+(lang==='zh'?'暂无未完成待办':'No pending todos')+'</h3><p>'+(lang==='zh'?'当前项目没有未完成事项。':'This project has no unfinished work.')+'</p></div>';const history=done.length?'<details class="todo-history"><summary>'+(lang==='zh'?'已完成历史':'Completed history')+' · '+done.length+'</summary><div class="todo-list">'+done.map(row).join('')+'</div></details>':'';openDrawer('<div class="drawer-kicker">PROJECT TODO</div><h2>'+esc(x.title||x.name||project)+'</h2><div class="todo-manager"><div class="todo-manager-head"><span>'+(lang==='zh'?'未完成待办':'Pending todos')+'</span><b>'+esc(pending.length)+' '+(lang==='zh'?'待完成':'pending')+'</b></div><form id="project-todo-form" class="todo-add"><label class="sr-only" for="project-todo-text">'+(lang==='zh'?'新增项目待办':'Add project todo')+'</label><input id="project-todo-text" name="todo" autocomplete="off" maxlength="2000" required aria-label="'+(lang==='zh'?'新增项目待办':'Add project todo')+'" placeholder="'+(lang==='zh'?'下一步要完成什么…':'What needs to happen next…')+'"><button class="primary-action" type="submit">'+(lang==='zh'?'添加':'Add')+'</button></form>'+active+history+'</div>');document.getElementById('project-todo-form').onsubmit=event=>submitProjectTodo(event,project);document.querySelectorAll('#drawer-body [data-todo-status]').forEach(button=>button.onclick=()=>setProjectTodoStatus(project,button.dataset.todoId,button.dataset.todoStatus,button))}
window.openProjectForm=(mode,index)=>{if(!ADMIN)return;const x=Number.isInteger(index)?window.visibleItems?.[index]:null;if(mode==='todos'&&x){openProjectTodos(x);return}if(mode==='delete'&&x){const project=x.project_id||x.id;openDrawer('<div class="drawer-kicker">HIGH IMPACT</div><h2>'+(lang==='zh'?'逻辑删除项目':'Logically delete project')+'</h2><div class="impact-box danger-impact"><b>'+esc(project)+'</b><p>'+(lang==='zh'?'项目会从活动注册表中移除；已有记忆保留，不做物理重写。此操作会改变后续路由。':'The project leaves the active registry; existing memories are retained and are not physically rewritten. This changes future routing.')+'</p></div><form id="project-delete-form" class="project-form"><label><span>'+(lang==='zh'?'输入项目 ID 以确认':'Type the project ID to confirm')+'</span><input id="project-delete-confirm" name="project-delete-confirm" autocomplete="off" spellcheck="false" required placeholder="'+esc(project)+'"></label><div class="actions"><button class="danger" type="submit">'+(lang==='zh'?'确认逻辑删除':'Confirm logical delete')+'</button></div></form>');document.getElementById('project-delete-form').onsubmit=event=>submitProjectDelete(event,index,project);return}if(mode==='merge'&&x){const source=x.project_id||x.id;const options=values(payload).filter(p=>(p.project_id||p.id)!==source).map(p=>{const id=p.project_id||p.id,name=p.title||p.name||id;return '<option value="'+esc(id)+'">'+esc(name)+' · '+esc(id)+'</option>'}).join('');openDrawer('<div class="drawer-kicker">PROJECT ROUTING</div><h2>'+(lang==='zh'?'合并项目':'Merge project')+'</h2><div class="impact-box"><span>'+(lang==='zh'?'源项目':'Source')+'</span><b>'+esc(source)+'</b><p>'+(lang==='zh'?'源项目将成为历史别名；记忆不会被物理重写。确认目标项目无歧义后再继续。':'The source becomes a historical alias; memories are not physically rewritten. Confirm the target is unambiguous before continuing.')+'</p></div><form id="project-form" class="project-form"><label><span>'+(lang==='zh'?'目标项目':'Target project')+'</span><select id="project-target" name="target-project" autocomplete="off" required>'+options+'</select></label><p class="form-note">'+(lang==='zh'?'旧项目会成为历史别名；记忆不会被物理重写。':'The source becomes a historical alias; memories are not physically rewritten.')+'</p><div class="actions"><button class="primary-action" type="submit">'+(lang==='zh'?'确认合并':'Merge')+'</button></div></form>');document.getElementById('project-form').onsubmit=event=>submitProjectMerge(event,source);return}const editing=mode==='edit'&&x;const id=editing?(x.project_id||x.id):'';openDrawer('<div class="drawer-kicker">PROJECT REGISTRY</div><h2>'+(editing?(lang==='zh'?'编辑项目':'Edit project'):(lang==='zh'?'新建项目':'New project'))+'</h2><form id="project-form" class="project-form"><label><span>Slug</span><input id="project-slug" name="project-slug" autocomplete="off" spellcheck="false" value="'+esc(id)+'" '+(editing?'disabled':'required')+' placeholder="my-project…"></label><label><span>'+(lang==='zh'?'显示名':'Display name')+'</span><input id="project-name" name="project-name" autocomplete="off" value="'+esc(editing?(x.title||x.name||''):'')+'" placeholder="My Project…"></label><label><span>'+(lang==='zh'?'描述':'Description')+'</span><textarea id="project-description" name="project-description" autocomplete="off" '+(editing?'':'required')+' rows="5" placeholder="'+(lang==='zh'?'用于路由消歧和项目理解…':'Used for routing and project disambiguation…')+'">'+esc(editing?(x.description||''):'')+'</textarea></label><label><span>'+(lang==='zh'?'别名':'Aliases')+'</span><input id="project-aliases" name="project-aliases" autocomplete="off" spellcheck="false" value="'+esc(editing&&Array.isArray(x.aliases)?x.aliases.join(', '):'')+'" placeholder="alias-one, Alias Two…"></label><div class="actions"><button class="primary-action" type="submit">'+(editing?(lang==='zh'?'保存修改':'Save changes'):(lang==='zh'?'创建项目':'Create project'))+'</button></div></form>');document.getElementById('project-form').onsubmit=event=>submitProjectForm(event,editing?'edit':'create',id)}
window.closeDrawer=()=>{const d=document.getElementById('drawer');if(d.classList.contains('hidden'))return;d.classList.add('hidden');d.setAttribute('aria-hidden','true');document.querySelectorAll('.site-header,#main-content,.skip-link').forEach(el=>el.removeAttribute('inert'));const restore=lastDrawerTrigger,selector=lastDrawerReturnSelector;lastDrawerTrigger=null;lastDrawerReturnSelector='';const target=(selector?document.querySelector(selector):null)||restore;if(target?.isConnected)target.focus({preventScroll:true})}
async function postAction(body){const q=new URLSearchParams();if(ADMIN&&accountSelect?.value)q.set('account_id',accountSelect.value);const r=await fetch(ACTION+(q.toString()?'?'+q.toString():''),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error(await r.text());return r.json()}
function toast(message){const el=document.getElementById('toast');el.textContent=message;el.classList.remove('hidden');clearTimeout(window.__memhubToast);window.__memhubToast=setTimeout(()=>el.classList.add('hidden'),2600)}
window.memoryAction=async(action,id,trigger)=>{if((action==='delete-memory'||action==='archive-memory'||action==='archive-skill')&&!confirm(lang==='zh'?'确认执行？':'Confirm action?'))return;await runMutation(action+':'+id,trigger,async()=>{await postAction({action,id});toast(lang==='zh'?'已更新':'Updated');closeDrawer();await load(current)})}
window.accountRole=async(id,role,trigger)=>{if(!confirm((lang==='zh'?'确认将账号角色改为 ':'Change account role to ')+role+'?'))return;await runMutation('role:'+id,trigger,async()=>{await postAction({action:'set-account-role',id,role});toast(lang==='zh'?'角色已更新':'Role updated');closeDrawer();await load('accounts')})}
window.submitProjectForm=async(event,mode,id)=>{event.preventDefault();const trigger=event.submitter;const aliases=document.getElementById('project-aliases').value.split(/[,\\n]/).map(x=>x.trim()).filter(Boolean);const body={action:mode==='edit'?'update-project':'create-project',project:mode==='edit'?id:document.getElementById('project-slug').value.trim(),name:document.getElementById('project-name').value.trim(),description:document.getElementById('project-description').value.trim(),aliases};await runMutation(body.action+':'+(body.project||'new'),trigger,async()=>{await postAction(body);toast(mode==='edit'?(lang==='zh'?'项目已更新':'Project updated'):(lang==='zh'?'项目已创建':'Project created'));closeDrawer();await load('projects')})}
window.submitProjectTodo=async(event,project)=>{event.preventDefault();const trigger=event.submitter;const text=document.getElementById('project-todo-text').value.trim();if(!text)return;await runMutation('add-todo:'+project,trigger,async()=>{await postAction({action:'add-project-todo',project,text});toast(lang==='zh'?'待办已添加':'Todo added');closeDrawer();await load('projects')})}
window.setProjectTodoStatus=async(project,todoId,status,trigger)=>{await runMutation('todo-status:'+todoId,trigger,async()=>{await postAction({action:'set-project-todo-status',project,todo_id:todoId,status});toast(status==='done'?(lang==='zh'?'待办已完成':'Todo completed'):(lang==='zh'?'待办已重新打开':'Todo reopened'));closeDrawer();await load('projects')})}
window.submitProjectMerge=async(event,source)=>{event.preventDefault();const trigger=event.submitter;const target=document.getElementById('project-target').value;if(!target||!confirm(lang==='zh'?'确认合并？源项目将转为历史别名。':'Merge these projects? The source becomes a historical alias.'))return;await runMutation('merge:'+source,trigger,async()=>{await postAction({action:'merge-project',project:source,target});toast(lang==='zh'?'项目已合并':'Projects merged');closeDrawer();projectSelect.value='';await load('projects')})}
window.submitProjectDelete=async(event,index,project)=>{event.preventDefault();const trigger=event.submitter,input=document.getElementById('project-delete-confirm');if(input.value.trim()!==project){toast(lang==='zh'?'项目 ID 不匹配':'Project ID does not match');input.focus();return}await runMutation('delete-project:'+project,trigger,async()=>{await postAction({action:'delete-project',project});toast(lang==='zh'?'项目已逻辑删除':'Project logically deleted');closeDrawer();projectSelect.value='';await load('projects')})}
window.deleteProject=async(index,trigger)=>{const x=window.visibleItems?.[index];if(!x)return;const project=x.project_id||x.id;if(!confirm(lang==='zh'?'逻辑删除 '+project+'？项目会退出活动路由，但已有记忆保留。':'Logically delete '+project+'? It leaves active routing while existing memories are retained.'))return;await runMutation('delete-project:'+project,trigger,async()=>{await postAction({action:'delete-project',project});toast(lang==='zh'?'项目已删除':'Project deleted');closeDrawer();projectSelect.value='';await load('projects')})}
window.saveDistillationConfig=async trigger=>{if(!ADMIN)return;const body={action:'set-distillation-config',auto_enabled:document.getElementById('cfg-auto').checked,turn_threshold:Number(document.getElementById('cfg-threshold').value),idle_minutes:Number(document.getElementById('cfg-idle').value)};await runMutation('distillation-config',trigger,async()=>{await postAction(body);toast(lang==='zh'?'蒸馏策略已保存':'Distillation policy saved');await load('processing')})}
document.addEventListener('keydown',event=>{const d=document.getElementById('drawer');if(d.classList.contains('hidden'))return;if(event.key==='Escape'){event.preventDefault();closeDrawer();return}if(event.key!=='Tab')return;const focusables=drawerFocusables();if(!focusables.length){event.preventDefault();d.focus();return}const first=focusables[0],last=focusables[focusables.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}else if(!d.contains(document.activeElement)){event.preventDefault();first.focus()}});
document.querySelectorAll('aside button[data-view]').forEach(b=>b.onclick=()=>load(b.dataset.view));document.querySelectorAll('#memory-flow [data-view-target]').forEach(b=>b.onclick=()=>load(b.dataset.viewTarget));if(mobileViewSelect)mobileViewSelect.onchange=()=>load(mobileViewSelect.value);filterInput.oninput=()=>renderCurrent();primaryAction.onclick=()=>openProjectForm('create');refreshButton.onclick=()=>load(current);projectSelect.onchange=()=>{syncScopeSummary();load(current)};if(accountSelect)accountSelect.onchange=()=>{const url=new URL(location.href);url.searchParams.set('account_id',accountSelect.value);location.href=url.toString()};document.getElementById('lang').onclick=()=>{lang=lang==='zh'?'en':'zh';localStorage.memhubLang=lang;tr()};document.getElementById('theme-toggle').onclick=()=>{theme=theme==='dark'?'light':'dark';localStorage.memhubTheme=theme;tr()};window.addEventListener('resize',()=>renderFreshness());window.addEventListener('popstate',()=>{const view=readUrlState();load(view,false,'none')});document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&!drawerIsOpen()&&Date.now()-lastRefreshAt>60000)load(current,true,'none')});clearInterval(window.__memhubAutoRefresh);window.__memhubAutoRefresh=setInterval(()=>{renderFreshness();if(document.visibilityState==='visible'&&!drawerIsOpen()&&Date.now()-lastRefreshAt>60000)load(current,true,'none')},15000);const menuToggle=document.getElementById('console-menu-toggle'),menu=document.getElementById('console-mobile-menu');if(menuToggle&&menu)menuToggle.onclick=()=>{const open=!menu.classList.toggle('hidden');menuToggle.setAttribute('aria-expanded',String(open));menuToggle.textContent=open?'×':'☰'};const initialView=readUrlState();tr();load(initialView,false,'replace');
`; }


function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function inlineJsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

async function loadSkillForAccount(runtime: MemhubRuntime, skillId: string): Promise<{
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

function skillFingerprint(skill: Awaited<ReturnType<typeof loadSkillForAccount>>): string {
  return createHash("sha256").update(JSON.stringify([
    skill.body, skill.title, skill.tags, skill.status, skill.projectId,
    skill.sourceAgentId, skill.sourceSkillId, skill.sourceSkillVersion
  ])).digest("hex");
}

function assertNextSkillVersion(current: string, next: string): void {
  const parse = (value: string): number[] => {
    if (!/^\d+(?:\.\d+){0,2}$/.test(value)) {
      throw new TypeError("Skill revision versions must be numeric dotted values such as 1.1.0");
    }
    return value.split(".").map(Number).concat([0, 0]).slice(0, 3);
  };
  const oldVersion = parse(current);
  const newVersion = parse(next);
  if (!newVersion.some((value, index) => value > oldVersion[index]! &&
      newVersion.slice(0, index).every((part, i) => part === oldVersion[i]))) {
    throw new Error(`Skill revision must advance version beyond ${current}`);
  }
}

function projectIdFromSkillTags(tags: readonly string[]): string | undefined {
  const tag = tags.find((value) => value.startsWith("project:"));
  const projectId = tag?.slice("project:".length).trim();
  return projectId || undefined;
}

function relevantProjectTodos(todos: readonly ProjectTodo[] | undefined, query: string): Array<{
  id: string;
  text: string;
  status: ProjectTodo["status"];
  completedAt?: string;
  matchedTerms: string[];
}> {
  const queryTerms = (uniqueStrings(tokenizeRetrievalText(query)) ?? []).slice(0, 32);
  const todoList = todos ?? [];
  if (queryTerms.length === 0 || todoList.length === 0) return [];
  const scored = todoList
    .map((todo) => {
      const todoTerms = new Set(tokenizeRetrievalText(todo.text));
      const matchedTerms = queryTerms.filter((term) => todoTerms.has(term));
      return { todo, matchedTerms, score: matchedTerms.length };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      Number(right.todo.status === "pending") - Number(left.todo.status === "pending") ||
      right.todo.updatedAt.localeCompare(left.todo.updatedAt)
    );
  const topScore = scored[0]?.score ?? 0;
  const minimumScore = queryTerms.length <= 2 ? 1 : Math.max(2, Math.ceil(topScore * 0.4));
  return scored
    .filter((item) => item.score >= minimumScore)
    .slice(0, 1)
    .map(({ todo, matchedTerms }) => ({
      id: todo.id,
      text: todo.text,
      status: todo.status,
      ...(todo.completedAt ? { completedAt: todo.completedAt } : {}),
      matchedTerms
    }));
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
