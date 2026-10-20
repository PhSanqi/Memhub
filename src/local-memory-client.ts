export interface RuntimeNamespace {
  source: string;
  profileId: string;
  projectId?: string;
  workspaceId?: string;
  workspacePath?: string;
  sessionKey?: string;
  userId?: string;
  tenantId?: string;
}

export interface RecallHit {
  id: string;
  kind: string;
  memoryLayer: string;
  status: string;
  title?: string;
  snippet: string;
  score: number;
  tags: string[];
  createdAt?: string;
  updatedAt?: string;
  source: string;
  retrievalRoutes?: string[];
}

export interface LocalMemoryRestClientOptions {
  endpoint: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

/** Preserve the upstream status without parsing an error message or URL. */
export class MemoryCoreHttpError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`memory core HTTP ${status}: ${detail}`);
    this.name = "MemoryCoreHttpError";
  }
}

/**
 * Minimal Memhub client for the loopback Memory Core API.
 * Keeping this client local avoids linking the MCP gateway to Memory's
 * internal package graph.
 */
export class LocalMemoryRestClient {
  private readonly endpoint: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LocalMemoryRestClientOptions) {
    assertLoopbackMemoryEndpoint(options.endpoint);
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Unauthenticated loopback health document; used for build/degraded checks. */
  health(timeoutMs = 1_500): Promise<unknown> {
    return this.requestRaw("/health", "GET", undefined, timeoutMs);
  }

  search(request: Record<string, unknown>): Promise<unknown> {
    return this.request("/api/v1/memory/search", request);
  }

  async addMemory(request: Record<string, unknown>): Promise<unknown> {
    if (reconcileMemoryAdd.getStore()) {
      const outcome = await this.request("/api/v1/memory/add/reconcile", request) as { outcome: string; result?: unknown };
      if (outcome.outcome !== "committed") {
        throw new Error("frozen Core commit outcome is unknown; use memhub_distill reconcile_commit to inspect or explicitly abandon it; no write was resent");
      }
      return outcome.result;
    }
    return this.request("/api/v1/memory/add", request);
  }

  viewerGet(path: string, timeoutMs = 5_000): Promise<unknown> {
    return this.requestRaw(path, "GET", undefined, timeoutMs, true);
  }

  viewerPost(path: string, body: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<unknown> {
    return this.requestRaw(path, "POST", body, timeoutMs, true);
  }

  viewerDelete(path: string, timeoutMs = 10_000): Promise<unknown> {
    return this.requestRaw(path, "DELETE", undefined, timeoutMs, true);
  }

  openSession(request: Record<string, unknown>): Promise<unknown> {
    return this.request("/api/v1/sessions/open", request);
  }

  startTurn(request: Record<string, unknown>): Promise<unknown> {
    return this.request("/api/v1/turns/start", request);
  }

  completeTurn(turnId: string, request: Record<string, unknown>): Promise<unknown> {
    return this.request(`/api/v1/turns/${encodeURIComponent(turnId)}/complete`, request);
  }

  closeSession(sessionId: string, request: Record<string, unknown>): Promise<unknown> {
    return this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/close`, request);
  }

  private async request(path: string, body: Record<string, unknown>): Promise<unknown> {
    return this.requestRaw(path, "POST", body);
  }

  private async requestRaw(
    path: string,
    method: "GET" | "POST" | "DELETE",
    body?: Record<string, unknown>,
    timeoutMs = 15_000,
    viewer = false
  ): Promise<unknown> {
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await this.fetchImpl(`${this.endpoint}${path}`, {
          method,
          headers: {
            "content-type": "application/json",
            ...(viewer ? { "x-memmy-viewer": "1" } : {}),
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (method !== "GET" || attempt > 0 || ![502, 503, 504].includes(response.status)) break;
        await response.body?.cancel();
      } catch (error) {
        if (method !== "GET" || attempt > 0 || !(error instanceof TypeError)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 50));
    }
    const text = await response.text();
    const payload = text ? safeJson(text) : undefined;
    if (!response.ok) {
      throw new MemoryCoreHttpError(response.status, safeErrorPayload(payload, text));
    }
    return payload;
  }
}

export function assertLoopbackMemoryEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TypeError("Memory Core endpoint must be a valid loopback HTTP URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Memory Core endpoint must use http or https");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return;
  const octets = host.split(".");
  if (
    octets.length === 4 &&
    octets.every((part) => /^\d{1,3}$/.test(part)) &&
    octets.map(Number).every((value) => value >= 0 && value <= 255) &&
    Number(octets[0]) === 127
  ) return;
  throw new Error(`Memhub refuses non-loopback Memory Core endpoint: ${url.origin}`);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function safeErrorPayload(payload: unknown, raw: string): string {
  if (typeof payload === "string") return clip(payload, 1_000);
  try {
    return clip(JSON.stringify(payload), 1_000);
  } catch {
    return clip(raw, 1_000);
  }
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
import { AsyncLocalStorage } from "node:async_hooks";

const reconcileMemoryAdd = new AsyncLocalStorage<boolean>();

/** Reconcile a frozen write without allowing an absent replay record to execute it. */
export function withCoreMemoryReconciliation<T>(run: () => Promise<T>): Promise<T> {
  return reconcileMemoryAdd.run(true, run);
}
