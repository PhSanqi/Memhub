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
import type { ProjectDescriptor } from "./project-registry.js";
import {
  DISTILLATION_CONTRACT_VERSION,
  distillationContract,
  validateDistillationCandidate
} from "./distillation-contract.js";

const VERSION = "0.1.0";
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
    description: "Private account/project-scoped long-term context and project architecture. Whenever Memhub is explicitly mentioned or invoked, first call memmy_context with the current request and stable conversation_id to load relevant conversation memory, then call memmy_project with action=current to verify the primary project before any project-scoped operation. If a project name is unknown, case-variant, or merely similar, call memmy_project_list and compare canonical slug, aliases, and description before creating/binding; never guess a project. Project mutations use memmy_project_manage plan -> explicit user authorization -> execute. Current-turn explicit project/workspace evidence overrides stale conversation binding. Before the final answer, persist only genuinely durable new facts/decisions/preferences/corrections rather than raw chat noise."
  });

  server.registerTool("memmy_context", {
    description: "当 Memhub 被提及或调用时，先用本工具结合当前请求与稳定 conversation_id 读取当前对话相关的长期记忆，再用 memmy_project action=current 核对 primary project，然后再进行 project-scoped 操作。若项目未唯一解析或名称相近，先调用 memmy_project_list 比较 canonical slug、aliases 与 description；不要尝试另一个大小写或盲目新建。当前轮的显式项目、workspace、项目名和 semantic_projects 优先于旧会话绑定；会话绑定只作为无本轮证据时的 fallback。同一会话可连续切换项目。业务记忆/架构只来自唯一 primary project；可复用 Skill 可从其他项目单独召回，不带入其业务 Current Truth。",
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
    const candidateQuery = optionalString(args.project) ?? optionalString(args.workspace_project) ?? query;
    const projectCandidates = capsule.resolvedProjectId === null || optionalString(args.project) || optionalString(args.workspace_project)
      ? await runtime.projects.suggest(runtime.accountId, candidateQuery, 8)
      : [];
    return jsonResult({
      ...capsule,
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

  server.registerTool("memmy_remember", {
    description: "在任务结束前的 memory hygiene 阶段写入真正耐久的新事实、决定、偏好或纠正。不要逐轮复制聊天内容；默认写全局，project scope 必须解析到注册表中的唯一 canonical project。未知/相似名称先用 memmy_project_list 核对，不允许通过写入隐式创建新项目。",
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
    await knownProjectRecords(runtime);
    if (scope === "project" && projectId !== null) {
      const requestedProject = projectId;
      projectId = await runtime.projects.resolve(runtime.accountId, requestedProject);
      if (projectId === null) {
        const candidates = await runtime.projects.suggest(runtime.accountId, requestedProject, 5);
        throw new Error(`unknown project "${requestedProject}". Call memmy_project_list with query="${requestedProject}" before creating or writing a new project. Similar: ${candidates.map((item) => item.projectId).join(", ") || "none"}`);
      }
    }
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
          impact = {
            project: canonical,
            logicalDelete: true,
            memoryPurged: false,
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
    description: "兼容项目上下文工具：列出、查看、绑定或解除当前会话项目，也可读取 Normify 权威项目架构。新的项目发现/消歧优先使用 memmy_project_list；项目修改使用 memmy_project_manage。Memhub 被提及或调用时，应先完成 memmy_context，再用 action=current 核对当前会话 primary project；若本轮有明确项目/workspace 证据，以本轮证据为准，不要凭旧绑定或模型猜测项目。",
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
      const details = await knownProjectRecords(runtime);
      return jsonResult({ projects: details.map((project) => project.projectId), projectDetails: details.map(projectForModel) });
    }
    const conversationId = optionalString(args.conversation_id);
    if (action === "current") {
      if (!conversationId) throw new TypeError("conversation_id is required for current");
      await knownProjectRecords(runtime);
      return jsonResult({ project: await runtime.router.currentProject(runtime.accountId, conversationId) });
    }
    if (action === "bind") {
      if (!conversationId) throw new TypeError("conversation_id is required for bind");
      const projectId = requiredString(args.project, "project");
      await knownProjectRecords(runtime);
      const canonical = await runtime.projects.resolve(runtime.accountId, projectId);
      if (!canonical) {
        const matches = await runtime.projects.suggest(runtime.accountId, projectId, 6);
        throw new Error(`unknown project "${projectId}". Use memmy_project_list before binding. Similar: ${matches.map((item) => item.projectId).join(", ") || "none"}`);
      }
      await runtime.router.bindProject(runtime.accountId, conversationId, canonical);
      return jsonResult({ ok: true, project: canonical, requested: projectId });
    }
    if (action === "unbind") {
      if (!conversationId) throw new TypeError("conversation_id is required for unbind");
      return jsonResult({ ok: true, removed: await runtime.router.unbindProject(runtime.accountId, conversationId) });
    }
    if (action === "architecture") {
      const projectId = requiredString(args.project, "project");
      await knownProjectRecords(runtime);
      const canonical = await runtime.projects.resolve(runtime.accountId, projectId);
      if (!canonical) throw new Error(`unknown project: ${projectId}`);
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
          if (kind === "projects") {
            const projects = await knownProjectRecords(runtime);
            const items = projects.map((project) => ({
              id: project.projectId,
              title: project.name || project.projectId,
              project_id: project.projectId,
              description: project.description,
              aliases: project.aliases,
              status: project.state,
              updated_at: project.updatedAt
            }));
            response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
              .end(JSON.stringify({ items, total: items.length }));
            return;
          }
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
        const projects = await knownProjectRecords(runtime);
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
  projects: ProjectDescriptor[];
  devices: Awaited<ReturnType<typeof listDevices>>;
  accounts: Awaited<ReturnType<typeof listAccounts>>;
  adminView: boolean;
  localControl: boolean;
}): string {
  const e = escapeHtml;
  const nav = input.account.role === "admin"
    ? `<a class="view-switch${input.adminView ? "" : " active"}" href="/memhub/user" data-zh="工作区" data-en="Workspace">工作区</a><a class="view-switch${input.adminView ? " active" : ""}" href="/memhub/admin" data-zh="管理" data-en="Admin">管理</a><a href="/memhub" data-zh="主页" data-en="About">主页</a>`
    : `<a class="view-switch active" href="/memhub/user" data-zh="工作区" data-en="Workspace">工作区</a><a href="/memhub" data-zh="主页" data-en="About">主页</a>`;
  const authBoundary = input.localControl ? "Local token + loopback Host" : "Cloudflare Access";
  const logoutLink = input.localControl ? "" : '<a class="logout" href="/cdn-cgi/access/logout" data-i18n="logout" data-zh="退出" data-en="Sign out">退出</a>';
  const accountLabel = e(input.account.cloudflare_email ?? input.account.username);
  const content = input.adminView
    ? `<div class="admin-shell"><aside><div class="brand">Memhub <em>Control</em></div><button data-view="overview">◫ <span data-i18n="overview">总览</span></button><button data-view="projects">▦ <span data-i18n="projects">项目</span></button><button data-view="captures">◉ <span data-i18n="captures">原始捕获</span></button><button data-view="episodes">◷ <span data-i18n="episodes">对话与 Episode</span></button><button data-view="distillation">⌬ <span data-i18n="distillation">蒸馏任务</span></button><button data-view="memories">◇ <span data-i18n="memories">记忆</span></button><button data-view="traces">⌁ <span data-i18n="traces">L1 轨迹</span></button><button data-view="skills">✦ <span data-i18n="skills">技能</span></button><button data-view="world-models">◎ <span data-i18n="world">世界模型</span></button><button data-view="knowledge">▤ <span data-i18n="knowledge">L2 域知识</span></button><button data-view="accounts">♙ <span data-i18n="accounts">账号</span></button><div class="aside-foot">${e(authBoundary)}<br><small data-zh="身份边界" data-en="Identity boundary">身份边界</small></div></aside><div class="console"><div class="hero"><div><small data-i18n="control">MEMORY CONTROL PLANE</small><h1 data-i18n="title">长期记忆管理</h1><p data-i18n="subtitle">先浏览轻量目录，再按需加载项目、Capture、Memory、Skill 与 World Model。</p></div><div class="hero-actions"><button id="theme-toggle" class="ui-toggle">暗色</button><button id="lang">EN</button>${logoutLink}</div></div><div id="account-panel" class="panel hidden"><h2 data-i18n="accounts">账号</h2><div class="grid">${input.accounts.map((a) => `<article><b>${e(a.cloudflare_email ?? a.username)}</b><span class="pill">${e(a.role)}</span><small>${e(a.account_id)}</small><div class="actions"><button class="soft" onclick="accountRole('${e(a.account_id)}','admin')">Admin</button><button class="soft" onclick="accountRole('${e(a.account_id)}','user')">User</button></div></article>`).join("")}</div></div><div id="data-panel" class="panel"><div class="panel-head"><div><h2 id="view-title">总览</h2><p id="view-desc" class="muted">选择一个数据域后再加载内容。</p></div><input id="filter" placeholder="搜索"></div><div id="cards" class="stats"></div><div id="items" class="items"></div></div></div></div><div id="drawer" class="drawer hidden"><button class="drawer-close" onclick="closeDrawer()">×</button><div id="drawer-body"></div></div><script>${consoleScript()}</script>`
    : `<section class="user-hero"><div><small data-zh="账号工作区" data-en="ACCOUNT WORKSPACE">账号工作区</small><h1 data-zh="我的 Memhub" data-en="My Memhub">我的 Memhub</h1><p data-zh="查看当前稳定账号自己的项目记忆边界、连接设备与访问权限。项目内容保持隔离；长期记忆治理仍由管理员 Control Plane 负责。" data-en="Inspect the project memory boundaries, connected devices and access role owned by this stable account. Project content stays isolated; long-term memory governance remains in the admin Control Plane.">查看当前稳定账号自己的项目记忆边界、连接设备与访问权限。项目内容保持隔离；长期记忆治理仍由管理员 Control Plane 负责。</p></div><div class="user-identity"><span data-zh="身份" data-en="IDENTITY">身份</span><b>${accountLabel}</b><small>${e(input.account.account_id)}</small></div></section><section class="user-stats"><article><span data-zh="项目空间" data-en="PROJECT SPACES">项目空间</span><b>${input.projects.length}</b><small data-zh="当前账号可见项目" data-en="Projects visible to this account">当前账号可见项目</small></article><article><span data-zh="连接设备" data-en="CONNECTED DEVICES">连接设备</span><b>${input.devices.filter((d) => !d.revoked_at).length}</b><small><span>${input.devices.length}</span> <span data-zh="台已注册" data-en="total registered">台已注册</span></small></article><article><span data-zh="访问角色" data-en="ACCESS ROLE">访问角色</span><b class="role-value">${e(input.account.role)}</b><small data-zh="${input.account.role === "admin" ? "可进入管理 Control Plane" : "账号工作区权限"}" data-en="${input.account.role === "admin" ? "Admin Control Plane access" : "Workspace access"}">${input.account.role === "admin" ? "可进入管理 Control Plane" : "账号工作区权限"}</small></article></section><div class="user-grid"><section class="user-panel"><div class="user-panel-head"><div><small data-zh="项目记忆" data-en="PROJECT MEMORY">项目记忆</small><h2 data-zh="项目空间" data-en="Project spaces">项目空间</h2></div><span><span>${input.projects.length}</span> <span data-zh="个空间" data-en="spaces">个空间</span></span></div><div class="user-list">${input.projects.map((p) => `<article><div class="user-icon">P</div><div><b>${e(p.name || p.projectId)}</b><span>${e(p.description || (p.aliases.length ? `aliases: ${p.aliases.join(", ")}` : p.projectId))}</span></div><small>${e(p.projectId)}</small></article>`).join("") || '<div class="user-empty" data-zh="暂无项目。项目建立后会在这里显示独立的长期记忆空间。" data-en="No projects yet. Each project will appear here as an isolated long-term memory space.">暂无项目。项目建立后会在这里显示独立的长期记忆空间。</div>'}</div></section><section class="user-panel"><div class="user-panel-head"><div><small data-zh="设备访问" data-en="DEVICE ACCESS">设备访问</small><h2 data-zh="连接设备" data-en="Connected devices">连接设备</h2></div><span><span>${input.devices.length}</span> <span data-zh="台已注册" data-en="registered">台已注册</span></span></div><div class="user-list">${input.devices.map((d) => `<article><div class="user-icon">D</div><div><b>${e(d.name)}</b><span>${e(d.device_id)}</span></div><small class="${d.revoked_at ? "state-revoked" : "state-live"}" data-zh="${d.revoked_at ? "已撤销" : "已连接"}" data-en="${d.revoked_at ? "REVOKED" : "CONNECTED"}">${d.revoked_at ? "已撤销" : "已连接"}</small></article>`).join("") || '<div class="user-empty" data-zh="暂无连接设备。设备接入后会显示稳定 device_id 与连接状态。" data-en="No connected devices yet. Registered devices will show a stable device_id and connection state here.">暂无连接设备。设备接入后会显示稳定 device_id 与连接状态。</div>'}</div></section></div><section class="user-boundary"><div><small data-zh="治理边界" data-en="GOVERNANCE BOUNDARY">治理边界</small><h2 data-zh="个人工作区只展示属于这个账号的边界。" data-en="The workspace only exposes boundaries owned by this account.">个人工作区只展示属于这个账号的边界。</h2></div><p><span data-zh="Raw Capture、Episode、蒸馏任务、Memory、Skill、L2 与 L3 的检查和治理入口位于管理员 Control Plane。" data-en="Inspection and governance for Raw Capture, Episodes, distillation jobs, Memory, Skills, L2 and L3 live in the admin Control Plane.">Raw Capture、Episode、蒸馏任务、Memory、Skill、L2 与 L3 的检查和治理入口位于管理员 Control Plane。</span>${input.account.role === "admin" ? ' <span data-zh="当前账号拥有管理员权限，可从顶部切换到" data-en="This account has administrator access; switch to">当前账号拥有管理员权限，可从顶部切换到</span> <a href="/memhub/admin">Admin</a>。' : ""}</p></section>`;
  const pageTitle = input.adminView ? "Memhub Control Plane" : "Memhub Workspace";
  const bodyClass = input.adminView ? "" : "user-body";
  const mainClass = input.adminView ? "admin-main" : "user-main";
  const userControls = input.adminView ? "" : '<div class="ui-controls"><button id="theme-toggle" class="ui-toggle">暗色</button><button id="lang-toggle" class="ui-toggle">EN</button></div>';
  const prefsScript = input.adminView ? "" : `<script>${pagePreferencesScript()}</script>`;
  return `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>${pageTitle}</title><style>${consoleCss()}${themeCss()}</style></head><body class="${bodyClass}"><header><b>Memhub</b><nav>${nav}<span>${accountLabel}</span>${userControls}${input.adminView ? "" : logoutLink}</nav></header><main class="${mainClass}">${content}</main>${prefsScript}</body></html>`;
}


function renderLanding(): string {
  return `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><meta name="description" content="Memhub is a private, project-aware long-term memory and context hub for AI harnesses."><title>Memhub — durable memory for AI work</title><style>${landingCss()}${themeCss()}</style></head><body class="landing-body">
  <header class="landing-header"><a class="landing-brand" href="/memhub"><span class="landing-mark">M</span><b>Memhub</b></a><nav><a href="#system" data-zh="系统" data-en="System">System</a><a href="#deploy" data-zh="部署" data-en="Deploy">Deploy</a><a href="https://github.com/PhSanqi/Memhub">GitHub</a><a class="header-cta" href="/memhub/user" data-zh="打开工作区" data-en="Open workspace">Open workspace</a><div class="ui-controls"><button id="theme-toggle" class="ui-toggle">Dark</button><button id="lang-toggle" class="ui-toggle">中文</button></div></nav></header>
  <main class="landing-main">
    <section class="landing-home">
      <div class="landing-copy"><span class="landing-eyebrow" data-zh="项目感知长期记忆" data-en="PROJECT-AWARE LONG-TERM MEMORY">PROJECT-AWARE LONG-TERM MEMORY</span><h1 data-zh="让记忆始终连接到正在进行的工作。" data-en="Memory that stays connected to the work.">Memory that stays connected to the work.</h1><p data-zh="Memhub 为 Codex、Claude Code、ChatGPT 风格 MCP 客户端和其他 AI Harness 提供统一、持久的记忆边界，而不强迫所有宿主采用同一种接入方式。" data-en="Memhub gives Codex, Claude Code, ChatGPT-style MCP clients and other AI harnesses one durable memory boundary without forcing every host into the same integration path.">Memhub gives Codex, Claude Code, ChatGPT-style MCP clients and other AI harnesses one durable memory boundary without forcing every host into the same integration path.</p><div class="landing-actions"><a class="primary-link" href="/memhub/user"><span data-zh="打开工作区" data-en="Open workspace">Open workspace</span> <span>→</span></a><a class="soft-link" href="https://github.com/PhSanqi/Memhub" data-zh="查看源码" data-en="View source">View source</a></div><div class="hero-proof"><span><i></i><span data-zh="账号 + 项目隔离" data-en="Account + project isolation">Account + project isolation</span></span><span><i></i><span data-zh="私有 Memory Core" data-en="Private Memory Core">Private Memory Core</span></span><span><i></i>Linux + Windows</span></div></div>
      <div class="system-preview"><div class="preview-head"><span class="preview-dots"><i></i><i></i><i></i></span><b>memory.lifecycle</b><small data-zh="显式边界" data-en="explicit boundary">explicit boundary</small></div><div class="pipeline"><div><span>01</span><b data-zh="捕获" data-en="Capture">Capture</b><small data-zh="完整轮次通过宿主适配器或 Bridge 进入系统。" data-en="Complete turns enter through host adapters or Bridge.">Complete turns enter through host adapters or Bridge.</small></div><div><span>02</span><b data-zh="解析作用域" data-en="Resolve scope">Resolve scope</b><small data-zh="每轮只确定一个主项目；账号知识保持独立。" data-en="One primary project per turn; account knowledge remains separate.">One primary project per turn; account knowledge remains separate.</small></div><div><span>03</span><b data-zh="蒸馏" data-en="Distill">Distill</b><small data-zh="AI Harness 基于证据完成语义判断。" data-en="AI harnesses perform semantic judgment against evidence.">AI harnesses perform semantic judgment against evidence.</small></div><div><span>04</span><b data-zh="提交" data-en="Commit">Commit</b><small data-zh="Memory、Skill、L2 与 L3 保留来源和验证信息。" data-en="Memory, Skill, L2 and L3 retain provenance and validation.">Memory, Skill, L2 and L3 retain provenance and validation.</small></div></div><div class="preview-foot"><code>project: current</code><span>storage → private</span></div></div>
    </section>
    <section class="signal-strip"><span data-zh="持久捕获" data-en="Durable capture">Durable capture</span><span data-zh="项目路由" data-en="Project routing">Project routing</span><span data-zh="可复用技能" data-en="Reusable skills">Reusable skills</span><span data-zh="权威架构" data-en="Authoritative architecture">Authoritative architecture</span><span data-zh="L2 / L3 演化" data-en="L2 / L3 evolution">L2 / L3 evolution</span></section>
    <section id="system" class="landing-section"><div class="section-intro"><span class="landing-eyebrow" data-zh="一个记忆系统，边界显式" data-en="ONE MEMORY SYSTEM, EXPLICIT BOUNDARIES">ONE MEMORY SYSTEM, EXPLICIT BOUNDARIES</span><h2 data-zh="保留有用上下文，而不是把所有历史压成一团。" data-en="Keep context useful without flattening everything into one history.">Keep context useful without flattening everything into one history.</h2><p data-zh="Memhub 区分属于个人的内容、属于单一项目的内容，以及可以作为能力跨项目复用的内容。" data-en="Memhub separates what belongs to the person, what belongs to one project, and what can be reused as a capability.">Memhub separates what belongs to the person, what belongs to one project, and what can be reused as a capability.</p></div><div class="feature-grid"><article><span class="feature-index">01</span><h3 data-zh="账号作用域" data-en="Account scope">Account scope</h3><p data-zh="个人偏好、跨项目规则、可复用工作流和一般知识保留在账号作用域。" data-en="Personal preferences, cross-project rules, reusable workflows and general knowledge stay account-scoped.">Personal preferences, cross-project rules, reusable workflows and general knowledge stay account-scoped.</p><small>GLOBAL / PERSONAL</small></article><article><span class="feature-index">02</span><h3 data-zh="项目作用域" data-en="Project scope">Project scope</h3><p data-zh="项目记忆、项目专属技能、环境档案、契约、领域知识和架构保持隔离。" data-en="Project memory, project-only skills, environment profile, contract, domain knowledge and architecture remain isolated.">Project memory, project-only skills, environment profile, contract, domain knowledge and architecture remain isolated.</p><small>PROJECT / AUTHORITATIVE</small></article><article><span class="feature-index">03</span><h3 data-zh="能力通道" data-en="Capability channel">Capability channel</h3><p data-zh="可复用 Skill 可以跨项目使用，但不会把普通项目记忆泄漏到其他工作区。" data-en="Reusable Skill artifacts can cross project boundaries without leaking ordinary project memory into another workspace.">Reusable Skill artifacts can cross project boundaries without leaking ordinary project memory into another workspace.</p><small>EXPLICIT REUSE</small></article><article><span class="feature-index">04</span><h3 data-zh="证据优先演化" data-en="Evidence-first evolution">Evidence-first evolution</h3><p data-zh="Raw Capture、Episode 和蒸馏任务在提交为持久 Memory、Skill、L2 或 L3 之前都可检查。" data-en="Raw captures, Episodes and distillation jobs remain inspectable before durable Memory, Skill, L2 or L3 state is committed.">Raw captures, Episodes and distillation jobs remain inspectable before durable Memory, Skill, L2 or L3 state is committed.</p><small>PROVENANCE / VALIDATION</small></article></div></section>
    <section class="boundary-section"><div><span class="landing-eyebrow" data-zh="设计边界" data-en="DESIGN BOUNDARY">DESIGN BOUNDARY</span><h2 data-zh="存储保持确定性，语义判断交给 AI Harness。" data-en="Storage stays deterministic. Semantic judgment stays with the AI harness.">Storage stays deterministic. Semantic judgment stays with the AI harness.</h2></div><div class="boundary-grid"><article><b>Memhub</b><p data-zh="负责捕获、作用域、存储、来源、队列、验证和提交。" data-en="Capture, scope, storage, provenance, queues, validation and commit.">Capture, scope, storage, provenance, queues, validation and commit.</p></article><span>↔</span><article><b>AI Harness</b><p data-zh="负责理解、抽象、综合以及依赖模型的演化工作。" data-en="Understanding, abstraction, synthesis and model-dependent evolution work.">Understanding, abstraction, synthesis and model-dependent evolution work.</p></article></div></section>
    <section id="deploy" class="landing-section"><div class="section-intro"><span class="landing-eyebrow" data-zh="四种发布形态" data-en="FOUR RELEASE SURFACES">FOUR RELEASE SURFACES</span><h2 data-zh="让记忆运行在它应该存在的位置。" data-en="Run it where the memory should live.">Run it where the memory should live.</h2><p data-zh="同一套实现发布为 Local/Server × Linux/Windows。Server Edition 把 Memory Core 保持在 Gateway 后的私有边界；Local Edition 不需要 VPS 或 Cloudflare。" data-en="The same implementation is packaged as local/server × Linux/Windows. Server Edition keeps Memory Core private behind the gateway; Local Edition needs no VPS or Cloudflare.">The same implementation is packaged as local/server × Linux/Windows. Server Edition keeps Memory Core private behind the gateway; Local Edition needs no VPS or Cloudflare.</p></div><div class="deploy-grid"><article><div><span class="deploy-tag">LOCAL</span><h3 data-zh="所有能力都在一台机器上" data-en="Everything on one machine">Everything on one machine</h3><p data-zh="MCP、capture、SQLite、evolution 和可选 Normify context 都留在本地。" data-en="MCP, capture, SQLite, evolution and optional Normify context stay local.">MCP, capture, SQLite, evolution and optional Normify context stay local.</p></div><code>bash editions/local/linux/install.sh</code></article><article><div><span class="deploy-tag">SERVER</span><h3 data-zh="一个持久的事实来源" data-en="One durable source of truth">One durable source of truth</h3><p data-zh="设备通过 Bridge 连接，认证后的远程客户端共享同一个服务端记忆边界。" data-en="Devices use Bridge transport while authenticated remote clients share the same server memory boundary.">Devices use Bridge transport while authenticated remote clients share the same server memory boundary.</p></div><code>MEMHUB_USERNAME=owner bash editions/server/linux/install.sh</code></article></div></section>
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

function consoleCss(): string { return `
*{box-sizing:border-box}body{margin:0;font:14px Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;background:#f7fbff;color:#17324d}header{height:54px;display:flex;justify-content:space-between;align-items:center;padding:0 28px;background:rgba(255,255,255,.92);border-bottom:1px solid #dbeaf5}nav{display:flex;gap:12px;align-items:center}a{color:#2877a8;text-decoration:none}.view-switch{padding:7px 10px;border-radius:9px}.view-switch.active{background:#e3f3f8;color:#156f91;font-weight:700}.logout,#lang{border:1px solid #c9dfec;background:white;border-radius:10px;padding:8px 13px;color:#35657e}.admin-main{max-width:none;margin:0;padding:0}.admin-shell{display:grid;grid-template-columns:220px 1fr;min-height:calc(100vh - 54px)}aside{padding:24px 14px;background:#eef8fc;border-right:1px solid #d6eaf3}.brand{font-size:19px;font-weight:750;padding:0 12px 24px}.brand em{font-style:normal;color:#4aa6c6}aside button{width:100%;text-align:left;border:0;background:transparent;padding:11px 12px;margin:3px 0;border-radius:10px;color:#42667a;font-weight:600}aside button:hover,aside button.active{background:#dff2f8;color:#147b9f}.aside-foot{position:sticky;top:calc(100vh - 130px);padding:18px 12px;color:#7595a5}.console{padding:30px 4vw 60px;max-width:1500px}.hero{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;padding:12px 2px 25px}.hero small,.landing-hero small{letter-spacing:.16em;color:#4a9ab8;font-weight:800}.hero h1{font-size:32px;margin:8px 0;color:#153d57}.hero p{margin:0;color:#6c8a9a}.hero-actions{display:flex;gap:9px}.panel{background:white;border:1px solid #dcebf2;box-shadow:0 8px 30px rgba(35,111,143,.06);border-radius:18px;padding:22px;margin-bottom:18px}.panel-head{display:flex;justify-content:space-between;gap:20px;align-items:center}.panel-head input{width:min(320px,40vw);border:1px solid #d3e5ee;border-radius:11px;padding:10px 13px;outline:none}.stats,.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:18px 0}.stats article,.grid article{padding:16px;border:1px solid #deedf3;background:#fbfeff;border-radius:13px;display:flex;flex-direction:column;gap:6px}.stats b{font-size:25px;color:#197b9e}.pill{align-self:flex-start;background:#e1f5f6;color:#237f88;border-radius:999px;padding:3px 8px}.items{display:flex;flex-direction:column;gap:9px}.row{cursor:pointer;border:1px solid #e2edf2;border-radius:12px;padding:14px 16px;background:#fff;display:grid;grid-template-columns:minmax(140px,1fr) minmax(220px,3fr) auto;gap:14px;align-items:start}.row:hover{border-color:#a9d7e7;background:#fbfeff}.row h3{font-size:14px;margin:0 0 5px;color:#24526c}.row p{margin:0;color:#587688;white-space:pre-wrap;overflow-wrap:anywhere;max-height:100px;overflow:hidden}.row small{color:#91a7b3}.empty{padding:48px;text-align:center;color:#8ca3af}.hidden{display:none!important}.muted{color:#7793a2}article small{overflow-wrap:anywhere}.drawer{position:fixed;z-index:20;right:0;top:54px;width:min(600px,94vw);height:calc(100vh - 54px);overflow:auto;background:#fff;border-left:1px solid #d6e8f0;box-shadow:-18px 0 50px rgba(24,86,112,.12);padding:30px}.drawer-close{float:right;border:0;background:#eef7fa;border-radius:50%;width:34px;height:34px;font-size:22px}.drawer pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f7fbfd;border:1px solid #e1edf2;border-radius:12px;padding:14px;font-size:12px}.actions{display:flex;gap:8px;margin:20px 0}.danger,.soft{border:1px solid #d8e7ed;background:#f7fbfc;border-radius:9px;padding:8px 12px}.danger{color:#a43b43;border-color:#efcdd0;background:#fff9f9}main{max-width:1180px;margin:0 auto;padding:46px 28px 70px}.landing-hero{padding:60px 0 48px;max-width:880px}.landing-hero h1{font-size:clamp(38px,7vw,72px);line-height:1.02;margin:16px 0;color:#123a54}.landing-hero p{font-size:18px;line-height:1.7;color:#557487;max-width:780px}.landing-actions{display:flex;gap:12px;margin-top:28px}.primary-link,.soft-link{display:inline-block;padding:11px 16px;border-radius:11px}.primary-link{background:#177b9d;color:white}.soft-link{background:#e8f4f8}.flow{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:18px 0 34px}.flow span{padding:9px 12px;background:#fff;border:1px solid #dbeaf1;border-radius:10px}.flow b{color:#80a5b7}@media(max-width:760px){.admin-shell{grid-template-columns:1fr}aside{display:flex;overflow:auto;padding:8px;position:sticky;top:54px;z-index:2}aside .brand,.aside-foot{display:none}aside button{min-width:max-content}.console{padding:18px}.hero{flex-direction:column}.row{grid-template-columns:1fr}.panel-head{align-items:flex-start;flex-direction:column}.panel-head input{width:100%}header{padding:0 14px}header nav span{display:none}main{padding:32px 18px}.landing-hero{padding-top:32px}}
body.admin-body{background:#090d12;color:#edf3f6}body.admin-body header{background:rgba(9,13,18,.94);border-color:#19232d;backdrop-filter:blur(14px)}body.admin-body header b{color:#edf3f6}body.admin-body header a{color:#8f9da8}body.admin-body .view-switch.active{background:#14231f;color:#91dfc3}body.admin-body .logout,body.admin-body #lang{border-color:#24303d;background:#0f151c;color:#a9b6c0}body.admin-body .admin-shell{grid-template-columns:226px minmax(0,1fr);min-height:calc(100vh - 54px)}body.admin-body aside{position:sticky;top:54px;height:calc(100vh - 54px);padding:22px 12px;background:#0b1016;border-color:#19232d;overflow:auto}body.admin-body .brand{font-size:17px;padding:0 10px 22px}body.admin-body .brand em{color:#72d0ae}body.admin-body aside button{border:1px solid transparent;padding:9px 10px;margin:2px 0;border-radius:8px;color:#8998a4}body.admin-body aside button:hover{background:#111922;color:#e1e9ed}body.admin-body aside button.active{background:#14231f;border-color:#203a32;color:#91dfc3}body.admin-body .aside-foot{position:static;margin:20px 10px 0;padding:16px 0 0;border-top:1px solid #19232d;color:#61707d;font-size:11px}body.admin-body .console{padding:34px clamp(20px,4vw,56px) 60px;max-width:1500px}body.admin-body .hero{padding:5px 0 26px}body.admin-body .hero small{color:#55a488;font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace}body.admin-body .hero h1{font-size:36px;letter-spacing:-.035em;margin:7px 0 8px;color:#edf3f6}body.admin-body .hero p{color:#8b99a6;line-height:1.6}body.admin-body .panel{background:#0f151c;border-color:#19232d;box-shadow:0 20px 60px rgba(0,0,0,.16);border-radius:13px;padding:20px;margin-bottom:18px}body.admin-body .panel-head{align-items:flex-start}body.admin-body .panel-head h2{margin:0 0 6px;color:#edf3f6}body.admin-body .panel-head input{border-color:#24303d;background:#0a1016;color:#edf3f6;border-radius:8px;padding:9px 11px}body.admin-body .muted{color:#8b99a6}body.admin-body .stats{grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px;margin:15px 0 18px}body.admin-body .stats article,body.admin-body .grid article{border-color:#19232d;background:#0c1218;border-radius:9px;padding:13px}body.admin-body .stats b{font:650 23px ui-monospace,SFMono-Regular,Menlo,monospace;color:#e9f2f4}body.admin-body .stats span,body.admin-body article small{color:#70808d}body.admin-body .pill{background:#14251f;color:#82d8b9}body.admin-body .items{gap:0;border-top:1px solid #19232d}body.admin-body .row{border:0;border-bottom:1px solid #19232d;border-radius:0;padding:13px 8px;background:transparent}body.admin-body .row:hover{background:#111820}body.admin-body .row h3{color:#d9e3e8}body.admin-body .row p{color:#8d9ca8;line-height:1.5}body.admin-body .row small{color:#53626e;font:10px ui-monospace,SFMono-Regular,Menlo,monospace}body.admin-body .empty{color:#73818d}body.admin-body .soft{border-color:#24303d;background:#111922;color:#aebac3}body.admin-body .danger{border-color:#563237;background:#1b1113;color:#ff969b}body.admin-body .drawer{background:#0e141b;border-color:#24303d;color:#edf3f6;box-shadow:-24px 0 70px rgba(0,0,0,.35)}body.admin-body .drawer-close{background:#151d25;color:#aeb8c1}body.admin-body .drawer pre{background:#090e13;border-color:#19232d;color:#a8bac4}.admin-toolbar{display:flex;gap:8px;align-items:center}.admin-toolbar #filter{min-width:min(320px,38vw)}body.admin-body .overview-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;border-top:0}body.admin-body .overview-card{appearance:none;border:1px solid #19232d;background:#0c1218;color:#edf3f6;border-radius:10px;padding:18px;text-align:left;display:grid;grid-template-columns:34px 1fr auto;gap:12px;align-items:center;cursor:pointer}body.admin-body .overview-card:hover{border-color:#2d4b40;background:#101a17}body.admin-body .overview-card>span{font:700 15px ui-monospace,SFMono-Regular,Menlo,monospace;color:#72d0ae}body.admin-body .overview-card div{display:flex;flex-direction:column;gap:5px}body.admin-body .overview-card b{font-size:14px}body.admin-body .overview-card small{color:#657582;font:10px ui-monospace,SFMono-Regular,Menlo,monospace}body.admin-body .overview-card i{font-style:normal;color:#52635c}@media(max-width:760px){body.admin-body .admin-shell{grid-template-columns:1fr}body.admin-body aside{position:sticky;top:54px;height:auto;display:flex;padding:7px;border-right:0;border-bottom:1px solid #19232d;z-index:3}body.admin-body aside .brand,body.admin-body .aside-foot{display:none}body.admin-body aside button{width:auto;min-width:max-content;margin:0}body.admin-body .console{padding:18px 14px 48px}.admin-toolbar{width:100%}.admin-toolbar #filter{min-width:0;flex:1}}
body.user-body{background:#090d12;color:#edf3f6;min-height:100vh}body.user-body header{background:rgba(9,13,18,.94);border-color:#19232d;backdrop-filter:blur(14px)}body.user-body header>b{color:#edf3f6}body.user-body header a{color:#8f9da8}body.user-body .view-switch.active{background:#14231f;color:#91dfc3}body.user-body .logout{border-color:#24303d;background:#0f151c;color:#a9b6c0}.user-main{max-width:1240px;padding:52px 28px 86px}.user-hero{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(280px,.65fr);gap:60px;align-items:end;padding:36px 0 42px;border-bottom:1px solid #19232d}.user-hero>div:first-child>small,.user-panel-head small,.user-boundary small{color:#55a488;font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em}.user-hero h1{font-size:clamp(44px,6vw,72px);line-height:.96;letter-spacing:-.055em;margin:12px 0 18px}.user-hero p{max-width:720px;margin:0;color:#8b99a6;font-size:16px;line-height:1.7}.user-identity{padding:18px;border:1px solid #24303d;border-radius:10px;background:#0d1319;display:flex;flex-direction:column;gap:7px}.user-identity>span{color:#61717d;font:10px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em}.user-identity b{font-size:14px;overflow-wrap:anywhere}.user-identity small{color:#667582;font:10px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.user-stats{display:grid;grid-template-columns:repeat(3,1fr);margin:0;border-bottom:1px solid #19232d}.user-stats article{min-height:142px;padding:24px 20px;border-right:1px solid #19232d;display:flex;flex-direction:column;gap:7px;background:transparent}.user-stats article:last-child{border-right:0}.user-stats span{color:#64747f;font:10px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.1em}.user-stats b{font:650 31px ui-monospace,SFMono-Regular,Menlo,monospace;color:#e9f2f4}.user-stats b.role-value{text-transform:uppercase;font-size:23px;color:#8edcbe}.user-stats small{color:#61717d}.user-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:42px 0 12px}.user-panel{margin:0;padding:0;border:1px solid #19232d;border-radius:12px;background:#0d1319;overflow:hidden}.user-panel-head{display:flex;justify-content:space-between;gap:20px;align-items:flex-end;padding:20px;border-bottom:1px solid #19232d}.user-panel-head h2{font-size:20px;margin:7px 0 0}.user-panel-head>span{color:#5f6f7b;font:10px ui-monospace,SFMono-Regular,Menlo,monospace}.user-list{display:flex;flex-direction:column}.user-list article{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:12px;align-items:center;padding:15px 18px;border-bottom:1px solid #19232d}.user-list article:last-child{border-bottom:0}.user-list article>div:nth-child(2){min-width:0;display:flex;flex-direction:column;gap:4px}.user-list article b{font-size:13px}.user-list article span{color:#697986;font-size:11px;overflow-wrap:anywhere}.user-list article>small{font:9px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;color:#61717d}.user-icon{width:30px;height:30px;display:grid;place-items:center;border:1px solid #2a3b47;border-radius:8px;background:#101820;color:#759489;font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace}.user-list .state-live{color:#6bc5a4}.user-list .state-revoked{color:#c2767d}.user-empty{padding:34px 20px;color:#667582;line-height:1.6}.user-boundary{display:grid;grid-template-columns:1fr 1fr;gap:50px;align-items:start;margin-top:12px;padding:38px 2px;border-top:1px solid #19232d}.user-boundary h2{font-size:29px;line-height:1.12;letter-spacing:-.03em;margin:9px 0 0}.user-boundary p{margin:0;color:#84929e;line-height:1.7}.user-boundary a{color:#8edcbe}@media(max-width:820px){.user-hero,.user-boundary{grid-template-columns:1fr;gap:24px}.user-grid{grid-template-columns:1fr}.user-stats{grid-template-columns:1fr}.user-stats article{min-height:auto;border-right:0;border-bottom:1px solid #19232d}.user-stats article:last-child{border-bottom:0}}@media(max-width:760px){body.user-body header nav span{display:none}.user-main{padding:28px 18px 60px}.user-hero{padding-top:22px}.user-hero h1{font-size:47px}.user-panel-head{align-items:flex-start;flex-direction:column;gap:9px}.user-list article{grid-template-columns:32px minmax(0,1fr)}.user-list article>small{grid-column:2}}
`; }

function consoleScript(): string { return `
document.body.classList.add("admin-body");
const dict={zh:{overview:'总览',projects:'项目',captures:'原始捕获',memories:'记忆',episodes:'对话与 Episode',distillation:'蒸馏任务',traces:'L1 轨迹',skills:'技能',world:'世界模型',knowledge:'L2 域知识',accounts:'账号',control:'MEMORY CONTROL PLANE',title:'长期记忆管理',subtitle:'先浏览轻量目录，再按需加载项目、Capture、Memory、Skill 与 World Model。',logout:'退出'},en:{overview:'Overview',projects:'Projects',captures:'Raw Captures',memories:'Memories',episodes:'Conversations & Episodes',distillation:'Distillation Jobs',traces:'L1 Traces',skills:'Skills',world:'World Models',knowledge:'L2 Knowledge',accounts:'Accounts',control:'MEMORY CONTROL PLANE',title:'Long-term Memory',subtitle:'Browse the lightweight directory first, then load projects, captures, memories, skills and world models on demand.',logout:'Sign out'}};
let lang=localStorage.memhubLang||((navigator.language||'').toLowerCase().startsWith('zh')?'zh':'en'), theme=localStorage.memhubTheme||'light', current='overview', payload=null, viewCache={}, activeRequest=null, requestSeq=0;
const filterInput=document.getElementById("filter"),adminToolbar=document.createElement("div"),refreshButton=document.createElement("button");
adminToolbar.className="admin-toolbar";refreshButton.className="soft";refreshButton.type="button";refreshButton.id="refresh";refreshButton.textContent="↻ Refresh";filterInput.replaceWith(adminToolbar);adminToolbar.append(filterInput,refreshButton);refreshButton.onclick=()=>{delete viewCache[current];load(current)};
const titles={overview:['总览','Overview'],projects:['项目','Projects'],captures:['原始捕获','Raw Captures'],memories:['记忆','Memories'],episodes:['对话与 Episode','Conversations & Episodes'],distillation:['蒸馏任务','Distillation Jobs'],traces:['L1 轨迹','L1 Traces'],skills:['技能','Skills'],'world-models':['世界模型','World Models'],knowledge:['L2 域知识','L2 Knowledge']};
function tr(){document.documentElement.lang=lang==='zh'?'zh-CN':'en';document.documentElement.dataset.theme=theme;document.querySelectorAll('[data-i18n]').forEach(x=>x.textContent=dict[lang][x.dataset.i18n]||x.textContent);document.querySelectorAll('[data-zh][data-en]').forEach(x=>x.textContent=x.dataset[lang]||x.textContent);document.getElementById('lang').textContent=lang==='zh'?'EN':'中文';document.getElementById('theme-toggle').textContent=theme==='dark'?(lang==='zh'?'亮色':'Light'):(lang==='zh'?'暗色':'Dark');refreshButton.textContent=lang==='zh'?'↻ 刷新':'↻ Refresh';filterInput.placeholder=lang==='zh'?'搜索':'Search';}
function values(o){if(!o||typeof o!=='object')return[];for(const k of ['items','tasks','memories','episodes','skills','records'])if(Array.isArray(o[k]))return o[k];return[]}
function textOf(x){if(current==='captures')return (x.user_text||'')+'\n→ '+(x.assistant_text||'');if(current==='distillation'){if(x.type==='history_distillation')return (x.scope==='project'?'project:'+x.project_id:'account')+' · '+x.target+'\n'+(x.processed_in_run||0)+'/'+(x.evidence_count||0)+' evidence processed';return (x.conversation_id||'conversation job')+'\n'+(x.evidence?.length||0)+' evidence turns'}return x.snippet||x.content||x.summary||x.description||x.title||x.text||JSON.stringify(x)}
function itemId(x){return x.id||x.memoryId||x.skillId||x.event_id||x.job_id||x.conversation_id}
function render(data){payload=data;const items=values(data),cards=document.getElementById('cards'),total=data?.total??items.length;let html='<article><b>'+total+'</b><span>'+(lang==='zh'?'当前条目':'Current items')+'</span></article><article><b>'+items.filter(x=>x.status==='pending'||x.status==='resolving').length+'</b><span>'+(lang==='zh'?'待处理':'Pending')+'</span></article><article><b>'+items.filter(x=>x.status==='failed').length+'</b><span>'+(lang==='zh'?'失败':'Failed')+'</span></article>';if(current==='distillation'&&data.config){html+='<article><b>'+(data.config.auto_enabled?'ON':'OFF')+'</b><span>'+(lang==='zh'?'自动队列':'Auto queue')+' · '+data.config.turn_threshold+' '+(lang==='zh'?'轮':'turns')+' / '+data.config.idle_minutes+' '+(lang==='zh'?'分钟空闲':'min idle')+'</span><button class="soft" onclick="configureAuto()">'+(lang==='zh'?'配置':'Configure')+'</button></article>'}cards.innerHTML=html;filter();}
function renderOverview(){payload=null;document.getElementById('cards').innerHTML='';const sections=[['projects','▦','项目','Projects','canonical slug / aliases / description'],['captures','◉','原始捕获','Raw Captures','capture / ingest'],['episodes','◷','对话与 Episode','Conversations & Episodes','conversation / episode'],['distillation','⌬','蒸馏任务','Distillation Jobs','queue / history distillation'],['memories','◇','记忆','Memories','L1 / durable memory'],['traces','⌁','L1 轨迹','L1 Traces','trace / provenance'],['skills','✦','技能','Skills','reusable capability'],['world-models','◎','世界模型','World Models','L3 / evolution'],['knowledge','▤','L2 域知识','L2 Knowledge','policy / domain knowledge']];const items=document.getElementById('items');items.className='items overview-grid';items.innerHTML=sections.map(s=>'<button class="overview-card" onclick="load(\''+s[0]+'\')"><span>'+s[1]+'</span><div><b>'+(lang==='zh'?s[2]:s[3])+'</b><small>'+s[4]+'</small></div><i>→</i></button>').join('')}
function filter(){const q=document.getElementById('filter').value.toLowerCase();const items=values(payload).filter(x=>JSON.stringify(x).toLowerCase().includes(q));window.visibleItems=items;document.getElementById('items').innerHTML=items.length?items.map((x,i)=>'<div class="row" onclick="openItem('+i+')"><div><h3>'+esc(x.title||x.kind||x.type||x.event_id||x.job_id||x.id||'Item')+'</h3><small>'+esc(x.status||x.host||x.sourceAgent||x.source||'')+'</small></div><p>'+esc(textOf(x))+'</p><small>'+esc(x.updatedAt||x.updated_at||x.createdAt||x.created_at||x.timestamp||itemId(x)||'')+'</small></div>').join(''):'<div class="empty">'+(lang==='zh'?'暂无内容':'No items')+'</div>'}
function openItem(i){const x=window.visibleItems[i],id=itemId(x);let actions='';if(id&&current==='captures')actions='<div class="actions"><button class="soft" onclick="event.stopPropagation();act(\'queue-distillation\',\''+js(x.event_id)+'\')">'+(lang==='zh'?'加入蒸馏队列':'Queue distillation')+'</button></div>';if(id&&current==='distillation'&&x.status==='failed')actions='<div class="actions"><button class="soft" onclick="event.stopPropagation();act(\'retry-distillation\',\''+js(x.job_id)+'\')">'+(lang==='zh'?'重试失败任务':'Retry failed job')+'</button></div>';if(id&&current==='memories')actions='<div class="actions"><button class="soft" onclick="event.stopPropagation();act(\'archive-memory\',\''+js(id)+'\')">'+(lang==='zh'?'归档':'Archive')+'</button><button class="danger" onclick="event.stopPropagation();act(\'delete-memory\',\''+js(id)+'\')">'+(lang==='zh'?'删除':'Delete')+'</button></div>';if(id&&current==='skills')actions='<div class="actions"><button class="soft" onclick="act(\'archive-skill\',\''+js(id)+'\')">'+(lang==='zh'?'归档':'Archive')+'</button></div>';if(id&&current==='world-models')actions='<div class="actions"><button class="soft" onclick="act(\'archive-world-model\',\''+js(id)+'\')">'+(lang==='zh'?'归档':'Archive')+'</button></div>';document.getElementById('drawer-body').innerHTML='<small>'+esc(current)+'</small><h2>'+esc(x.title||x.kind||x.event_id||x.job_id||x.id||(lang==='zh'?'详情':'Detail'))+'</h2><p>'+esc(textOf(x))+'</p>'+actions+'<h3>'+(lang==='zh'?'元数据 / 来源':'Metadata / Provenance')+'</h3><pre>'+esc(JSON.stringify(x,null,2))+'</pre>';document.getElementById('drawer').classList.remove('hidden')}
function closeDrawer(){document.getElementById('drawer').classList.add('hidden')}function js(s){return String(s).replace(/[\\']/g,'\\$&')}async function act(action,id){if(!confirm((lang==='zh'?'确认执行：':'Confirm action: ')+action+'?'))return;const r=await fetch('/memhub/admin/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,id})});if(!r.ok){alert(await r.text());return}delete viewCache[current];delete viewCache.overview;closeDrawer();load(current)}
async function configureAuto(){const c=payload.config||{},enabled=confirm(lang==='zh'?'确定=开启自动形成蒸馏待办；取消=关闭。不会由 Memhub 后端调用模型。':'OK enables automatic distillation job creation; Cancel disables it. Memhub itself will not call a model.');const t=Number(prompt('Turn threshold',String(c.turn_threshold||8))),idle=Number(prompt('Idle minutes',String(c.idle_minutes||30)));const r=await fetch('/memhub/admin/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'set-distillation-config',auto_enabled:enabled,turn_threshold:t,idle_minutes:idle})});if(!r.ok){alert(await r.text());return}delete viewCache.distillation;load('distillation')}
async function accountRole(id,role){if(!confirm((lang==='zh'?'确认账号权限改为 ':'Change account role to ')+role+'?'))return;const r=await fetch('/memhub/admin/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'set-account-role',id,role})});if(!r.ok){alert(await r.text());return}location.reload()}
async function fetchView(view,signal){if(viewCache[view])return viewCache[view];const r=await fetch('/memhub/admin/api?kind='+encodeURIComponent(view),{signal});if(!r.ok)throw Error(await r.text());const data=await r.json();viewCache[view]=data;return data}
async function load(view){const seq=++requestSeq;current=view;if(activeRequest)activeRequest.abort();activeRequest=null;document.querySelectorAll('aside button').forEach(b=>b.classList.toggle('active',b.dataset.view===view));if(view==='accounts'){document.getElementById('account-panel').classList.remove('hidden');document.getElementById('data-panel').classList.add('hidden');return}document.getElementById('account-panel').classList.add('hidden');document.getElementById('data-panel').classList.remove('hidden');document.getElementById('view-title').textContent=titles[view][lang==='zh'?0:1];if(view==='overview'){adminToolbar.style.display='none';document.getElementById('view-desc').textContent=lang==='zh'?'首屏不请求 Memory Core；选择一个数据域后再按需加载，并在本页缓存结果。':'The first screen does not query Memory Core. Choose a data domain to load it on demand; results are cached in this page.';renderOverview();return}adminToolbar.style.display='flex';document.getElementById('items').className='items';document.getElementById('view-desc').textContent=view==='projects'?(lang==='zh'?'项目注册表：canonical slug、aliases 与 description。':'Project registry: canonical slug, aliases and description.'):(view==='captures'||view==='distillation')?(lang==='zh'?'Memhub Capture / Evidence 层数据':'Memhub capture / evidence-layer data'):(lang==='zh'?'按需读取账号隔离数据；读取可取消，已加载视图会缓存。':'Load account-scoped data on demand; requests are cancellable and loaded views are cached.');if(viewCache[view]){render(viewCache[view]);return}document.getElementById('cards').innerHTML='';document.getElementById('items').innerHTML='<div class="empty">'+(lang==='zh'?'正在读取当前数据域；可以随时切换其它页面…':'Loading this data domain; you can switch views immediately…')+'</div>';const controller=new AbortController();activeRequest=controller;const timer=setTimeout(()=>controller.abort('timeout'),6500);try{const data=await fetchView(view,controller.signal);if(seq===requestSeq)render(data)}catch(e){if(seq!==requestSeq||controller.signal.aborted&&controller.signal.reason!=='timeout')return;if(seq===requestSeq)document.getElementById('items').innerHTML='<div class="empty">'+(controller.signal.reason==='timeout'?(lang==='zh'?'当前数据域读取超时。其它页面仍可正常使用，可重试或切换。':'This data domain timed out. Other views remain usable; retry or switch views.'):esc(String(e)))+'</div>'}finally{clearTimeout(timer);if(activeRequest===controller)activeRequest=null}}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
document.querySelectorAll('aside button').forEach(b=>b.onclick=()=>load(b.dataset.view));document.getElementById('filter').oninput=filter;document.getElementById('lang').onclick=()=>{lang=lang==='zh'?'en':'zh';localStorage.memhubLang=lang;tr();load(current)};document.getElementById('theme-toggle').onclick=()=>{theme=theme==='dark'?'light':'dark';localStorage.memhubTheme=theme;tr()};tr();load('overview');
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
  const projectStorageIds = input.scope === "project" && input.projectId
    ? await input.runtime.projects.storageIds(input.runtime.accountId, input.projectId)
    : [];
  const core = input.scope === "project"
    ? projectStorageIds.flatMap((projectId) => listCoreMemoryEvidence({
        dbPath,
        userId: input.runtime.userId,
        projectId,
        excludeCaptureDerived: true
      }).map((item) => ({ ...item, ...(input.projectId ? { project_id: input.projectId } : {}) })))
    : listCoreMemoryEvidence({ dbPath, userId: input.runtime.userId });
  const filteredCore = core.filter((item) => input.target === "skill" || item.layer !== "Skill");
  if (input.scope === "account") return filteredCore;

  const captures = await listCaptureEvents(input.stateRoot, input.runtime.accountId);
  const projectByConversation = new Map<string, string | null>();
  const turns: HistoryEvidence[] = [];
  for (const capture of captures) {
    if (!capture.ingested || !capture.user_text?.trim() || !capture.assistant_text?.trim()) continue;
    let resolvedProject = capture.project_hint
      ? await input.runtime.projects.resolve(input.runtime.accountId, capture.project_hint) ?? capture.project_hint
      : projectByConversation.get(capture.conversation_id);
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
  return [...turns, ...filteredCore];
}

async function knownProjectIds(runtime: MemhubRuntime): Promise<string[]> {
  return (await knownProjectRecords(runtime)).map((project) => project.projectId);
}

async function knownProjectRecords(runtime: MemhubRuntime): Promise<ProjectDescriptor[]> {
  const discovered = await rawDiscoveredProjectIds(runtime);
  return runtime.projects.reconcile(runtime.accountId, discovered);
}

async function rawDiscoveredProjectIds(runtime: MemhubRuntime): Promise<string[]> {
  const discovered = await runtime.architecture.listProjects(runtime.accountId).catch(() => []);
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

function projectForModel(project: ProjectDescriptor): Record<string, unknown> {
  return {
    project: project.projectId,
    name: project.name,
    description: project.description,
    aliases: project.aliases,
    state: project.state,
    ...(project.mergedInto ? { mergedInto: project.mergedInto } : {}),
    descriptionMissing: !project.description,
    updatedAt: project.updatedAt
  };
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
  input: { scope: string; project?: string; conversationId?: string }
): Promise<{ projectId: string | null; conversationId?: string }> {
  if (input.scope !== "global" && input.scope !== "project") {
    throw new TypeError("scope must be global or project");
  }
  let projectId = input.project ?? null;
  if (input.scope === "project") await knownProjectRecords(runtime);
  if (input.scope === "project" && projectId !== null) {
    const requestedProject = projectId;
    projectId = await runtime.projects.resolve(runtime.accountId, requestedProject);
    if (projectId === null) {
      const candidates = await runtime.projects.suggest(runtime.accountId, requestedProject, 5);
      throw new Error(`unknown project "${requestedProject}". Use memmy_project_list before project-scoped operations. Similar: ${candidates.map((item) => item.projectId).join(", ") || "none"}`);
    }
  }
  if (input.scope === "project" && projectId === null && input.conversationId) {
    projectId = await runtime.router.currentProject(runtime.accountId, input.conversationId);
  }
  if (input.scope === "project" && projectId === null) {
    throw new Error("project scope requires an explicit or conversation-bound project");
  }
  if (input.scope === "global") projectId = null;
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
