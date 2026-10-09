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
  listCaptureEvents,
  listDevices,
  revokeDevice
} from "./capture.js";
import { captureSessionId } from "./capture-ingest.js";
import { handleCaptureHttpRequest } from "./capture-http.js";
import { hydrateMemoryEvidence, recordMemoryHydration } from "./memory-hydration.js";
import { reconcileFrozenCaptureIngests } from "./capture-recovery.js";
import {
  auditDistillationControl,
  discoverDistillationControl,
  nextDistillationControl,
  recoverDistillationControl,
  renewDistillationControl,
  skipDistillationControl
} from "./distillation-control.js";
import { discoverDistillationJobs } from "./distillation-discovery.js";
import {
  distillationResultTimestamp,
  getDistillationConfig,
  listDistillationJobs,
  type DistillationEvidenceItem,
  type DistillationJob
} from "./distillation-jobs.js";
import { createMemhubRuntime, type MemhubRuntime, type MemhubRuntimeOptions } from "./runtime.js";
import type { ContextItem } from "./context-capsule.js";
import type { ProjectDescriptor, ProjectTodo } from "./project-registry.js";
import {
  DISTILLATION_CONTRACT_VERSION,
  distillationContract,
  validateDistillationCandidate
} from "./distillation-contract.js";
import {
  handleMemoryControlRead
} from "./memory-control-http.js";
import { handleMemoryControlAction } from "./memory-control-actions.js";
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
import { assertNextSkillVersion } from "./skill-version.js";
import { tokenizeRetrievalText } from "./retrieval-ranker.js";
import { JsonResultTransport } from "./result-transport.js";
import { renderConsole, renderDocs, renderLanding, renderUnprovisionedAccount } from "./web-ui.js";
import { distillationNextPayload } from "./distillation-transport.js";
import { submitDistillationControl } from "./distillation-submit.js";
import {
  reconcileCompletedL2DerivedJob,
  reconcileCurrentL4DerivedJob
} from "./distillation-derived-recovery.js";
import { planDistillationConsolidation } from "./distillation-consolidation.js";
import {
  commitArchitectureRevision,
  listArchitectureRevisions,
  prepareArchitectureRevision
} from "./architecture-history.js";
import {
  executeUserAuthorizedMemory,
  planUserAuthorizedMemory
} from "./user-authorized-memory.js";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
const projectMutationAuthorizations = new Map<string, {
  accountId: string;
  operation: "create" | "update" | "archive" | "unarchive" | "delete" | "merge";
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
const architectureMutationAuthorizations = new Map<string, {
  accountId: string;
  projectId: string;
  expectedPath: string;
  expectedFingerprint: string;
  content: string;
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
    description: "Private account/project-scoped long-term memory and project routing. Whenever Memhub is explicitly mentioned or invoked, first call memmy_context with the current request and the current workspace_project/project evidence; include a stable conversation_id when the Harness exposes one. Project-scoped tools should carry workspace_project or project from the current turn. A conversation binding is only a fallback when current-turn workspace/project evidence is unavailable. If explicit project and workspace_project disagree after canonical resolution, Memhub rejects the operation instead of guessing. If the transport does not expose a stable conversation_id, do not invent one. If a project name is unknown, case-variant, or merely similar, call memmy_project_list and compare canonical slug, aliases, and description before creating/binding. Project Registry mutations use memmy_project_manage plan -> explicit user authorization -> execute. Project Architecture replacements use memmy_project architecture_plan -> full-text user review -> architecture_execute. Explicit user-authored L3/L4 changes use memhub_memory plan -> full-text user review -> capture the confirmation as L1 -> execute. Project todos are first-class state. Before the final answer, persist only genuinely durable new facts/decisions/preferences/corrections rather than raw chat noise."
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
    description: "当 Memhub 被提及或调用时，先用本工具结合当前请求读取相关长期记忆。Harness 若能提供稳定 conversation_id 就传入，并可随后用 memmy_project action=current 核对持久 conversation binding；若 transport 没有稳定 conversation_id，不要伪造，直接使用本工具返回的 resolvedProjectId 与本轮显式 project/workspace 证据。若项目未唯一解析或名称相近，先调用 memmy_project_list 比较 canonical slug、aliases 与 description；不要尝试另一个大小写或盲目新建。当前轮的显式项目、workspace、项目名和 semantic_projects 优先于旧会话绑定；会话绑定只作为无本轮证据时的 fallback。业务记忆/架构只来自唯一 primary project；可复用 Skill 可从其他项目单独召回，不带入其业务 Current Truth。对能够证明当前 revision 的 L2/L3/L4 Memory，返回 item.evidenceRef；下游蒸馏必须原样回传该 exact ref，不要从稳定 Memory id 自行拼接或解析 latest。",
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
    await attachExactEvidenceRefsToContext(stateRoot, runtime, capsule);
    for (const item of [...capsule.globalMemory, ...capsule.projectMemory]) {
      if (!item.evidenceRef) continue;
      item.provenance = {
        ...(item.provenance ?? {}),
        hydration: {
          contract: "progressive-disclosure-v1",
          tool: "memhub_memory",
          action: "load",
          evidence_ref: item.evidenceRef
        }
      };
    }
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
      progressiveDisclosure: {
        version: "progressive-disclosure-v1",
        discover: "memmy_context",
        contextualize: "memhub_memory action=load evidence_ref=<exact-ref>",
        hydrateSkill: "memhub_skill action=load skill_id=<skill-id>",
        rule: "Load full content only for the selected exact revision or Skill; do not eagerly hydrate all recalled items."
      },
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

  server.registerTool("memhub_memory", {
    description: "Progressive-disclosure Memory read + explicit-user-authorized L3/L4 governance. action=load hydrates one exact evidenceRef (L1/L2/L3/L4) returned by memmy_context. action=plan prepares a full canonical L3 or L4 replacement; the model MUST show proposed_content to the user in full and ask for explicit confirmation. After the user confirms, capture that confirmation as L1 and call action=execute with the one-time authorization_id plus confirmation_evidence_ref. L3 is project-scoped; L4 is account-scoped. This direct-authority path never auto-promotes between layers and never replaces Todo/Project Architecture/Skill state.",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        action: { type: "string", enum: ["load", "plan", "execute"] },
        evidence_ref: { type: "string", description: "load: exact evidenceRef returned by memmy_context; do not reconstruct it." },
        kind: { type: "string", enum: ["l3", "l4"], description: "plan only. L3=project durable rules/experience; L4=account-wide durable profile/rules." },
        content: { type: "string", description: "plan only. The complete final canonical L3/L4 body, not a patch or append fragment." },
        base_evidence_ref: { type: "string", description: "plan only. Exact current L3/L4 evidenceRef from memmy_context. Required whenever that layer already has active memory." },
        project: { type: "string", description: "L3 plan only: explicit project slug/name/alias." },
        workspace_project: { type: "string", description: "L3 plan only: current workspace project; disagreement with project is rejected." },
        note: { type: "string", description: "plan only: short reason for the user-authorized change." },
        authorization_id: { type: "string", description: "execute only: one-time id returned by the exact plan the user approved." },
        confirmation_evidence_ref: { type: "string", description: "execute only: exact l1:<event-id> for the user's explicit confirmation turn." }
      },
      required: ["action"],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    const action = requiredString(args.action, "action");
    if (action === "load") {
      const item = await hydrateMemoryEvidence({
        stateRoot,
        accountId: runtime.accountId,
        evidenceRef: requiredString(args.evidence_ref, "evidence_ref")
      });
      const telemetry = await recordMemoryHydration({ stateRoot, accountId: runtime.accountId, item });
      return jsonResult({
        item,
        telemetry,
        progressive_disclosure: {
          hydrated: true,
          estimated_tokens: item.estimated_tokens,
          source_of_truth: item.revision_id ? "distillation-revision-ledger" : "durable-l1-capture"
        }
      });
    }
    if (action === "plan") {
      const kind = requiredString(args.kind, "kind");
      if (kind !== "l3" && kind !== "l4") throw new TypeError("kind must be l3 or l4");
      let projectId: string | null = null;
      if (kind === "l3") {
        projectId = (await resolveToolScope(runtime, {
          scope: "project",
          project: optionalString(args.project),
          workspaceProject: optionalString(args.workspace_project)
        })).projectId;
        if (!projectId) throw new Error("L3 plan requires a resolved project");
      }
      return jsonResult(await planUserAuthorizedMemory({
        stateRoot,
        runtime,
        kind,
        projectId,
        content: requiredString(args.content, "content"),
        baseEvidenceRef: optionalString(args.base_evidence_ref),
        note: optionalString(args.note)
      }));
    }
    if (action === "execute") {
      return jsonResult(await executeUserAuthorizedMemory({
        stateRoot,
        runtime,
        authorizationId: requiredString(args.authorization_id, "authorization_id"),
        confirmationEvidenceRef: requiredString(args.confirmation_evidence_ref, "confirmation_evidence_ref")
      }));
    }
    throw new TypeError("action must be load, plan, or execute");
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
        projectId: skill.projectId,
        estimatedTokens: Math.max(1, Math.ceil(Buffer.byteLength(skill.body, "utf8") / 4))
      });
      return jsonResult({
        skill_id: skillId,
        execution_id: loaded.executionId,
        metadata: skillSelectionMetadataFromBody(skill.body, {
          projectId: skill.projectId,
          tags: skill.tags,
          title: skill.title,
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
    description: "统一的 L2/L3/L4/Skill 蒸馏入口。L2=项目发展时间线，并可同时产出 evidence-backed project_description；L3=项目内用户长期规则/经验/偏好，L4=跨项目用户画像，Skill=正交的可执行流程。语义整理由当前 Harness 模型完成；Memhub 负责证据边界、scope、版本、provenance 与提交。consolidate 是 EverOS-style reflection 的只读计划：选择历史 revision → merge/re-extract → 用现有 canonical artifact 提交 replacement，不新增记忆层。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        action: { type: "string", enum: ["audit", "discover", "consolidate", "recover_ingest", "reconcile_derived", "reconcile_l4", "next", "renew", "submit", "skip"], description: "audit 只读审计；discover 扫描 L1；consolidate 为 L2/L3 生成 select→merge→re-extract→supersede 只读计划；recover/reconcile 处理缺口；next/renew/submit/skip 处理正式蒸馏。" },
        event_id: { type: "string", description: "recover_ingest 必填的完整稳定 Capture event_id，仅恢复此事件" },
        kind: { type: "string", enum: ["l2", "l3", "l4", "skill"], description: "目标层。next 可省略以领取任意待办；submit 必须与 job target 一致。" },
        content: { type: "string", description: "完整目标层内容" },
        scope: { type: "string", enum: ["account", "project"], description: "L2/L3 必须 project；L4 必须 account；Skill 可两者。" },
        project: { type: "string", description: "project scope 的明确项目 slug" },
        workspace_project: { type: "string", description: "当前工作区解析出的 project；与 project 不一致时拒绝项目级操作" },
        conversation_id: { type: "string", description: "可继承已绑定项目；不会跨项目猜测" },
        title: { type: "string", description: "可选标题；Skill 必填" },
        tags: { type: "array", items: { type: "string" } },
        source_harness: { type: "string", description: "产生该沉淀的 Harness，例如 codex / claude-code" },
        artifact_id: { type: "string", description: "可覆盖默认 canonical artifact id；Skill 必填，且同一 workflow 的所有 revision 必须保持稳定不变" },
        version: { type: "string", description: "Harness 侧产物版本；Skill 必填 numeric dotted 版本，例如 1.1.0" }
        ,project_description: { type: "string", description: "L2 可附带 1-3 句项目描述，概括目标、范围与当前重点；必须来自同一批证据。人工描述存在时不会被覆盖。" }
        ,evidence_refs: { type: "array", items: { type: "string" }, description: "支持该产物的精确证据引用。L2 使用不可变 L1 ref；L3/L4 必须原样使用 memmy_context 或 leased job 返回的 exact revision ref（l2:<memory-id>:<revision-id> / l3:<memory-id>:<revision-id>），禁止只提交稳定 Memory id 或自动解析 latest。" }
        ,source_conversations: { type: "array", items: { type: "string" }, description: "产物来源对话 ID；与 distilled_by 分开保存" }
        ,confidence: { type: "number", minimum: 0, maximum: 1 }
        ,job_id: { type: "string", description: "submit/next 的 leased job，reconcile_derived 的已完成 L2 source job，或 reconcile_l4 的当前最新 L3 source job" }
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
    if (action === "audit") {
      return jsonResult(await auditDistillationControl({
        stateRoot,
        runtime,
        bridgeRoot: process.env.MEMHUB_BRIDGE_HOME ?? null
      }));
    }
    if (action === "consolidate") {
      const kind = requiredString(args.kind, "kind");
      if (kind !== "l2" && kind !== "l3") throw new TypeError("consolidate kind must be l2 or l3");
      const { projectId } = await resolveToolScope(runtime, {
        scope: "project",
        project: requiredString(args.project, "project"),
        workspaceProject: optionalString(args.workspace_project)
      });
      return jsonResult(await planDistillationConsolidation({
        stateRoot,
        runtime,
        kind,
        projectId: projectId!
      }));
    }
    if (action === "recover_ingest") {
      const eventId = requiredString(args.event_id, "event_id");
      const { projectId } = await resolveToolScope(runtime, {
        scope: "project",
        project: requiredString(args.project, "project"),
        workspaceProject: optionalString(args.workspace_project)
      });
      return jsonResult(await recoverDistillationControl({
        stateRoot, runtime, eventId, projectId: projectId!, dryRun: args.dry_run === true
      }));
    }
    if (action === "reconcile_derived") {
      const jobId = requiredString(args.job_id, "job_id");
      const { projectId } = await resolveToolScope(runtime, {
        scope: "project",
        project: requiredString(args.project, "project"),
        workspaceProject: optionalString(args.workspace_project)
      });
      return jsonResult(await reconcileCompletedL2DerivedJob({
        stateRoot, accountId: runtime.accountId, jobId,
        projectId: projectId!, dryRun: args.dry_run !== false
      }));
    }
    if (action === "reconcile_l4") {
      return jsonResult(await reconcileCurrentL4DerivedJob({
        stateRoot,
        accountId: runtime.accountId,
        jobId: requiredString(args.job_id, "job_id"),
        dryRun: args.dry_run !== false
      }));
    }
    if (action === "discover") {
      return jsonResult(await discoverDistillationControl({
        stateRoot,
        runtime,
        dryRun: args.dry_run === true,
        ...(optionalString(args.conversation_id) ? { conversationId: optionalString(args.conversation_id) } : {})
      }));
    }
    if (action === "next") {
      return jsonResult(await nextDistillationControl({
        stateRoot,
        runtime,
        sourceHarness,
        leaseToken,
        jobId: optionalString(args.job_id),
        kind: optionalString(args.kind),
        scope: optionalString(args.scope),
        project: optionalString(args.project),
        workspaceProject: optionalString(args.workspace_project),
        conversationId: optionalString(args.conversation_id),
        evidenceOffset: optionalInteger(args.evidence_offset) ?? 0,
        evidenceChunkChars: optionalInteger(args.evidence_chunk_chars) ?? 120_000,
        leaseSeconds: optionalInteger(args.lease_seconds),
        leaseTokenSupported: args.lease_token_supported === true,
        resolveProjectScope: async (scope) => (await resolveToolScope(runtime, {
          scope: "project", ...scope
        })).projectId,
        renderNext: distillationNextPayload
      }));
    }
    if (action === "renew") {
      return jsonResult(await renewDistillationControl({
        stateRoot, runtime,
        jobId: requiredString(args.job_id, "job_id"),
        sourceHarness, leaseToken,
        leaseSeconds: optionalInteger(args.lease_seconds) ?? 300
      }));
    }
    if (action === "skip") {
      return jsonResult(await skipDistillationControl({
        stateRoot, runtime,
        jobId: requiredString(args.job_id, "job_id"),
        sourceHarness, leaseToken
      }));
    }
    if (action !== undefined && action !== "submit") throw new TypeError("action must be audit, discover, consolidate, recover_ingest, reconcile_derived, reconcile_l4, next, renew, submit, or skip");
    return jsonResult(await submitDistillationControl({
      args, stateRoot, runtime, sourceHarness, leaseToken,
      resolveToolScope, validateDistillationEvidenceChain
    }));
  });

  server.registerTool("memmy_project_list", {
    description: "只读列出当前账号的项目注册表。默认仅返回 active 项目；include_archived 可显式查看 archived 项目，include_inactive 可查看 merged/deleted/archived 历史状态。返回 canonical project slug、显示名、description、aliases 和状态；query 可按相似名称检索候选。模型在准备创建项目、绑定一个不确定项目、或发现大小写/近似名称时，应先调用本工具，用名称相似度 + description 判断是否已有同一项目，禁止盲目新建。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        query: { type: "string", description: "可选的项目名称/slug/关键词，用于查找相似项目候选" },
        include_archived: { type: "boolean", description: "是否显式包含 archived 项目；默认 false。归档项目保留全部 Memory，但不会出现在普通列表中。" },
        include_inactive: { type: "boolean", description: "是否包含 archived/merged/deleted 历史项目；默认 false" },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "相似候选最大数量；默认 8" }
      },
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    await knownProjectRecords(runtime);
    const includeInactive = optionalBoolean(args.include_inactive) ?? false;
    const includeArchived = optionalBoolean(args.include_archived) ?? false;
    const projects = await runtime.projects.list(runtime.accountId, { includeInactive, includeArchived });
    const query = optionalString(args.query);
    const matches = query
      ? await runtime.projects.suggest(runtime.accountId, query, optionalInteger(args.limit) ?? 8, {
          includeArchived: includeInactive || includeArchived
        })
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
    description: "受控项目管理工具。支持 create/update/archive/unarchive/delete/merge，但所有修改都必须先 action=plan；plan 只返回一次性 authorization_id 和影响说明，不修改数据。模型必须把计划展示给用户，并在收到针对该计划的明确授权后才能 action=execute。禁止把 plan 本身、历史授权或模型推断当成授权。archive 是可恢复的非破坏性归档：保留全部 Memory/别名/待办，默认项目列表、路由和管理界面隐藏；unarchive 恢复为 active。delete 是逻辑删除，不物理清空 Memory；merge 将 source 变成 target 的历史 alias，未来写入统一到 target，旧 alias 下的历史记忆仍参与召回。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        action: { type: "string", enum: ["plan", "execute"] },
        operation: { type: "string", enum: ["create", "update", "archive", "unarchive", "delete", "merge"] },
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
      if (!["create", "update", "archive", "unarchive", "delete", "merge"].includes(operation)) throw new TypeError("unsupported project management operation");
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
        const canonical = operation === "unarchive"
          ? await runtime.projects.resolve(runtime.accountId, project, { includeArchived: true })
          : await runtime.projects.resolve(runtime.accountId, project);
        if (!canonical) throw new Error(`unknown or inactive project: ${project}`);
        payload.project = canonical;
        if (operation === "update") {
          const hasName = typeof args.name === "string";
          const hasDescription = typeof args.description === "string";
          const hasAliases = Array.isArray(args.aliases);
          if (!hasName && !hasDescription && !hasAliases) throw new TypeError("update requires name, description, or aliases");
          if (hasName && !String(args.name).trim()) throw new TypeError("name must be a non-empty string");
          if (hasAliases && (args.aliases as unknown[]).some((item) => typeof item !== "string" || !item.trim())) {
            throw new TypeError("aliases must contain only non-empty strings; use [] to clear aliases");
          }
          const current = (await runtime.projects.list(runtime.accountId)).find((item) => item.projectId === canonical);
          if (!current) throw new Error(`unknown or inactive project: ${canonical}`);
          const normalizedAliases = hasAliases ? stringArray(args.aliases) ?? [] : current.aliases;
          const sameAliases = [...normalizedAliases].sort().join("\u0000") === [...current.aliases].sort().join("\u0000");
          if ((!hasName || String(args.name).trim() === current.name) &&
              (!hasDescription || String(args.description).trim() === (current.manualDescription ?? "")) &&
              (!hasAliases || sameAliases)) {
            throw new TypeError("update has no effective changes; provide a different name, description, or aliases");
          }
          if (hasName) payload.name = String(args.name);
          if (hasDescription) payload.description = String(args.description);
          if (hasAliases) payload.aliases = stringArray(args.aliases) ?? [];
          impact = {
            project: canonical,
            stableCanonicalSlug: canonical,
            changesMetadataOnly: true
          };
        } else if (operation === "archive") {
          const blockers = (await unfinishedDistillationJobsForProject(stateRoot, runtime, canonical))
            .filter((job) => job.status === "pending" || job.status === "leased");
          const historicalFailed = (await unfinishedDistillationJobsForProject(stateRoot, runtime, canonical))
            .filter((job) => job.status === "failed");
          impact = {
            project: canonical,
            logicalArchive: true,
            memoryPurged: false,
            hiddenByDefault: true,
            restorable: true,
            blockedByDistillationJobs: blockers.map((job) => ({
              job_id: job.job_id,
              status: job.status,
              target: job.target
            })),
            preservedFailedDistillationJobs: historicalFailed.map((job) => ({
              job_id: job.job_id,
              status: job.status,
              target: job.target
            })),
            note: "All durable evidence, aliases and Todos remain stored. The project is removed from normal routing/list/UI until unarchived."
          };
        } else if (operation === "unarchive") {
          const current = (await runtime.projects.list(runtime.accountId, { includeInactive: true }))
            .find((item) => item.projectId === canonical);
          if (!current || current.state !== "archived") throw new Error(`project is not archived: ${project}`);
          impact = {
            project: canonical,
            restoresActiveRouting: true,
            memoryPreserved: true,
            aliasesPreserved: true,
            todosPreserved: true
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
      // Project governance has the same human-in-the-loop approval boundary as
      // Skill governance; use the same one-day approval window. Execute remains
      // one-shot and validates the planned object before mutation.
      const expiresAt = Date.now() + 24 * 60 * 60_000;
      projectMutationAuthorizations.set(authorizationId, {
        accountId: runtime.accountId,
        operation: operation as "create" | "update" | "archive" | "unarchive" | "delete" | "merge",
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
    } else if (authorization.operation === "archive") {
      const blockers = (await unfinishedDistillationJobsForProject(stateRoot, runtime, project))
        .filter((job) => job.status === "pending" || job.status === "leased");
      if (blockers.length > 0) {
        throw new Error(`project has ${blockers.length} active distillation job(s); complete or resolve them before archive`);
      }
      result = await runtime.projects.archive(runtime.accountId, project);
    } else if (authorization.operation === "unarchive") {
      result = await runtime.projects.unarchive(runtime.accountId, project);
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
    description: "项目上下文 + Project Architecture。action=current 在没有 conversation_id 时不会报错或伪造会话身份；本轮明确 project/workspace 优先。list/current/bind/unbind 管项目解析；architecture 只读当前架构；architecture_plan 准备完整 canonical Architecture replacement，必须把 proposed_content 全文展示给用户并取得明确授权后才能 architecture_execute；architecture_history 读取本地审计/回滚历史。Architecture 只承载稳定结构、ownership、SOT、接口与硬约束；动态进度放 L2，Todo 放 memhub_todo，项目 metadata 用 memmy_project_manage。Legacy normify-* 永远只读。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "current", "bind", "unbind", "architecture", "architecture_plan", "architecture_execute", "architecture_history"] },
        conversation_id: { type: "string" },
        project: { type: "string" },
        workspace_project: { type: "string", description: "当前工作区解析出的 project；与 project 不一致时拒绝操作" },
        query: { type: "string", description: "architecture 时用于选择最相关的架构模块" },
        content: { type: "string", description: "architecture_plan：完整最终 canonical Architecture 正文，不是 patch/append 片段。" },
        authorization_id: { type: "string", description: "architecture_execute：用户明确批准对应 plan 后使用的一次性 authorization id。" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "architecture_history 返回条数，默认 20。" }
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
    if (action === "architecture_history") {
      const explicitEvidence = await resolveExplicitProjectEvidence(runtime, {
        project: optionalString(args.project),
        workspaceProject: optionalString(args.workspace_project)
      });
      if (!explicitEvidence.projectId) throw new TypeError("architecture_history requires project or workspace_project");
      return jsonResult({
        project: explicitEvidence.projectId,
        revisions: await listArchitectureRevisions({
          stateRoot,
          accountId: runtime.accountId,
          projectId: explicitEvidence.projectId,
          limit: optionalInteger(args.limit) ?? 20
        }),
        rollback: "To roll back, take the desired revision's before_content/proposed_content, create a fresh architecture_plan with that complete text, show it to the user, then execute only after approval."
      });
    }
    if (action === "architecture_plan") {
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
      return jsonResult({
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
      });
    }
    if (action === "architecture_execute") {
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
      return jsonResult({
        ok: true,
        operation: "replace_project_architecture",
        project: plan.projectId,
        path: written.after.path,
        fingerprint: written.after.fingerprint,
        revision_id: audit.revision_id,
        history_preserved: true,
        rollback_available: true
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
        await handleCaptureHttpRequest({
          request,
          response,
          stateRoot: options.stateRoot,
          runtimeFor,
          queueDistillation: maybeQueueThresholdDistillation
        });
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
          await handleMemoryControlRead({
            response,
            url,
            stateRoot: options.stateRoot,
            runtime,
            accounts,
            selectedAccount,
            adminView
          });
          return;
        }
        if (url.pathname === actionPath && request.method === "POST") {
          await handleMemoryControlAction({
            request, response, stateRoot: options.stateRoot, runtime, accounts, selectedAccount, adminView,
            unfinishedDistillationJobsForProject, assertManagedMemory
          });
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

  // The durable ingested marker is the reconciliation source after a
  // marker->enqueue crash. Scan once on startup instead of waiting for the
  // next 60-second tick, and prevent overlapping full-account scans.
  let inFlightDiscovery: Promise<void> | null = null;
  const reconcile = (): Promise<void> => {
    if (!inFlightDiscovery) {
      const current = queueIdleDistillation(options.stateRoot, runtimeFor)
        .catch((error) => {
          console.error("[memhub] idle distillation scheduler:", error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (inFlightDiscovery === current) inFlightDiscovery = null;
        });
      inFlightDiscovery = current;
    }
    return inFlightDiscovery;
  };
  void reconcile();
  const idleTimer = setInterval(() => { void reconcile(); }, 60_000);
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
  // Frozen Core intents are a capture durability concern, not a distillation
  // preference, so include complete un-ingested accounts even when automatic
  // distillation is disabled.
  const entries = await listCaptureIndexEntries(stateRoot, undefined, { completeOnly: true });
  const failures: Error[] = [];
  for (const accountId of new Set(entries.map((item) => item.account_id))) {
    try {
      const runtime = runtimeForAccount(accountId);
      await reconcileFrozenCaptureIngests({ stateRoot, runtime });
      if (!config.auto_enabled) continue;
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

async function attachExactEvidenceRefsToContext(
  stateRoot: string,
  runtime: MemhubRuntime,
  capsule: { globalMemory: ContextItem[]; projectMemory: ContextItem[] }
): Promise<void> {
  const jobs = await listDistillationJobs(stateRoot, runtime.accountId);
  const items = [...capsule.globalMemory, ...capsule.projectMemory];
  for (const item of items) {
    const layer = item.provenance?.memoryLayer;
    const prefix = layer === "L2" ? "l2" : layer === "L3" ? "l3" : layer === "L4" ? "l4" : null;
    if (!prefix || !item.updatedAt) continue;
    const updatedAt = Date.parse(item.updatedAt);
    if (!Number.isFinite(updatedAt)) continue;
    const candidate = jobs
      .filter((job) =>
        job.status === "completed" &&
        job.target === prefix &&
        job.result_kind === prefix &&
        job.result_id === item.id &&
        Boolean(job.result_content?.trim()) &&
        Boolean(distillationResultTimestamp(job))
      )
      .sort((a, b) =>
        (distillationResultTimestamp(b) ?? "").localeCompare(distillationResultTimestamp(a) ?? "") ||
        b.job_id.localeCompare(a.job_id)
      )
      .find((job) => {
        const committedAt = Date.parse(distillationResultTimestamp(job)!);
        // Core and the local revision ledger are committed by the same submit
        // operation but do not share one clock write. A narrow window proves
        // this is the current revision while rejecting stale historical jobs.
        return Number.isFinite(committedAt) && Math.abs(updatedAt - committedAt) <= 60_000;
      });
    if (candidate) item.evidenceRef = `${prefix}:${item.id}:${candidate.job_id}`;
  }
}

async function validateDistillationEvidenceChain(input: {
  stateRoot: string;
  runtime: MemhubRuntime;
  kind: "l2" | "l3" | "l4" | "skill";
  projectId: string | null;
  evidenceRefs: string[];
  job?: DistillationJob;
}): Promise<DistillationEvidenceItem[]> {
  if (input.kind === "skill") return [];

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
      return structuredClone(input.job.evidence);
    }
    if (input.kind === "l3") {
      if (!input.projectId || input.job.evidence.some((item) => !item.project_id || !projectStorageIds?.has(item.project_id))) {
        throw new Error("L3 job evidence must be L2 from the same project");
      }
      return structuredClone(input.job.evidence);
    }
    const projects = new Set(input.job.evidence.map((item) => item.project_id).filter(Boolean));
    if (projects.size < 2) throw new Error("L4 job requires L3 evidence from at least two projects");
    return structuredClone(input.job.evidence);
  }

  if (input.kind === "l2") {
    if (!input.projectId) throw new Error("L2 evidence requires a resolved project");
    const projectStorageIds = new Set(await input.runtime.projects.storageIds(input.runtime.accountId, input.projectId));
    const captures = await listCaptureEvents(input.stateRoot, input.runtime.accountId);
    const byId = new Map(captures.map((item) => [item.event_id, item]));
    const resolved: DistillationEvidenceItem[] = [];
    for (const ref of input.evidenceRefs) {
      const eventId = parseLayerEvidenceRef(ref, "l1");
      const event = byId.get(eventId);
      if (!event || !event.ingested || event.capture_status !== "complete" || !event.user_text?.trim() || !event.assistant_text?.trim()) {
        throw new Error(`L2 evidence does not resolve to a complete ingested L1 turn: ${ref}`);
      }
      if (!event.project_hint || !projectStorageIds.has(event.project_hint)) {
        throw new Error(`L2 evidence belongs to another or unresolved project: ${ref}`);
      }
      resolved.push({
        ref,
        kind: "turn",
        layer: "L1",
        timestamp: event.timestamp,
        project_id: event.project_hint,
        conversation_id: event.conversation_id,
        user_text: event.user_text.trim(),
        assistant_text: event.assistant_text.trim(),
        ...(event.reasoning_summary?.trim() ? { reasoning_summary: event.reasoning_summary.trim() } : {})
      });
    }
    return resolved;
  }

  const expectedLayer = input.kind === "l3" ? "L2" : "L3";
  const expectedPrefix = input.kind === "l3" ? "l2" : "l3";
  const projectStorageIds = input.kind === "l3" && input.projectId
    ? new Set(await input.runtime.projects.storageIds(input.runtime.accountId, input.projectId))
    : null;
  const jobs = await listDistillationJobs(input.stateRoot, input.runtime.accountId);
  const candidateRefs = completedRevisionCandidates(jobs, expectedPrefix, projectStorageIds);
  const resolved: DistillationEvidenceItem[] = [];
  const projects = new Set<string>();

  for (const ref of input.evidenceRefs) {
    const parsed = parseVersionedLayerEvidenceRef(ref, expectedPrefix);
    if (!parsed) {
      throw exactEvidenceRefError({
        requiredLayer: expectedLayer,
        received: ref,
        projectId: input.projectId,
        expectedPrefix,
        candidateRefs
      });
    }
    const source = jobs.find((item) => item.job_id === parsed.revisionId);
    if (!source ||
        source.status !== "completed" ||
        source.target !== expectedPrefix ||
        source.result_kind !== expectedPrefix ||
        source.result_id !== parsed.memoryId ||
        !source.result_content?.trim() ||
        !distillationResultTimestamp(source)) {
      throw exactEvidenceRefError({
        requiredLayer: expectedLayer,
        received: ref,
        projectId: input.projectId,
        expectedPrefix,
        candidateRefs
      });
    }
    const project = source.project_id?.trim();
    if (!project) {
      throw new Error(`${expectedLayer} revision is missing project provenance: ${ref}`);
    }
    if (input.kind === "l3" && !projectStorageIds?.has(project)) {
      throw new Error(`L3 evidence belongs to another project: ${ref}`);
    }
    projects.add(project);
    resolved.push({
      ref,
      kind: "artifact",
      layer: expectedLayer,
      timestamp: distillationResultTimestamp(source)!,
      project_id: project,
      title: canonicalLayerTitle(expectedPrefix, project),
      content: source.result_content
    });
  }
  if (input.kind === "l4" && projects.size < 2) {
    throw new Error("L4 requires L3 evidence from at least two distinct projects");
  }
  return resolved;
}

function completedRevisionCandidates(
  jobs: DistillationJob[],
  expectedPrefix: "l2" | "l3",
  projectStorageIds: Set<string> | null
): string[] {
  return jobs
    .filter((job) =>
      job.status === "completed" &&
      job.target === expectedPrefix &&
      job.result_kind === expectedPrefix &&
      Boolean(job.result_id?.trim()) &&
      Boolean(job.result_content?.trim()) &&
      Boolean(distillationResultTimestamp(job)) &&
      (!projectStorageIds || Boolean(job.project_id && projectStorageIds.has(job.project_id)))
    )
    .sort((a, b) =>
      (distillationResultTimestamp(b) ?? "").localeCompare(distillationResultTimestamp(a) ?? "") ||
      b.job_id.localeCompare(a.job_id)
    )
    .slice(0, 5)
    .map((job) => `${expectedPrefix}:${job.result_id}:${job.job_id}`);
}

function exactEvidenceRefError(input: {
  requiredLayer: "L2" | "L3";
  received: string;
  projectId: string | null;
  expectedPrefix: "l2" | "l3";
  candidateRefs: string[];
}): Error {
  return new Error([
    "MEMHUB_EVIDENCE_REF_INVALID",
    `required_layer: ${input.requiredLayer}`,
    `received: ${input.received}`,
    `resolved_project: ${input.projectId ?? "account"}`,
    `valid_evidence_ref_example: ${input.expectedPrefix}:<memory-id>:<revision-id>`,
    "hint: Use the exact evidenceRef returned by memmy_context; do not rebuild it from the stable Memory id.",
    ...(input.candidateRefs.length > 0
      ? [`candidate_evidence_refs: ${input.candidateRefs.join(", ")}`]
      : [])
  ].join(" | "));
}

function parseVersionedLayerEvidenceRef(
  ref: string,
  expectedPrefix: "l2" | "l3"
): { memoryId: string; revisionId: string } | null {
  const prefix = `${expectedPrefix}:`;
  if (!ref.startsWith(prefix)) return null;
  const value = ref.slice(prefix.length).trim();
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;
  const memoryId = value.slice(0, separator).trim();
  const revisionId = value.slice(separator + 1).trim();
  return memoryId && revisionId ? { memoryId, revisionId } : null;
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

function uniqueStrings(values: string[]): string[] | undefined {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return normalized.length ? [...new Set(normalized)] : undefined;
}

function normalizeArchitecturePlanContent(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized) throw new TypeError("Project Architecture content must be non-empty");
  return `${normalized}\n`;
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

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new TypeError("value must be a boolean");
  return value;
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
