#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../vendor/memory-core/src/storage/schema.js";

const OBSOLETE_JOB_TYPES = [
  "user_memory_embedding",
  "negative_experience",
  "l2_association",
  "l2_induction",
  "l3_abstraction",
  "l3_world_model_update",
  "project_environment_profile",
  "skill_crystallization"
];

const args = parseArgs(process.argv.slice(2));
const dbPath = resolve(args.db ?? process.env.MEMHUB_MEMORY_DB ??
  join(homedir(), ".memmy", "memory-service", "memory.sqlite"));
const reportRoot = resolve(args.reportRoot ??
  join(homedir(), ".memmy", "memhub", "repairs"));
const startedAt = new Date().toISOString();

const db = new Database(dbPath, args.apply ? {} : { readonly: true });
try {
  db.pragma("foreign_keys = ON");
  const before = inspect(db);
  if (before.integrity !== "ok") {
    throw new Error(`refusing operation because SQLite integrity_check failed: ${before.integrity}`);
  }

  let backupPath;
  let reportPath;
  if (args.apply) {
    const stamp = startedAt.replace(/[:.]/g, "-");
    const runDir = join(reportRoot, stamp);
    await mkdir(runDir, { recursive: true });
    backupPath = join(runDir, "memory.sqlite.before");
    await db.backup(backupPath);

    migrate(db);
    const after = inspect(db);
    if (after.integrity !== "ok" || after.foreignKeyViolations !== 0) {
      throw new Error(
        `migration validation failed: integrity=${after.integrity} foreignKeyViolations=${after.foreignKeyViolations}; restore ${backupPath}`
      );
    }

    const report = { ok: true, apply: true, startedAt, dbPath, backupPath, before, after };
    reportPath = join(runDir, "report.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  } else {
    console.log(JSON.stringify({
      ok: true,
      apply: false,
      startedAt,
      dbPath,
      migrationNeeded: before.schemaVersion < 8,
      current: before
    }, null, 2));
  }
} finally {
  db.close();
}

function inspect(db) {
  const schemaVersion = tableExists(db, "schema_migrations")
    ? Number(db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version ?? 0)
    : 0;
  const layers = tableExists(db, "memories")
    ? db.prepare("SELECT memory_layer AS layer, COUNT(*) AS count FROM memories GROUP BY memory_layer ORDER BY memory_layer").all()
    : [];
  const legacyMemories = tableExists(db, "memories")
    ? db.prepare(`SELECT memory_layer AS layer, status, COUNT(*) AS count
        FROM memories
        WHERE COALESCE(json_extract(properties_json, '$.internal_info.memory_kind'), '') IN ('policy','world_model')
           OR COALESCE(json_extract(properties_json, '$.internal_info.legacy_memory_model'), '') = 'v1'
        GROUP BY memory_layer, status ORDER BY memory_layer, status`).all()
    : [];
  const userMemories = tableExists(db, "user_memories")
    ? db.prepare("SELECT status, COUNT(*) AS count FROM user_memories GROUP BY status ORDER BY status").all()
    : [];
  const legacyJobs = tableExists(db, "evolution_jobs")
    ? db.prepare(`SELECT job_type AS jobType, status, COUNT(*) AS count
        FROM evolution_jobs
        WHERE job_type IN (${OBSOLETE_JOB_TYPES.map(() => "?").join(",")})
        GROUP BY job_type, status ORDER BY job_type, status`).all(...OBSOLETE_JOB_TYPES)
    : [];
  const activeLegacyJobs = legacyJobs
    .filter((row) => ["queued", "leased", "failed"].includes(row.status))
    .reduce((sum, row) => sum + Number(row.count), 0);
  const embeddingRetryKinds = tableExists(db, "embedding_retry_queue")
    ? db.prepare("SELECT target_kind AS targetKind, status, COUNT(*) AS count FROM embedding_retry_queue GROUP BY target_kind, status ORDER BY target_kind, status").all()
    : [];
  const oldL3Index = Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='index' AND name='uq_evolution_jobs_l3_immutable_dedupe'"
  ).get());

  return {
    schemaVersion,
    integrity: db.pragma("integrity_check", { simple: true }),
    foreignKeyViolations: db.pragma("foreign_key_check").length,
    layers,
    legacyMemories,
    userMemories,
    legacyJobs,
    activeLegacyJobs,
    embeddingRetryKinds,
    oldL3Index
  };
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
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
