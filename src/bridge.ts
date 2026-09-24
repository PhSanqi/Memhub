#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { mergeCaptureEvent, normalizeCaptureEvent, type MemhubCaptureEvent } from "./capture.js";
import { withFileMutationLock } from "./file-mutation-lock.js";
import { asHttpJsonBodyError, HttpJsonBodyError, readJsonBody } from "./http-json.js";

interface BridgeConfig {
  version: 1;
  mcp_endpoint?: string;
  capture_endpoint: string;
  device_token: string;
  cloudflare_access_client_id?: string;
  cloudflare_access_client_secret?: string;
}

export class MemhubBridgeQueue {
  constructor(private readonly stateRoot: string) {}

  async enqueue(raw: unknown): Promise<MemhubCaptureEvent> {
    const event = normalizeCaptureEvent(raw);
    const key = createHash("sha256").update(event.event_id, "utf8").digest("hex");
    const path = join(this.queueDir(), `${key}.json`);
    await mkdir(this.queueDir(), { recursive: true, mode: 0o700 });
    return withFileMutationLock(path, async () => {
      try {
        const existing = normalizeCaptureEvent(JSON.parse(await readFile(path, "utf8")) as unknown);
        if (existing.event_id !== event.event_id) throw new Error("bridge queue hash collision");
        const merged = mergeCaptureEvent(existing, event);
        if (!merged.updated) return existing;
        await writeQueueEvent(path, merged.event);
        return merged.event;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      }
      await writeQueueEvent(path, event);
      return event;
    });
  }

  async pending(): Promise<number> {
    try {
      return (await readdir(this.queueDir())).filter(isQueuedCaptureName).length;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
      throw error;
    }
  }

  async flush(config: BridgeConfig): Promise<{ sent: number; pending: number; stopped_on_error?: string }> {
    await this.recoverAbandonedClaims();
    let files: string[];
    try {
      files = (await readdir(this.queueDir())).filter((name) => /^[0-9a-f]{64}\.json$/.test(name)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { sent: 0, pending: 0 };
      throw error;
    }
    let sent = 0;
    for (const name of files) {
      const path = join(this.queueDir(), name);
      const key = name.slice(0, 64);
      const canonicalPath = join(this.queueDir(), `${key}.json`);
      const claim = join(this.queueDir(), `${key}.sending-${Date.now()}-${process.pid}-${randomUUID()}.json`);
      const claimed = await withFileMutationLock(canonicalPath, async () => {
        try {
          await rename(path, claim);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
          throw error;
        }
      });
      if (!claimed) continue;
      try {
        const event = normalizeCaptureEvent(JSON.parse(await readFile(claim, "utf8")) as unknown);
        await uploadCapture(config, event);
        await rm(claim, { force: true });
        sent += 1;
      } catch (error) {
        try {
          await this.restoreClaim(claim, canonicalPath, key);
        } catch (restoreError) {
          return {
            sent,
            pending: await this.pending(),
            stopped_on_error: `capture upload failed; claim recovery pending: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
          };
        }
        return {
          sent,
          pending: await this.pending(),
          stopped_on_error: error instanceof Error ? error.message : String(error)
        };
      }
    }
    const pending = await this.pending();
    return pending > 0 && (files.length === 0 || sent === 0)
      ? { sent, pending, stopped_on_error: "capture_upload_inflight" }
      : { sent, pending };
  }

  private async restoreClaim(claim: string, canonicalPath: string, key: string): Promise<void> {
    await withFileMutationLock(canonicalPath, async () => {
      let claimed: MemhubCaptureEvent;
      try { claimed = normalizeCaptureEvent(JSON.parse(await readFile(claim, "utf8")) as unknown); }
      catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
        throw error;
      }
      if (createHash("sha256").update(claimed.event_id, "utf8").digest("hex") !== key) {
        throw new Error("capture claim hash mismatch");
      }
      let merged = claimed;
      try {
        const newer = normalizeCaptureEvent(JSON.parse(await readFile(canonicalPath, "utf8")) as unknown);
        merged = mergeCaptureEvent(claimed, newer).event;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      }
      await writeQueueEvent(canonicalPath, merged);
      await rm(claim, { force: true });
    });
  }

  private async recoverAbandonedClaims(): Promise<void> {
    let names: string[];
    try { names = await readdir(this.queueDir()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      const matched = /^([0-9a-f]{64})\.sending-(?:(\d{13})-(\d+)-)?[0-9a-f-]+\.json$/.exec(name);
      if (!matched) continue;
      const claim = join(this.queueDir(), name);
      const startedAt = matched[2] ? Number(matched[2]) : (await stat(claim).catch(() => null))?.mtimeMs;
      if (startedAt === undefined) continue;
      // A live upload can use the whole configured 300-second timeout. Do not
      // steal its claim just because another caller starts flushing.
      const age = Date.now() - startedAt;
      const owner = matched[3] ? Number(matched[3]) : null;
      if (age < 360_000 && (owner === null || processIsAlive(owner))) continue;
      await this.restoreClaim(claim, join(this.queueDir(), `${matched[1]}.json`), matched[1]!);
    }
  }

  private queueDir(): string {
    return join(resolve(this.stateRoot), "queue");
  }
}

function isQueuedCaptureName(name: string): boolean {
  return /^[0-9a-f]{64}(?:\.sending-[0-9a-f-]+)?\.json$/.test(name);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code === "EPERM"; }
}

export async function saveBridgeConfig(stateRoot: string, input: {
  mcpEndpoint?: string;
  captureEndpoint: string;
  deviceToken: string;
  cloudflareAccessClientId?: string;
  cloudflareAccessClientSecret?: string;
}): Promise<void> {
  const endpoint = normalizeCaptureEndpoint(input.captureEndpoint);
  const token = input.deviceToken.trim();
  if (!token.startsWith("mhdev_") || token.length < 30) throw new TypeError("invalid Memhub device token");
  const config: BridgeConfig = {
    version: 1,
    ...(input.mcpEndpoint ? { mcp_endpoint: normalizeEndpoint(input.mcpEndpoint, "MCP") } : {}),
    capture_endpoint: endpoint,
    device_token: token,
    ...(input.cloudflareAccessClientId?.trim() ? { cloudflare_access_client_id: input.cloudflareAccessClientId.trim() } : {}),
    ...(input.cloudflareAccessClientSecret?.trim() ? { cloudflare_access_client_secret: input.cloudflareAccessClientSecret.trim() } : {})
  };
  const path = bridgeConfigPath(stateRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}

export async function loadBridgeConfig(stateRoot: string): Promise<BridgeConfig> {
  const raw = JSON.parse(await readFile(bridgeConfigPath(stateRoot), "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Memhub bridge config invalid");
  const record = raw as Record<string, unknown>;
  if (record.version !== 1 || typeof record.capture_endpoint !== "string" || typeof record.device_token !== "string") {
    throw new Error("Memhub bridge config invalid");
  }
  return {
    version: 1,
    ...(typeof record.mcp_endpoint === "string" ? { mcp_endpoint: normalizeEndpoint(record.mcp_endpoint, "MCP") } : {}),
    capture_endpoint: normalizeCaptureEndpoint(record.capture_endpoint),
    device_token: record.device_token,
    ...(typeof record.cloudflare_access_client_id === "string" ? { cloudflare_access_client_id: record.cloudflare_access_client_id } : {}),
    ...(typeof record.cloudflare_access_client_secret === "string" ? { cloudflare_access_client_secret: record.cloudflare_access_client_secret } : {})
  };
}

export async function serveBridge(options: { stateRoot: string; host?: string; port?: number }): Promise<void> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") throw new Error("Memhub Bridge only supports loopback bind");
  const port = options.port ?? 17861;
  const queue = new MemhubBridgeQueue(options.stateRoot);
  let flushPromise: Promise<{ sent: number; pending: number; stopped_on_error?: string }> | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let failureStreak = 0;
  let nextRetryAt = 0;
  let lastFlushError: string | null = null;
  const retryJitter = bridgeRetryJitter(options.stateRoot);
  const flushQueue = () => {
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      const config = await loadBridgeConfig(options.stateRoot);
      let sent = 0;
      for (;;) {
        const result = await queue.flush(config);
        sent += result.sent;
        if (result.pending === 0 || result.stopped_on_error) return { ...result, sent };
      }
    })().finally(() => { flushPromise = null; });
    return flushPromise;
  };
  const clearRetryTimer = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };
  const scheduleBackgroundFlush = (delayMs: number) => {
    const target = Date.now() + Math.max(0, delayMs);
    if (retryTimer && nextRetryAt <= target) return;
    clearRetryTimer();
    nextRetryAt = target;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      nextRetryAt = 0;
      void runBackgroundFlush();
    }, Math.max(0, target - Date.now()));
    retryTimer.unref();
  };
  const runBackgroundFlush = async () => {
    try {
      const result = await flushQueue();
      if (result.stopped_on_error) {
        failureStreak += 1;
        lastFlushError = result.stopped_on_error;
        scheduleBackgroundFlush(bridgeRetryDelayMs(failureStreak, retryJitter));
        return;
      }
      failureStreak = 0;
      lastFlushError = null;
      scheduleBackgroundFlush(5_000);
    } catch (error) {
      failureStreak += 1;
      lastFlushError = error instanceof Error ? error.message : String(error);
      scheduleBackgroundFlush(bridgeRetryDelayMs(failureStreak, retryJitter));
    }
  };
  const flushInBackground = () => {
    if (failureStreak > 0 && nextRetryAt > Date.now()) return;
    scheduleBackgroundFlush(0);
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/health") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { allow: "GET, HEAD" }).end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(request.method === "HEAD" ? undefined : JSON.stringify({ ok: true, service: "memhub-bridge" }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/status") {
        return json(response, 200, {
          ok: true,
          pending: await queue.pending(),
          retry: {
            failure_streak: failureStreak,
            next_retry_at: nextRetryAt > 0 ? new Date(nextRetryAt).toISOString() : null,
            last_error: lastFlushError
          }
        });
      }
      if (url.pathname === "/mcp") {
        const config = await loadBridgeConfig(options.stateRoot);
        if (!config.mcp_endpoint) return json(response, 503, { error: "mcp_endpoint_not_configured" });
        await proxyMcp(request, response, config);
        return;
      }
      if (request.method === "POST" && url.pathname === "/context") {
        const config = await loadBridgeConfig(options.stateRoot);
        await proxyContext(request, response, config);
        return;
      }
      if (request.method === "POST" && url.pathname === "/lifecycle") {
        const config = await loadBridgeConfig(options.stateRoot);
        const body = await readJsonBody(request);
        const event = body && typeof body === "object" && !Array.isArray(body)
          ? String((body as Record<string, unknown>).event ?? "").toLowerCase()
          : "";
        if (event === "postcompact" || event === "sessionend") {
          const flushed = await flushQueue();
          if (flushed.pending > 0) {
            return json(response, 503, { error: "capture_flush_pending", ...flushed });
          }
        }
        await proxyLifecycle(response, config, body);
        return;
      }
      if (request.method === "POST" && url.pathname === "/flush") {
        const result = await flushQueue();
        if (!result.stopped_on_error) {
          failureStreak = 0;
          lastFlushError = null;
          scheduleBackgroundFlush(5_000);
        }
        return json(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/capture") {
        const event = await queue.enqueue(await readJsonBody(request));
        const pending = await queue.pending();
        flushInBackground();
        return json(response, 202, { accepted: true, event_id: event.event_id, pending });
      }
      response.writeHead(404).end();
    })().catch((error) => {
      const bodyError = asHttpJsonBodyError(error);
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      const fetchFailure = error instanceof TypeError && /fetch failed/i.test(error.message);
      return json(response,
        bodyError?.statusCode ?? (timeout ? 504 : fetchFailure ? 502 : 400),
        {
          error: bodyError?.code ?? (timeout ? "upstream_timeout" : fetchFailure ? "upstream_unavailable" : "bad_request"),
          message: error instanceof Error ? error.message : String(error)
        }
      );
    });
  });
  server.keepAliveTimeout = 95_000;
  server.headersTimeout = 100_000;
  server.on("connection", (socket) => socket.setKeepAlive(true, 30_000));
  await new Promise<void>((ready, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => ready());
  });
  flushInBackground();
  console.error(`[memhub-bridge] listening on http://${host}:${port}`);
}

export function bridgeRetryDelayMs(failureStreak: number, jitter = 1): number {
  if (!Number.isFinite(failureStreak) || failureStreak <= 0) return 5_000;
  const exponent = Math.min(4, Math.max(0, Math.trunc(failureStreak) - 1));
  const base = Math.min(60_000, 5_000 * (2 ** exponent));
  const boundedJitter = Math.min(1.2, Math.max(0.8, Number.isFinite(jitter) ? jitter : 1));
  return Math.round(base * boundedJitter);
}

function bridgeRetryJitter(stateRoot: string): number {
  const digest = createHash("sha256").update(resolve(stateRoot), "utf8").digest();
  return 0.8 + (digest.readUInt16BE(0) / 0xFFFF) * 0.4;
}

async function writeQueueEvent(path: string, event: MemhubCaptureEvent): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(event, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function uploadCapture(config: BridgeConfig, event: MemhubCaptureEvent): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${config.device_token}`
  };
  if (config.cloudflare_access_client_id && config.cloudflare_access_client_secret) {
    headers["CF-Access-Client-Id"] = config.cloudflare_access_client_id;
    headers["CF-Access-Client-Secret"] = config.cloudflare_access_client_secret;
  }
  const response = await fetch(config.capture_endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(bridgeUpstreamTimeoutMs())
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`capture upload HTTP ${response.status}: ${text.slice(0, 500)}`);
}

function json(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function bridgeConfigPath(stateRoot: string): string {
  return join(resolve(stateRoot), "bridge.json");
}

function normalizeCaptureEndpoint(value: string): string {
  return normalizeEndpoint(value, "capture");
}

function normalizeEndpoint(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error(`${label} endpoint must be HTTPS or loopback HTTP`);
  }
  return url.toString();
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

async function proxyMcp(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  config: BridgeConfig
): Promise<void> {
  const method = request.method ?? "GET";
  const headers: Record<string, string> = {
    accept: singleRequestHeader(request.headers.accept) ?? "application/json, text/event-stream",
    "x-memhub-device-token": config.device_token
  };
  const contentType = singleRequestHeader(request.headers["content-type"]);
  if (contentType) headers["content-type"] = contentType;
  const sessionId = singleRequestHeader(request.headers["mcp-session-id"]);
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const lastEventId = singleRequestHeader(request.headers["last-event-id"]);
  if (lastEventId) headers["last-event-id"] = lastEventId;
  if (config.cloudflare_access_client_id && config.cloudflare_access_client_secret) {
    headers["CF-Access-Client-Id"] = config.cloudflare_access_client_id;
    headers["CF-Access-Client-Secret"] = config.cloudflare_access_client_secret;
  }
  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 4_000_000) {
        throw new HttpJsonBodyError("MCP request body exceeds 4000000 bytes", 413, "request_body_too_large");
      }
      chunks.push(buffer);
    }
    body = Buffer.concat(chunks).toString("utf8");
  }
  const upstream = await fetch(config.mcp_endpoint!, {
    method,
    headers,
    ...(body ? { body } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(120_000)
  });
  await pipeUpstreamResponse(upstream, response, ["content-type", "mcp-session-id", "www-authenticate"]);
}

async function proxyContext(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  config: BridgeConfig
): Promise<void> {
  const body = JSON.stringify(await readJsonBody(request));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${config.device_token}`
  };
  if (config.cloudflare_access_client_id && config.cloudflare_access_client_secret) {
    headers["CF-Access-Client-Id"] = config.cloudflare_access_client_id;
    headers["CF-Access-Client-Secret"] = config.cloudflare_access_client_secret;
  }
  const upstream = await fetch(contextEndpoint(config.capture_endpoint), {
    method: "POST",
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(bridgeUpstreamTimeoutMs())
  });
  await pipeUpstreamResponse(upstream, response, ["content-type"]);
}

async function proxyLifecycle(
  response: import("node:http").ServerResponse,
  config: BridgeConfig,
  payload: unknown
): Promise<void> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${config.device_token}`
  };
  if (config.cloudflare_access_client_id && config.cloudflare_access_client_secret) {
    headers["CF-Access-Client-Id"] = config.cloudflare_access_client_id;
    headers["CF-Access-Client-Secret"] = config.cloudflare_access_client_secret;
  }
  const upstream = await fetch(siblingEndpoint(config.capture_endpoint, "lifecycle"), {
    method: "POST",
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(bridgeUpstreamTimeoutMs())
  });
  await pipeUpstreamResponse(upstream, response, ["content-type"]);
}

async function pipeUpstreamResponse(
  upstream: Response,
  response: import("node:http").ServerResponse,
  headerNames: string[]
): Promise<void> {
  const responseHeaders: Record<string, string> = { "cache-control": "no-store" };
  for (const name of headerNames) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders[name] = value;
  }
  if (!responseHeaders["content-type"]) responseHeaders["content-type"] = "application/json";
  response.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) { response.end(); return; }
  const reader = upstream.body.getReader();
  try {
    while (true) {
      if (response.destroyed) {
        await reader.cancel().catch(() => undefined);
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!response.write(Buffer.from(value))) await once(response, "drain");
    }
    response.end();
  } finally {
    reader.releaseLock();
  }
}

function contextEndpoint(captureEndpoint: string): string {
  return siblingEndpoint(captureEndpoint, "context");
}

function siblingEndpoint(baseEndpoint: string, leaf: string): string {
  const url = new URL(baseEndpoint);
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length === 0) throw new Error("endpoint path is empty");
  segments[segments.length - 1] = leaf;
  url.pathname = `/${segments.join("/")}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function singleRequestHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function defaultBridgeRoot(): string {
  return resolve(process.env.MEMHUB_BRIDGE_HOME ?? join(homedir(), ".memhub"));
}

function bridgeUpstreamTimeoutMs(): number {
  const configured = Number(process.env.MEMHUB_BRIDGE_UPSTREAM_TIMEOUT_MS ?? "");
  if (Number.isFinite(configured) && configured >= 100 && configured <= 300_000) {
    return Math.trunc(configured);
  }
  return 15_000;
}

async function readStdinJson(): Promise<unknown> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return JSON.parse(raw || "{}");
}

export async function bridgeMain(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? "serve";
  const stateRoot = process.env.MEMHUB_BRIDGE_HOME ?? defaultBridgeRoot();
  if (command === "configure") {
    const endpointIndex = argv.indexOf("--endpoint");
    const endpoint = endpointIndex >= 0 ? argv[endpointIndex + 1] : process.env.MEMHUB_CAPTURE_ENDPOINT;
    const mcpEndpointIndex = argv.indexOf("--mcp-endpoint");
    const mcpEndpoint = mcpEndpointIndex >= 0 ? argv[mcpEndpointIndex + 1] : process.env.MEMHUB_MCP_ENDPOINT;
    const deviceToken = process.env.MEMHUB_DEVICE_TOKEN;
    if (!endpoint) throw new Error("configure requires --endpoint or MEMHUB_CAPTURE_ENDPOINT");
    if (!deviceToken) throw new Error("configure requires MEMHUB_DEVICE_TOKEN environment variable");
    await saveBridgeConfig(stateRoot, {
      mcpEndpoint,
      captureEndpoint: endpoint,
      deviceToken,
      cloudflareAccessClientId: process.env.CF_ACCESS_CLIENT_ID,
      cloudflareAccessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET
    });
    process.stdout.write("configured\n");
    return;
  }
  if (command === "capture") {
    const queue = new MemhubBridgeQueue(stateRoot);
    const event = await queue.enqueue(await readStdinJson());
    if (process.env.MEMHUB_BRIDGE_ENQUEUE_ONLY === "1") {
      process.stdout.write(JSON.stringify({
        accepted: true,
        event_id: event.event_id,
        sent: 0,
        pending: await queue.pending(),
        queued_only: true
      }, null, 2) + "\n");
      return;
    }
    let result;
    try { result = await queue.flush(await loadBridgeConfig(stateRoot)); }
    catch (error) { result = { sent: 0, pending: await queue.pending(), stopped_on_error: error instanceof Error ? error.message : String(error) }; }
    process.stdout.write(JSON.stringify({ accepted: true, event_id: event.event_id, ...result }, null, 2) + "\n");
    return;
  }
  if (command === "flush") {
    const queue = new MemhubBridgeQueue(stateRoot);
    process.stdout.write(JSON.stringify(await queue.flush(await loadBridgeConfig(stateRoot)), null, 2) + "\n");
    return;
  }
  if (command === "status") {
    const queue = new MemhubBridgeQueue(stateRoot);
    process.stdout.write(JSON.stringify({ pending: await queue.pending(), configured: existsBridgeConfig(stateRoot) }, null, 2) + "\n");
    return;
  }
  if (command === "serve") {
    const portIndex = argv.indexOf("--port");
    const port = portIndex >= 0 ? Number(argv[portIndex + 1]) : 17861;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("invalid bridge port");
    await serveBridge({ stateRoot, port });
    return;
  }
  throw new Error(`unknown bridge command: ${command}`);
}

function existsBridgeConfig(stateRoot: string): boolean {
  try { readFileSync(bridgeConfigPath(stateRoot), "utf8"); return true; } catch { return false; }
}

const invokedArg = process.argv[1];
const invokedPath = invokedArg && !invokedArg.startsWith("-") && existsSync(resolve(invokedArg))
  ? realpathSync(resolve(invokedArg))
  : "";
if (invokedPath !== "" && invokedPath === fileURLToPath(import.meta.url)) await bridgeMain();
