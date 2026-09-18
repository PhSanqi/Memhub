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
  resolveCloudflareAccount
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
      tags: stringArray(args.tags)
    });
    return jsonResult({ ok: true, scope, project: projectId, memory: result });
  });

  server.registerTool("memhub_distill", {
    description: "提交由当前 Harness 提炼出的结构化沉淀。Skill 可写账号级或单项目级；summary/knowledge 作为 curated memory 保存，不会绕过原生 L2/L3 evolution。",
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
      },
      required: ["kind", "content", "scope"],
      additionalProperties: false
    } as JsonSchemaType)
  }, async (args) => {
    const kind = requiredString(args.kind, "kind");
    if (kind !== "skill" && kind !== "summary" && kind !== "knowledge") {
      throw new TypeError("kind must be skill, summary, or knowledge");
    }
    const scope = requiredString(args.scope, "scope");
    if (scope !== "global" && scope !== "project") {
      throw new TypeError("scope must be global or project");
    }
    const title = optionalString(args.title);
    if (kind === "skill" && !title) throw new TypeError("title is required for skill distillation");
    const conversationId = optionalString(args.conversation_id);
    let projectId = optionalString(args.project) ?? null;
    if (scope === "project" && projectId === null && conversationId) {
      projectId = await runtime.router.currentProject(runtime.accountId, conversationId);
    }
    if (scope === "project" && projectId === null) {
      throw new Error("project-scoped distillation requires an explicit or conversation-bound project");
    }
    if (scope === "global") projectId = null;
    if (projectId) {
      const projects = await runtime.router.listProjects(runtime.accountId);
      if (projects.length > 0 && !projects.includes(projectId)) {
        throw new Error(`unknown project for account: ${projectId}`);
      }
    }
    const sourceHarness = optionalString(args.source_harness) ?? "mcp-harness";
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
    });
    return jsonResult({
      ok: true,
      kind,
      scope,
      project: projectId,
      sourceHarness,
      nativeEvolution: false,
      memory: result
    });
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
    else if (arg === "--normify-command") options.normifyCommand = value();
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

  const runtimeFor = (accountId: string): MemhubRuntime => {
    let runtime = runtimes.get(accountId);
    if (!runtime) {
      runtime = createMemhubRuntime({ ...runtimeOptions, accountId });
      runtimes.set(accountId, runtime);
    }
    return runtime;
  };

  const handlerFor = (accountId: string) => {
    let handler = handlers.get(accountId);
    if (handler) return handler;
    handler = toNodeHandler(
      createMcpHandler(() => createMemhubMcpServerForRuntime(runtimeFor(accountId))),
      { onerror: (error) => console.error("[memhub] MCP HTTP error:", error.message) }
    );
    handlers.set(accountId, handler);
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
      if (url.pathname !== options.path) {
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
        handlerFor(device.account_id)(request, response);
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
      handlerFor(account.account_id)(request, response);
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

const invokedArg = process.argv[1];
const invokedPath = invokedArg && !invokedArg.startsWith("-") && existsSync(resolve(invokedArg))
  ? realpathSync(resolve(invokedArg))
  : "";
if (invokedPath !== "" && invokedPath === fileURLToPath(import.meta.url)) await main();
