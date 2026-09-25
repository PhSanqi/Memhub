import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCoreDatabase } from "../scripts/stability-state.mjs";

const home = await mkdtemp(join(tmpdir(), "memhub-stability-state-"));
try {
  assert.equal(detectCoreDatabase(home), null);
  const clean = join(home, ".memhub", "core", "memory.sqlite");
  await mkdir(join(home, ".memhub", "core"), { recursive: true });
  await writeFile(clean, "test");
  assert.equal(detectCoreDatabase(home), clean);
  const legacy = join(home, ".memmy", "memory-service", "memory.sqlite");
  await mkdir(join(home, ".memmy", "memory-service"), { recursive: true });
  await writeFile(legacy, "test");
  assert.equal(detectCoreDatabase(home), legacy, "legacy Core path takes precedence as in core-migration");
  console.log("stability-state-e2e: ok");
} finally {
  await rm(home, { recursive: true, force: true });
}
