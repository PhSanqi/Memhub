#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import type { JsonSchemaType } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { runAccountCommand, runAdminTokenCommand } from "./cli-admin.js";
import { recoverCaptureIndex, listCaptureEvents } from "./capture.js";
import {
  attachExactEvidenceRefsToContext,
  explainMemoryWhy,
  hydrateMemoryEvidence,
  recordMemoryHydration
} from "./memory-hydration.js";
import {
  relevantProjectTodos,
  resolveExplicitProjectEvidence,
  resolveToolScope
} from "./context-router.js";
import {
  auditDistillationControl,
  discoverDistillationControl,
  nextDistillationControl,
  recoverDistillationControl,
  renewDistillationControl,
  skipDistillationControl
} from "./distillation-control.js";
import { validateDistillationEvidenceChain } from "./distillation-evidence.js";
import {
  maybeQueueThresholdDistillation,
  queueIdleDistillation
} from "./distillation-scheduling.js";
import {
  executeProjectMutation,
  planProjectMutation,
  unfinishedDistillationJobsForProject
} from "./project-governance.js";
import { createMemhubRuntime, resolveLocalAccountId, type MemhubRuntime, type MemhubRuntimeOptions } from "./runtime.js";
import { resolveControlRoot } from "./state-root.mjs";
import { utf8Prefix } from "./context-capsule.js";
import type { ProjectDescriptor } from "./project-registry.js";
import { distillationContract } from "./distillation-contract.js";
import {
  executeSkillMutation,
  loadSkillForAccount,
  planSkillMutation
} from "./skill-governance.js";
import { recentL1Continuity, upsertL1Turn } from "./turn-log.js";
import { assignCaptureProjects, projectClarification } from "./capture-project-assignments.js";
import { resolveCaptureProject } from "./capture-project-resolution.js";
import {
  readSkillExecution,
  recordSkillExecutionEvent,
  recordSkillLoad,
  skillTelemetrySummary,
  type SkillExecutionStage
} from "./skill-telemetry.js";
import { enrichSkillCandidateReliability, skillSelectionMetadataFromBody } from "./skill-router.js";
import { buildTurnKnowledgePlan } from "./turn-knowledge-plan.js";
import { JsonResultTransport } from "./result-transport.js";
import { normalizeBasePath, serveHttp } from "./gateway-http.js";
import { distillationNextPayload } from "./distillation-transport.js";
import { submitDistillationControl } from "./distillation-submit.js";
import {
  reconcileCompletedL2DerivedJob,
  reconcileCurrentL4DerivedJob
} from "./distillation-derived-recovery.js";
import { planDistillationConsolidation } from "./distillation-consolidation.js";
import { listArchitectureRevisions } from "./architecture-history.js";
import {
  executeArchitectureMutation,
  planArchitectureMutation
} from "./architecture-governance.js";
import {
  executeUserAuthorizedMemory,
  planUserAuthorizedMemory
} from "./user-authorized-memory.js";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

export interface MemhubMcpOptions extends MemhubRuntimeOptions {}

export function createMemhubMcpServer(options: MemhubMcpOptions = {}): McpServer {
  const stateRoot = resolve(options.controlRoot ?? process.env.MEMHUB_CONTROL_ROOT ?? defaultStateRoot());
  const runtime = createMemhubRuntime({ ...options, controlRoot: stateRoot });
  const server = createMemhubMcpServerForRuntime(runtime, stateRoot);
  const onclose = server.server.onclose;
  server.server.onclose = () => { try { onclose?.(); } finally { runtime.dispose(); } };
  return server;
}

export function createMemhubMcpServerForRuntime(runtime: MemhubRuntime, stateRoot = defaultStateRoot()): McpServer {
  const server = new McpServer({
    name: "memhub",
    version: VERSION,
    description: "Private account/project-scoped long-term memory and project routing. Each Memhub turn should call memmy_context with the current request plus explicit workspace_project/project evidence, then memmy_turn action=open before work and action=commit before the final answer. Host conversation/session IDs are optional provenance only: they do not select projects, branches, or distillation batches. Project-scoped tools must carry workspace_project or project from the current turn. If explicit project and workspace_project disagree after canonical resolution, Memhub rejects the operation instead of guessing. If a project name is unknown, case-variant, or merely similar, call memmy_project_list and compare canonical slug, aliases, and description before creating anything. Project Registry mutations use memmy_project_manage plan -> explicit user authorization -> execute. Project Architecture replacements use memmy_project architecture_plan -> full-text user review -> architecture_execute. Explicit user-authored L3/L4 changes use memhub_memory plan -> full-text user review -> capture the confirmation as L1 -> execute. Project todos are first-class state."
  });
  const resultTransport = new JsonResultTransport(stateRoot, runtime.accountId);
  const jsonResult = (value: unknown, pretty = true) => inlineJsonResult(resultTransport.wrap(value, { readOnly: true }), pretty);

  server.registerTool("memhub_result", {
    description: "续取被 Memhub 分片的 MCP JSON 结果。当返回 result_transport.mode=chunked 时，按 result_id 和 next_offset 继续读取，按 offset 拼接 result_chunk 后解析原始 JSON。短结果不经过此工具。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        result_id: { type: "string", description: "大结果传输标识" },
        offset: { type: "integer", minimum: 0, description: "续取起始字符偏移量" },
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
    description: "Record turns with open/commit; when project_resolution appears, ask the user then call assign.",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        action: { type: "string", enum: ["open", "checkpoint", "commit", "failed", "truncated", "resume", "assign"], description: "open/checkpoint/commit/failed/truncated/resume/assign" },
        event_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 200 },
        keep_global: { type: "boolean" },
        event_id: { type: "string", description: "open 返回的稳定 L1 event id；后续 checkpoint/commit/resume 原样回传" },
        conversation_id: { type: "string", description: "可选 transport provenance；不用于 project/branch 路由" },
        continuity_id: { type: "string", description: "Explicit continuity key; assign binds later turns" },
        turn_id: { type: "string", description: "Harness 原生 turn id；可替代 event_id 做幂等定位" },
        previous_event_id: { type: "string", description: "显式前序 L1 event id" },
        project: { type: "string", description: "明确 canonical project；与 workspace_project 冲突时拒绝" },
        workspace_project: { type: "string", description: "当前工作区解析出的 project；与 project 冲突时拒绝" },
        user_text: { type: "string", description: "用户原始输入文本" },
        assistant_text: { type: "string", description: "助手最终回答文本" },
        reasoning_summary: { type: "string", description: "可公开审计的决策摘要，不得包含隐藏 chain-of-thought" },
        tool_summary: { type: "string", description: "关键工具动作与结果摘要" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "resume 最大返回轮数，默认 12" }
      },
      required: ["action"],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    const action = requiredString(args.action, "action");
    const transportConversationId = optionalString(args.conversation_id);
    const requestedContinuityId = optionalString(args.continuity_id);
    if (action === "assign") {
      return jsonResult({ ok: true, ...await assignCaptureProjects({
        stateRoot, accountId: runtime.accountId, projects: runtime.projects, assignedBy: "host",
        project: args.project, keepGlobal: args.keep_global, continuityId: args.continuity_id, eventIds: args.event_ids
      }) });
    }
    if (action === "resume") {
      const resumeEventId = optionalString(args.event_id);
      const event = resumeEventId
        ? (await listCaptureEvents(stateRoot, runtime.accountId, { eventId: resumeEventId, limit: 1 }))[0]
        : undefined;
      if (resumeEventId && !event) throw new Error("capture event not found for account");
      const continuityId = requestedContinuityId ?? transportConversationId ?? event?.continuity_id;
      if (!continuityId) throw new TypeError("resume requires continuity_id, conversation_id, or event_id");
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
    const existingEvent = eventId ? (await listCaptureEvents(stateRoot, runtime.accountId, { eventId, limit: 1 }))[0] : undefined;
    const continuityId = requestedContinuityId ?? existingEvent?.continuity_id ?? conversationId;

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
      turn: {
        ...(stableEventId ? { event_id: stableEventId } : {}),
        host: runtime.source.platform,
        conversation_id: existingEvent?.conversation_id ?? conversationId,
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
          transport_conversation_id_available: Boolean(transportConversationId)
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
          projectId: result.project_id
        });
      } catch (error) {
        distillation_queue_error = error instanceof Error ? error.message : String(error);
        console.error("[memhub] turn distillation queue:", distillation_queue_error);
      }
    }
    let distillationAck: { queued: boolean; job_id?: string } | undefined;
    if (distillation) {
      const rec = objectRecord(distillation);
      const jobs = Array.isArray(rec.jobs) ? rec.jobs : [];
      const firstJob = jobs.length > 0 ? objectRecord(jobs[0]) : undefined;
      const jobId = typeof firstJob?.job_id === "string" ? firstJob.job_id : undefined;
      distillationAck = {
        queued: Boolean(rec.queued || jobs.length > 0),
        ...(jobId ? { job_id: jobId } : {})
      };
    }
    const storedEvent = (action === "open" || action === "commit") && !result.project_id
      ? (await listCaptureEvents(stateRoot, runtime.accountId, { eventId: result.turn.event_id, limit: 1 }))[0] : undefined;
    const resolution = storedEvent ? await resolveCaptureProject(storedEvent,
      ref => runtime.projects.resolve(runtime.accountId, ref), stateRoot) : undefined;
    const clarification = storedEvent && resolution?.source !== "keep_global"
      ? await projectClarification({ stateRoot, accountId: runtime.accountId, projects: runtime.projects,
          text: storedEvent.user_text ?? "", candidate: resolution?.candidate,
          continuityId: storedEvent.continuity_id, rateLimit: true }) : undefined;
    return jsonResult({
      ok: true,
      action,
      turn_id: turnId ?? result.turn.turn_id ?? null,
      event_id: result.turn.event_id ?? stableEventId ?? null,
      continuity_id: result.turn.continuity_id,
      status: result.turn.status,
      project_id: result.project_id ?? projectId ?? null,
      ingested: Boolean(result.turn.ingested),
      ...(clarification ? { project_resolution: clarification } : {}),
      ...(distillationAck ? { distillation: distillationAck } : {}),
      ...(distillation_queue_error ? { distillation_queue_error } : {}),
      transport_conversation_id: transportConversationId ?? null
    });
  });

  server.registerTool("memmy_context", {
    description: "conversation_id 不参与项目选择；不猜测项目，project/workspace 冲突时拒绝，透传 evidenceRef；出现 clarification 时询问用户后调用 memmy_turn action=assign。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        query: { type: "string", description: "当前用户请求或需要补充上下文的问题" },
        detail: { type: "string", enum: ["brief", "full"], description: "输出模式：brief（默认，精简瘦身）或 full（完整模式）" },
        max_content_bytes: { type: "integer", minimum: 2000, maximum: 512000, description: "总内容字节预算上限，范围 2000-512000" },
        conversation_id: { type: "string", description: "可选 transport provenance；不参与项目选择" },
        continuity_id: { type: "string", description: "Explicit continuity key; user-assigned bindings may select the project" },
        project: { type: "string", description: "明确项目 slug；禁止盲目猜测项目" },
        workspace_project: { type: "string", description: "由工作区/仓库确定的项目 slug；与 project 冲突时拒绝" },
        branch: { type: "string", description: "可选项目内 Branch id/name；仅收窄任务 retrieval，不建立新记忆层" },
        semantic_projects: {
          type: "array",
          items: { type: "string" },
          description: "语义项目候选列表；非唯一时保持 global-only"
        },
        capability_projects: {
          type: "array",
          items: { type: "string" },
          description: "可复用 Skill 检索候选项目列表；默认检索已知项目"
        },
        cross_project_skills: {
          type: "boolean",
          description: "是否启用跨项目可复用 Skill 召回；默认 true"
        },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "每类记忆最大召回条数" }
      },
      required: ["query"],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    const query = requiredString(args.query, "query");
    const detail = args.detail === "full" ? "full" : "brief";
    const maxContentBytes = optionalInteger(args.max_content_bytes);
    const projectRecords = await knownProjectRecords(runtime);
    const knownProjects = projectRecords.map((project) => project.projectId);
    const requestedCapabilityProjects = stringArray(args.capability_projects) ?? [];
    const crossProjectSkills = optionalBoolean(args.cross_project_skills) ?? true;
    const continuityResolution = !optionalString(args.project) && !optionalString(args.workspace_project) && optionalString(args.continuity_id)
      ? await resolveCaptureProject({ account_id: runtime.accountId, event_id: `context:${randomUUID()}`,
          continuity_id: optionalString(args.continuity_id), timestamp: new Date().toISOString() },
          ref => runtime.projects.resolve(runtime.accountId, ref), stateRoot) : undefined;
    const capsule = await runtime.router.context({
      accountId: runtime.accountId,
      userId: runtime.userId,
      query,
      conversationId: optionalString(args.conversation_id),
      continuityId: optionalString(args.continuity_id),
      projectId: optionalString(args.project) ?? continuityResolution?.projectId ?? undefined,
      workspaceProjectId: optionalString(args.workspace_project),
      branchId: optionalString(args.branch),
      semanticProjectIds: stringArray(args.semantic_projects),
      knownProjectIds: knownProjects,
      reusableSkillProjectIds: crossProjectSkills
        ? (requestedCapabilityProjects.length > 0 ? requestedCapabilityProjects : knownProjects)
        : [],
      limit: optionalInteger(args.limit),
      detail,
      maxContentBytes
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
    const turnKnowledgePlan = await buildTurnKnowledgePlan({
      query,
      capsule,
      detail,
      dedupe: true,
      hydrateEvidence: async (evidenceRef) => {
        const item = await hydrateMemoryEvidence({ stateRoot, accountId: runtime.accountId, evidenceRef });
        return { content: item.content };
      }
    });

    const isExplicitlyResolved = capsule.resolvedProjectId !== null &&
      capsule.recallScope === "global_and_project" &&
      (capsule.resolutionSource === "deterministic_binding" || capsule.resolutionSource === "exact_alias");

    const relevantTodoQuery = capsule.branchContext
      ? `${query}\n${capsule.branchContext.name}\n${capsule.branchContext.goal}`
      : query;

    let finalProjectCandidates: unknown[];
    if (detail !== "full" && isExplicitlyResolved) {
      const resolvedProject = projectRecords.find((p) => p.projectId === capsule.resolvedProjectId);
      if (resolvedProject) {
        const descBytes = Buffer.byteLength(resolvedProject.description, "utf8");
        const description = descBytes <= 240
          ? resolvedProject.description
          : utf8Prefix(resolvedProject.description, 240);
        const relevantTodos = relevantProjectTodos(resolvedProject.todos, relevantTodoQuery, 5, 200);
        finalProjectCandidates = [{
          project: resolvedProject.projectId,
          name: resolvedProject.name,
          description,
          relevantTodos
        }];
      } else {
        finalProjectCandidates = [];
      }
    } else {
      const candidateQuery = optionalString(args.project) ?? optionalString(args.workspace_project) ?? query;
      const candidates = capsule.resolvedProjectId === null || optionalString(args.project) || optionalString(args.workspace_project)
        ? await runtime.projects.suggest(runtime.accountId, candidateQuery, 8)
        : [];
      finalProjectCandidates = candidates.map((project) => ({
        project: project.projectId,
        name: project.name,
        description: project.description,
        aliases: project.aliases,
        similarity: project.similarity,
        matchedBy: project.matchedBy,
        descriptionMissing: !project.description,
        ...(project.projectId === capsule.resolvedProjectId
          ? { relevantTodos: relevantProjectTodos(project.todos, relevantTodoQuery, 1) }
          : {})
      }));
    }

    let finalDiagnostics = capsule.retrievalDiagnostics;
    if (detail !== "full" && capsule.retrievalDiagnostics) {
      const diag = capsule.retrievalDiagnostics;
      const combinedQueryTerms = uniqueStrings([
        ...diag.lanes.global.queryTerms,
        ...diag.lanes.project.queryTerms,
        ...diag.lanes.skills.queryTerms
      ]) ?? [];
      finalDiagnostics = {
        version: diag.version,
        requestedLimit: diag.requestedLimit,
        finalLimit: diag.finalLimit,
        candidateLimit: diag.candidateLimit,
        queryTerms: combinedQueryTerms,
        weights: {
          semanticWeight: diag.lanes.project.semanticWeight,
          lexicalWeight: diag.lanes.project.lexicalWeight,
          diversityPenalty: diag.lanes.project.diversityPenalty
        },
        lanes: {
          global: {
            candidateCount: diag.lanes.global.candidateCount,
            dedupedCount: diag.lanes.global.dedupedCount,
            emittedCount: diag.lanes.global.emittedCount
          },
          project: {
            candidateCount: diag.lanes.project.candidateCount,
            dedupedCount: diag.lanes.project.dedupedCount,
            emittedCount: diag.lanes.project.emittedCount
          },
          skills: {
            candidateCount: diag.lanes.skills.candidateCount,
            dedupedCount: diag.lanes.skills.dedupedCount,
            emittedCount: diag.lanes.skills.emittedCount
          }
        },
        ...(diag.coreStatus ? { coreStatus: diag.coreStatus } : {})
      } as unknown as typeof capsule.retrievalDiagnostics;
    }

    const responsePayload: Record<string, unknown> = {
      ...capsule,
      ...(finalDiagnostics ? { retrievalDiagnostics: finalDiagnostics } : {}),
      turnKnowledgePlan,
      projectCandidates: finalProjectCandidates
    };
    if (capsule.resolvedProjectId === null && continuityResolution?.source !== "keep_global") {
      const clarification = await projectClarification({ stateRoot, accountId: runtime.accountId,
        projects: runtime.projects, text: query, continuityId: optionalString(args.continuity_id),
        rateLimit: Boolean(optionalString(args.continuity_id)) });
      if (clarification) responsePayload.clarification = clarification;
    }

    if (detail === "full") {
      responsePayload.progressiveDisclosure = {
        version: "progressive-disclosure-v1",
        discover: "memmy_context",
        contextualize: "memhub_memory action=load evidence_ref=<exact-ref>",
        hydrateSkill: "memhub_skill action=load skill_id=<skill-id>",
        rule: "Load full content only for the selected exact revision or Skill; do not eagerly hydrate all recalled items."
      };
    }

    return jsonResult(responsePayload, detail === "full");
  });

  server.registerTool("memhub_memory", {
    description: "Progressive-disclosure 记忆读取与 L3/L4 治理。action=load 按 exact evidenceRef 水合单条记忆；action=why 查看证据链；action=plan 准备 L3/L4 替换，必须全文向用户展示并获明确授权，并先把该确认记录为 L1；action=execute 凭 authorization_id 与 confirmation_evidence_ref 执行。禁止自动提级。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        action: { type: "string", enum: ["load", "why", "plan", "execute"], description: "操作类型：load/why/plan/execute" },
        evidence_ref: { type: "string", description: "load/why: memmy_context 返回的 exact evidenceRef" },
        query: { type: "string", description: "why: 待审查因果或决策背景的具体问题" },
        max_sources: { type: "integer", minimum: 1, maximum: 8, description: "why: 每节最大证据数；默认 4" },
        kind: { type: "string", enum: ["l3", "l4"], description: "plan: 记忆层级，l3 为项目经验，l4 为全局规则" },
        content: { type: "string", description: "plan: 完整的 L3/L4 正文全文，非增量 patch" },
        base_evidence_ref: { type: "string", description: "plan: 当前层级 exact evidenceRef" },
        project: { type: "string", description: "L3 plan: 明确项目 slug；与 workspace_project 冲突时拒绝" },
        workspace_project: { type: "string", description: "L3 plan: 工作区项目；与 project 冲突时拒绝" },
        note: { type: "string", description: "plan: 变更原因简述" },
        authorization_id: { type: "string", description: "execute: plan 返回的单次授权标识" },
        confirmation_evidence_ref: { type: "string", description: "execute: 用户明确确认轮的 l1:<event-id>" }
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
    if (action === "why") {
      return jsonResult(await explainMemoryWhy({
        stateRoot,
        accountId: runtime.accountId,
        evidenceRef: requiredString(args.evidence_ref, "evidence_ref"),
        query: requiredString(args.query, "query"),
        maxSources: optionalInteger(args.max_sources)
      }));
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
    throw new TypeError("action must be load, why, plan, or execute");
  });

  server.registerTool("memhub_branch", {
    description: "项目内 Branch Context。Branch 是显式 task/workstream scope，不绑定 host conversation。create/list/close/reopen 管理 Branch 元数据；检索时由 memmy_context 显式传 branch。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "create", "close", "reopen"], description: "操作类型：list/create/close/reopen" },
        project: { type: "string", description: "项目 slug/name/alias；与 workspace_project 冲突时拒绝" },
        workspace_project: { type: "string", description: "当前工作区解析出的 project；与 project 冲突时拒绝" },
        branch: { type: "string", description: "Branch id/name；close/reopen 必填" },
        name: { type: "string", description: "create 时的 Branch 名称" },
        goal: { type: "string", description: "create 时明确 workstream 目标，用于检索过滤" },
        include_closed: { type: "boolean", description: "list 是否包含已关闭 Branch；默认 false" }
      },
      required: ["action"],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    const action = requiredString(args.action, "action");
    const explicit = await resolveExplicitProjectEvidence(runtime, {
      project: optionalString(args.project),
      workspaceProject: optionalString(args.workspace_project)
    });
    const projectId = explicit.projectId;
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
    description: "Skill Router / Execution Lifecycle。memmy_context 返回精简候选；action=load 加载 Skill 与 execution_id，真正执行后 action=record 记录 invoked、success/failure、user_correction；status 查看 telemetry。修订或退役现有 Skill 必须 action=plan（operation=revise/retire）并向用户展示精确影响，取得针对该计划的明确批准后才 action=execute；保留稳定 source_skill_id，版本替换归档旧 memory id，不创建同名并行现行 Skill。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        action: { type: "string", enum: ["load", "record", "status", "plan", "execute"], description: "操作类型：load/record/status/plan/execute" },
        skill_id: { type: "string", description: "memmy_context 返回的 Skill memory id" },
        execution_id: { type: "string", description: "load 返回；record 时必须原样回传" },
        stage: { type: "string", enum: ["invoked", "success", "failure", "user_correction"], description: "action=record 的执行阶段" },
        executor: { type: "string", description: "实际执行 Harness/executor，如 codex/chatgpt/claude-code" },
        note: { type: "string", description: "简短执行结果、修订理由或纠正摘要；不要写隐藏 chain-of-thought" },
        operation: { type: "string", enum: ["revise", "retire"], description: "action=plan 的治理操作" },
        content: { type: "string", description: "revise 时的完整新版 Skill 过程" },
        title: { type: "string", description: "revise 时的 Skill 标题" },
        version: { type: "string", description: "revise 时严格递增的 numeric dotted 版本，如 1.1.0" },
        tags: { type: "array", items: { type: "string" }, description: "新版业务检索标签（不可自行声明 scope/provenance）" },
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
      return jsonResult(await planSkillMutation({ runtime, args, skillId, skill }));
    }
    if (action === "execute") {
      return jsonResult(await executeSkillMutation({ stateRoot, runtime, args, skillId, skill }));
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
    description: "统一的 L2/L3/L4/Skill 蒸馏入口。L2=项目时间线，可产出 evidence-backed project_description；L3=项目规则/经验；L4=跨项目画像；Skill=可执行流程。语义整理由当前 Harness 完成，Memhub 负责证据边界、scope、版本与提交。consolidate 为 L2/L3 只读整理计划；不新增记忆层。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        action: { type: "string", enum: ["audit", "discover", "consolidate", "recover_ingest", "reconcile_derived", "reconcile_l4", "reconcile_commit", "next", "renew", "submit", "skip"], description: "audit 审计；discover 扫描；consolidate 整理计划；recover/reconcile 处理缺口；next/renew/submit/skip 蒸馏" },
        event_id: { type: "string", description: "recover_ingest 必填的完整稳定 Capture event_id，仅恢复此事件" },
        kind: { type: "string", enum: ["l2", "l3", "l4", "skill"], description: "目标层；next 可省略领取任意待办，submit 必须与 job target 一致" },
        content: { type: "string", description: "完整目标层内容" },
        scope: { type: "string", enum: ["account", "project"], description: "L2/L3 必须 project；L4 必须 account；Skill 可两者" },
        project: { type: "string", description: "project scope 的明确项目 slug" },
        workspace_project: { type: "string", description: "当前工作区解析出的 project；与 project 不一致时拒绝项目级操作" },
        title: { type: "string", description: "可选标题；Skill 必填" },
        tags: { type: "array", items: { type: "string" }, description: "业务检索标签" },
        source_harness: { type: "string", description: "产生该沉淀的 Harness，例如 codex / claude-code" },
        artifact_id: { type: "string", description: "覆盖默认 canonical artifact id；Skill 必填且同一 workflow 保持稳定" },
        version: { type: "string", description: "Harness 侧产物版本；Skill 必填 numeric dotted 版本，例如 1.1.0" },
        project_description: { type: "string", description: "L2 可附带 1-3 句项目描述，概括目标范围；人工描述存在时不覆盖" },
        evidence_refs: { type: "array", items: { type: "string" }, description: "支持产物的精确证据引用。L2 用 L1 ref；L3/L4 须原样使用 exact revision ref" },
        source_conversations: { type: "array", items: { type: "string" }, description: "产物来源对话 ID；与 distilled_by 分开保存" },
        confidence: { type: "number", minimum: 0, maximum: 1, description: "置信度，范围 0-1" },
        job_id: { type: "string", description: "submit/next 的 leased job，或 reconcile 的 source job" },
        lease_seconds: { type: "integer", minimum: 30, maximum: 900, description: "租约秒数，30-900" },
        lease_token_supported: { type: "boolean", description: "新客户端启用 opaque lease token 协议" },
        lease_token: { type: "string", description: "next 返回的 opaque lease token；后续操作须原样提供" },
        evidence_offset: { type: "integer", minimum: 0, description: "大 evidence job 分片读取偏移" },
        evidence_chunk_chars: { type: "integer", minimum: 10000, maximum: 200000, description: "大 evidence 每次最多返回字符数；默认 120000" },
        commit_id: { type: "string", description: "reconcile_commit: inspect 返回的提交 ID；省略时列出本账户记录" },
        reconcile_mode: { type: "string", enum: ["inspect", "reconcile", "abandon"], description: "inspect 查看冻结候选；reconcile 只对账不重写 Core；abandon 须操作员确认" },
        commit_generation: { type: "string", description: "对账或放弃时必须回传 inspect 的 generation" },
        operator_confirmation: { type: "string", description: "明确知晓 Core 可能已写入后，由操作员确认 abandon:<generation>" },
        operator_reason: { type: "string", description: "放弃冻结提交的操作员原因；原记录保留到正常终态清理" },
        inspect_contract: { type: "boolean", description: "只返回 Memhub 蒸馏规则，不写入任何内容" },
        dry_run: { type: "boolean", description: "按当前契约校验候选与 scope，但不写入 Memory Core" }
      },
      required: [],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    if (args.inspect_contract === true) return jsonResult({ contract: distillationContract() });
    const action = optionalString(args.action);
    const sourceHarness = optionalString(args.source_harness) ?? runtime.source.platform ?? "mcp-harness";
    const leaseToken = optionalString(args.lease_token);
    if (action === "reconcile_commit") {
      const mode = optionalString(args.reconcile_mode) ?? "inspect";
      if (!["inspect", "reconcile", "abandon"].includes(mode)) throw new Error("invalid reconcile_mode");
      const { reconcileDistillationCommit } = await import("./distillation-submit.js");
      return jsonResult(await reconcileDistillationCommit({ stateRoot, runtime,
        commitId: optionalString(args.commit_id), mode: mode as "inspect" | "reconcile" | "abandon",
        generation: optionalString(args.commit_generation), confirmation: optionalString(args.operator_confirmation),
        reason: optionalString(args.operator_reason) }));
    }
    if (action === "audit") {
      return jsonResult(await auditDistillationControl({
        stateRoot,
        runtime
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
        dryRun: args.dry_run === true
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
    description: "只读列出当前账号项目注册表。默认返回摘要（description 最多 280 字符及 pendingTodoCount）；detail=true 返回完整详情。返回 canonical project slug、显示名、description、aliases 和状态。准备创建项目、绑定不确定项目或发现近似名称时，用相似度 + description 判断是否已有同一项目，禁止盲目新建。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        detail: { type: "boolean", description: "是否返回完整项目详情；默认 false，仅返回摘要" },
        query: { type: "string", description: "可选项目名称/slug/关键词，用于查找相似项目候选" },
        include_archived: { type: "boolean", description: "是否显式包含 archived 项目；默认 false" },
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
    const format = optionalBoolean(args.detail) ? projectForModel : projectSummaryForModel;
    return jsonResult({
      projects: projects.map(format),
      matches: matches.map((project) => ({
        ...format(project),
        similarity: project.similarity,
        matchedBy: project.matchedBy
      })),
      instructions: "Prefer an existing canonical project when name/alias and description describe the same work. If still ambiguous, ask the user. Only create through memmy_project_manage after explicit authorization."
    });
  });

  server.registerTool("memhub_todo", {
    description: "项目待办的一等 MCP 工具。使用 Project Registry 作为唯一事实源，支持 list/add/complete/reopen；禁止把待办写进 Project Architecture、项目 description 或 L2/L3。list 在未指定项目时列出所有 active project 待办；写操作必须显式提供 project 或 workspace_project。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "complete", "reopen"], description: "操作类型：list/add/complete/reopen" },
        project: { type: "string", description: "明确项目 slug/name/alias；与 workspace_project 冲突时拒绝" },
        workspace_project: { type: "string", description: "当前工作区解析出的 project；与 project 冲突时拒绝项目级操作" },
        text: { type: "string", description: "add 时必填的待办内容，最长 2000 字符" },
        todo_id: { type: "string", description: "complete/reopen 时必填" },
        status: { type: "string", enum: ["pending", "done", "all"], description: "list 过滤；默认 pending" }
      },
      required: ["action"],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    const action = requiredString(args.action, "action");
    if (!["list", "add", "complete", "reopen"].includes(action)) throw new TypeError("unsupported todo action");
    await knownProjectRecords(runtime);

    if (action === "list" && !optionalString(args.project) && !optionalString(args.workspace_project)) {
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
      workspaceProject: optionalString(args.workspace_project)
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
    description: "受控项目管理工具。支持 create/update/archive/unarchive/delete/merge。所有修改必须先 action=plan，返回一次性 authorization_id 和影响说明，不修改数据。模型必须把计划展示给用户，并在收到针对该计划的明确授权后才能 action=execute。禁止把 plan 本身、历史授权或模型推断当成授权。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        action: { type: "string", enum: ["plan", "execute"], description: "操作类型：plan/execute" },
        operation: { type: "string", enum: ["create", "update", "archive", "unarchive", "delete", "merge"], description: "操作：create/update/archive/unarchive/delete/merge" },
        project: { type: "string", description: "create 为新 canonical slug；其它为当前项目 ref" },
        target: { type: "string", description: "merge 的目标 canonical project ref" },
        name: { type: "string", description: "create/update 显示名；不改变稳定 canonical slug" },
        description: { type: "string", description: "create 必填；update 可修改。用于项目消歧" },
        aliases: { type: "array", items: { type: "string" }, description: "create/update 显式别名集合" },
        authorization_id: { type: "string", description: "execute 时必须提供刚才 plan 返回的一次性授权 ID" }
      },
      required: ["action"],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    const action = requiredString(args.action, "action");
    if (action === "plan") {
      return jsonResult(await planProjectMutation({ stateRoot, runtime, args, projectForModel }));
    }
    if (action !== "execute") throw new TypeError("action must be plan or execute");
    return jsonResult(await executeProjectMutation({ stateRoot, runtime, args }));
  });

  server.registerTool("memmy_project", {
    description: "项目上下文与 Project Architecture。Project 只由显式 project/workspace_project、exact alias 或唯一 semantic evidence 解析，不保存 host conversation binding。current 读当前项目；architecture 读架构；architecture_plan/execute 受控完整替换；architecture_history 读历史；list 读项目列表（默认摘要）。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        detail: { type: "boolean", description: "list 是否返回完整项目详情；默认 false，仅返回摘要" },
        action: { type: "string", enum: ["list", "current", "architecture", "architecture_plan", "architecture_execute", "architecture_history"], description: "操作类型：list/current/architecture/architecture_plan/architecture_execute/architecture_history" },
        project: { type: "string", description: "明确项目 slug/alias；与 workspace_project 冲突时拒绝" },
        workspace_project: { type: "string", description: "当前工作区解析出的 project；与 project 冲突时拒绝操作" },
        query: { type: "string", description: "architecture 时用于选择最相关架构模块" },
        content: { type: "string", description: "architecture_plan：完整最终 canonical Architecture 正文，非 patch 片段" },
        authorization_id: { type: "string", description: "architecture_execute：用户批准对应 plan 后使用的一次性 authorization id" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "architecture_history 返回条数，默认 20" }
      },
      required: ["action"],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    const action = requiredString(args.action, "action");
    if (action === "list") {
      const details = await knownProjectRecords(runtime);
      return jsonResult({ projects: details.map((project) => project.projectId), projectDetails: details.map(optionalBoolean(args.detail) ? projectForModel : projectSummaryForModel) });
    }
    if (action === "current") {
      await knownProjectRecords(runtime);
      const explicitEvidence = await resolveExplicitProjectEvidence(runtime, {
        project: optionalString(args.project),
        workspaceProject: optionalString(args.workspace_project)
      });
      if (explicitEvidence.projectId) {
        return jsonResult({
          project: explicitEvidence.projectId,
          resolution_source: explicitEvidence.resolutionSource,
          persisted: false
        });
      }
      return jsonResult({
        project: null,
        resolution_source: "no_current_turn_project",
        persisted: false,
        note: "Pass project or workspace_project from the current turn; host conversation identity is not project state."
      });
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
      return jsonResult(await planArchitectureMutation({ runtime, args, resolveExplicitProjectEvidence }));
    }
    if (action === "architecture_execute") {
      return jsonResult(await executeArchitectureMutation({ stateRoot, runtime, args, resolveExplicitProjectEvidence }));
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
  if (argv[0] === "admin-token") {
    await runAdminTokenCommand(argv.slice(1));
    return;
  }
  const options = parseArgs(argv);
  const {
    stateRoot = defaultStateRoot(),
    httpPort,
    httpPath = "/mcp",
    basePath = normalizeBasePath(process.env.MEMHUB_BASE_PATH?.trim() || "/memhub"),
    publicHost = process.env.MEMHUB_PUBLIC_HOST?.trim() || undefined,
    allowJit = process.env.MEMHUB_ALLOW_JIT === "1",
    ...runtimeOptions
  } = options;
  const effectiveRuntimeOptions: MemhubRuntimeOptions = {
    ...runtimeOptions,
    controlRoot: runtimeOptions.controlRoot ?? stateRoot
  };
  await recoverCaptureIndex(stateRoot);
  if (httpPort !== undefined) {
    await serveHttp(
      effectiveRuntimeOptions,
      { stateRoot, port: httpPort, path: httpPath, basePath, publicHost, allowJit },
      {
        createServerForRuntime: createMemhubMcpServerForRuntime,
        queueIdleDistillation,
        unfinishedDistillationJobsForProject,
        assertManagedMemory,
        knownProjectRecords
      }
    );
    return;
  }
  console.error(`[memhub] serving stdio account=${resolveLocalAccountId(effectiveRuntimeOptions)}`);
  await serveStdio(() => createMemhubMcpServer({ ...effectiveRuntimeOptions, controlRoot: stateRoot }));
}

function defaultStateRoot(): string {
  return resolve(resolveControlRoot());
}


function inlineJsonResult(value: unknown, pretty = true) {
  return { content: [{ type: "text" as const, text: pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value) }] };
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
    for (let page = 1; ; page++) {
      const params = new URLSearchParams({ limit: "100", page: String(page), userId: runtime.userId });
      const payload = objectRecord(await runtime.memoryClient.viewerGet(`/api/v1/${kind}?${params}`));
      const items = Array.isArray(payload.items) ? payload.items : [];
      if (items.some((item) => objectRecord(item).id === memoryId)) return;
      if (payload.hasNext !== true && !(typeof payload.totalPages === "number" && page < payload.totalPages)) break;
      if (!items.length) break;
    }
  }
  throw new Error(`managed memory not found for account: ${memoryId}`);
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

async function knownProjectRecords(runtime: MemhubRuntime): Promise<ProjectDescriptor[]> {
  return runtime.projects.list(runtime.accountId);
}

function projectSummaryForModel(project: ProjectDescriptor): Record<string, unknown> {
  const chars = Array.from(project.description);
  return {
    project: project.projectId,
    name: project.name,
    aliases: project.aliases,
    state: project.state,
    descriptionSource: project.descriptionSource ?? (project.description ? "legacy" : "empty"),
    description: chars.slice(0, 280).join(""),
    ...(chars.length > 280 ? { descriptionTruncated: true } : {}),
    pendingTodoCount: (project.todos ?? []).filter((todo) => todo.status === "pending").length
  };
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

const invokedArg = process.argv[1];
const invokedPath = invokedArg && !invokedArg.startsWith("-") && existsSync(resolve(invokedArg))
  ? realpathSync(resolve(invokedArg))
  : "";
if (invokedPath !== "" && invokedPath === fileURLToPath(import.meta.url)) await main();
