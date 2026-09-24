#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const origin = argumentValue("--origin");
const publicHost = argumentValue("--public-host") ?? process.env.MEMHUB_PUBLIC_HOST ?? "";
const attempts = integerOption("--attempts", 5, 1, 20);
const timeoutMs = integerOption("--timeout-ms", 5_000, 250, 30_000);
const metricsAddress = argumentValue("--metrics") ?? "auto";
const http2AbResult = argumentValue("--http2-ab-result") ?? process.env.MEMHUB_HTTP2_AB_RESULT ?? "unknown";
if (!["unknown", "failed", "passed"].includes(http2AbResult)) {
  throw new Error("--http2-ab-result must be unknown, failed, or passed");
}

const report = {
  ok: true,
  checked_at: new Date().toISOString(),
  cloudflared: cloudflaredVersion(),
  http2_ab_result: http2AbResult,
  origin: origin
    ? await probe(origin, { attempts, timeoutMs })
    : await probeFirst([
        "http://127.0.0.1:3001/health",
        "http://127.0.0.1:3001/memhub/health",
        "http://127.0.0.1:3001/"
      ], { attempts, timeoutMs }),
  public: null,
  metrics: await readMetrics(metricsAddress, timeoutMs)
};

if (!report.origin.ok) report.ok = false;
const resolvedPublicHost = publicHost || inferPublicHost(report.metrics, report.origin?.url);
report.public_host_source = publicHost ? "explicit" : resolvedPublicHost ? "connector-config" : null;
if (resolvedPublicHost) {
  const base = resolvedPublicHost.startsWith("http://") || resolvedPublicHost.startsWith("https://")
    ? resolvedPublicHost
    : `https://${resolvedPublicHost.replace(/^\/+|\/+$/g, "")}`;
  const headers = {};
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
  }
  report.public = await probeFirst([
    new URL("/health", base).toString(),
    new URL("/memhub/health", base).toString(),
    new URL("/", base).toString()
  ], { attempts, timeoutMs, headers, allowAccessChallenge: Object.keys(headers).length === 0 });
  if (!report.public.ok && !report.public.access_protected) report.ok = false;
}

const scopedMetrics = metricsForHost(report.metrics, resolvedPublicHost);
report.warnings = metricWarnings(scopedMetrics, http2AbResult);
const metricsAfter = await readMetrics(metricsAddress, timeoutMs);
const scopedMetricsAfter = metricsForHost(metricsAfter, resolvedPublicHost);
report.metric_deltas = metricDeltas(scopedMetrics, scopedMetricsAfter);
report.metric_failures = metricFailures(scopedMetricsAfter, report.metric_deltas);
if (report.metric_failures.length > 0) report.ok = false;
if (report.origin?.url?.endsWith("/")) report.warnings.push("origin health endpoint is unavailable; probe fell back to the web root");
if (report.public?.url?.endsWith("/")) report.warnings.push("public health endpoint is unavailable; probe fell back to the web root");

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;

async function probe(url, options) {
  const latencies = [];
  let lastStatus = null;
  let lastError = null;
  let accessProtected = false;
  for (let index = 0; index < options.attempts; index += 1) {
    const started = performance.now();
    try {
      const response = await fetch(url, {
        headers: options.headers,
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs)
      });
      const elapsed = Math.round((performance.now() - started) * 10) / 10;
      lastStatus = response.status;
      if (options.allowAccessChallenge && (response.status === 401 || response.status === 403 || response.status === 302)) {
        accessProtected = true;
        latencies.push(elapsed);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      latencies.push(elapsed);
      await response.arrayBuffer();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    url,
    ok: latencies.length === options.attempts && !accessProtected,
    access_protected: accessProtected,
    attempts: options.attempts,
    successes: latencies.length,
    status: lastStatus,
    latency_ms: sorted.length ? {
      min: sorted[0],
      p50: sorted[Math.floor((sorted.length - 1) * 0.5)],
      max: sorted.at(-1)
    } : null,
    error: lastError
  };
}

async function probeFirst(urls, options) {
  const results = [];
  for (const url of urls) {
    const result = await probe(url, options);
    results.push(result);
    if (result.ok || result.access_protected || result.successes > 0) return { ...result, candidates: results };
  }
  return { ...results.at(-1), candidates: results };
}

async function readMetrics(address, timeoutMs) {
  const candidates = address === "auto"
    ? Array.from({ length: 5 }, (_, index) => `http://127.0.0.1:${20241 + index}/metrics`)
    : [`http://${address.replace(/^https?:\/\//, "").replace(/\/$/, "")}/metrics`];
  const endpoints = [];
  for (const url of candidates) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(timeoutMs, 1_000)) });
      if (!response.ok) continue;
      const text = await response.text();
      const connectorConfig = await readConnectorConfig(new URL("/config", url), timeoutMs);
      const processStart = metricValue(text, "process_start_time_seconds");
      const closedConnections = metricValue(text, "quic_client_closed_connections");
      const processAgeSeconds = processStart === null ? null : Math.max(0, Date.now() / 1000 - processStart);
      const quicClosedPerHour = processAgeSeconds && processAgeSeconds >= 300 && closedConnections !== null
        ? Math.round((closedConnections * 3600 / processAgeSeconds) * 10) / 10
        : null;
      endpoints.push({
        available: true,
        url,
        ha_connections: metricValue(text, "cloudflared_tunnel_ha_connections"),
        request_errors: metricValue(text, "cloudflared_tunnel_request_errors"),
        heartbeat_retries: metricValue(text, "cloudflared_tunnel_timer_retries"),
        active_streams: metricValue(text, "cloudflared_tunnel_active_streams"),
        total_connections: metricValue(text, "quic_client_total_connections"),
        closed_connections: closedConnections,
        register_success: metricValue(text, "cloudflared_tunnel_tunnel_register_success"),
        process_start_time_seconds: processStart,
        process_age_seconds: processAgeSeconds === null ? null : Math.round(processAgeSeconds),
        quic_closed_connections_per_hour: quicClosedPerHour,
        quic_smoothed_rtt: metricValues(text, "quic_client_smoothed_rtt"),
        quic_lost_packets: metricValues(text, "quic_client_lost_packets"),
        connector_config: connectorConfig
      });
    } catch {}
  }
  if (address !== "auto") return endpoints[0] ?? { available: false, checked: candidates };
  return { available: endpoints.length > 0, endpoints, checked: candidates };
}

async function readConnectorConfig(url, timeoutMs) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(timeoutMs, 1_000)) });
    if (!response.ok) return null;
    const payload = await response.json();
    const ingress = Array.isArray(payload?.config?.ingress) ? payload.config.ingress : [];
    return {
      ingress: ingress.map((entry) => ({
        hostname: typeof entry?.hostname === "string" ? entry.hostname : "",
        service: typeof entry?.service === "string" ? entry.service : "",
        origin_request: safeOriginRequest(entry?.originRequest)
      }))
    };
  } catch {
    return null;
  }
}

function safeOriginRequest(value) {
  if (!value || typeof value !== "object") return null;
  return {
    connect_timeout_seconds: numberOrNull(value.connectTimeout),
    tcp_keepalive_seconds: numberOrNull(value.tcpKeepAlive),
    keepalive_timeout_seconds: numberOrNull(value.keepAliveTimeout),
    keepalive_connections: numberOrNull(value.keepAliveConnections),
    http2_origin: value.http2Origin === true
  };
}

function inferPublicHost(metrics, originUrl) {
  if (!originUrl) return "";
  let origin;
  try {
    origin = new URL(originUrl);
  } catch {
    return "";
  }
  const originPort = origin.port || (origin.protocol === "https:" ? "443" : "80");
  const endpoints = Array.isArray(metrics?.endpoints) ? metrics.endpoints : metrics?.available ? [metrics] : [];
  for (const endpoint of endpoints) {
    for (const ingress of endpoint.connector_config?.ingress ?? []) {
      if (!ingress.hostname || !ingress.service) continue;
      try {
        const service = new URL(ingress.service);
        const servicePort = service.port || (service.protocol === "https:" ? "443" : "80");
        if (service.hostname === origin.hostname && servicePort === originPort) return ingress.hostname;
      } catch {}
    }
  }
  return "";
}

function metricsForHost(metrics, hostname) {
  if (!hostname || !Array.isArray(metrics?.endpoints)) return metrics;
  const normalizedHost = hostname.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  const endpoints = metrics.endpoints.filter((endpoint) =>
    (endpoint.connector_config?.ingress ?? []).some((ingress) => ingress.hostname === normalizedHost)
  );
  return endpoints.length ? { ...metrics, endpoints } : metrics;
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function metricWarnings(metrics, http2AbResult = "unknown") {
  const endpoints = Array.isArray(metrics?.endpoints) ? metrics.endpoints : metrics?.available ? [metrics] : [];
  const warnings = [];
  for (const endpoint of endpoints) {
    if (endpoint.ha_connections !== null && endpoint.ha_connections < 4) {
      warnings.push(`${endpoint.url}: only ${endpoint.ha_connections}/4 tunnel HA connections are active`);
    }
    if (endpoint.heartbeat_retries !== null && endpoint.heartbeat_retries > 0) {
      warnings.push(`${endpoint.url}: heartbeat retry gauge is ${endpoint.heartbeat_retries}`);
    }
    if (endpoint.quic_closed_connections_per_hour !== null && endpoint.quic_closed_connections_per_hour > 12) {
      const guidance = http2AbResult === "failed"
        ? "forced HTTP/2 already failed its controlled A/B; retain auto and investigate QUIC path and edge connectivity without repeating that change"
        : http2AbResult === "passed"
          ? "verify transport choice against current matched-window public success rate and HA before changing production"
          : "a protocol A/B may help only after verifying TCP/7844 connectivity and a safe rollback path";
      warnings.push(`${endpoint.url}: high QUIC connection churn (${endpoint.quic_closed_connections_per_hour} lifetime-average closed connections/hour, Memhub heuristic); ${guidance}`);
    }
    for (const ingress of endpoint.connector_config?.ingress ?? []) {
      const origin = ingress.origin_request;
      if (!origin) continue;
      const loopback = /^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(ingress.service);
      if (loopback && origin.connect_timeout_seconds !== null && origin.connect_timeout_seconds > 5) {
        warnings.push(`${endpoint.url}: ${ingress.hostname || "default ingress"} uses ${origin.connect_timeout_seconds}s loopback origin connect timeout; consider a separate controlled trial of 5s with rollback, not a transport switch`);
      }
      if (/^http:\/\//i.test(ingress.service) && origin.http2_origin) {
        warnings.push(`${endpoint.url}: ${ingress.hostname || "default ingress"} enables HTTP/2-to-origin for a plain HTTP origin`);
      }
    }
  }
  return warnings;
}

function metricDeltas(before, after) {
  const beforeEndpoints = Array.isArray(before?.endpoints) ? before.endpoints : before?.available ? [before] : [];
  const afterEndpoints = Array.isArray(after?.endpoints) ? after.endpoints : after?.available ? [after] : [];
  const deltas = [];
  for (const current of afterEndpoints) {
    const previous = beforeEndpoints.find((endpoint) => endpoint.url === current.url);
    const sameProcess = previous
      && previous.process_start_time_seconds !== null
      && previous.process_start_time_seconds === current.process_start_time_seconds;
    deltas.push({
      url: current.url,
      same_process: Boolean(sameProcess),
      request_errors: sameProcess && previous.request_errors !== null && current.request_errors !== null
        ? Math.max(0, current.request_errors - previous.request_errors)
        : null,
      closed_connections: sameProcess && previous.closed_connections !== null && current.closed_connections !== null
        ? Math.max(0, current.closed_connections - previous.closed_connections)
        : null
    });
  }
  return deltas;
}

function metricFailures(metrics, deltas = []) {
  const endpoints = Array.isArray(metrics?.endpoints) ? metrics.endpoints : metrics?.available ? [metrics] : [];
  const failures = [];
  for (const endpoint of endpoints) {
    if (endpoint.ha_connections !== null && endpoint.ha_connections < 4) {
      failures.push(`${endpoint.url}: only ${endpoint.ha_connections}/4 tunnel HA connections are active`);
    }
    const delta = deltas.find((item) => item.url === endpoint.url);
    if (delta?.request_errors !== null && delta?.request_errors > 0) {
      failures.push(`${endpoint.url}: tunnel request errors increased by ${delta.request_errors} during this check`);
    }
  }
  return failures;
}

function metricValue(text, name) {
  const values = metricValues(text, name);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function metricValues(text, name) {
  const values = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith(name)) continue;
    const value = Number(line.trim().split(/\s+/).at(-1));
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

function cloudflaredVersion() {
  const result = spawnSync("cloudflared", ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || result.stderr.trim() || null;
}

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function integerOption(flag, fallback, min, max) {
  const raw = argumentValue(flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  return value;
}
