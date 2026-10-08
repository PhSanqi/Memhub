import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAssetHygiene } from "../scripts/asset-hygiene.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "memhub-asset-hygiene-e2e-"));
const root = join(sandbox, "Memhub");

async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function fixtureDir(path, body = "fixture\n") {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "payload.txt"), body);
}

try {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "memhub", version: "0.2.6" }) + "\n");
  await fixtureDir(join(root, "release", "v0.2.5"));
  await fixtureDir(join(root, "release", "v0.2.6"));

  const review = join(root, ".review-runtime");
  const pack1 = join(review, "review-pack-v2");
  const pack2 = join(review, "review-pack-v2-2");
  const pack3 = join(review, "review-pack-v2-3");
  await fixtureDir(pack1, "oldest\n");
  await fixtureDir(pack2, "previous\n");
  await fixtureDir(pack3, "current\n");
  const now = Date.now() / 1000;
  await utimes(pack1, now - 300, now - 300);
  await utimes(pack2, now - 200, now - 200);
  await utimes(pack3, now - 100, now - 100);
  await fixtureDir(join(review, "qa-complete-old"));
  await fixtureDir(join(review, "fresh-eyes-old"));
  await fixtureDir(join(review, "win-transfer"));
  await fixtureDir(join(review, "live-prod-keep"));
  await fixtureDir(join(review, "redesign-v2", "pages"));
  await mkdir(join(review, "redesign-v2"), { recursive: true });
  await writeFile(join(review, "redesign-v2", "latest-pack.txt"), pack3 + "\n");
  await fixtureDir(join(sandbox, "memhub_release_rebuild_20261001"));

  const audit = await runAssetHygiene({ root, keepReview: 2 });
  const candidates = new Set(audit.candidates.map((item) => item.path));
  assert.ok(candidates.has("release/v0.2.5"));
  assert.ok(candidates.has(".review-runtime/review-pack-v2"));
  assert.ok(candidates.has(".review-runtime/qa-complete-old"));
  assert.ok(candidates.has(".review-runtime/fresh-eyes-old"));
  assert.ok(candidates.has(".review-runtime/win-transfer"));
  assert.ok(candidates.has(".review-runtime/redesign-v2/pages"));
  assert.ok(!candidates.has("release/v0.2.6"));
  assert.ok(!candidates.has(".review-runtime/review-pack-v2-2"));
  assert.ok(!candidates.has(".review-runtime/review-pack-v2-3"));
  assert.ok(!candidates.has(".review-runtime/live-prod-keep"));
  assert.ok(audit.externalReviewRequired.includes(join(sandbox, "memhub_release_rebuild_20261001")));
  assert.equal(await exists(join(root, "release", "v0.2.5")), true, "audit must be non-destructive");

  const releaseOnly = await runAssetHygiene({
    root,
    apply: true,
    releaseOnly: true,
    currentReleaseOverride: "v0.2.6"
  });
  assert.ok(releaseOnly.removed.some((item) => item.path === "release/v0.2.5"));
  assert.equal(await exists(join(root, "release", "v0.2.5")), false);
  assert.equal(await exists(join(root, "release", "v0.2.6")), true);
  assert.equal(await exists(pack1), true, "release-only cleanup must not touch review packs");
  assert.equal(await exists(join(review, "qa-complete-old")), true,
    "release-only cleanup must not touch QA/review outputs");
  await fixtureDir(join(root, "release", "v0.2.5"));

  await runAssetHygiene({ root, apply: true, keepReview: 2, reviewPacksOnly: true });
  assert.equal(await exists(pack1), false, "pack-only cleanup must remove superseded review packs");
  assert.equal(await exists(pack2), true);
  assert.equal(await exists(pack3), true);
  assert.equal(await exists(join(root, "release", "v0.2.5")), true, "pack-only cleanup must not touch release outputs");
  assert.equal(await exists(join(review, "fresh-eyes-old")), true, "pack-only cleanup must not touch other review evidence");

  const applied = await runAssetHygiene({ root, apply: true, keepReview: 2 });
  assert.ok(applied.removed.some((item) => item.path === "release/v0.2.5"));
  assert.equal(await exists(join(root, "release", "v0.2.5")), false);
  assert.equal(await exists(join(root, "release", "v0.2.6")), true);
  assert.equal(await exists(join(review, "qa-complete-old")), false);
  assert.equal(await exists(join(review, "fresh-eyes-old")), false);
  assert.equal(await exists(join(review, "win-transfer")), false);
  assert.equal(await exists(join(review, "redesign-v2", "pages")), false);
  assert.equal(await exists(join(review, "live-prod-keep")), true);
  assert.equal(await exists(pack2), true);
  assert.equal(await exists(pack3), true);
  assert.equal((await readFile(join(review, "redesign-v2", "latest-pack.txt"), "utf8")).trim(), pack3);
  assert.equal(await exists(join(sandbox, "memhub_release_rebuild_20261001")), true,
    "external historical directories are report-only and require separate review");

  console.log("memhub-asset-hygiene-e2e: ok");
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
