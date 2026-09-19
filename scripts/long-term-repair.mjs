#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";

const args = parseArgs(process.argv.slice(2));
const dbPath = resolve(args.db ?? process.env.MEMHUB_MEMORY_DB ??
  join(homedir(), ".memmy", "memory-service", "memory.sqlite"));
const reportRoot = resolve(args.reportRoot ??
  join(homedir(), ".memmy", "memhub", "repairs"));

const db = new Database(dbPath);
db.pragma("foreign_keys = ON");
const quickCheck = db.pragma("quick_check", { simple: true });
if (quickCheck !== "ok") {
  throw new Error(`refusing repair because SQLite quick_check failed: ${quickCheck}`);
}

const plan = buildPlan(db);
const startedAt = new Date().toISOString();
let backupPath = null;
let reportPath = null;

if (args.apply) {
  const stamp = startedAt.replace(/[:.]/g, "-");
  const runDir = join(reportRoot, stamp);
  await mkdir(runDir, { recursive: true });
  backupPath = join(runDir, "memory.sqlite.before");
  await db.backup(backupPath);

  const apply = db.transaction(() => applyPlan(db, plan, startedAt));
  apply();

  const afterCheck = db.pragma("quick_check", { simple: true });
  if (afterCheck !== "ok") {
    throw new Error(`SQLite quick_check failed after repair: ${afterCheck}; restore ${backupPath}`);
  }
  const report = {
    ok: true,
    apply: true,
    startedAt,
    dbPath,
    backupPath,
    plan: summarizePlan(plan),
    after: summarizeCurrentState(db)
  };
  reportPath = join(runDir, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

const result = {
  ok: true,
  apply: args.apply,
  dbPath,
  quickCheck,
  plan: summarizePlan(plan),
  ...(backupPath ? { backupPath } : {}),
  ...(reportPath ? { reportPath } : {}),
  current: summarizeCurrentState(db)
};
console.log(JSON.stringify(result, null, 2));
db.close();

function buildPlan(db) {
  const memories = db.prepare(`
    SELECT id, memory_layer, status, tags_json, info_json, properties_json
    FROM memories
    WHERE deleted_at IS NULL AND status IN ('activated','resolving')
  `).all();
  const archiveMemories = [];
  const promoteSkills = [];

  for (const row of memories) {
    const tags = jsonArray(row.tags_json);
    const scoped = tags.includes("global") || tags.some((tag) => tag.startsWith("project:"));
    if (scoped) continue;
    if (row.memory_layer === "Skill" && tags.includes("agent-source") && tags.includes("cross-agent-skill")) {
      promoteSkills.push({
        ...row,
        tags: unique([...tags, "global", "artifact:skill", "legacy-import"])
      });
      continue;
    }
    if (row.memory_layer === "L1") {
      archiveMemories.push({
        ...row,
        reason: tags.includes("agent-source")
          ? "legacy_unscoped_agent_source"
          : "legacy_unscoped_memory",
        tags: unique([...tags, tags.includes("agent-source")
          ? "quarantine:legacy-agent-source"
          : "quarantine:legacy-unscoped"])
      });
    }
  }

  const badUserMemories = db.prepare(`
    SELECT id, content
    FROM user_memories
    WHERE status = 'active' AND deleted_at IS NULL
  `).all().filter((row) => isKnownHarnessPrompt(row.content));

  const deferredJobs = db.prepare(`
    SELECT id, job_type, status, attempts, max_attempts, payload_json, last_error
    FROM evolution_jobs
    WHERE status = 'dead_letter'
      AND job_type IN ('l3_world_model_update','project_environment_profile')
      AND last_error = 'Assigned model is unavailable'
  `).all();

  const staleProjectEnvironmentJobs = db.prepare(`
    SELECT id, job_type, status, attempts, max_attempts, payload_json, last_error
    FROM evolution_jobs
    WHERE status = 'dead_letter'
      AND job_type = 'project_environment_profile'
      AND (
        last_error LIKE 'ENOENT:%'
        OR last_error LIKE 'EACCES:%'
        OR last_error LIKE 'EPERM:%'
        OR last_error LIKE 'project_environment_workspace_%'
      )
  `).all().map((row) => ({
    ...row,
    payload: jsonObject(row.payload_json)
  }));

  const inconsistentL3Jobs = db.prepare(`
    SELECT id, job_type, status, attempts, max_attempts, payload_json, last_error
    FROM evolution_jobs
    WHERE status = 'dead_letter'
      AND job_type = 'l3_world_model_update'
      AND last_error LIKE 'target is already dead letter:%'
  `).all().map((row) => ({
    ...row,
    payload: jsonObject(row.payload_json)
  })).filter((row) =>
    typeof row.payload.batchId === "string" &&
    typeof row.payload.targetField === "string"
  );

  const projectEnvironmentStates = db.prepare(`
    SELECT user_id, project_id
    FROM l3_world_model_project_environment_state
    WHERE status = 'failed' AND last_error = 'Assigned model is unavailable'
  `).all();

  return {
    archiveMemories,
    promoteSkills,
    badUserMemories,
    deferredJobs,
    staleProjectEnvironmentJobs,
    inconsistentL3Jobs,
    projectEnvironmentStates
  };
}

function applyPlan(db, plan, at) {
  const updateMemory = db.prepare(`
    UPDATE memories
    SET status = @status,
        tags_json = @tagsJson,
        info_json = @infoJson,
        properties_json = @propertiesJson,
        version = version + 1,
        updated_at = @at
    WHERE id = @id AND deleted_at IS NULL
  `);

  for (const row of plan.archiveMemories) {
    const info = jsonObject(row.info_json);
    const properties = jsonObject(row.properties_json);
    if (Object.hasOwn(info, "status")) info.status = "archived";
    if (Object.hasOwn(properties, "status")) properties.status = "archived";
    if (Array.isArray(info.tags)) info.tags = row.tags;
    if (Array.isArray(properties.tags)) properties.tags = row.tags;
    updateMemory.run({
      id: row.id,
      status: "archived",
      tagsJson: JSON.stringify(row.tags),
      infoJson: JSON.stringify(info),
      propertiesJson: JSON.stringify(properties),
      at
    });
  }

  for (const row of plan.promoteSkills) {
    const info = jsonObject(row.info_json);
    const properties = jsonObject(row.properties_json);
    if (Array.isArray(info.tags)) info.tags = row.tags;
    if (Array.isArray(properties.tags)) properties.tags = row.tags;
    updateMemory.run({
      id: row.id,
      status: row.status,
      tagsJson: JSON.stringify(row.tags),
      infoJson: JSON.stringify(info),
      propertiesJson: JSON.stringify(properties),
      at
    });
  }

  const archiveUserMemory = db.prepare(`
    UPDATE user_memories
    SET status = 'archived',
        archived_at = ?,
        archive_reason = 'memhub_harness_prompt_quarantine',
        updated_at = ?
    WHERE id = ? AND status = 'active' AND deleted_at IS NULL
  `);
  for (const row of plan.badUserMemories) {
    archiveUserMemory.run(at, at, row.id);
  }

  const requeueJob = db.prepare(`
    UPDATE evolution_jobs
    SET status = 'queued',
        attempts = 0,
        leased_until = NULL,
        last_error = NULL,
        updated_at = ?
    WHERE id = ? AND status = 'dead_letter'
  `);
  for (const row of plan.deferredJobs) {
    requeueJob.run(at, row.id);
  }

  const supersedeStaleEnvironmentJob = db.prepare(`
    UPDATE evolution_jobs
    SET status = 'succeeded',
        leased_until = NULL,
        payload_json = ?,
        updated_at = ?
    WHERE id = ? AND status = 'dead_letter'
  `);
  const resetStaleEnvironmentState = db.prepare(`
    UPDATE l3_world_model_project_environment_state
    SET project_kind = 'unknown',
        status = 'uninitialized',
        current_scan_id = NULL,
        last_error = NULL,
        updated_at = ?
    WHERE user_id = ? AND project_id = ? AND current_scan_id = ?
  `);
  for (const row of plan.staleProjectEnvironmentJobs) {
    supersedeStaleEnvironmentJob.run(JSON.stringify({
      ...row.payload,
      maintenanceDisposition: "stale_environment_scan"
    }), at, row.id);
    const userId = row.payload.userId;
    const projectId = row.payload.projectId;
    const scanId = row.payload.scanId;
    if (typeof userId === "string" && typeof projectId === "string" && typeof scanId === "string") {
      resetStaleEnvironmentState.run(at, userId, projectId, scanId);
    }
  }

  const resetL3Target = db.prepare(`
    UPDATE l3_world_model_batch_targets
    SET status = 'queued',
        no_change = 0,
        applied_at = NULL,
        updated_at = ?
    WHERE batch_id = ? AND target_field = ? AND status = 'dead_letter'
  `);
  const reopenL3Batch = db.prepare(`
    UPDATE l3_world_model_evidence_batches
    SET terminal_outcome = NULL,
        completed_at = NULL,
        updated_at = ?
    WHERE id = ?
  `);
  for (const row of plan.inconsistentL3Jobs) {
    resetL3Target.run(at, row.payload.batchId, row.payload.targetField);
    reopenL3Batch.run(at, row.payload.batchId);
    requeueJob.run(at, row.id);
  }

  const resetProjectEnvironment = db.prepare(`
    UPDATE l3_world_model_project_environment_state
    SET status = 'queued',
        last_error = NULL,
        updated_at = ?
    WHERE user_id = ? AND project_id = ?
      AND status = 'failed'
  `);
  for (const row of plan.projectEnvironmentStates) {
    resetProjectEnvironment.run(at, row.user_id, row.project_id);
  }
}

function summarizePlan(plan) {
  return {
    archiveUnscopedL1: plan.archiveMemories.length,
    promoteCrossAgentSkills: plan.promoteSkills.length,
    archiveHarnessUserMemories: plan.badUserMemories.length,
    requeueModelUnavailableJobs: plan.deferredJobs.length,
    supersedeStaleProjectEnvironmentJobs: plan.staleProjectEnvironmentJobs.length,
    repairInconsistentL3Targets: plan.inconsistentL3Jobs.length,
    resetProjectEnvironmentStates: plan.projectEnvironmentStates.length,
    memoryArchiveReasons: countBy(plan.archiveMemories, (row) => row.reason),
    jobTypes: countBy(plan.deferredJobs, (row) => row.job_type)
  };
}

function summarizeCurrentState(db) {
  return {
    activeMemories: scalar(db, "SELECT COUNT(*) FROM memories WHERE deleted_at IS NULL AND status IN ('activated','resolving')"),
    archivedMemories: scalar(db, "SELECT COUNT(*) FROM memories WHERE deleted_at IS NULL AND status = 'archived'"),
    activeUserMemories: scalar(db, "SELECT COUNT(*) FROM user_memories WHERE deleted_at IS NULL AND status = 'active'"),
    archivedUserMemories: scalar(db, "SELECT COUNT(*) FROM user_memories WHERE deleted_at IS NULL AND status = 'archived'"),
    deadLetterJobs: scalar(db, "SELECT COUNT(*) FROM evolution_jobs WHERE status = 'dead_letter'"),
    queuedL3Jobs: scalar(db, "SELECT COUNT(*) FROM evolution_jobs WHERE status = 'queued' AND job_type = 'l3_world_model_update'"),
    queuedProjectEnvironmentJobs: scalar(db, "SELECT COUNT(*) FROM evolution_jobs WHERE status = 'queued' AND job_type = 'project_environment_profile'")
  };
}

function isKnownHarnessPrompt(content) {
  const text = String(content ?? "").trim();
  return /^# Overview\s+Generate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this Projectless task/i.test(text) ||
    /^You are an expert at upholding safety and compliance standards for Codex ambient suggestions\./i.test(text);
}

function jsonArray(value) {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function jsonObject(value) {
  try {
    const parsed = JSON.parse(value ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function unique(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function countBy(values, keyFn) {
  const result = {};
  for (const value of values) {
    const key = keyFn(value);
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function scalar(db, sql) {
  return Number(db.prepare(sql).pluck().get() ?? 0);
}

function parseArgs(argv) {
  const out = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--apply") out.apply = true;
    else if (arg === "--db") out.db = value();
    else if (arg === "--report-root") out.reportRoot = value();
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/long-term-repair.mjs [--db FILE] [--report-root DIR] [--apply]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}
