import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
  toNodeHandler
} from "@modelcontextprotocol/node";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";
import {
  ensureLocalAdminToken,
  listAccounts,
  resolveCloudflareAccount,
  verifyLocalAdminToken
} from "./auth.js";
import { resolveCloudflareAccessIssuer, verifyCloudflareAccessJwt } from "./cloudflare.js";
import type { DistillationJob } from "./distillation-jobs.js";
import { asHttpJsonBodyError } from "./http-json.js";
import { LocalMemoryRestClient } from "./local-memory-client.js";
import { handleMemoryControlAction } from "./memory-control-actions.js";
import { handleMemoryControlRead } from "./memory-control-http.js";
import type { ProjectDescriptor } from "./project-registry.js";
import { createMemhubRuntime, resolveLocalAccountId, type MemhubRuntime, type MemhubRuntimeOptions } from "./runtime.js";
import {
  buildIdentitiesMatch,
  readLocalBuildIdentity,
  type ServiceHealthProbe
} from "./service-readiness.js";
import { renderConsole, renderDocs, renderLanding, renderUnprovisionedAccount } from "./web-ui.js";

export function normalizeBasePath(value: string): string {
  const path = value.trim() || "/";
  if (!path.startsWith("/") || path.startsWith("//") || /[?#[\]\\\s<>"']/.test(path) ||
      path.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("base path must start with / and contain no query/fragment");
  }
  return path === "/" ? "/" : path.replace(/\/+$/, "");
}

export function webPath(basePath: string, suffix = ""): string {
  const base = normalizeBasePath(basePath);
  return `${base === "/" ? "" : base}${suffix}` || "/";
}

export function webRoutePath(pathname: string, basePath: string, mcpPath: string): string {
  if (pathname.replace(/\/$/, "") === mcpPath) return mcpPath;
  const base = normalizeBasePath(basePath);
  if (base === "/") return pathname === "/" ? "/memhub" : `/memhub${pathname}`;
  // A bookmarked `<base>/` is the console root, not an unknown `/memhub/` route.
  if (pathname === base || pathname === `${base}/`) return "/memhub";
  if (pathname.startsWith(`${base}/`)) return `/memhub${pathname.slice(base.length)}`;
  return pathname === "/" ? "/" : "";
}

export function webSecurityHeaders(html?: string): Record<string, string> {
  const hashes = [...(html ?? "").matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => `'sha256-${createHash("sha256").update(match[1]!).digest("base64")}'`);
  const scripts = `script-src 'self' ${hashes.join(" ")}; script-src-attr 'unsafe-inline'; `;
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy": `${scripts}frame-ancestors 'none'; base-uri 'none'; object-src 'none'`
  };
}

export function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function basicPassword(value: string | undefined): string | undefined {
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

export function isLocalControlRequest(request: IncomingMessage): boolean {
  const remote = request.socket.remoteAddress ?? "";
  const loopbackPeer = remote === "127.0.0.1" || remote === "::1" || remote.startsWith("::ffff:127.");
  if (!loopbackPeer) return false;
  const host = (singleHeader(request.headers.host) ?? "").toLowerCase();
  const hostName = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":", 1)[0];
  if (hostName !== "localhost" && hostName !== "127.0.0.1" && hostName !== "::1") return false;
  if (singleHeader(request.headers["cf-access-jwt-assertion"]) ||
      singleHeader(request.headers["cf-ray"]) ||
      singleHeader(request.headers["cf-connecting-ip"])) return false;
  return true;
}

export interface ServeHttpDependencies {
  createServerForRuntime: (runtime: MemhubRuntime, stateRoot: string) => McpServer;
  queueIdleDistillation: (
    stateRoot: string,
    runtimeForAccount: (accountId: string) => MemhubRuntime
  ) => Promise<void>;
  unfinishedDistillationJobsForProject: (
    stateRoot: string,
    runtime: MemhubRuntime,
    projectId: string
  ) => Promise<DistillationJob[]>;
  assertManagedMemory: (runtime: MemhubRuntime, memoryId: string) => Promise<void>;
  knownProjectRecords: (runtime: MemhubRuntime) => Promise<ProjectDescriptor[]>;
}

const WEB_ASSETS = {
  "logo-mark.png": readFileSync(fileURLToPath(new URL("../web-assets/logo-mark.png", import.meta.url))),
  "logo-lockup.png": readFileSync(fileURLToPath(new URL("../web-assets/logo-lockup.png", import.meta.url)))
} as const;

export async function serveHttp(
  runtimeOptions: MemhubRuntimeOptions,
  options: { stateRoot: string; port: number; path: string; basePath: string; publicHost?: string; allowJit: boolean },
  deps: ServeHttpDependencies
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
  // Read once at start: the gateway's own build identity, plus a client used
  // only to summarize Core health on /health.
  const gatewayBuild = readLocalBuildIdentity();
  const coreHealthClient = createCoreHealthClient(runtimeOptions);

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
      createMcpHandler(() => deps.createServerForRuntime(runtimeFor(accountId, source), options.stateRoot)),
      { onerror: (error) => console.error("[memhub] MCP HTTP error:", error.message) }
    );
    handlers.set(handlerKey, handler);
    return handler;
  };

  const http = createServer((request, response) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    response.setHeader("x-memhub-request-id", requestId);
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("cache-control", "no-store");
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
      if (options.publicHost && isOAuthProtectedResourceMetadataPath(url.pathname, options.path)) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" }).end();
          return;
        }
        const authorizationServer = await resolveCloudflareAccessIssuer(options.stateRoot, options.publicHost);
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          ...webSecurityHeaders()
        });
        response.end(request.method === "HEAD" ? undefined : JSON.stringify({
          resource: `https://${options.publicHost}${options.path}`,
          authorization_servers: [authorizationServer]
        }));
        return;
      }
      if (url.pathname === healthPath) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { allow: "GET, HEAD" }).end();
          return;
        }
        const coreHealth = await readCoreHealthBrief(coreHealthClient);
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
          ...webSecurityHeaders()
        });
        response.end(request.method === "HEAD" ? undefined : JSON.stringify({
          ok: true,
          service: "memhub",
          uptime_seconds: Math.floor(process.uptime()),
          build: { ...gatewayBuild },
          coreBuildMatches: buildIdentitiesMatch(gatewayBuild, coreHealth.build),
          degraded: coreHealth.degraded
        }));
        return;
      }
      url.pathname = webRoutePath(url.pathname, options.basePath, options.path) || "/__not_found__";
      if (url.pathname === "/") {
        response.writeHead(302, { location: webPath(options.basePath), "cache-control": "no-store" }).end();
        return;
      }
      if (url.pathname === "/memhub") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { allow: "GET, HEAD" }).end();
          return;
        }
        const html = renderLanding(options.basePath);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300",
          ...webSecurityHeaders(html)
        });
        response.end(request.method === "HEAD" ? undefined : html);
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
        const html = renderDocs(url.pathname, options.basePath);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300",
          ...webSecurityHeaders(html)
        });
        response.end(request.method === "HEAD" ? undefined : html);
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
          summary = localAdminAccount(
            accounts,
            runtimeOptions.accountId ?? process.env.MEMHUB_LOCAL_ADMIN_ACCOUNT ?? process.env.MEMHUB_OWNER_ACCOUNT_ID
          );
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
              const html = renderUnprovisionedAccount(identity.email, options.basePath);
              response.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...webSecurityHeaders(html) });
              response.end(html);
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
            callerAccountId: summary.account_id,
            adminView
          });
          return;
        }
        if (url.pathname === actionPath && request.method === "POST") {
          await handleMemoryControlAction({
            request, response, stateRoot: options.stateRoot, runtime, accounts, selectedAccount, adminView,
            callerAccountId: summary.account_id,
            unfinishedDistillationJobsForProject: deps.unfinishedDistillationJobsForProject,
            assertManagedMemory: deps.assertManagedMemory
          });
          return;
        }
        const projects = await deps.knownProjectRecords(runtime);
        const visibleAccounts = isAdmin && adminView ? accounts : [];
        const html = renderConsole({ account: summary, projects, accounts: visibleAccounts, adminView, localControl, selectedAccountId: selectedAccount.account_id, basePath: options.basePath });
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...webSecurityHeaders(html) });
        response.end(html);
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

      if (options.publicHost === undefined || isLocalControlRequest(request)) {
        handlerFor(resolveLocalAccountId(runtimeOptions))(request, response);
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
          platform: "remote-mcp",
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
      const errorId = requestId.slice(0, 8);
      console.error(`[memhub] HTTP request error ${errorId}:`, error);
      if (!response.headersSent) {
        response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({
          error: code,
          message: status === 500 ? "Internal server error" : error instanceof Error ? error.message : String(error),
          ...(status === 500 ? { error_id: errorId } : {})
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
  if (options.publicHost) {
    console.error(`[memhub] Cloudflare Access allowlist enabled for https://${options.publicHost}${options.path}`);
  }

  // The durable ingested marker is the reconciliation source after a
  // marker->enqueue crash. Scan once on startup instead of waiting for the
  // next 60-second tick, and prevent overlapping full-account scans.
  let inFlightDiscovery: Promise<void> | null = null;
  const reconcile = (): Promise<void> => {
    if (!inFlightDiscovery) {
      const current = deps.queueIdleDistillation(options.stateRoot, runtimeFor)
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
  http.once("close", () => {
    clearInterval(idleTimer);
    void (inFlightDiscovery ?? Promise.resolve()).then(() => {
      for (const runtime of runtimes.values()) runtime.dispose();
    });
  });
}

export function isOAuthProtectedResourceMetadataPath(pathname: string, resourcePath: string): boolean {
  const normalizedResourcePath = resourcePath === "/" ? "" : resourcePath.replace(/\/$/, "");
  return pathname === "/.well-known/oauth-protected-resource" ||
    pathname === `/.well-known/oauth-protected-resource${normalizedResourcePath}`;
}

export function localAdminAccount(
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

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function createCoreHealthClient(runtimeOptions: MemhubRuntimeOptions): LocalMemoryRestClient | undefined {
  try {
    return new LocalMemoryRestClient({
      endpoint: runtimeOptions.memoryEndpoint ?? process.env.MEMHUB_MEMORY_URL ?? "http://127.0.0.1:18960",
      token: runtimeOptions.memoryToken ?? process.env.MEMHUB_MEMORY_TOKEN
    });
  } catch {
    return undefined;
  }
}

/**
 * Summarizes Core health for the gateway document. Unreachable or malformed
 * Core responses are reported as degraded, never as a gateway failure.
 */
async function readCoreHealthBrief(
  client: LocalMemoryRestClient | undefined
): Promise<Pick<ServiceHealthProbe, "degraded" | "build">> {
  if (!client) return { degraded: ["core_unreachable"] };
  try {
    const payload = await client.health(1_500);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { degraded: ["core_invalid_health"] };
    }
    const object = payload as Record<string, unknown>;
    const degraded = Array.isArray(object.degraded)
      ? object.degraded.filter((item): item is string => typeof item === "string")
      : [];
    const buildValue = object.build;
    const candidate = buildValue && typeof buildValue === "object" && !Array.isArray(buildValue)
      ? buildValue as Record<string, unknown>
      : undefined;
    const build = candidate && typeof candidate.vendorSha256 === "string" &&
      typeof candidate.memhubVersion === "string"
      ? { vendorSha256: candidate.vendorSha256, memhubVersion: candidate.memhubVersion }
      : undefined;
    return { degraded, ...(build ? { build } : {}) };
  } catch {
    return { degraded: ["core_unreachable"] };
  }
}
