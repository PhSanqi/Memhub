import { connect } from "node:net";

export type MemhubServiceKind = "core" | "gateway" | "bridge";

export interface ServiceProbe {
  ok: boolean;
  status: number | null;
  reason: string;
}

export function assertLoopbackHealthUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("Memhub service readiness requires a plain loopback HTTP URL");
  }
  return url;
}

export async function probeService(url: string, kind: MemhubServiceKind, timeoutMs = 1_000): Promise<ServiceProbe> {
  assertLoopbackHealthUrl(url);
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, status: response.status, reason: `http_${response.status}` };
    if (kind === "gateway" || kind === "bridge" || kind === "core") {
      const data: unknown = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return { ok: false, status: response.status, reason: "invalid_health_payload" };
      }
      const object = data as Record<string, unknown>;
      if (kind === "core") {
        const storage = object.storage;
        if (object.ok !== true || typeof object.serviceVersion !== "string" ||
            !Number.isSafeInteger(object.protocolVersion) || Number(object.protocolVersion) < 1 ||
            !storage || typeof storage !== "object" || Array.isArray(storage) ||
            (storage as Record<string, unknown>).ready !== true) {
          return { ok: false, status: response.status, reason: "core_not_ready" };
        }
        return { ok: true, status: response.status, reason: "ready" };
      }
      const expectedService = kind === "gateway" ? "memhub" : "memhub-bridge";
      if (object.ok !== true || object.service !== expectedService) {
        return { ok: false, status: response.status, reason: "unexpected_service" };
      }
    }
    return { ok: true, status: response.status, reason: "ready" };
  } catch (error) {
    return { ok: false, status: null, reason: error instanceof Error ? error.name : "connection_error" };
  }
}

export async function waitForService(options: {
  url: string;
  kind: MemhubServiceKind;
  timeoutMs?: number;
  intervalMs?: number;
  probeTimeoutMs?: number;
  signal?: AbortSignal;
  isAlive?: () => boolean;
}): Promise<void> {
  assertLoopbackHealthUrl(options.url);
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 200;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000 ||
      !Number.isInteger(intervalMs) || intervalMs < 10 || intervalMs > 10_000) {
    throw new RangeError("invalid service readiness timeout/interval");
  }
  const deadline = Date.now() + timeoutMs;
  let lastReason = "not_checked";
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error(`${options.kind} startup cancelled`);
    if (options.isAlive && !options.isAlive()) throw new Error(`${options.kind} process exited before readiness`);
    const probe = await probeService(options.url, options.kind, Math.min(options.probeTimeoutMs ?? 1_000, Math.max(100, deadline - Date.now())));
    if (probe.ok) {
      if (options.isAlive && !options.isAlive()) throw new Error(`${options.kind} process exited during readiness`);
      return;
    }
    lastReason = probe.reason;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`${options.kind} readiness timeout (${lastReason})`);
}

export async function loopbackPortOccupied(url: string, timeoutMs = 400): Promise<boolean> {
  const parsed = assertLoopbackHealthUrl(url);
  const port = Number(parsed.port || 80);
  return new Promise((resolveOccupied) => {
    const socket = connect({ host: parsed.hostname === "[::1]" ? "::1" : parsed.hostname, port });
    const done = (occupied: boolean) => { socket.destroy(); resolveOccupied(occupied); };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}
