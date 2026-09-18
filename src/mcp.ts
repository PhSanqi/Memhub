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
  importNormifyAccounts,
  listAccounts,
  resolveCloudflareAccount,
  setAccountRole
} from "./auth.js";
import { importNormifyCloudflarePin, verifyCloudflareAccessJwt } from "./cloudflare.js";
import {
  authenticateDevice,
  createDevice,
  isCaptureIngested,
  listDevices,
  markCaptureIngested,
  normalizeCaptureEvent,
  revokeDevice,
  storeCaptureEvent
} from "./capture.js";
import { ingestCaptureIntoMemory } from "./capture-ingest.js";
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
  return createMemhubMcpServerForRuntime(runtime);
}

export function createMemhubMcpServerForRuntime(runtime: MemhubRuntime): McpServer {
  const server = new McpServer({
    name: "memhub",
    version: VERSION,
    description: "Private account/project-scoped long-term context and project architecture"
  });

  server.registerTool("memmy_context", {
    description: "读取与当前请求相关的长期上下文。自动隔离账号与项目；项目不明确时只返回全局记忆，不会混入其它项目。",
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
    description: "写入一条长期记忆。默认写全局；project scope 必须能明确解析出唯一项目，不能凭模型猜测。",
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

  server.registerTool("memhub_distill", {
    description: "由当前 MCP/Harness 的 AI 完成内容蒸馏，Memhub 只提供并强制蒸馏契约、scope、证据引用、provenance 与写入校验。传 inspect_contract=true 可只读取规则而不写入。",
    inputSchema: fromJsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
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
        ,inspect_contract: { type: "boolean", description: "只返回 Memhub 蒸馏规则，不写入任何内容" }
        ,dry_run: { type: "boolean", description: "按当前契约校验候选与 scope，但不写入 Memory Core" }
      },
      required: [],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    if (args.inspect_contract === true) return jsonResult({ contract: distillationContract() });
    const kind = requiredString(args.kind, "kind");
    if (kind !== "skill" && kind !== "summary" && kind !== "knowledge") {
      throw new TypeError("kind must be skill, summary, or knowledge");
    }
    const scope = requiredString(args.scope, "scope");
    const title = optionalString(args.title);
    if (kind === "skill" && !title) throw new TypeError("title is required for skill distillation");
    const { projectId, conversationId } = await resolveToolScope(runtime, {
      scope,
      project: optionalString(args.project),
      conversationId: optionalString(args.conversation_id)
    });
    const sourceHarness = optionalString(args.source_harness) ?? "mcp-harness";
    const evidenceRefs = stringArray(args.evidence_refs);
    const sourceConversations = stringArray(args.source_conversations);
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
    const result = await runtime.memory.distill({
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
      version: optionalString(args.version)
      ,
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
    return jsonResult({
      ok: true,
      kind,
      scope,
      project: projectId,
      sourceHarness,
      nativeEvolution: false,
      contract: DISTILLATION_CONTRACT_VERSION,
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
      return jsonResult({ projects: await runtime.router.listProjects(runtime.accountId) });
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
        "",
        "Default transport: stdio.",
        "HTTP binds only to 127.0.0.1. --public-host enables Cloudflare Access JWT identity.",
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
      createMcpHandler(() => createMemhubMcpServerForRuntime(runtimeFor(accountId, source))),
      { onerror: (error) => console.error("[memhub] MCP HTTP error:", error.message) }
    );
    handlers.set(handlerKey, handler);
    return handler;
  };

  const http = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!validateHost(request, response) || !validateOrigin(request, response)) return;
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

      if (url.pathname === "/" || url.pathname === "/memhub" || url.pathname.startsWith("/memhub/admin")) {
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
        const account = await resolveCloudflareAccount(options.stateRoot, identity, { allowJit: options.allowJit });
        const summary = (await listAccounts(options.stateRoot)).find((item) => item.account_id === account.account_id)!;
        const isAdmin = summary.role === "admin";
        if (url.pathname.startsWith("/memhub/admin") && !isAdmin) {
          response.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("Administrator access required");
          return;
        }
        const runtime = runtimeFor(account.account_id);
        if (url.pathname === "/memhub/admin/api" && request.method === "GET") {
          const kind = url.searchParams.get("kind") ?? "overview";
          const allowed = new Map([
            ["overview", "/api/v1/overview"], ["memories", "/api/v1/memories?limit=100"],
            ["episodes", "/api/v1/episodes"], ["skills", "/api/v1/skills?limit=100"],
            ["world-models", "/api/v1/world-models?limit=100"], ["knowledge", "/api/v1/knowledge?limit=100"],
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
          if (!action || !id) { response.writeHead(400).end(); return; }
          if (action === "delete-memory") await runtime.memoryClient.viewerDelete(`/api/v1/memory/${encodeURIComponent(id)}`);
          else if (action === "archive-memory") await runtime.memoryClient.viewerPost(`/api/v1/memory/${encodeURIComponent(id)}/archive`);
          else if (action === "archive-skill") await runtime.memoryClient.viewerPost("/api/v1/skills/archive", { skillId: id });
          else if (action === "archive-world-model") await runtime.memoryClient.viewerPost(`/api/v1/world-models/${encodeURIComponent(id)}/archive`);
          else { response.writeHead(400).end(); return; }
          response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
          return;
        }
        const projects = await runtime.router.listProjects(account.account_id).catch(() => []);
        const devices = await listDevices(options.stateRoot, account.account_id);
        const accounts = isAdmin && url.pathname.startsWith("/memhub/admin") ? await listAccounts(options.stateRoot) : [];
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        response.end(renderConsole({ account: summary, projects, devices, accounts, adminView: url.pathname.startsWith("/memhub/admin") }));
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

function renderConsole(input: {
  account: Awaited<ReturnType<typeof listAccounts>>[number];
  projects: string[];
  devices: Awaited<ReturnType<typeof listDevices>>;
  accounts: Awaited<ReturnType<typeof listAccounts>>;
  adminView: boolean;
}): string {
  const e = escapeHtml;
  const nav = input.account.role === "admin"
    ? `<a href="/memhub">Workspace</a><a href="/memhub/admin">Admin</a>`
    : `<a href="/memhub">Workspace</a>`;
  const content = input.adminView
    ? `<div class="admin-shell"><aside><div class="brand">Memhub <em>Control</em></div><button data-view="overview">◫ <span data-i18n="overview">总览</span></button><button data-view="memories">◇ <span data-i18n="memories">记忆</span></button><button data-view="episodes">◷ <span data-i18n="episodes">对话与 Episode</span></button><button data-view="traces">⌁ <span data-i18n="traces">原始轨迹</span></button><button data-view="skills">✦ <span data-i18n="skills">技能</span></button><button data-view="world-models">◎ <span data-i18n="world">世界模型</span></button><button data-view="knowledge">▤ <span data-i18n="knowledge">域经验</span></button><button data-view="accounts">♙ <span data-i18n="accounts">账号</span></button><div class="aside-foot">Cloudflare Access<br><small>Identity boundary</small></div></aside><div class="console"><div class="hero"><div><small data-i18n="control">MEMORY CONTROL PLANE</small><h1 data-i18n="title">长期记忆管理</h1><p data-i18n="subtitle">查看、追踪并管理从对话到技能与世界模型的各级沉淀。</p></div><div class="hero-actions"><button id="lang">EN</button><a class="logout" href="/cdn-cgi/access/logout" data-i18n="logout">退出</a></div></div><div id="account-panel" class="panel hidden"><h2 data-i18n="accounts">账号</h2><div class="grid">${input.accounts.map((a) => `<article><b>${e(a.cloudflare_email ?? a.username)}</b><span class="pill">${e(a.role)}</span><small>${e(a.account_id)}</small></article>`).join("")}</div></div><div id="data-panel" class="panel"><div class="panel-head"><div><h2 id="view-title">总览</h2><p id="view-desc" class="muted">正在读取 Memory Core…</p></div><input id="filter" placeholder="搜索 / Search"></div><div id="cards" class="stats"></div><div id="items" class="items"><div class="empty">Loading…</div></div></div></div></div><div id="drawer" class="drawer hidden"><button class="drawer-close" onclick="closeDrawer()">×</button><div id="drawer-body"></div></div><script>${consoleScript()}</script>`
    : `<section><h2>我的 Memhub</h2><div class="stats"><article><b>${input.projects.length}</b><span>项目</span></article><article><b>${input.devices.length}</b><span>设备</span></article><article><b>${e(input.account.role)}</b><span>权限</span></article></div></section><section><h2>项目</h2><div class="grid">${input.projects.map((p) => `<article><b>${e(p)}</b><span>项目记忆空间</span></article>`).join("") || "<p class=\"muted\">暂无项目</p>"}</div></section><section><h2>连接设备</h2><div class="grid">${input.devices.map((d) => `<article><b>${e(d.name)}</b><span>${d.revoked_at ? "已撤销" : "已连接"}</span><small>${e(d.device_id)}</small></article>`).join("") || "<p class=\"muted\">暂无设备</p>"}</div></section><section><h2>记忆与沉淀</h2><p class="muted">Memory / Skill / Domain Experience 的浏览、保留、归档和删除控制面将在 Memory Core 管理 API 接通后显示在这里；账号隔离继续使用稳定 account_id。</p></section>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Memhub Control Plane</title><style>${consoleCss()}</style></head><body><header><b>Memhub</b><nav>${nav}<span>${e(input.account.cloudflare_email ?? input.account.username)}</span>${input.adminView ? "" : '<a class="logout" href="/cdn-cgi/access/logout">退出</a>'}</nav></header><main class="${input.adminView ? "admin-main" : ""}">${content}</main></body></html>`;
}

function consoleCss(): string { return `
*{box-sizing:border-box}body{margin:0;font:14px Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;background:#f7fbff;color:#17324d}header{height:54px;display:flex;justify-content:space-between;align-items:center;padding:0 28px;background:rgba(255,255,255,.92);border-bottom:1px solid #dbeaf5}nav{display:flex;gap:18px;align-items:center}a{color:#2877a8;text-decoration:none}.logout,#lang{border:1px solid #c9dfec;background:white;border-radius:10px;padding:8px 13px;color:#35657e}.admin-main{max-width:none;margin:0;padding:0}.admin-shell{display:grid;grid-template-columns:220px 1fr;min-height:calc(100vh - 54px)}aside{padding:24px 14px;background:#eef8fc;border-right:1px solid #d6eaf3}.brand{font-size:19px;font-weight:750;padding:0 12px 24px}.brand em{font-style:normal;color:#4aa6c6}aside button{width:100%;text-align:left;border:0;background:transparent;padding:11px 12px;margin:3px 0;border-radius:10px;color:#42667a;font-weight:600}aside button:hover,aside button.active{background:#dff2f8;color:#147b9f}.aside-foot{position:sticky;top:calc(100vh - 130px);padding:18px 12px;color:#7595a5}.console{padding:30px 4vw 60px;max-width:1500px}.hero{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;padding:12px 2px 25px}.hero small{letter-spacing:.16em;color:#4a9ab8;font-weight:800}.hero h1{font-size:32px;margin:8px 0;color:#153d57}.hero p{margin:0;color:#6c8a9a}.hero-actions{display:flex;gap:9px}.panel{background:white;border:1px solid #dcebf2;box-shadow:0 8px 30px rgba(35,111,143,.06);border-radius:18px;padding:22px;margin-bottom:18px}.panel-head{display:flex;justify-content:space-between;gap:20px;align-items:center}.panel-head input{width:min(320px,40vw);border:1px solid #d3e5ee;border-radius:11px;padding:10px 13px;outline:none}.stats,.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:18px 0}.stats article,.grid article{padding:16px;border:1px solid #deedf3;background:#fbfeff;border-radius:13px;display:flex;flex-direction:column;gap:6px}.stats b{font-size:25px;color:#197b9e}.pill{align-self:flex-start;background:#e1f5f6;color:#237f88;border-radius:999px;padding:3px 8px}.items{display:flex;flex-direction:column;gap:9px}.row{cursor:pointer;border:1px solid #e2edf2;border-radius:12px;padding:14px 16px;background:#fff;display:grid;grid-template-columns:minmax(140px,1fr) minmax(220px,3fr) auto;gap:14px;align-items:start}.row:hover{border-color:#a9d7e7;background:#fbfeff}.row h3{font-size:14px;margin:0 0 5px;color:#24526c}.row p{margin:0;color:#587688;white-space:pre-wrap;overflow-wrap:anywhere;max-height:100px;overflow:hidden}.row small{color:#91a7b3}.empty{padding:48px;text-align:center;color:#8ca3af}.hidden{display:none!important}.muted{color:#7793a2}article small{overflow-wrap:anywhere}.drawer{position:fixed;z-index:20;right:0;top:54px;width:min(600px,94vw);height:calc(100vh - 54px);overflow:auto;background:#fff;border-left:1px solid #d6e8f0;box-shadow:-18px 0 50px rgba(24,86,112,.12);padding:30px}.drawer-close{float:right;border:0;background:#eef7fa;border-radius:50%;width:34px;height:34px;font-size:22px}.drawer pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f7fbfd;border:1px solid #e1edf2;border-radius:12px;padding:14px;font-size:12px}.actions{display:flex;gap:8px;margin:20px 0}.danger,.soft{border:1px solid #d8e7ed;background:#f7fbfc;border-radius:9px;padding:8px 12px}.danger{color:#a43b43;border-color:#efcdd0;background:#fff9f9}@media(max-width:760px){.admin-shell{grid-template-columns:1fr}aside{display:flex;overflow:auto;padding:8px;position:sticky;top:54px;z-index:2}aside .brand,.aside-foot{display:none}aside button{min-width:max-content}.console{padding:18px}.hero{flex-direction:column}.row{grid-template-columns:1fr}.panel-head{align-items:flex-start;flex-direction:column}.panel-head input{width:100%}}
`; }

function consoleScript(): string { return `
const dict={zh:{overview:'总览',memories:'记忆',episodes:'对话与 Episode',traces:'原始轨迹',skills:'技能',world:'世界模型',knowledge:'域经验',accounts:'账号',control:'MEMORY CONTROL PLANE',title:'长期记忆管理',subtitle:'查看、追踪并管理从对话到技能与世界模型的各级沉淀。',logout:'退出'},en:{overview:'Overview',memories:'Memories',episodes:'Conversations & Episodes',traces:'Raw Traces',skills:'Skills',world:'World Models',knowledge:'Domain Experience',accounts:'Accounts',control:'MEMORY CONTROL PLANE',title:'Long-term Memory',subtitle:'Inspect and manage distilled knowledge from conversations through skills and world models.',logout:'Sign out'}};
let lang=localStorage.memhubLang||'zh', current='overview', payload=null;
const titles={overview:['总览','Overview'],memories:['记忆','Memories'],episodes:['对话与 Episode','Conversations & Episodes'],traces:['原始轨迹','Raw Traces'],skills:['技能','Skills'],'world-models':['世界模型','World Models'],knowledge:['域经验','Domain Experience']};
function tr(){document.documentElement.lang=lang==='zh'?'zh-CN':'en';document.querySelectorAll('[data-i18n]').forEach(x=>x.textContent=dict[lang][x.dataset.i18n]||x.textContent);document.getElementById('lang').textContent=lang==='zh'?'EN':'中文';}
function values(o){if(!o||typeof o!=='object')return[];for(const k of ['items','tasks','memories','episodes','skills','records'])if(Array.isArray(o[k]))return o[k];return[]}
function textOf(x){return x.snippet||x.content||x.summary||x.description||x.title||x.text||JSON.stringify(x)}
function render(data){payload=data;const items=values(data);const cards=document.getElementById('cards');const total=data?.total??items.length;cards.innerHTML='<article><b>'+total+'</b><span>'+(lang==='zh'?'当前条目':'Current items')+'</span></article><article><b>'+items.filter(x=>x.status==='activated').length+'</b><span>Activated</span></article><article><b>'+items.filter(x=>x.status==='archived').length+'</b><span>Archived</span></article>';filter();}
function filter(){const q=document.getElementById('filter').value.toLowerCase();const items=values(payload).filter(x=>JSON.stringify(x).toLowerCase().includes(q));window.visibleItems=items;document.getElementById('items').innerHTML=items.length?items.map((x,i)=>'<div class="row" onclick="openItem('+i+')"><div><h3>'+esc(x.title||x.kind||x.type||x.id||'Item')+'</h3><small>'+esc(x.status||x.sourceAgent||x.source||'')+'</small></div><p>'+esc(textOf(x))+'</p><small>'+esc(x.updatedAt||x.createdAt||x.id||'')+'</small></div>').join(''):'<div class="empty">'+(lang==='zh'?'暂无内容':'No items')+'</div>'}
function openItem(i){const x=window.visibleItems[i],id=x.id||x.memoryId||x.skillId;let actions='';if(id&&current==='memories')actions='<div class="actions"><button class="soft" onclick="event.stopPropagation();act(\'archive-memory\',\''+js(id)+'\')">Archive</button><button class="danger" onclick="event.stopPropagation();act(\'delete-memory\',\''+js(id)+'\')">Delete</button></div>';if(id&&current==='skills')actions='<div class="actions"><button class="soft" onclick="act(\'archive-skill\',\''+js(id)+'\')">Archive</button></div>';if(id&&current==='world-models')actions='<div class="actions"><button class="soft" onclick="act(\'archive-world-model\',\''+js(id)+'\')">Archive</button></div>';document.getElementById('drawer-body').innerHTML='<small>'+esc(current)+'</small><h2>'+esc(x.title||x.kind||x.id||'Detail')+'</h2><p>'+esc(textOf(x))+'</p>'+actions+'<h3>Metadata / Provenance</h3><pre>'+esc(JSON.stringify(x,null,2))+'</pre>';document.getElementById('drawer').classList.remove('hidden')}
function closeDrawer(){document.getElementById('drawer').classList.add('hidden')}function js(s){return String(s).replace(/[\\']/g,'\\$&')}async function act(action,id){if(!confirm((lang==='zh'?'确认执行：':'Confirm action: ')+action+'?'))return;const r=await fetch('/memhub/admin/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,id})});if(!r.ok){alert(await r.text());return}closeDrawer();load(current)}
async function load(view){current=view;document.querySelectorAll('aside button').forEach(b=>b.classList.toggle('active',b.dataset.view===view));if(view==='accounts'){document.getElementById('account-panel').classList.remove('hidden');document.getElementById('data-panel').classList.add('hidden');return}document.getElementById('account-panel').classList.add('hidden');document.getElementById('data-panel').classList.remove('hidden');document.getElementById('view-title').textContent=titles[view][lang==='zh'?0:1];document.getElementById('view-desc').textContent=lang==='zh'?'来自本机 Memory Core 的账号隔离数据':'Account-scoped data from the local Memory Core';document.getElementById('items').innerHTML='<div class="empty">Loading…</div>';try{const r=await fetch('/memhub/admin/api?kind='+encodeURIComponent(view));if(!r.ok)throw Error(await r.text());render(await r.json())}catch(e){document.getElementById('items').innerHTML='<div class="empty">'+esc(String(e))+'</div>'}}
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
