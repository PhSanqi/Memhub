#!/usr/bin/env node
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
  importNormifyAccounts,
  listAccounts,
  resolveCloudflareAccount,
  setAccountRole,
  verifyLocalAdminToken
} from "./auth.js";
import { importNormifyCloudflarePin, verifyCloudflareAccessJwt } from "./cloudflare.js";
import {
  authenticateDevice,
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
  completeDistillationJob,
  enqueueDistillationJob,
  failDistillationJob,
  getDistillationConfig,
  leaseDistillationJob,
  listDistillationJobs,
  retryDistillationJob,
  setDistillationConfig
} from "./distillation-jobs.js";
import {
  commitHistoryMemoryBatch,
  commitHistorySkillBatch,
  leaseHistoryBatch,
  listCoreMemoryEvidence,
  listHistoryDistillationState,
  prepareHistorySubmission,
  renderMemoryHistoryDocument,
  renderSkillHistoryDocument,
  skillKey,
  startHistoryDistillation,
  validateMemoryHistoryDocument,
  validateSkillHistoryDocuments,
  type HistoryEvidence
} from "./history-distillation.js";
import { createMemhubRuntime, type MemhubRuntime, type MemhubRuntimeOptions } from "./runtime.js";
import {
  DISTILLATION_CONTRACT_VERSION,
  distillationContract,
  validateDistillationCandidate
} from "./distillation-contract.js";

const VERSION = "0.1.0";

export interface MemhubMcpOptions extends MemhubRuntimeOptions {}

export function createMemhubMcpServer(options: MemhubMcpOptions = {}): McpServer {
  const runtime = createMemhubRuntime(options);
  return createMemhubMcpServerForRuntime(runtime, defaultStateRoot());
}

export function createMemhubMcpServerForRuntime(runtime: MemhubRuntime, stateRoot = defaultStateRoot()): McpServer {
  const server = new McpServer({
    name: "memhub",
    version: VERSION,
    description: "Private account/project-scoped long-term context and project architecture. Start each user turn with memmy_context when the host has not already injected Memhub context; before the final answer, persist only genuinely durable new facts/decisions/preferences/corrections rather than raw chat noise."
  });

  server.registerTool("memmy_context", {
    description: "每轮任务开始时读取与当前请求相关的长期上下文。自动组合账号/全局记忆与唯一已解析项目的项目记忆；项目不明确时只返回全局，避免串项目。返回内容是候选 evidence，当前 Harness 应先过滤噪声和失效内容再使用。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        query: { type: "string", description: "当前用户请求或需要补充上下文的问题" },
        conversation_id: { type: "string", description: "当前 AI 会话/线程稳定 ID；用于保持项目绑定" },
        project: { type: "string", description: "明确项目 slug；用户未明确时不要猜" },
        workspace_project: { type: "string", description: "由工作区/仓库确定的项目 slug" },
        semantic_projects: {
          type: "array",
          items: { type: "string" },
          description: "宿主已有分类器得出的项目候选；多个候选会触发 global-only"
        },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "每类记忆最大召回数量" }
      },
      required: ["query"],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    const capsule = await runtime.router.context({
      accountId: runtime.accountId,
      userId: runtime.userId,
      query: requiredString(args.query, "query"),
      conversationId: optionalString(args.conversation_id),
      projectId: optionalString(args.project),
      workspaceProjectId: optionalString(args.workspace_project),
      semanticProjectIds: stringArray(args.semantic_projects),
      limit: optionalInteger(args.limit)
    });
    return jsonResult(capsule);
  });

  server.registerTool("memmy_remember", {
    description: "在任务结束前的 memory hygiene 阶段写入真正耐久的新事实、决定、偏好或纠正。不要逐轮复制聊天内容；默认写全局，project scope 必须能明确解析出唯一项目，不能凭模型猜测。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        content: { type: "string", description: "需要长期保存的事实、决定、偏好或上下文" },
        scope: { type: "string", enum: ["global", "project"], description: "记忆作用域" },
        project: { type: "string", description: "project scope 的明确项目 slug" },
        conversation_id: { type: "string", description: "可用于继承已绑定项目" },
        title: { type: "string" },
        tags: { type: "array", items: { type: "string" } }
      },
      required: ["content"],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    const scope = optionalString(args.scope) ?? "global";
    if (scope !== "global" && scope !== "project") throw new TypeError("scope must be global or project");
    const conversationId = optionalString(args.conversation_id);
    let projectId = optionalString(args.project) ?? null;
    if (scope === "project" && projectId === null && conversationId) {
      projectId = await runtime.router.currentProject(runtime.accountId, conversationId);
    }
    if (scope === "project" && projectId === null) {
      throw new Error("project-scoped memory requires an explicit or conversation-bound project");
    }
    if (scope === "global") projectId = null;
    const result = await runtime.memory.remember({
      accountId: runtime.accountId,
      userId: runtime.userId,
      content: requiredString(args.content, "content"),
      projectId,
      conversationId,
      title: optionalString(args.title),
      tags: stringArray(args.tags),
      provenance: {
        platform: runtime.source.platform,
        transport: runtime.source.transport,
        principal: runtime.source.principalId,
        connection: runtime.source.connectionId,
        account: runtime.accountId,
        authenticated_account: runtime.source.authenticatedAccount
      }
    });
    return jsonResult({ ok: true, scope, project: projectId, memory: result });
  });

  server.registerTool("memhub_history_distill", {
    description: "手动发起历史蒸馏。可蒸馏当前项目历史或账号全部长期记忆，并选择形成连续的综合记忆或可复用 Skills。Memhub 维护 evidence ledger、增量游标、前序蒸馏基线与幂等性；真正的语义分析由当前 ChatGPT/Codex/Claude Harness 完成。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "next", "submit", "status"] },
        scope: { type: "string", enum: ["project", "account"], description: "project=当前项目全部历史；account=当前稳定 account_id 的全部长期记忆" },
        project: { type: "string", description: "project scope 的明确项目；也可由 conversation_id 继承绑定" },
        conversation_id: { type: "string" },
        target: { type: "string", enum: ["memory", "skill"], description: "memory=形成连续的全面长期记忆；skill=从历史中提取/演进可复用 Skills" },
        run_id: { type: "string" },
        batch_hash: { type: "string" },
        source_harness: { type: "string" },
        lease_seconds: { type: "integer", minimum: 60, maximum: 1800 },
        memory: {
          type: "object",
          description: "memory target 的结构化累计文档。必须基于 continuation + 本批新 evidence 更新，不得只写本批摘要。",
          properties: {
            title: { type: "string" }, overview: { type: "string" },
            who: { type: "array", items: { type: "string" } },
            what: { type: "array", items: { type: "string" } },
            where: { type: "array", items: { type: "string" } },
            when: { type: "array", items: { type: "string" } },
            why: { type: "array", items: { type: "string" } },
            how: { type: "array", items: { type: "string" } },
            decisions: { type: "array", items: { type: "string" } },
            constraints: { type: "array", items: { type: "string" } },
            preferences: { type: "array", items: { type: "string" } },
            relationships: { type: "array", items: { type: "string" } },
            current_truth: { type: "array", items: { type: "string" } },
            legacy: { type: "array", items: { type: "string" } },
            unknowns: { type: "array", items: { type: "string" } },
            provenance: { type: "array", items: { type: "string" } }
          },
          required: ["title", "overview", "who", "what", "where", "when", "why", "how", "decisions", "constraints", "preferences", "relationships", "current_truth", "legacy", "unknowns", "provenance"],
          additionalProperties: false
        },
        skills: {
          type: "array",
          description: "skill target 可一次提交 0..10 个真正可复用的 Skill。已有 Skill/continuation 只用于去重和演进，不应换标题重复创建。",
          items: {
            type: "object",
            properties: {
              title: { type: "string" }, purpose: { type: "string" },
              when_to_use: { type: "array", items: { type: "string" } },
              prerequisites: { type: "array", items: { type: "string" } },
              inputs: { type: "array", items: { type: "string" } },
              procedure: { type: "array", items: { type: "string" } },
              verification: { type: "array", items: { type: "string" } },
              failure_modes: { type: "array", items: { type: "string" } },
              boundaries: { type: "array", items: { type: "string" } },
              reusable_principles: { type: "array", items: { type: "string" } },
              provenance: { type: "array", items: { type: "string" } }
            },
            required: ["title", "purpose", "when_to_use", "prerequisites", "inputs", "procedure", "verification", "failure_modes", "boundaries", "reusable_principles", "provenance"],
            additionalProperties: false
          }
        },
        no_skill_reason: { type: "string", description: "本批没有真正可复用 Skill 时说明原因；skills=[] 时必填" }
      },
      required: ["action"],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    const action = requiredString(args.action, "action");
    const sourceHarness = optionalString(args.source_harness) ?? runtime.source.platform ?? "mcp-harness";
    if (action === "status") {
      return jsonResult(await listHistoryDistillationState(stateRoot, runtime.accountId));
    }
    if (action === "start") {
      const scope = requiredString(args.scope, "scope");
      if (scope !== "project" && scope !== "account") throw new TypeError("scope must be project or account");
      const target = requiredString(args.target, "target");
      if (target !== "memory" && target !== "skill") throw new TypeError("target must be memory or skill");
      const projectId = scope === "project"
        ? (await resolveToolScope(runtime, {
            scope: "project",
            project: optionalString(args.project),
            conversationId: optionalString(args.conversation_id)
          })).projectId
        : null;
      const evidence = await collectHistoryEvidence({ runtime, stateRoot, projectId, scope, target });
      const started = await startHistoryDistillation({
        stateRoot,
        accountId: runtime.accountId,
        scope,
        projectId,
        target,
        evidence
      });
      return jsonResult({
        ...started,
        scope,
        project: projectId,
        target,
        instructions: started.run
          ? `Call memhub_history_distill action=next with run_id=${started.run.run_id}. Continue next -> submit until the run is completed.`
          : "No new evidence remains for this scope/target. Previously processed evidence will not be distilled again."
      });
    }
    if (action === "next") {
      const runId = requiredString(args.run_id, "run_id");
      const batch = await leaseHistoryBatch(
        stateRoot,
        runtime.accountId,
        runId,
        sourceHarness,
        optionalInteger(args.lease_seconds) ?? 600
      );
      return jsonResult({
        batch,
        contract: batch?.target === "memory" ? historyMemoryContract() : historySkillContract(),
        instructions: batch
          ? batch.target === "memory"
            ? "Treat continuation.prior_memory_document as the previous canonical state. Produce one UPDATED CUMULATIVE memory document that preserves still-valid prior facts and integrates only the new evidence. Explicitly separate Current Truth from Legacy/Superseded, preserve dates and provenance, and fill every who/what/where/when/why/how field even when the correct value is unknown. Then submit with the same run_id and batch_hash."
            : "Use continuation.prior_skills as the existing Skill catalog. Extract only genuinely reusable procedures. Do not create chat summaries disguised as Skills and do not duplicate an existing Skill under a new title; evolve a matching Skill when appropriate. Submit skills=[] with no_skill_reason when this batch contains no reusable Skill."
          : "Run is complete or has no remaining evidence."
      });
    }
    if (action !== "submit") throw new TypeError("action must be start, next, submit, or status");
    const runId = requiredString(args.run_id, "run_id");
    const batchHash = requiredString(args.batch_hash, "batch_hash");
    const prepared = await prepareHistorySubmission(stateRoot, runtime.accountId, runId, batchHash);
    const scope = prepared.run.scope === "project" ? "project" as const : "global" as const;
    const projectId = prepared.run.project_id;
    const evidenceRefs = prepared.batch.refs;
    const sourceConversations = uniqueStrings(prepared.evidence.map((item) => item.conversation_id ?? ""));
    if (prepared.run.target === "memory") {
      const document = validateMemoryHistoryDocument(args.memory);
      const content = renderMemoryHistoryDocument(document);
      const result = await runtime.memory.distill({
        accountId: runtime.accountId,
        userId: runtime.userId,
        kind: "summary",
        content,
        projectId,
        title: document.title,
        tags: ["memhub-history-distill", `history-series:${prepared.run.series_key}`, "history-target:memory"],
        sourceHarness,
        artifactId: `history-memory:${prepared.run.series_key}:${batchHash}`,
        evidenceRefs,
        sourceConversations,
        contractVersion: "memhub-history-distill-v1",
        provenance: {
          platform: runtime.source.platform,
          transport: runtime.source.transport,
          principal: runtime.source.principalId,
          connection: runtime.source.connectionId,
          account: runtime.accountId,
          authenticated_account: runtime.source.authenticatedAccount
        }
      });
      const resultId = requireMemoryResultId(result);
      if (prepared.series.latest_result_id && prepared.series.latest_result_id !== resultId) {
        await runtime.memoryClient.viewerPost(`/api/v1/memory/${encodeURIComponent(prepared.series.latest_result_id)}/archive`);
      }
      const run = await commitHistoryMemoryBatch({ stateRoot, accountId: runtime.accountId, runId, batchHash, resultId, content });
      return jsonResult({ ok: true, run, result_id: resultId, scope, project: projectId, next: run.status === "active" ? "call action=next" : "completed" });
    }
    const skills = validateSkillHistoryDocuments(args.skills ?? []);
    const noSkillReason = optionalString(args.no_skill_reason);
    if (skills.length === 0 && !noSkillReason) throw new TypeError("no_skill_reason is required when skills is empty");
    const results: Array<{ title: string; resultId: string; content: string }> = [];
    for (const skill of skills) {
      const content = renderSkillHistoryDocument(skill);
      const key = skillKey(skill.title);
      const existing = prepared.series.skill_catalog?.find((item) => item.key === key);
      const result = await runtime.memory.distill({
        accountId: runtime.accountId,
        userId: runtime.userId,
        kind: "skill",
        content,
        projectId,
        title: skill.title,
        tags: ["memhub-history-distill", `history-series:${prepared.run.series_key}`, "history-target:skill"],
        sourceHarness,
        artifactId: `history-skill:${prepared.run.series_key}:${key}:${batchHash}`,
        evidenceRefs,
        sourceConversations,
        contractVersion: "memhub-history-distill-v1",
        provenance: {
          platform: runtime.source.platform,
          transport: runtime.source.transport,
          principal: runtime.source.principalId,
          connection: runtime.source.connectionId,
          account: runtime.accountId,
          authenticated_account: runtime.source.authenticatedAccount
        }
      });
      const resultId = requireMemoryResultId(result);
      if (existing?.result_id && existing.result_id !== resultId) {
        await runtime.memoryClient.viewerPost("/api/v1/skills/archive", { skillId: existing.result_id });
      }
      results.push({ title: skill.title, resultId, content });
    }
    const run = await commitHistorySkillBatch({ stateRoot, accountId: runtime.accountId, runId, batchHash, skills: results });
    return jsonResult({
      ok: true,
      run,
      skills: results.map((item) => ({ title: item.title, result_id: item.resultId })),
      no_skill_reason: skills.length === 0 ? noSkillReason : undefined,
      scope,
      project: projectId,
      next: run.status === "active" ? "call action=next" : "completed"
    });
  });

  server.registerTool("memhub_distill", {
    description: "由当前 MCP/Harness 的 AI 完成内容蒸馏，Memhub 只提供并强制蒸馏契约、scope、证据引用、provenance 与写入校验。传 inspect_contract=true 可只读取规则而不写入。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        action: { type: "string", enum: ["next", "submit", "skip"], description: "next 领取待蒸馏 evidence；submit 提交模型蒸馏结果；skip 明确判定该批 evidence 不应形成长期知识。省略时保持兼容，直接提交。" },
        kind: { type: "string", enum: ["skill", "summary", "knowledge"], description: "沉淀产物类型" },
        content: { type: "string", description: "完整沉淀内容；Skill 应包含何时调用、步骤与边界" },
        scope: { type: "string", enum: ["global", "project"], description: "账号级或项目级；必须明确" },
        project: { type: "string", description: "project scope 的明确项目 slug" },
        conversation_id: { type: "string", description: "可继承已绑定项目；不会跨项目猜测" },
        title: { type: "string", description: "产物标题；Skill 必填，作为 Skill 名称" },
        tags: { type: "array", items: { type: "string" } },
        source_harness: { type: "string", description: "产生该沉淀的 Harness，例如 codex / claude-code" },
        artifact_id: { type: "string", description: "Harness 侧稳定产物 ID；用于幂等重试" },
        version: { type: "string", description: "Harness 侧产物版本；主要用于 Skill" }
        ,evidence_refs: { type: "array", items: { type: "string" }, description: "支持该产物的 Memory/RawTurn/Episode 等稳定引用" }
        ,source_conversations: { type: "array", items: { type: "string" }, description: "产物来源对话 ID；与 distilled_by 分开保存" }
        ,confidence: { type: "number", minimum: 0, maximum: 1 }
        ,job_id: { type: "string", description: "提交通过 next 或 Control Plane 领取的 distillation job" }
        ,lease_seconds: { type: "integer", minimum: 30, maximum: 900 }
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
      const requestedScope = optionalString(args.scope);
      let projectFilter: string | null | undefined;
      if (requestedScope === "global") projectFilter = null;
      else if (requestedScope === "project") {
        projectFilter = (await resolveToolScope(runtime, {
          scope: "project",
          project: optionalString(args.project),
          conversationId: optionalString(args.conversation_id)
        })).projectId;
      }
      const job = await leaseDistillationJob(stateRoot, runtime.accountId, {
        projectId: projectFilter,
        harness: sourceHarness,
        leaseSeconds: optionalInteger(args.lease_seconds)
      });
      return jsonResult({
        job,
        contract: distillationContract(),
        instructions: job
          ? "Analyze only the supplied evidence. Decide whether durable skill, summary, or knowledge is justified. Check relevant existing context before creating a duplicate artifact. If nothing durable is justified, call memhub_distill action=skip with job_id. Otherwise call memhub_distill action=submit with job_id and the candidate."
          : "No pending distillation job for this account/scope."
      });
    }
    if (action === "skip") {
      const jobId = requiredString(args.job_id, "job_id");
      const job = (await listDistillationJobs(stateRoot, runtime.accountId)).find((item) => item.job_id === jobId);
      if (!job) throw new Error("distillation job not found for account");
      await completeDistillationJob(stateRoot, runtime.accountId, jobId, { kind: "noop" });
      return jsonResult({ ok: true, job_id: jobId, skipped: true, reason: "no durable artifact justified by evidence" });
    }
    if (action !== undefined && action !== "submit") throw new TypeError("action must be next, submit, or skip");
    const jobId = optionalString(args.job_id);
    const job = jobId
      ? (await listDistillationJobs(stateRoot, runtime.accountId)).find((item) => item.job_id === jobId)
      : undefined;
    if (jobId && !job) throw new Error("distillation job not found for account");
    const kind = requiredString(args.kind, "kind");
    if (kind !== "skill" && kind !== "summary" && kind !== "knowledge") {
      throw new TypeError("kind must be skill, summary, or knowledge");
    }
    const scope = optionalString(args.scope) ?? job?.scope;
    if (!scope) throw new TypeError("scope is required");
    const title = optionalString(args.title);
    if (kind === "skill" && !title) throw new TypeError("title is required for skill distillation");
    const { projectId, conversationId } = await resolveToolScope(runtime, {
      scope,
      project: optionalString(args.project) ?? job?.project_id ?? undefined,
      conversationId: optionalString(args.conversation_id) ?? job?.conversation_id
    });
    if (job && (job.scope !== scope || job.project_id !== projectId)) throw new Error("distillation job scope mismatch");
    const evidenceRefs = uniqueStrings([...(job?.evidence_refs ?? []), ...(stringArray(args.evidence_refs) ?? [])]);
    const sourceConversations = uniqueStrings([...(job ? [job.conversation_id] : []), ...(stringArray(args.source_conversations) ?? [])]);
    const confidence = optionalNumber(args.confidence);
    validateDistillationCandidate({
      kind,
      content: requiredString(args.content, "content"),
      evidence: { evidenceRefs, sourceConversations, confidence }
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
      result = await runtime.memory.distill({
        accountId: runtime.accountId,
        userId: runtime.userId,
        kind,
        content: requiredString(args.content, "content"),
        projectId,
        conversationId,
        title,
        tags: stringArray(args.tags),
        sourceHarness,
        artifactId: optionalString(args.artifact_id),
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
    } catch (error) {
      if (jobId) {
        await failDistillationJob(
          stateRoot,
          runtime.accountId,
          jobId,
          error instanceof Error ? error.message : String(error)
        );
      }
      throw error;
    }
    if (jobId) await completeDistillationJob(stateRoot, runtime.accountId, jobId, { kind, resultId: memoryResultId(result) });
    return jsonResult({
      ok: true,
      kind,
      scope,
      project: projectId,
      sourceHarness,
      nativeEvolution: false,
      contract: DISTILLATION_CONTRACT_VERSION,
      job_id: jobId,
      memory: result
    });
  });

  server.registerTool("memhub_evolution", {
    description: "让当前已登录 Harness 参与原生 L3 World Model 演化。next 领取严格 scoped 的任务；submit 提交 JSON candidate，由 Memory Core 用原 batch ownership/hash 规则校验后写回。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        action: { type: "string", enum: ["next", "submit"] },
        scope: { type: "string", enum: ["global", "project"] },
        project: { type: "string", description: "project scope 的明确项目 slug" },
        conversation_id: { type: "string", description: "可继承当前会话已绑定项目" },
        lease_seconds: { type: "integer", minimum: 30, maximum: 900 },
        job_id: { type: "string", description: "submit 时使用 next 返回的 jobId" },
        expected_field_hash: { type: "string" },
        expected_profile_hash: { type: "string" },
        candidate: {
          type: "object",
          additionalProperties: true,
          description: "严格匹配 next.expectedSchema 的 JSON 对象"
        }
      },
      required: ["action", "scope"],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    const action = requiredString(args.action, "action");
    if (action !== "next" && action !== "submit") {
      throw new TypeError("action must be next or submit");
    }
    const scope = requiredString(args.scope, "scope");
    const { projectId } = await resolveToolScope(runtime, {
      scope,
      project: optionalString(args.project),
      conversationId: optionalString(args.conversation_id)
    });
    const namespace = {
      source: "memhub-evolution",
      profileId: "default",
      userId: runtime.userId,
      tenantId: runtime.accountId,
      ...(projectId ? { projectId } : {})
    };

    if (action === "next") {
      const leaseSeconds = optionalInteger(args.lease_seconds);
      const result = await runtime.memoryClient.leaseExternalL3({
        adapterId: "memhub-harness-evolution",
        namespace,
        projectId,
        ...(leaseSeconds === undefined ? {} : { leaseSeconds })
      });
      return jsonResult({
        scope,
        project: projectId,
        result,
        instructions: "If result.job is non-null, follow job.systemPrompt using job.dynamicInput, return exactly job.expectedSchema, then call memhub_evolution action=submit with the same scope/project, job hashes, and candidate object."
      });
    }

    const jobId = requiredString(args.job_id, "job_id");
    const expectedFieldHash = requiredString(args.expected_field_hash, "expected_field_hash");
    const candidate = objectValue(args.candidate, "candidate");
    const result = await runtime.memoryClient.submitExternalL3(jobId, {
      adapterId: "memhub-harness-evolution",
      namespace,
      projectId,
      expectedFieldHash,
      ...(optionalString(args.expected_profile_hash)
        ? { expectedProfileHash: optionalString(args.expected_profile_hash) }
        : {}),
      candidate
    });
    return jsonResult({ scope, project: projectId, result });
  });

  server.registerTool("memmy_project", {
    description: "列出、查看、绑定或解除当前会话项目，也可读取 Normify 权威项目架构。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "current", "bind", "unbind", "architecture"] },
        conversation_id: { type: "string" },
        project: { type: "string" },
        query: { type: "string", description: "architecture 时用于生成相关架构 brief" }
      },
      required: ["action"],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    const action = requiredString(args.action, "action");
    if (action === "list") {
      return jsonResult({ projects: await knownProjectIds(runtime) });
    }
    const conversationId = optionalString(args.conversation_id);
    if (action === "current") {
      if (!conversationId) throw new TypeError("conversation_id is required for current");
      return jsonResult({ project: await runtime.router.currentProject(runtime.accountId, conversationId) });
    }
    if (action === "bind") {
      if (!conversationId) throw new TypeError("conversation_id is required for bind");
      const projectId = requiredString(args.project, "project");
      await runtime.router.bindProject(runtime.accountId, conversationId, projectId);
      return jsonResult({ ok: true, project: projectId });
    }
    if (action === "unbind") {
      if (!conversationId) throw new TypeError("conversation_id is required for unbind");
      return jsonResult({ ok: true, removed: await runtime.router.unbindProject(runtime.accountId, conversationId) });
    }
    if (action === "architecture") {
      const projectId = requiredString(args.project, "project");
      const query = optionalString(args.query) ?? "project architecture, ownership, dependencies and current constraints";
      return jsonResult({
        project: projectId,
        architecture: await runtime.router.projectArchitecture(runtime.accountId, projectId, query)
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
    else if (arg === "--normify-root") options.normifyRoot = value();
    else if (arg === "--no-normify") options.disableNormify = true;
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
    else if (arg === "--public-host") {
      const host = value().trim().toLowerCase();
      if (!host || host.includes("/") || host.includes(":")) throw new Error("--public-host must be a hostname");
      options.publicHost = host;
    }
    else if (arg === "--allow-jit") options.allowJit = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write([
        "Usage: memhub-mcp [options]",
        "       memhub-mcp account list|add|bind-email|delete|import-normify ...",
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
    publicHost = process.env.MEMHUB_PUBLIC_HOST?.trim() || undefined,
    allowJit = process.env.MEMHUB_ALLOW_JIT === "1",
    ...runtimeOptions
  } = options;
  if (httpPort !== undefined) {
    await serveHttp(runtimeOptions, { stateRoot, port: httpPort, path: httpPath, capturePath, publicHost, allowJit });
    return;
  }
  console.error(`[memhub] serving stdio account=${runtimeOptions.accountId ?? process.env.MEMHUB_ACCOUNT_ID ?? "local"}`);
  await serveStdio(() => createMemhubMcpServer(runtimeOptions));
}

async function serveHttp(
  runtimeOptions: MemhubRuntimeOptions,
  options: { stateRoot: string; port: number; path: string; capturePath: string; publicHost?: string; allowJit: boolean }
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
          "x-content-type-options": "nosniff"
        });
        response.end(request.method === "HEAD" ? undefined : renderLanding());
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
        const capsule = await runtime.router.context({
          accountId: runtime.accountId,
          userId: runtime.userId,
          query: requiredString(body.query, "query"),
          conversationId: optionalString(body.conversation_id),
          projectId: optionalString(body.project),
          workspaceProjectId: optionalString(body.workspace_project),
          semanticProjectIds: stringArray(body.semantic_projects),
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
          response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({
            error: "invalid_capture",
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

      if (url.pathname === "/memhub/user" || url.pathname.startsWith("/memhub/admin")) {
        const accounts = await listAccounts(options.stateRoot);
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
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!options.allowJit && message.includes("未加入 Memhub 本地允许列表")) {
              response.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
              response.end(renderUnprovisionedAccount(identity.email));
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
        const runtime = runtimeFor(summary.account_id);
        if (url.pathname === "/memhub/admin/api" && request.method === "GET") {
          const kind = url.searchParams.get("kind") ?? "overview";
          if (kind === "captures") {
            const captures = await listCaptureEvents(options.stateRoot, summary.account_id);
            const items = captures.map((capture) => ({
              ...capture,
              status: capture.ingested
                ? "ingested"
                : capture.user_text && capture.assistant_text
                  ? "complete_pending_ingest"
                  : "partial",
              scope: capture.project_hint ? `project:${capture.project_hint}` : "global_or_conversation_bound"
            }));
            response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
              .end(JSON.stringify({ items, total: items.length }));
            return;
          }
          if (kind === "distillation") {
            const jobs = await listDistillationJobs(options.stateRoot, summary.account_id);
            const config = await getDistillationConfig(options.stateRoot);
            const history = await listHistoryDistillationState(options.stateRoot, summary.account_id);
            const historyItems = history.runs.map((run) => ({
              ...run,
              type: "history_distillation",
              evidence_count: run.evidence.length,
              processed_in_run: run.cursor,
              remaining_in_run: Math.max(0, run.evidence.length - run.cursor)
            }));
            response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
              .end(JSON.stringify({ items: [...historyItems, ...jobs], total: historyItems.length + jobs.length, config, history_series: history.series }));
            return;
          }
          const allowed = new Map([
            ["overview", "/api/v1/overview"], ["memories", "/api/v1/memories?limit=100"],
            ["episodes", "/api/v1/episodes"], ["skills", "/api/v1/skills?limit=100"],
            ["world-models", "/api/v1/world-models?limit=100"], ["knowledge", "/api/v1/policies?limit=100"],
            ["traces", "/api/v1/traces?limit=100"]
          ]);
          const target = allowed.get(kind);
          if (!target) { response.writeHead(400).end(); return; }
          const payload = await runtime.memoryClient.viewerGet(target);
          response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(payload));
          return;
        }
        if (url.pathname === "/memhub/admin/action" && request.method === "POST") {
          const body = await readJsonBody(request) as Record<string, unknown>;
          const action = optionalString(body.action);
          const id = optionalString(body.id);
          if (!action) { response.writeHead(400).end(); return; }
          if (action === "set-distillation-config") {
            const config = await setDistillationConfig(options.stateRoot, {
              ...(typeof body.auto_enabled === "boolean" ? { auto_enabled: body.auto_enabled } : {}),
              ...(typeof body.turn_threshold === "number" ? { turn_threshold: body.turn_threshold } : {}),
              ...(typeof body.idle_minutes === "number" ? { idle_minutes: body.idle_minutes } : {})
            });
            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, config }));
            return;
          }
          if (action === "set-account-role") {
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
          if (!id) { response.writeHead(400).end(); return; }
          if (action === "queue-distillation") {
            const captures = await listCaptureEvents(options.stateRoot, summary.account_id);
            const selected = captures.find((item) => item.event_id === id || item.conversation_id === id);
            if (!selected) { response.writeHead(404).end(); return; }
            const projectId = await runtime.router.currentProject(summary.account_id, selected.conversation_id);
            const queued = await enqueueDistillationJob({
              stateRoot: options.stateRoot,
              accountId: summary.account_id,
              projectId,
              conversationId: selected.conversation_id,
              captures: captures.filter((item) =>
                item.conversation_id === selected.conversation_id &&
                item.ingested &&
                (projectId ? !item.project_hint || item.project_hint === projectId : !item.project_hint)
              ),
              reason: "manual"
            });
            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, ...queued }));
            return;
          }
          if (action === "retry-distillation") {
            const retried = await retryDistillationJob(options.stateRoot, summary.account_id, id);
            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, job: retried }));
            return;
          }
          if (action === "delete-memory") await runtime.memoryClient.viewerDelete(`/api/v1/memory/${encodeURIComponent(id)}`);
          else if (action === "archive-memory") await runtime.memoryClient.viewerPost(`/api/v1/memory/${encodeURIComponent(id)}/archive`);
          else if (action === "archive-skill") await runtime.memoryClient.viewerPost("/api/v1/skills/archive", { skillId: id });
          else if (action === "archive-world-model") await runtime.memoryClient.viewerPost(`/api/v1/world-models/${encodeURIComponent(id)}/archive`);
          else { response.writeHead(400).end(); return; }
          response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
          return;
        }
        const projects = await knownProjectIds(runtime);
        const devices = await listDevices(options.stateRoot, summary.account_id);
        const visibleAccounts = isAdmin && url.pathname.startsWith("/memhub/admin") ? accounts : [];
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        response.end(renderConsole({ account: summary, projects, devices, accounts: visibleAccounts, adminView: url.pathname.startsWith("/memhub/admin"), localControl }));
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
      const identity = await verifyCloudflareAccessJwt(options.stateRoot, options.publicHost, assertion);
      const account = await resolveCloudflareAccount(options.stateRoot, identity, { allowJit: options.allowJit });
      handlerFor(account.account_id, {
        platform: "chatgpt",
        transport: "mcp",
        principalId: identity.sub ? `cloudflare:${identity.sub}` : `cloudflare-email:${identity.email}`,
        connectionId: "cloudflare-managed-oauth",
        authenticatedAccount: identity.email
      })(request, response);
    })().catch((error) => {
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
    });
  });

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
  if (!config.auto_enabled) return null;
  const jobs = await listDistillationJobs(input.stateRoot, input.accountId);
  const used = new Set(jobs.filter((job) => job.conversation_id === input.conversationId && job.project_id === input.projectId).flatMap((job) => job.evidence_refs));
  const allCaptures = (await listCaptureEvents(input.stateRoot, input.accountId))
    .filter((item) => item.conversation_id === input.conversationId && item.ingested && item.user_text && item.assistant_text)
    .filter((item) => input.projectId ? !item.project_hint || item.project_hint === input.projectId : !item.project_hint);
  if (allCaptures.length < config.turn_threshold || allCaptures.length % config.turn_threshold !== 0) return null;
  const captures = allCaptures.filter((item) => !used.has(`capture:${item.event_id}`));
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
  const captures = await listCaptureEvents(stateRoot);
  const groups = new Map<string, typeof captures>();
  for (const capture of captures) {
    if (!capture.ingested || !capture.user_text || !capture.assistant_text) continue;
    const key = `${capture.account_id}\0${capture.conversation_id}`;
    const group = groups.get(key) ?? [];
    group.push(capture);
    groups.set(key, group);
  }
  const cutoff = Date.now() - config.idle_minutes * 60_000;
  for (const group of groups.values()) {
    const latest = Math.max(...group.map((item) => Date.parse(item.timestamp)));
    if (!Number.isFinite(latest) || latest > cutoff || group.length < 2) continue;
    const accountId = group[0]!.account_id;
    const conversationId = group[0]!.conversation_id;
    const runtime = runtimeForAccount(accountId);
    const projectId = await runtime.router.currentProject(accountId, conversationId);
    const jobs = await listDistillationJobs(stateRoot, accountId);
    const used = new Set(jobs.filter((job) => job.conversation_id === conversationId && job.project_id === projectId).flatMap((job) => job.evidence_refs));
    const scoped = group
      .filter((item) => projectId ? !item.project_hint || item.project_hint === projectId : !item.project_hint)
      .filter((item) => !used.has(`capture:${item.event_id}`));
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
  if (action === "import-normify") {
    if (!args[1]) throw new Error("account import-normify requires Normify root directory");
    const accounts = await importNormifyAccounts(stateRoot, args[1]);
    const cloudflare = await importNormifyCloudflarePin(stateRoot, args[1]);
    process.stdout.write(JSON.stringify({ accounts, cloudflare }, null, 2) + "\n");
    return;
  }
  throw new Error(`unknown account action: ${action ?? "<missing>"}`);
}

function defaultStateRoot(): string {
  return resolve(process.env.MEMHUB_STATE_ROOT ?? join(homedir(), ".memmy", "memhub"));
}

async function readJsonBody(request: import("node:http").IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("request body too large");
  }
  return JSON.parse(raw || "{}");
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
  projects: string[];
  devices: Awaited<ReturnType<typeof listDevices>>;
  accounts: Awaited<ReturnType<typeof listAccounts>>;
  adminView: boolean;
  localControl: boolean;
}): string {
  const e = escapeHtml;
  const nav = input.account.role === "admin"
    ? `<a class="view-switch${input.adminView ? "" : " active"}" href="/memhub/user">User</a><a class="view-switch${input.adminView ? " active" : ""}" href="/memhub/admin">Admin</a><a href="/memhub">About</a>`
    : `<a class="view-switch active" href="/memhub/user">User</a><a href="/memhub">About</a>`;
  const authBoundary = input.localControl ? "Local token + loopback Host" : "Cloudflare Access";
  const logoutLink = input.localControl ? "" : '<a class="logout" href="/cdn-cgi/access/logout" data-i18n="logout">退出</a>';
  const content = input.adminView
    ? `<div class="admin-shell"><aside><div class="brand">Memhub <em>Control</em></div><button data-view="overview">◫ <span data-i18n="overview">总览</span></button><button data-view="captures">◉ <span data-i18n="captures">原始捕获</span></button><button data-view="episodes">◷ <span data-i18n="episodes">对话与 Episode</span></button><button data-view="distillation">⌬ <span data-i18n="distillation">蒸馏任务</span></button><button data-view="memories">◇ <span data-i18n="memories">记忆</span></button><button data-view="traces">⌁ <span data-i18n="traces">L1 轨迹</span></button><button data-view="skills">✦ <span data-i18n="skills">技能</span></button><button data-view="world-models">◎ <span data-i18n="world">世界模型</span></button><button data-view="knowledge">▤ <span data-i18n="knowledge">L2 域知识</span></button><button data-view="accounts">♙ <span data-i18n="accounts">账号</span></button><div class="aside-foot">${e(authBoundary)}<br><small>Identity boundary</small></div></aside><div class="console"><div class="hero"><div><small data-i18n="control">MEMORY CONTROL PLANE</small><h1 data-i18n="title">长期记忆管理</h1><p data-i18n="subtitle">查看从 Raw Capture 到 Episode、蒸馏任务、Memory、Skill 与 World Model 的完整生命周期。</p></div><div class="hero-actions"><button id="lang">EN</button>${logoutLink}</div></div><div id="account-panel" class="panel hidden"><h2 data-i18n="accounts">账号</h2><div class="grid">${input.accounts.map((a) => `<article><b>${e(a.cloudflare_email ?? a.username)}</b><span class="pill">${e(a.role)}</span><small>${e(a.account_id)}</small><div class="actions"><button class="soft" onclick="accountRole('${e(a.account_id)}','admin')">Admin</button><button class="soft" onclick="accountRole('${e(a.account_id)}','user')">User</button></div></article>`).join("")}</div></div><div id="data-panel" class="panel"><div class="panel-head"><div><h2 id="view-title">总览</h2><p id="view-desc" class="muted">正在读取 Memory Core…</p></div><input id="filter" placeholder="搜索 / Search"></div><div id="cards" class="stats"></div><div id="items" class="items"><div class="empty">Loading…</div></div></div></div></div><div id="drawer" class="drawer hidden"><button class="drawer-close" onclick="closeDrawer()">×</button><div id="drawer-body"></div></div><script>${consoleScript()}</script>`
    : `<section><h2>我的 Memhub</h2><div class="stats"><article><b>${input.projects.length}</b><span>项目</span></article><article><b>${input.devices.length}</b><span>设备</span></article><article><b>${e(input.account.role)}</b><span>权限</span></article></div></section><section><h2>项目</h2><div class="grid">${input.projects.map((p) => `<article><b>${e(p)}</b><span>项目记忆空间</span></article>`).join("") || "<p class=\"muted\">暂无项目</p>"}</div></section><section><h2>连接设备</h2><div class="grid">${input.devices.map((d) => `<article><b>${e(d.name)}</b><span>${d.revoked_at ? "已撤销" : "已连接"}</span><small>${e(d.device_id)}</small></article>`).join("") || "<p class=\"muted\">暂无设备</p>"}</div></section><section><h2>记忆与沉淀</h2><p class="muted">原始捕获、Episode、蒸馏任务、Memory、Skill、L2 与 L3 的治理入口位于管理员 Control Plane。普通用户页只展示当前稳定 account_id 自己的项目与设备。</p></section>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Memhub Control Plane</title><style>${consoleCss()}</style></head><body><header><b>Memhub</b><nav>${nav}<span>${e(input.account.cloudflare_email ?? input.account.username)}</span>${input.adminView ? "" : logoutLink}</nav></header><main class="${input.adminView ? "admin-main" : ""}">${content}</main></body></html>`;
}

function renderLanding(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Memhub</title><style>${consoleCss()}</style></head><body><header><b>Memhub</b><nav><a href="/memhub/user">Open workspace</a><a href="/memhub/admin">Admin</a></nav></header><main><section class="landing-hero"><small>LONG-TERM MEMORY INFRASTRUCTURE</small><h1>Memory that stays connected to the work.</h1><p>Memhub separates raw conversation capture, semantic distillation, durable memory, reusable skills, project knowledge and world-model evolution. Storage and provenance stay in Memhub; semantic reasoning stays in the connected AI harness.</p><div class="landing-actions"><a class="primary-link" href="/memhub/user">Open workspace</a><a class="soft-link" href="#architecture">Architecture</a></div></section><section id="architecture"><h2>Lifecycle</h2><div class="flow"><span>Raw capture</span><b>→</b><span>Turns</span><b>→</b><span>Episodes</span><b>→</b><span>Evidence</span><b>→</b><span>Distillation</span><b>→</b><span>Memory / Skill / L2 / L3</span></div></section><section><h2>Design boundary</h2><div class="grid"><article><b>Memhub</b><span>Capture, storage, account and project scope, provenance, jobs, validation and commit.</span></article><article><b>AI Harness</b><span>Understanding, abstraction, semantic judgment and high-quality distillation.</span></article><article><b>Control Plane</b><span>Observe and govern the lifecycle without collapsing everything into one memory list.</span></article></div></section></main></body></html>`;
}

function renderUnprovisionedAccount(email: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Memhub account required</title><style>${consoleCss()}</style></head><body><header><b>Memhub</b><nav><a href="/memhub">About</a><a class="logout" href="/cdn-cgi/access/logout">退出</a></nav></header><main><section class="landing-hero"><small>ACCOUNT NOT PROVISIONED</small><h1>这个身份还没有 Memhub 账号。</h1><p>Cloudflare Access 已完成身份认证，但 Memhub 当前关闭自动开户。管理员需要先为 <b>${escapeHtml(email)}</b> 创建或绑定账号，然后才能进入用户工作区。</p><div class="landing-actions"><a class="primary-link" href="/memhub">返回项目介绍</a><a class="soft-link" href="/cdn-cgi/access/logout">更换登录身份</a></div></section></main></body></html>`;
}

function consoleCss(): string { return `
*{box-sizing:border-box}body{margin:0;font:14px Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;background:#f7fbff;color:#17324d}header{height:54px;display:flex;justify-content:space-between;align-items:center;padding:0 28px;background:rgba(255,255,255,.92);border-bottom:1px solid #dbeaf5}nav{display:flex;gap:12px;align-items:center}a{color:#2877a8;text-decoration:none}.view-switch{padding:7px 10px;border-radius:9px}.view-switch.active{background:#e3f3f8;color:#156f91;font-weight:700}.logout,#lang{border:1px solid #c9dfec;background:white;border-radius:10px;padding:8px 13px;color:#35657e}.admin-main{max-width:none;margin:0;padding:0}.admin-shell{display:grid;grid-template-columns:220px 1fr;min-height:calc(100vh - 54px)}aside{padding:24px 14px;background:#eef8fc;border-right:1px solid #d6eaf3}.brand{font-size:19px;font-weight:750;padding:0 12px 24px}.brand em{font-style:normal;color:#4aa6c6}aside button{width:100%;text-align:left;border:0;background:transparent;padding:11px 12px;margin:3px 0;border-radius:10px;color:#42667a;font-weight:600}aside button:hover,aside button.active{background:#dff2f8;color:#147b9f}.aside-foot{position:sticky;top:calc(100vh - 130px);padding:18px 12px;color:#7595a5}.console{padding:30px 4vw 60px;max-width:1500px}.hero{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;padding:12px 2px 25px}.hero small,.landing-hero small{letter-spacing:.16em;color:#4a9ab8;font-weight:800}.hero h1{font-size:32px;margin:8px 0;color:#153d57}.hero p{margin:0;color:#6c8a9a}.hero-actions{display:flex;gap:9px}.panel{background:white;border:1px solid #dcebf2;box-shadow:0 8px 30px rgba(35,111,143,.06);border-radius:18px;padding:22px;margin-bottom:18px}.panel-head{display:flex;justify-content:space-between;gap:20px;align-items:center}.panel-head input{width:min(320px,40vw);border:1px solid #d3e5ee;border-radius:11px;padding:10px 13px;outline:none}.stats,.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:18px 0}.stats article,.grid article{padding:16px;border:1px solid #deedf3;background:#fbfeff;border-radius:13px;display:flex;flex-direction:column;gap:6px}.stats b{font-size:25px;color:#197b9e}.pill{align-self:flex-start;background:#e1f5f6;color:#237f88;border-radius:999px;padding:3px 8px}.items{display:flex;flex-direction:column;gap:9px}.row{cursor:pointer;border:1px solid #e2edf2;border-radius:12px;padding:14px 16px;background:#fff;display:grid;grid-template-columns:minmax(140px,1fr) minmax(220px,3fr) auto;gap:14px;align-items:start}.row:hover{border-color:#a9d7e7;background:#fbfeff}.row h3{font-size:14px;margin:0 0 5px;color:#24526c}.row p{margin:0;color:#587688;white-space:pre-wrap;overflow-wrap:anywhere;max-height:100px;overflow:hidden}.row small{color:#91a7b3}.empty{padding:48px;text-align:center;color:#8ca3af}.hidden{display:none!important}.muted{color:#7793a2}article small{overflow-wrap:anywhere}.drawer{position:fixed;z-index:20;right:0;top:54px;width:min(600px,94vw);height:calc(100vh - 54px);overflow:auto;background:#fff;border-left:1px solid #d6e8f0;box-shadow:-18px 0 50px rgba(24,86,112,.12);padding:30px}.drawer-close{float:right;border:0;background:#eef7fa;border-radius:50%;width:34px;height:34px;font-size:22px}.drawer pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f7fbfd;border:1px solid #e1edf2;border-radius:12px;padding:14px;font-size:12px}.actions{display:flex;gap:8px;margin:20px 0}.danger,.soft{border:1px solid #d8e7ed;background:#f7fbfc;border-radius:9px;padding:8px 12px}.danger{color:#a43b43;border-color:#efcdd0;background:#fff9f9}main{max-width:1180px;margin:0 auto;padding:46px 28px 70px}.landing-hero{padding:60px 0 48px;max-width:880px}.landing-hero h1{font-size:clamp(38px,7vw,72px);line-height:1.02;margin:16px 0;color:#123a54}.landing-hero p{font-size:18px;line-height:1.7;color:#557487;max-width:780px}.landing-actions{display:flex;gap:12px;margin-top:28px}.primary-link,.soft-link{display:inline-block;padding:11px 16px;border-radius:11px}.primary-link{background:#177b9d;color:white}.soft-link{background:#e8f4f8}.flow{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:18px 0 34px}.flow span{padding:9px 12px;background:#fff;border:1px solid #dbeaf1;border-radius:10px}.flow b{color:#80a5b7}@media(max-width:760px){.admin-shell{grid-template-columns:1fr}aside{display:flex;overflow:auto;padding:8px;position:sticky;top:54px;z-index:2}aside .brand,.aside-foot{display:none}aside button{min-width:max-content}.console{padding:18px}.hero{flex-direction:column}.row{grid-template-columns:1fr}.panel-head{align-items:flex-start;flex-direction:column}.panel-head input{width:100%}header{padding:0 14px}header nav span{display:none}main{padding:32px 18px}.landing-hero{padding-top:32px}}
`; }

function consoleScript(): string { return `
const dict={zh:{overview:'总览',captures:'原始捕获',memories:'记忆',episodes:'对话与 Episode',distillation:'蒸馏任务',traces:'L1 轨迹',skills:'技能',world:'世界模型',knowledge:'L2 域知识',accounts:'账号',control:'MEMORY CONTROL PLANE',title:'长期记忆管理',subtitle:'查看从 Raw Capture 到 Episode、蒸馏任务、Memory、Skill 与 World Model 的完整生命周期。',logout:'退出'},en:{overview:'Overview',captures:'Raw Captures',memories:'Memories',episodes:'Conversations & Episodes',distillation:'Distillation Jobs',traces:'L1 Traces',skills:'Skills',world:'World Models',knowledge:'L2 Knowledge',accounts:'Accounts',control:'MEMORY CONTROL PLANE',title:'Long-term Memory',subtitle:'Inspect the lifecycle from raw captures through episodes, distillation jobs, memories, skills and world models.',logout:'Sign out'}};
let lang=localStorage.memhubLang||'zh', current='overview', payload=null, viewCache={}, activeRequest=null, requestSeq=0;
const titles={overview:['总览','Overview'],captures:['原始捕获','Raw Captures'],memories:['记忆','Memories'],episodes:['对话与 Episode','Conversations & Episodes'],distillation:['蒸馏任务','Distillation Jobs'],traces:['L1 轨迹','L1 Traces'],skills:['技能','Skills'],'world-models':['世界模型','World Models'],knowledge:['L2 域知识','L2 Knowledge']};
function tr(){document.documentElement.lang=lang==='zh'?'zh-CN':'en';document.querySelectorAll('[data-i18n]').forEach(x=>x.textContent=dict[lang][x.dataset.i18n]||x.textContent);document.getElementById('lang').textContent=lang==='zh'?'EN':'中文';}
function values(o){if(!o||typeof o!=='object')return[];for(const k of ['items','tasks','memories','episodes','skills','records'])if(Array.isArray(o[k]))return o[k];return[]}
function textOf(x){if(current==='captures')return (x.user_text||'')+'\n→ '+(x.assistant_text||'');if(current==='distillation'){if(x.type==='history_distillation')return (x.scope==='project'?'project:'+x.project_id:'account')+' · '+x.target+'\n'+(x.processed_in_run||0)+'/'+(x.evidence_count||0)+' evidence processed';return (x.conversation_id||'conversation job')+'\n'+(x.evidence?.length||0)+' evidence turns'}return x.snippet||x.content||x.summary||x.description||x.title||x.text||JSON.stringify(x)}
function itemId(x){return x.id||x.memoryId||x.skillId||x.event_id||x.job_id||x.conversation_id}
function render(data){payload=data;const items=values(data),cards=document.getElementById('cards'),total=data?.total??items.length;let html='<article><b>'+total+'</b><span>'+(lang==='zh'?'当前条目':'Current items')+'</span></article><article><b>'+items.filter(x=>x.status==='pending'||x.status==='resolving').length+'</b><span>Pending</span></article><article><b>'+items.filter(x=>x.status==='failed').length+'</b><span>Failed</span></article>';if(current==='distillation'&&data.config){html+='<article><b>'+(data.config.auto_enabled?'ON':'OFF')+'</b><span>Auto queue · '+data.config.turn_threshold+' turns / '+data.config.idle_minutes+' min idle</span><button class="soft" onclick="configureAuto()">Configure</button></article>'}cards.innerHTML=html;filter();}
function filter(){const q=document.getElementById('filter').value.toLowerCase();const items=values(payload).filter(x=>JSON.stringify(x).toLowerCase().includes(q));window.visibleItems=items;document.getElementById('items').innerHTML=items.length?items.map((x,i)=>'<div class="row" onclick="openItem('+i+')"><div><h3>'+esc(x.title||x.kind||x.type||x.event_id||x.job_id||x.id||'Item')+'</h3><small>'+esc(x.status||x.host||x.sourceAgent||x.source||'')+'</small></div><p>'+esc(textOf(x))+'</p><small>'+esc(x.updatedAt||x.updated_at||x.createdAt||x.created_at||x.timestamp||itemId(x)||'')+'</small></div>').join(''):'<div class="empty">'+(lang==='zh'?'暂无内容':'No items')+'</div>'}
function openItem(i){const x=window.visibleItems[i],id=itemId(x);let actions='';if(id&&current==='captures')actions='<div class="actions"><button class="soft" onclick="event.stopPropagation();act(\'queue-distillation\',\''+js(x.event_id)+'\')">Queue distillation</button></div>';if(id&&current==='distillation'&&x.status==='failed')actions='<div class="actions"><button class="soft" onclick="event.stopPropagation();act(\'retry-distillation\',\''+js(x.job_id)+'\')">Retry failed job</button></div>';if(id&&current==='memories')actions='<div class="actions"><button class="soft" onclick="event.stopPropagation();act(\'archive-memory\',\''+js(id)+'\')">Archive</button><button class="danger" onclick="event.stopPropagation();act(\'delete-memory\',\''+js(id)+'\')">Delete</button></div>';if(id&&current==='skills')actions='<div class="actions"><button class="soft" onclick="act(\'archive-skill\',\''+js(id)+'\')">Archive</button></div>';if(id&&current==='world-models')actions='<div class="actions"><button class="soft" onclick="act(\'archive-world-model\',\''+js(id)+'\')">Archive</button></div>';document.getElementById('drawer-body').innerHTML='<small>'+esc(current)+'</small><h2>'+esc(x.title||x.kind||x.event_id||x.job_id||x.id||'Detail')+'</h2><p>'+esc(textOf(x))+'</p>'+actions+'<h3>Metadata / Provenance</h3><pre>'+esc(JSON.stringify(x,null,2))+'</pre>';document.getElementById('drawer').classList.remove('hidden')}
function closeDrawer(){document.getElementById('drawer').classList.add('hidden')}function js(s){return String(s).replace(/[\\']/g,'\\$&')}async function act(action,id){if(!confirm((lang==='zh'?'确认执行：':'Confirm action: ')+action+'?'))return;const r=await fetch('/memhub/admin/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,id})});if(!r.ok){alert(await r.text());return}delete viewCache[current];delete viewCache.overview;closeDrawer();load(current)}
async function configureAuto(){const c=payload.config||{},enabled=confirm(lang==='zh'?'确定=开启自动形成蒸馏待办；取消=关闭。不会由 Memhub 后端调用模型。':'OK enables automatic distillation job creation; Cancel disables it. Memhub itself will not call a model.');const t=Number(prompt('Turn threshold',String(c.turn_threshold||8))),idle=Number(prompt('Idle minutes',String(c.idle_minutes||30)));const r=await fetch('/memhub/admin/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'set-distillation-config',auto_enabled:enabled,turn_threshold:t,idle_minutes:idle})});if(!r.ok){alert(await r.text());return}delete viewCache.distillation;load('distillation')}
async function accountRole(id,role){if(!confirm((lang==='zh'?'确认账号权限改为 ':'Change account role to ')+role+'?'))return;const r=await fetch('/memhub/admin/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'set-account-role',id,role})});if(!r.ok){alert(await r.text());return}location.reload()}
async function fetchView(view,signal){if(viewCache[view])return viewCache[view];const r=await fetch('/memhub/admin/api?kind='+encodeURIComponent(view),{signal});if(!r.ok)throw Error(await r.text());const data=await r.json();viewCache[view]=data;return data}
async function load(view){const seq=++requestSeq;current=view;if(activeRequest)activeRequest.abort();activeRequest=null;document.querySelectorAll('aside button').forEach(b=>b.classList.toggle('active',b.dataset.view===view));if(view==='accounts'){document.getElementById('account-panel').classList.remove('hidden');document.getElementById('data-panel').classList.add('hidden');return}document.getElementById('account-panel').classList.add('hidden');document.getElementById('data-panel').classList.remove('hidden');document.getElementById('view-title').textContent=titles[view][lang==='zh'?0:1];document.getElementById('view-desc').textContent=(view==='captures'||view==='distillation')?(lang==='zh'?'Memhub Capture / Evidence 层数据':'Memhub capture / evidence-layer data'):(lang==='zh'?'来自 Memory Core 的账号隔离数据；读取可随时切换/取消':'Account-scoped Memory Core data; navigation remains cancellable');if(viewCache[view]){render(viewCache[view]);return}document.getElementById('items').innerHTML='<div class="empty">'+(lang==='zh'?'正在读取；可直接切换其它页面…':'Loading; you can switch views immediately…')+'</div>';const controller=new AbortController();activeRequest=controller;const timer=setTimeout(()=>controller.abort('timeout'),6500);try{const data=await fetchView(view,controller.signal);if(seq===requestSeq)render(data)}catch(e){if(seq!==requestSeq||controller.signal.aborted&&controller.signal.reason!=='timeout')return;if(seq===requestSeq)document.getElementById('items').innerHTML='<div class="empty">'+(controller.signal.reason==='timeout'?(lang==='zh'?'Memory Core 读取超时。此页面未阻塞其它功能，可重试或切换。':'Memory Core timed out. Other views remain usable; retry or switch views.'):esc(String(e)))+'</div>'}finally{clearTimeout(timer);if(activeRequest===controller)activeRequest=null}}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
document.querySelectorAll('aside button').forEach(b=>b.onclick=()=>load(b.dataset.view));document.getElementById('filter').oninput=filter;document.getElementById('lang').onclick=()=>{lang=lang==='zh'?'en':'zh';localStorage.memhubLang=lang;tr();load(current)};tr();load('overview');
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

async function collectHistoryEvidence(input: {
  runtime: MemhubRuntime;
  stateRoot: string;
  scope: "project" | "account";
  projectId: string | null;
  target: "memory" | "skill";
}): Promise<HistoryEvidence[]> {
  const dbPath = process.env.MEMHUB_MEMORY_DB?.trim() || join(homedir(), ".memmy", "memory-service", "memory.sqlite");
  const core = listCoreMemoryEvidence({
    dbPath,
    userId: input.runtime.userId,
    ...(input.scope === "project" ? { projectId: input.projectId, excludeCaptureDerived: true } : {})
  }).filter((item) => input.target === "skill" || item.layer !== "Skill");
  if (input.scope === "account") return core;

  const captures = await listCaptureEvents(input.stateRoot, input.runtime.accountId);
  const projectByConversation = new Map<string, string | null>();
  const turns: HistoryEvidence[] = [];
  for (const capture of captures) {
    if (!capture.ingested || !capture.user_text?.trim() || !capture.assistant_text?.trim()) continue;
    let resolvedProject = capture.project_hint ?? projectByConversation.get(capture.conversation_id);
    if (resolvedProject === undefined) {
      resolvedProject = await input.runtime.router.currentProject(input.runtime.accountId, capture.conversation_id);
      projectByConversation.set(capture.conversation_id, resolvedProject);
    }
    if (resolvedProject !== input.projectId) continue;
    turns.push({
      ref: `capture:${capture.event_id}`,
      kind: "turn",
      timestamp: capture.timestamp,
      conversation_id: capture.conversation_id,
      ...(resolvedProject ? { project_id: resolvedProject } : {}),
      user_text: capture.user_text.trim(),
      assistant_text: capture.assistant_text.trim(),
      tags: ["memhub-capture", `host:${capture.host}`]
    });
  }
  return [...turns, ...core];
}

async function knownProjectIds(runtime: MemhubRuntime): Promise<string[]> {
  const discovered = await runtime.router.listProjects(runtime.accountId).catch(() => []);
  const dbPath = process.env.MEMHUB_MEMORY_DB?.trim() || join(homedir(), ".memmy", "memory-service", "memory.sqlite");
  let remembered: string[] = [];
  try {
    remembered = listCoreMemoryEvidence({ dbPath, userId: runtime.userId })
      .map((item) => item.project_id)
      .filter((value): value is string => Boolean(value?.trim()))
      .filter((value) => !/^ws_[a-f0-9]{32,}$/i.test(value));
  } catch {
    // Project listing should remain useful even if the Core DB is temporarily unavailable.
  }
  return [...new Set([...discovered, ...remembered].map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function historyMemoryContract(): Record<string, unknown> {
  return {
    version: "memhub-history-distill-v1",
    target: "memory",
    cumulative: true,
    required_dimensions: [
      "who", "what", "where", "when", "why", "how", "decisions", "constraints", "preferences",
      "relationships", "current_truth", "legacy", "unknowns", "provenance"
    ],
    rules: [
      "Use only supplied evidence plus continuation.prior_memory_document.",
      "Produce a cumulative canonical state, not a delta-only summary.",
      "Preserve concrete dates, actors, systems, paths, decisions, reasons and procedures when evidence supports them.",
      "Separate current truth from superseded/legacy facts and explicitly retain unknowns instead of guessing.",
      "Do not repeat already-processed evidence merely because it appears in the prior canonical document."
    ]
  };
}

function historySkillContract(): Record<string, unknown> {
  return {
    version: "memhub-history-distill-v1",
    target: "skill",
    cumulative_catalog: true,
    rules: [
      "A Skill must be a reusable procedure or decision method, never a chat summary.",
      "Compare against continuation.prior_skills and Skill-layer evidence before creating a new Skill.",
      "Evolve a matching Skill rather than creating a renamed duplicate.",
      "Each Skill must define when to use it, prerequisites, inputs, procedure, verification, failure modes, boundaries, reusable principles and provenance.",
      "If no reusable Skill is justified, submit skills=[] with no_skill_reason; the evidence is then marked reviewed and will not be proposed again."
    ]
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

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function resolveToolScope(
  runtime: MemhubRuntime,
  input: { scope: string; project?: string; conversationId?: string }
): Promise<{ projectId: string | null; conversationId?: string }> {
  if (input.scope !== "global" && input.scope !== "project") {
    throw new TypeError("scope must be global or project");
  }
  let projectId = input.project ?? null;
  if (input.scope === "project" && projectId === null && input.conversationId) {
    projectId = await runtime.router.currentProject(runtime.accountId, input.conversationId);
  }
  if (input.scope === "project" && projectId === null) {
    throw new Error("project scope requires an explicit or conversation-bound project");
  }
  if (input.scope === "global") projectId = null;
  if (projectId) {
    const projects = await runtime.router.listProjects(runtime.accountId);
    if (projects.length > 0 && !projects.includes(projectId)) {
      throw new Error(`unknown project for account: ${projectId}`);
    }
  }
  return {
    projectId,
    ...(input.conversationId ? { conversationId: input.conversationId } : {})
  };
}

const invokedArg = process.argv[1];
const invokedPath = invokedArg && !invokedArg.startsWith("-") && existsSync(resolve(invokedArg))
  ? realpathSync(resolve(invokedArg))
  : "";
if (invokedPath !== "" && invokedPath === fileURLToPath(import.meta.url)) await main();
