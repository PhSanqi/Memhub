#!/usr/bin/env node

import { lstat, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_PACK_RE = /^review-pack-v2(?:-\d+)?$/;
const RELEASE_DIR_RE = /^v\d+\.\d+\.\d+$/;
const EXTERNAL_HISTORY_RE = /^(?:memhub_release_rebuild_|memhub_history_rewrite_).*(?:worktree|checkout|\d{8})?/i;

export async function runAssetHygiene({
  root = DEFAULT_ROOT,
  apply = false,
  keepReview = 2,
  reviewPacksOnly = false,
  releaseOnly = false,
  currentReleaseOverride
} = {}) {
  root = resolve(root);
  if (reviewPacksOnly && releaseOnly) {
    throw new Error("reviewPacksOnly and releaseOnly are mutually exclusive");
  }
  if (!Number.isInteger(keepReview) || keepReview < 1 || keepReview > 10) {
    throw new Error("keepReview must be an integer from 1 to 10");
  }

  const releaseRoot = join(root, "release");
  const reviewRoot = join(root, ".review-runtime");
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const currentRelease = currentReleaseOverride ?? `v${packageJson.version}`;
  if (!RELEASE_DIR_RE.test(currentRelease)) throw new Error(`invalid current release: ${currentRelease}`);
  const candidates = [];
  const kept = [];
  const unknownReview = [];

  if (!reviewPacksOnly) {
    for (const entry of await safeReadDir(releaseRoot)) {
      if (!entry.isDirectory() || !RELEASE_DIR_RE.test(entry.name)) continue;
      const path = join(releaseRoot, entry.name);
      if (entry.name === currentRelease) kept.push({ kind: "current-release", path: relative(root, path) });
      else await addCandidate(candidates, root, releaseRoot, path, "superseded release output");
    }
  }

  const reviewEntries = releaseOnly ? [] : (await safeReadDir(reviewRoot)).filter((entry) => entry.isDirectory());
  if (!releaseOnly) {
    const packEntries = [];
    for (const entry of reviewEntries) {
      if (!REVIEW_PACK_RE.test(entry.name)) continue;
      const path = join(reviewRoot, entry.name);
      const info = await stat(path);
      packEntries.push({ name: entry.name, path, mtimeMs: info.mtimeMs });
    }
    packEntries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));

    const latestPointer = await readLatestReviewPointer(reviewRoot);
    const protectedPacks = [];
    if (latestPointer && packEntries.some((item) => item.path === latestPointer)) protectedPacks.push(latestPointer);
    for (const item of packEntries) {
      if (protectedPacks.length >= keepReview) break;
      if (!protectedPacks.includes(item.path)) protectedPacks.push(item.path);
    }
    for (const item of packEntries) {
      if (protectedPacks.includes(item.path)) kept.push({ kind: "review-pack", path: relative(root, item.path) });
      else await addCandidate(candidates, root, reviewRoot, item.path, `review retention keeps ${keepReview}`);
    }
  }

  if (!reviewPacksOnly && !releaseOnly) {
    for (const entry of reviewEntries) {
      if (REVIEW_PACK_RE.test(entry.name)) continue;
      const path = join(reviewRoot, entry.name);
      if (/^qa-complete-/.test(entry.name)) {
        await addCandidate(candidates, root, reviewRoot, path, "complete QA output is reproducible");
      } else if (/^fresh-eyes-/.test(entry.name)) {
        await addCandidate(candidates, root, reviewRoot, path, "superseded visual review output");
      } else if (entry.name === "win-transfer") {
        await addCandidate(candidates, root, reviewRoot, path, "temporary transfer bundle");
      } else if (/^live-prod-/.test(entry.name)) {
        kept.push({ kind: "production-evidence", path: relative(root, path) });
      } else if (entry.name === "redesign-v2") {
        kept.push({ kind: "review-control", path: relative(root, path) });
      } else {
        unknownReview.push(relative(root, path));
      }
    }
    const pages = join(reviewRoot, "redesign-v2", "pages");
    if (await pathExists(pages)) {
      await addCandidate(candidates, root, reviewRoot, pages, "generated review page staging");
    }
  }

  const externalReviewRequired = [];
  if (!reviewPacksOnly && !releaseOnly) {
    const parent = dirname(root);
    for (const entry of await safeReadDir(parent)) {
      if (!entry.isDirectory() || !EXTERNAL_HISTORY_RE.test(entry.name)) continue;
      const path = join(parent, entry.name);
      if (path === root) continue;
      externalReviewRequired.push(path);
    }
  }

  const report = {
    ok: true,
    apply,
    root,
    policy: {
      currentRelease,
      keepReview,
      reviewPacksOnly,
      releaseOnly,
      externalHistory: "report-only"
    },
    candidates: candidates.map(({ path, bytes, reason }) => ({ path: relative(root, path), bytes, reason })),
    totalBytes: candidates.reduce((sum, item) => sum + item.bytes, 0),
    kept,
    unknownReview,
    externalReviewRequired
  };

  if (!apply) return report;

  const removed = [];
  for (const item of candidates) {
    await safeRemove(root, item.path);
    removed.push({ path: relative(root, item.path), bytes: item.bytes, reason: item.reason });
  }
  return { ...report, removed };
}

async function addCandidate(candidates, root, managedRoot, path, reason) {
  assertInside(root, managedRoot);
  assertInside(managedRoot, path);
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`refusing symlink candidate: ${path}`);
  candidates.push({ path, bytes: await treeBytes(path), reason });
}

async function safeRemove(root, path) {
  const releaseRoot = join(root, "release");
  const reviewRoot = join(root, ".review-runtime");
  if (!isInside(releaseRoot, path) && !isInside(reviewRoot, path)) {
    throw new Error(`refusing path outside generated roots: ${path}`);
  }
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`refusing symlink removal: ${path}`);
  await rm(path, { recursive: true, force: true });
}

async function readLatestReviewPointer(reviewRoot) {
  const pointer = join(reviewRoot, "redesign-v2", "latest-pack.txt");
  try {
    const raw = (await readFile(pointer, "utf8")).trim();
    if (!raw) return null;
    const path = isAbsolute(raw) ? resolve(raw) : resolve(reviewRoot, raw);
    if (!isInside(reviewRoot, path) || !REVIEW_PACK_RE.test(basename(path))) return null;
    return path;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function safeReadDir(path) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function pathExists(path) {
  try { await lstat(path); return true; }
  catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function treeBytes(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`refusing to follow symlink: ${path}`);
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    total += await treeBytes(join(path, entry.name));
  }
  return total;
}

function assertInside(base, target) {
  if (!isInside(base, target)) throw new Error(`path escapes managed root: ${target}`);
}

function isInside(base, target) {
  const rel = relative(resolve(base), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function argumentValue(flag, args = process.argv.slice(2)) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

async function main() {
  const keepRaw = argumentValue("--keep-review");
  const keepReview = keepRaw === undefined ? 2 : Number(keepRaw);
  const report = await runAssetHygiene({
    root: DEFAULT_ROOT,
    apply: process.argv.includes("--apply"),
    keepReview,
    reviewPacksOnly: process.argv.includes("--review-packs-only"),
    releaseOnly: process.argv.includes("--release-only")
  });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
}
