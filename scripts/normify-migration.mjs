#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const rootDir = resolve(args.root ?? process.env.MEMHUB_NORMIFY_ROOT ?? process.cwd());
const stateRoot = resolve(args.stateRoot ?? join(homedir(), ".memmy", "memhub"));
const accountId = args.accountId ?? await singleAccountId(stateRoot);
const accountRoot = join(rootDir, ".normify", "accounts", accountHash(accountId));
const legacy = await discoverLegacyArchitectureDirs(rootDir);

const rows = [];
for (const source of legacy) {
  const target = join(accountRoot, basename(source.dir));
  const targetHasModules = await hasModules(target);
  if (targetHasModules) {
    rows.push({
      project: source.slug,
      source: source.dir,
      target,
      action: "already_present"
    });
    continue;
  }
  if (await exists(target)) {
    rows.push({
      project: source.slug,
      source: source.dir,
      target,
      action: "conflict_target_exists_without_modules"
    });
    continue;
  }
  if (!args.apply) {
    rows.push({
      project: source.slug,
      source: source.dir,
      target,
      action: "would_copy"
    });
    continue;
  }
  await mkdir(accountRoot, { recursive: true });
  await cp(source.dir, target, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true
  });
  rows.push({
    project: source.slug,
    source: source.dir,
    target,
    action: "copied"
  });
}

console.log(JSON.stringify({
  ok: true,
  apply: args.apply,
  rootDir,
  accountHash: accountHash(accountId),
  discovered: legacy.length,
  rows
}, null, 2));

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
    else if (arg === "--root") out.root = value();
    else if (arg === "--state-root") out.stateRoot = value();
    else if (arg === "--account-id") out.accountId = value();
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/normify-migration.mjs [--root DIR] [--state-root DIR] [--account-id ID] [--apply]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

async function singleAccountId(stateRoot) {
  const path = join(stateRoot, "accounts.json");
  const parsed = JSON.parse(await readFile(path, "utf8"));
  const records = Object.values(parsed?.accounts ?? {})
    .filter((record) => record && typeof record === "object" && typeof record.account_id === "string");
  if (records.length !== 1) {
    throw new Error("cannot infer account_id: pass --account-id when accounts.json does not contain exactly one account");
  }
  return records[0].account_id;
}

async function discoverLegacyArchitectureDirs(rootDir) {
  const found = new Map();
  await walk(resolve(rootDir), 2);
  return [...found.values()].sort((left, right) => left.dir.localeCompare(right.dir));

  async function walk(directory, depth) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === ".git" || entry.name === ".normify" || entry.name === "node_modules") continue;
      const candidate = join(directory, entry.name);
      if (entry.name.startsWith("normify-")) {
        if (await hasModules(candidate)) {
          found.set(candidate, {
            dir: candidate,
            slug: entry.name.slice("normify-".length)
          });
        }
        continue;
      }
      if (depth > 0) await walk(candidate, depth - 1);
    }
  }
}

async function hasModules(projectDir) {
  try {
    return (await stat(join(projectDir, "modules"))).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function accountHash(accountId) {
  return createHash("sha256").update(accountId.trim(), "utf8").digest("hex");
}
