#!/usr/bin/env node
import { spawnSync } from "node:child_process";

if (process.platform !== "linux") {
  console.log(JSON.stringify({ ok: true, skipped: true, reason: "systemd user smoke is Linux-only" }));
  process.exit(0);
}

const suffix = `memhub-it-${process.pid}-${Date.now()}`;
const core = `${suffix}-core.service`;
const gateway = `${suffix}-gateway.service`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (!options.allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || result.error?.message || "unknown error").trim()}`);
  }
  return result;
}

function systemctl(...args) {
  return run("systemctl", ["--user", ...args]);
}

function mainPid(unit) {
  const value = systemctl("show", "-p", "MainPID", "--value", unit).stdout.trim();
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`${unit} has no live MainPID: ${value}`);
  return pid;
}

function active(unit) {
  return systemctl("is-active", unit).stdout.trim() === "active";
}

function delay(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitFor(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (predicate()) return; } catch { /* service can be between states */ }
    delay(100);
  }
  throw new Error("timed out waiting for systemd stack recovery");
}

function launch(unit, dependencies = []) {
  const properties = [
    "--property=Restart=on-failure",
    "--property=RestartSec=300ms",
    "--property=StartLimitIntervalSec=10s",
    "--property=StartLimitBurst=5"
  ];
  for (const dependency of dependencies) {
    properties.push(`--property=Requires=${dependency}`);
    properties.push(`--property=After=${dependency}`);
    properties.push(`--property=PartOf=${dependency}`);
  }
  run("systemd-run", ["--user", `--unit=${unit}`, ...properties, "/usr/bin/sleep", "infinity"]);
}

function snapshot() {
  return {
    core: { pid: mainPid(core), active: active(core) },
    gateway: { pid: mainPid(gateway), active: active(gateway) }
  };
}

function waitChanged(before, expectedChanged) {
  waitFor(() => {
    const current = snapshot();
    return ["core", "gateway"].every((name) => current[name].active) &&
      expectedChanged.every((name) => current[name].pid !== before[name].pid);
  });
  return snapshot();
}

const report = { ok: false, systemd: null, scenarios: [] };
try {
  const running = run("systemctl", ["--user", "is-system-running"], { allowFailure: true });
  if (running.status !== 0 || running.stdout.trim() !== "running") {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: `user systemd not running: ${running.stdout.trim() || running.stderr.trim()}` }, null, 2));
    process.exit(0);
  }
  report.systemd = run("systemctl", ["--user", "--version"]).stdout.split(/\r?\n/)[0];
  launch(core);
  launch(gateway, [core]);
  waitFor(() => active(core) && active(gateway));

  let before = snapshot();
  process.kill(before.core.pid, "SIGKILL");
  let after = waitChanged(before, ["core", "gateway"]);
  report.scenarios.push({ fault: "core", before, after, expected_restarts: ["core", "gateway"] });

  before = after;
  process.kill(before.gateway.pid, "SIGKILL");
  after = waitChanged(before, ["gateway"]);
  if (after.core.pid !== before.core.pid) throw new Error("gateway failure unexpectedly restarted core");
  report.scenarios.push({ fault: "gateway", before, after, expected_restarts: ["gateway"] });
  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} finally {
  run("systemctl", ["--user", "stop", gateway, core], { allowFailure: true });
  run("systemctl", ["--user", "reset-failed", gateway, core], { allowFailure: true });
}
