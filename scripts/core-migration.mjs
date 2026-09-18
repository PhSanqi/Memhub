#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const here = dirname(fileURLToPath(import.meta.url));
const memhubDir = resolve(here, "..");

const argv = process.argv.slice(2);
const command = argv.shift() ?? "preflight";
const args = parseArgs(argv);

const legacyDb = join(homedir(), ".memmy", "memory-service", "memory.sqlite");
const legacyConfig = join(homedir(), ".memmy", "config.yaml");
const cleanDb = join(homedir(), ".memhub", "core", "memory.sqlite");
const cleanConfig = join(homedir(), ".memhub", "core", "config.yaml");
const dbPath = resolve(args.db ?? (existsSync(legacyDb) ? legacyDb : cleanDb));
const configPath = resolve(args.config ?? (existsSync(legacyConfig) ? legacyConfig : cleanConfig));
const migrationRoot = resolve(args["state-root"] ?? join(homedir(), ".memmy", "memhub", "core-migrations"));
const memoryVendor = resolve(args["memory-vendor"] ?? join(memhubDir, "vendor", "memory-core", "src"));
const agentSourceVendor = resolve(args["agent-source-vendor"] ?? join(memhubDir, "vendor", "agent-source-core"));
const normifyVendor = resolve(args["normify-vendor"] ?? join(memhubDir, "vendor", "normify", "lib"));
const vendorManifestPath = resolve(args["vendor-manifest"] ?? join(memhubDir, "vendor", "manifest.json"));

if (command === "preflight") {
  await preflight();
} else if (command === "verify") {
  await verify();
} else if (command === "preserved") {
  await preserved();
} else {
  usage();
  process.exitCode = 2;
}

async function preflight() {
  requireFile(dbPath, "Memory database");
  requireFile(configPath, "Memory config");
  const vendorManifest = JSON.parse(await readFile(vendorManifestPath, "utf8"));
  if (vendorManifest.format !== "memhub-vendor-manifest-v1") {
    fail("unsupported vendor manifest", { format: vendorManifest.format });
  }
  const memoryParity = await verifyVendoredTree("memory-core", memoryVendor, vendorManifest.components?.memory);
  const agentSourceParity = await verifyVendoredTree("agent-source-core", agentSourceVendor, vendorManifest.components?.agentSource);
  const normifyParity = await verifyVendoredTree("architecture-core", normifyVendor, vendorManifest.components?.architecture);
  if (!memoryParity.equal || !agentSourceParity.equal || !normifyParity.equal) {
    fail("vendored core integrity check failed", {
      memoryParity,
      agentSourceParity,
      normifyParity
    });
  }

  const live = openDatabase(dbPath);
  const liveIntegrity = integrity(live);
  if (liveIntegrity !== "ok") {
    live.close();
    fail("live database quick_check failed", { result: liveIntegrity });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotDir = join(migrationRoot, stamp);
  const snapshotDb = join(snapshotDir, "memory.sqlite");
  const snapshotConfig = join(snapshotDir, "config.yaml");
  await mkdir(snapshotDir, { recursive: true, mode: 0o700 });
  await chmod(snapshotDir, 0o700);
  await live.backup(snapshotDb);
  live.close();
  // Keep the rollback baseline immutable. Shadow validation must use a copy.
  await chmod(snapshotDb, 0o400);
  await copyFile(configPath, snapshotConfig);
  await chmod(snapshotConfig, 0o400);

  const snapshot = openDatabase(snapshotDb);
  const fingerprint = fingerprintDatabase(snapshot);
  snapshot.close();
  if (fingerprint.integrity !== "ok") {
    fail("snapshot database quick_check failed", { result: fingerprint.integrity });
  }

  const snapshotStat = await stat(snapshotDb);
  const manifest = {
    format: "memhub-core-migration-v2",
    createdAt: new Date().toISOString(),
    source: {
      dbPath,
      configPath
    },
    snapshot: {
      directory: snapshotDir,
      dbPath: snapshotDb,
      configPath: snapshotConfig,
      bytes: snapshotStat.size,
      sha256: await sha256File(snapshotDb)
    },
    runtimeParity: {
      memory: memoryParity,
      agentSource: agentSourceParity,
      architecture: normifyParity
    },
    database: fingerprint
  };
  const manifestPath = join(snapshotDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  await chmod(manifestPath, 0o600);

  process.stdout.write(JSON.stringify({
    ok: true,
    phase: "preflight",
    manifest: manifestPath,
    snapshot: snapshotDb,
    database: {
      integrity: fingerprint.integrity,
      schemaHash: fingerprint.schemaHash,
      durableTables: Object.keys(fingerprint.durableTables).length
    },
    runtimeParity: {
      memory: memoryParity.equal,
      agentSource: agentSourceParity.equal,
      architecture: normifyParity.equal
    }
  }, null, 2) + "\n");
}

async function verify() {
  const manifestPath = resolve(args.manifest ?? args._?.[0] ?? "");
  if (!manifestPath || !existsSync(manifestPath)) {
    fail("verify requires --manifest <manifest.json>");
  }
  requireFile(dbPath, "Memory database");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.format !== "memhub-core-migration-v2") {
    fail("unsupported migration manifest", { format: manifest.format });
  }
  const db = openDatabase(dbPath);
  const current = fingerprintDatabase(db);
  db.close();
  const expected = manifest.database;
  const mismatches = [];
  if (current.integrity !== "ok") mismatches.push({ kind: "integrity", current: current.integrity });
  if (current.schemaHash !== expected.schemaHash) {
    mismatches.push({ kind: "schema", expected: expected.schemaHash, current: current.schemaHash });
  }
  if (current.migrationStateHash !== expected.migrationStateHash) {
    mismatches.push({
      kind: "migration-state",
      expected: expected.migrationStateHash,
      current: current.migrationStateHash
    });
  }
  const names = new Set([
    ...Object.keys(expected.durableTables ?? {}),
    ...Object.keys(current.durableTables ?? {})
  ]);
  for (const name of [...names].sort()) {
    const before = expected.durableTables?.[name];
    const after = current.durableTables?.[name];
    if (!before || !after || before.rows !== after.rows || before.sha256 !== after.sha256) {
      mismatches.push({ kind: "table", table: name, expected: before ?? null, current: after ?? null });
    }
  }
  if (mismatches.length > 0) {
    fail("database differs from the migration baseline; do not retire the rollback snapshot", {
      manifest: manifestPath,
      mismatches
    });
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    phase: "verify",
    manifest: manifestPath,
    db: dbPath,
    integrity: current.integrity,
    schemaHash: current.schemaHash,
    durableTables: Object.keys(current.durableTables).length
  }, null, 2) + "\n");
}

async function preserved() {
  const manifestPath = resolve(args.manifest ?? args._?.[0] ?? "");
  if (!manifestPath || !existsSync(manifestPath)) {
    fail("preserved requires --manifest <manifest.json>");
  }
  requireFile(dbPath, "Memory database");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.format !== "memhub-core-migration-v2") {
    fail("unsupported migration manifest", { format: manifest.format });
  }
  const baselinePath = resolve(manifest.snapshot?.dbPath ?? "");
  requireFile(baselinePath, "Migration baseline database");

  const baseline = openDatabase(baselinePath);
  const current = openDatabase(dbPath);
  const baselineSchema = schemaHash(baseline);
  const currentSchema = schemaHash(current);
  const missing = [];
  const regressions = [];
  const checked = {};

  if (baselineSchema !== currentSchema) {
    regressions.push({ kind: "schema", expected: baselineSchema, current: currentSchema });
  }
  const tables = durableTableNames(baseline);
  for (const table of tables) {
    const pk = primaryKeyColumns(baseline, table);
    if (pk.length === 0) {
      const before = Number(baseline.prepare(`select count(*) as n from ${quoteId(table)}`).get().n);
      const after = Number(current.prepare(`select count(*) as n from ${quoteId(table)}`).get().n);
      checked[table] = { baselineRows: before, currentRows: after, primaryKey: [] };
      if (after < before) regressions.push({ kind: "row-count", table, baseline: before, current: after });
      continue;
    }
    const beforeRows = baseline.prepare(
      `select ${pk.map(quoteId).join(",")} from ${quoteId(table)} order by ${pk.map(quoteId).join(",")}`
    ).all();
    const currentKeys = new Set(current.prepare(
      `select ${pk.map(quoteId).join(",")} from ${quoteId(table)}`
    ).all().map((row) => keyTuple(pk, row)));
    const tableMissing = beforeRows
      .map((row) => keyTuple(pk, row))
      .filter((key) => !currentKeys.has(key));
    checked[table] = {
      baselineRows: beforeRows.length,
      currentRows: currentKeys.size,
      primaryKey: pk,
      missing: tableMissing.length
    };
    if (tableMissing.length > 0) {
      missing.push({ table, count: tableMissing.length, sample: tableMissing.slice(0, 10) });
    }
  }
  baseline.close();
  current.close();
  if (missing.length > 0 || regressions.length > 0) {
    fail("post-cutover database does not preserve the migration baseline", {
      manifest: manifestPath,
      db: dbPath,
      missing,
      regressions
    });
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    phase: "preserved",
    manifest: manifestPath,
    db: dbPath,
    tablesChecked: Object.keys(checked).length,
    baselineRowsPreserved: Object.values(checked).reduce((sum, item) => sum + item.baselineRows, 0),
    checked
  }, null, 2) + "\n");
}

function fingerprintDatabase(db) {
  const tableRows = db.prepare(
    "select name,sql from sqlite_master where type='table' and name not like 'sqlite_%' order by name"
  ).all();
  const durableTables = {};
  const tableCounts = {};
  for (const table of tableRows) {
    const name = table.name;
    try {
      tableCounts[name] = Number(db.prepare(`select count(*) as n from ${quoteId(name)}`).get().n);
    } catch (error) {
      tableCounts[name] = { unavailable: error instanceof Error ? error.message : String(error) };
    }
    if (isDerivedIndexTable(name) || isVolatileOperationalTable(name)) continue;
    durableTables[name] = hashTable(db, name);
  }
  const migrationState = db.prepare(
    "select id,version,checksum from schema_migrations order by id"
  ).all();
  return {
    integrity: integrity(db),
    userVersion: Number(db.pragma("user_version", { simple: true })),
    schemaHash: schemaHash(db),
    migrationStateHash: sha256Text(JSON.stringify(migrationState)),
    tableCounts,
    durableTables
  };
}

function schemaHash(db) {
  return sha256Text(JSON.stringify(db.prepare(
    "select type,name,tbl_name,sql from sqlite_master where sql is not null order by type,name"
  ).all()));
}

function durableTableNames(db) {
  return db.prepare(
    "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name"
  ).all().map((row) => row.name)
    .filter((name) => !isDerivedIndexTable(name) && !isVolatileOperationalTable(name));
}

function primaryKeyColumns(db, table) {
  return db.prepare(`pragma table_info(${quoteId(table)})`).all()
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => column.name);
}

function keyTuple(columns, row) {
  return JSON.stringify(columns.map((column) => normalizeKeyValue(row[column])));
}

function normalizeKeyValue(value) {
  if (Buffer.isBuffer(value)) return { blob: value.toString("base64") };
  if (typeof value === "bigint") return { bigint: value.toString() };
  return value;
}

function hashTable(db, table) {
  const columns = db.prepare(`pragma table_info(${quoteId(table)})`).all();
  const pk = columns.filter((column) => Number(column.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((column) => quoteId(column.name));
  const order = pk.length > 0 ? pk.join(",") : "rowid";
  const hash = createHash("sha256");
  let rows = 0;
  let iterator;
  try {
    iterator = db.prepare(`select * from ${quoteId(table)} order by ${order}`).iterate();
  } catch {
    const fallback = columns.map((column) => quoteId(column.name)).join(",");
    iterator = db.prepare(`select * from ${quoteId(table)} order by ${fallback}`).iterate();
  }
  for (const row of iterator) {
    rows += 1;
    for (const column of columns) {
      hash.update(column.name, "utf8");
      hash.update("\u0000");
      updateValue(hash, row[column.name]);
      hash.update("\u0001");
    }
    hash.update("\u0002");
  }
  return { rows, sha256: hash.digest("hex") };
}

function updateValue(hash, value) {
  if (value === null || value === undefined) {
    hash.update("null");
  } else if (Buffer.isBuffer(value)) {
    hash.update("blob:");
    hash.update(value);
  } else if (typeof value === "bigint") {
    hash.update(`bigint:${value.toString()}`);
  } else {
    hash.update(`${typeof value}:${String(value)}`, "utf8");
  }
}

function integrity(db) {
  const result = db.pragma("quick_check");
  return result.map((row) => Object.values(row)[0]).join("; ");
}

function openDatabase(path) {
  return new Database(path, { readonly: true, fileMustExist: true });
}

function isDerivedIndexTable(name) {
  return /_fts(?:_|$)/.test(name) || /^memory_vec_/.test(name);
}

function isVolatileOperationalTable(name) {
  // These rows are expected to change from service startup and read-only
  // validation itself. Their counts are still recorded in tableCounts, but
  // they are not part of the lossless content fingerprint.
  return name === "api_logs" || name === "recall_events" || name === "schema_migrations";
}

async function compareTrees(label, sourceRoot, vendorRoot, normalize = undefined) {
  if (!existsSync(sourceRoot)) fail(`${label} source runtime is missing`, { sourceRoot });
  if (!existsSync(vendorRoot)) fail(`${label} vendored runtime is missing`, { vendorRoot });
  const source = await treeFingerprint(sourceRoot, normalize);
  const vendor = await treeFingerprint(vendorRoot, normalize);
  return {
    label,
    equal: source.sha256 === vendor.sha256 && source.files === vendor.files,
    sourceRoot,
    vendorRoot,
    files: source.files,
    sourceSha256: source.sha256,
    vendorSha256: vendor.sha256
  };
}

async function verifyVendoredTree(label, root, expected) {
  if (!expected || typeof expected !== "object") {
    fail(`${label} is missing from vendor manifest`);
  }
  if (!existsSync(root)) fail(`${label} vendored runtime is missing`, { root });
  const actual = await treeFingerprint(root);
  return {
    label,
    equal: actual.files === expected.files && actual.sha256 === expected.sha256,
    root,
    files: actual.files,
    expectedFiles: expected.files,
    sha256: actual.sha256,
    expectedSha256: expected.sha256
  };
}

async function treeFingerprint(root, normalize = undefined) {
  const files = await walk(root);
  const hash = createHash("sha256");
  for (const path of files) {
    const rel = relative(root, path).replaceAll("\\", "/");
    hash.update(rel, "utf8");
    hash.update("\u0000");
    if (normalize) {
      const data = await readFile(path);
      hash.update(sha256Text(normalize(rel, data.toString("utf8"))), "utf8");
    } else {
      hash.update(await sha256File(path), "utf8");
    }
    hash.update("\u0001");
  }
  return { files: files.length, sha256: hash.digest("hex") };
}

async function walk(root) {
  const out = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function quoteId(value) {
  return '"' + String(value).replaceAll('"', '""') + '"';
}

function requireFile(path, label) {
  if (!existsSync(path)) fail(`${label} is missing`, { path });
}

function parseArgs(values) {
  const parsed = { _: [] };
  for (let i = 0; i < values.length; i += 1) {
    const arg = values[i];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const value = values[++i];
    if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
    parsed[key] = value;
  }
  return parsed;
}

function fail(message, details = undefined) {
  process.stderr.write(JSON.stringify({ ok: false, error: message, ...(details ? { details } : {}) }, null, 2) + "\n");
  process.exit(1);
}

function usage() {
  process.stderr.write([
    "Usage:",
    "  node scripts/core-migration.mjs preflight [--db PATH] [--config PATH] [--state-root PATH]",
    "  node scripts/core-migration.mjs verify --manifest PATH [--db PATH]",
    "  node scripts/core-migration.mjs preserved --manifest PATH [--db PATH]",
    "",
    "preflight performs runtime source/vendor parity checks, SQLite quick_check,",
    "an online SQLite backup, and a durable-table cryptographic fingerprint.",
    "verify is intended for a frozen exact cutover comparison. preserved checks",
    "that every durable record identity in a pre-cutover baseline still exists",
    "after the new core has resumed normal writes."
  ].join("\n") + "\n");
}
