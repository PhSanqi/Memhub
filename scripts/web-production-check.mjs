#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const explicitBase = argumentValue("--base") ?? process.env.MEMHUB_PUBLIC_HOST ?? "";
const timeoutMs = integerOption("--timeout-ms", 8_000, 500, 30_000);
const warnLatencyMs = integerOption("--warn-latency-ms", 2_000, 100, 30_000);
const maxLatencyMs = integerOption("--max-latency-ms", timeoutMs, 100, 30_000);
const base = explicitBase ? normalizeBase(explicitBase) : inferBaseFromNetworkCheck();

if (!base) {
  console.error("Unable to resolve the public Memhub base URL. Pass --base or MEMHUB_PUBLIC_HOST.");
  process.exit(2);
}

const checks = [];
const publicPages = [
  ["/", [200], /^text\/html/i],
  ["/docs", [200], /^text\/html/i],
  ["/docs/install", [200], /^text\/html/i],
  ["/docs/workflows", [200], /^text\/html/i],
  ["/docs/privacy", [200], /^text\/html/i],
  ["/docs/troubleshooting", [200], /^text\/html/i],
  ["/assets/logo-mark.png", [200], /^image\/png/i],
  ["/assets/logo-lockup.png", [200], /^image\/png/i],
  ["/health", [200], /^application\/json/i],
  ["/user", [302, 401, 403], null],
  ["/admin", [302, 401, 403], null]
];

checks.push(...await Promise.all(publicPages.map(([path, statuses, contentType]) => checkRoute(path, statuses, contentType))));

const [landing, docs] = await Promise.all([fetchText("/"), fetchText("/docs")]);
checks.push(markerCheck("landing:preview-status", landing.ok && landing.text.includes("preview-status"), landing.error));
checks.push(markerCheck("landing:color-scheme", landing.ok && landing.text.includes("color-scheme:light"), landing.error));
checks.push(markerCheck("docs:section-rail", docs.ok && docs.text.includes("docs-section-rail"), docs.error));
checks.push(markerCheck("docs:color-scheme", docs.ok && docs.text.includes("color-scheme:light"), docs.error));

for (const [name, expected] of [
  ["content-security-policy", /frame-ancestors\s+'none'/i],
  ["x-content-type-options", /^nosniff$/i],
  ["referrer-policy", /^no-referrer$/i]
]) {
  const value = landing.headers.get(name) ?? "";
  checks.push({ name: `header:${name}`, ok: expected.test(value), observed: value || null });
}

const failed = checks.filter((check) => !check.ok);
const warnings = checks
  .filter((check) => check.ok && Number.isFinite(check.latency_ms) && check.latency_ms > warnLatencyMs)
  .map((check) => `${check.name}: ${check.latency_ms}ms exceeds ${warnLatencyMs}ms warning threshold`);
const report = {
  ok: failed.length === 0,
  checked_at: new Date().toISOString(),
  base,
  timeout_ms: timeoutMs,
  warn_latency_ms: warnLatencyMs,
  max_latency_ms: maxLatencyMs,
  checks,
  failed: failed.map((check) => check.name),
  warnings
};

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;

async function checkRoute(path, acceptedStatuses, expectedContentType) {
  const started = performance.now();
  try {
    const response = await fetch(new URL(path, base), {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs)
    });
    await response.arrayBuffer();
    const latencyMs = Math.round((performance.now() - started) * 10) / 10;
    const contentType = response.headers.get("content-type") ?? "";
    return {
      name: `route:${path}`,
      ok: acceptedStatuses.includes(response.status)
        && latencyMs <= maxLatencyMs
        && (!expectedContentType || expectedContentType.test(contentType)),
      status: response.status,
      latency_ms: latencyMs,
      content_type: contentType || null,
      accepted_statuses: acceptedStatuses
    };
  } catch (error) {
    return {
      name: `route:${path}`,
      ok: false,
      status: null,
      latency_ms: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function fetchText(path) {
  try {
    const response = await fetch(new URL(path, base), {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs)
    });
    return { ok: response.ok, text: await response.text(), headers: response.headers, status: response.status, error: null };
  } catch (error) {
    return {
      ok: false,
      text: "",
      headers: new Headers(),
      status: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function markerCheck(name, ok, error = null) {
  return { name, ok, ...(error ? { error } : {}) };
}

function inferBaseFromNetworkCheck() {
  const result = spawnSync(process.execPath, ["scripts/cloudflare-health.mjs", "--attempts", "1"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: Math.max(timeoutMs * 3, 5_000)
  });
  if (!result.stdout.trim()) return "";
  try {
    const report = JSON.parse(result.stdout);
    return report.public?.url ? normalizeBase(new URL(report.public.url).origin) : "";
  } catch {
    return "";
  }
}

function normalizeBase(value) {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(withScheme);
  return `${url.protocol}//${url.host}/`;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function integerOption(name, fallback, min, max) {
  const value = Number(argumentValue(name));
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
