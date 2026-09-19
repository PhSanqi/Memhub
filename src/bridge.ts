#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { mergeCaptureEvent, normalizeCaptureEvent, type MemhubCaptureEvent } from "./capture.js";

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
  }

  async pending(): Promise<number> {
    try {
      return (await readdir(this.queueDir())).filter((name) => name.endsWith(".json")).length;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
      throw error;
    }
  }

  async flush(config: BridgeConfig): Promise<{ sent: number; pending: number; stopped_on_error?: string }> {
    let files: string[];
    try {
      files = (await readdir(this.queueDir())).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { sent: 0, pending: 0 };
      throw error;
    }
    let sent = 0;
    for (const name of files) {
      const path = join(this.queueDir(), name);
      const event = normalizeCaptureEvent(JSON.parse(await readFile(path, "utf8")) as unknown);
      try {
        await uploadCapture(config, event);
        await rm(path, { force: true });
        sent += 1;
      } catch (error) {
        return {
          sent,
          pending: await this.pending(),
          stopped_on_error: error instanceof Error ? error.message : String(error)
        };
      }
    }
    return { sent, pending: await this.pending() };
  }

  private queueDir(): string {
    return join(resolve(this.stateRoot), "queue");
  }
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
  let flushPromise: Promise<unknown> | null = null;
  const flushInBackground = () => {
    if (flushPromise) return;
    flushPromise = (async () => {
      try {
        const config = await loadBridgeConfig(options.stateRoot);
        await queue.flush(config);
      } catch {
        // Offline/unconfigured is expected; the durable queue is retried later.
      } finally {
        flushPromise = null;
      }
    })();
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/status") {
        return json(response, 200, { ok: true, pending: await queue.pending() });
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
        await proxyLifecycle(request, response, config);
        return;
      }
      if (request.method === "POST" && url.pathname === "/flush") {
        return json(response, 200, await queue.flush(await loadBridgeConfig(options.stateRoot)));
      }
      if (request.method === "POST" && url.pathname === "/capture") {
        const event = await queue.enqueue(await readJsonBody(request));
        const pending = await queue.pending();
        flushInBackground();
        return json(response, 202, { accepted: true, event_id: event.event_id, pending });
      }
      response.writeHead(404).end();
    })().catch((error) => json(response, 400, { error: error instanceof Error ? error.message : String(error) }));
  });
  await new Promise<void>((ready, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => ready());
  });
  const retryTimer = setInterval(flushInBackground, 5_000);
  retryTimer.unref();
  flushInBackground();
  console.error(`[memhub-bridge] listening on http://${host}:${port}`);
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
    signal: AbortSignal.timeout(15_000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`capture upload HTTP ${response.status}: ${text.slice(0, 500)}`);
}

async function readJsonBody(request: import("node:http").IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("request body too large");
  }
  return JSON.parse(raw || "{}");
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
      if (bytes > 4_000_000) throw new Error("MCP request body too large");
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
  const responseHeaders: Record<string, string> = { "cache-control": "no-store" };
  for (const name of ["content-type", "mcp-session-id", "www-authenticate"] as const) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders[name] = value;
  }
  response.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) { response.end(); return; }
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      response.write(Buffer.from(value));
    }
    response.end();
  } finally {
    reader.releaseLock();
  }
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
    signal: AbortSignal.timeout(15_000)
  });
  const text = await upstream.text();
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "cache-control": "no-store"
  });
  response.end(text);
}

async function proxyLifecycle(
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
  const upstream = await fetch(siblingEndpoint(config.capture_endpoint, "lifecycle"), {
    method: "POST",
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(15_000)
  });
  const text = await upstream.text();
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "cache-control": "no-store"
  });
  response.end(text);
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
