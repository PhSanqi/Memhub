#!/usr/bin/env node

import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const stateRoot = resolve(args["state-root"] ?? join(homedir(), ".memmy", "memhub"));
const apply = Boolean(args.apply);
const keepMigrations = integerArg(args["keep-migrations"], 3);
const keepRepairs = integerArg(args["keep-repairs"], 1);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const archiveRoot = join(stateRoot, "archive", "state-hygiene", stamp);

const accounts = await registeredAccountIds();
const candidates = [];

await collectOldDirectories("core-migrations", keepMigrations, "superseded rollback snapshot");
await collectOldDirectories("repairs", keepRepairs, "superseded repair snapshot");
await collectOrphanCapturePartitions();
await collectMatchingFiles(join(stateRoot, "distillation"), /^jobs\.json\.before-/,
  "legacy distillation backup no longer read by runtime");
await collectMatchingFiles(stateRoot, /^memhub\.env\..*\.bak$/,
  "legacy environment backup outside active configuration");

const report = {
  ok: true,
  apply,
  stateRoot,
  archiveRoot: apply ? archiveRoot : undefined,
  registeredAccounts: [...accounts].sort(),
  policy: { keepMigrations, keepRepairs },
  candidates: candidates.map(({ source, relative, bytes, reason }) => ({ source, relative, bytes, reason })),
  totalBytes: candidates.reduce((sum, item) => sum + item.bytes, 0)
};

if (!apply) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(0);
}

await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
const moved = [];
for (const item of candidates) {
  const destination = join(archiveRoot, item.relative);
  await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
  await rename(item.source, destination);
  moved.push({ ...item, destination });
}

const manifest = {
  ...report,
  moved: moved.map(({ source, destination, relative, bytes, reason }) => ({ source, destination, relative, bytes, reason })),
  restore: "Move any archived path back to its original source path. No files were deleted."
};
await writeFile(join(archiveRoot, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
process.stdout.write(JSON.stringify({ ...manifest, manifest: join(archiveRoot, "MANIFEST.json") }, null, 2) + "\n");

async function registeredAccountIds() {
  const path = join(stateRoot, "accounts.json");
  if (!existsSync(path)) return new Set();
  const data = JSON.parse(await readFile(path, "utf8"));
  return new Set(Object.values(data.accounts ?? {}).map((record) => record?.account_id).filter(Boolean));
}

async function collectOldDirectories(name, keep, reason) {
  const root = join(stateRoot, name);
  if (!existsSync(root)) return;
  const entries = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    entries.push({ path, name: entry.name, mtimeMs: (await stat(path)).mtimeMs });
  }
  entries.sort((a, b) => b.name.localeCompare(a.name));
  for (const item of entries.slice(Math.max(0, keep))) {
    candidates.push(await candidate(item.path, join(name, item.name), reason));
  }
}

async function collectOrphanCapturePartitions() {
  const root = join(stateRoot, "captures");
  if (!existsSync(root)) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const ids = new Set();
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const event = JSON.parse(await readFile(join(dir, file), "utf8"));
        if (typeof event.account_id === "string") ids.add(event.account_id);
      } catch {
        // A malformed capture directory is safer to leave in place for manual inspection.
      }
    }
    if (ids.size > 0 && [...ids].every((id) => !accounts.has(id))) {
      candidates.push(await candidate(dir, join("captures", entry.name),
        `orphan capture partition for unregistered account(s): ${[...ids].sort().join(",")}`));
    }
  }
}

async function collectMatchingFiles(root, pattern, reason) {
  if (!existsSync(root)) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const path = join(root, entry.name);
    const relativeRoot = root === stateRoot ? "root-backups" : basename(root);
    candidates.push(await candidate(path, join(relativeRoot, entry.name), reason));
  }
}

async function candidate(source, relative, reason) {
  return { source, relative, reason, bytes: await treeBytes(source) };
}

async function treeBytes(path) {
  const info = await stat(path);
  if (info.isFile()) return info.size;
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    total += await treeBytes(join(path, entry.name));
  }
  return total;
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else { out[key] = next; index += 1; }
  }
  return out;
}

function integerArg(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1000) throw new Error(`invalid integer: ${value}`);
  return parsed;
}
