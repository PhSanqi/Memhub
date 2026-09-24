#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmExecPath = process.env.npm_execpath?.trim();
const npmRunner = npmExecPath
  ? { command: process.execPath, prefixArgs: [npmExecPath] }
  : { command: npmCommand, prefixArgs: [] };
const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const explicitDir = readOption("--report-dir");
const stateRoot = resolve(process.env.MEMHUB_STATE_ROOT ?? join(homedir(), ".memmy", "memhub"));
const reportDir = resolve(explicitDir ?? join(stateRoot, "diagnostics", "stability", runId));

const steps = [
  ["typecheck", ["run", "typecheck"]],
  ["test", ["test"]],
  ["state-audit", ["run", "state:audit"]],
  ["core-check", ["run", "core:check"]],
  ["release-check", ["run", "release:check"]],
  ["release-complete-check", ["run", "release:complete:check"]]
];

await mkdir(reportDir, { recursive: true, mode: 0o700 });
const startedAt = new Date();
const results = [];

for (const [name, args] of steps) {
  if (name === "core-check" && !existsSync(join(stateRoot, "core", "memory.sqlite"))) {
    results.push(await skippedStep(name, "Memory Core state is not initialized on this host"));
    continue;
  }
  results.push(await runStep(name, npmRunner.command, [...npmRunner.prefixArgs, ...args]));
}

const completedAt = new Date();
const summary = {
  ok: results.every((item) => item.exit_code === 0 || item.skipped === true),
  run_id: runId,
  started_at: startedAt.toISOString(),
  completed_at: completedAt.toISOString(),
  duration_ms: completedAt.getTime() - startedAt.getTime(),
  report_dir: reportDir,
  environment: {
    hostname: hostname(),
    platform: platform(),
    node: process.version,
    cwd: repoRoot
  },
  git: {
    head: await gitValue(["rev-parse", "HEAD"]),
    branch: await gitValue(["branch", "--show-current"]),
    status: await gitValue(["status", "--short"])
  },
  steps: results
};

await writeJson(join(reportDir, "summary.json"), summary);
process.stdout.write(`\n[memhub-stability] summary: ${join(reportDir, "summary.json")}\n`);
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exitCode = summary.ok ? 0 : 1;

async function runStep(name, command, args) {
  const logPath = join(reportDir, `${name}.log`);
  const chunks = [];
  const started = new Date();
  process.stdout.write(`\n[memhub-stability] ${name}\n`);

  const exitCode = await new Promise((resolveExit, rejectExit) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const record = (stream, chunk) => {
      const buffer = Buffer.from(chunk);
      chunks.push(buffer);
      stream.write(buffer);
    };
    child.stdout.on("data", (chunk) => record(process.stdout, chunk));
    child.stderr.on("data", (chunk) => record(process.stderr, chunk));
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => {
      if (signal) chunks.push(Buffer.from(`\n[signal] ${signal}\n`));
      resolveExit(code ?? 1);
    });
  });

  const completed = new Date();
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
  await writeFile(logPath, Buffer.concat(chunks), { mode: 0o600 });
  return {
    name,
    command: [command, ...args],
    started_at: started.toISOString(),
    completed_at: completed.toISOString(),
    duration_ms: completed.getTime() - started.getTime(),
    exit_code: exitCode,
    log_file: logPath
  };
}

async function skippedStep(name, reason) {
  const now = new Date();
  const logPath = join(reportDir, `${name}.log`);
  const message = `[memhub-stability] skipped: ${reason}\n`;
  process.stdout.write(`\n[memhub-stability] ${name}\n${message}`);
  await writeFile(logPath, message, { mode: 0o600 });
  return {
    name,
    command: null,
    started_at: now.toISOString(),
    completed_at: now.toISOString(),
    duration_ms: 0,
    exit_code: null,
    skipped: true,
    skip_reason: reason,
    log_file: logPath
  };
}

async function gitValue(args) {
  return new Promise((resolveValue) => {
    const child = spawn("git", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.once("error", () => resolveValue(null));
    child.once("exit", (code) => {
      resolveValue(code === 0 ? Buffer.concat(chunks).toString("utf8").trim() : null);
    });
  });
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}
