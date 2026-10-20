import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempRoot = join(repo, ".tmp-tests");
const protectedRoot = join(homedir(), ".memmy");

function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function realPath(path) {
  try { return realpathSync(path); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return join(realPath(dirname(path)), relative(dirname(path), path));
  }
}

export function assertTestPaths(paths) {
  for (const [name, value] of Object.entries(paths)) {
    const path = resolve(value);
    assert.ok(!inside(protectedRoot, path), `${name} must not be inside ~/.memmy`);
    const actual = realPath(path);
    assert.ok(!inside(protectedRoot, actual), `${name} must not resolve inside ~/.memmy`);
    assert.ok(inside(realPath(repo), actual) && actual !== realPath(repo), `${name} must stay under memhubruntime`);
  }
}

export async function createTestRoot(prefix) {
  assertTestPaths({ tempRoot });
  await mkdir(tempRoot, { recursive: true });
  return mkdtemp(join(tempRoot, prefix));
}

export function testEnvironment(stateRoot, architectureRoot, overrides = {}, inherited = process.env) {
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !key.toUpperCase().startsWith("MEMHUB_")));
  Object.assign(env, {
    TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot,
    MEMHUB_STATE_ROOT: resolve(stateRoot),
    MEMHUB_ARCHITECTURE_ROOT: resolve(architectureRoot),
    ...overrides
  });
  const controlRoot = env.MEMHUB_CONTROL_ROOT ?? env.MEMHUB_STATE_ROOT;
  assertTestPaths({
    stateRoot: env.MEMHUB_STATE_ROOT,
    controlRoot,
    architectureRoot: env.MEMHUB_ARCHITECTURE_ROOT,
    registry: env.MEMHUB_PROJECT_REGISTRY ?? join(controlRoot, "project-registry.json"),
    branches: env.MEMHUB_BRANCHES ?? join(controlRoot, "project-branches.json"),
    ...(env.MEMHUB_MEMORY_DB ? { memoryDb: env.MEMHUB_MEMORY_DB } : {}),
    ...(env.MEMHUB_HOME ? { home: env.MEMHUB_HOME } : {})
  });
  return env;
}

// Stack tests also construct runtimes in-process and spawn crash workers.
export function isolateTestEnvironment(stateRoot, architectureRoot) {
  const env = testEnvironment(stateRoot, architectureRoot);
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase().startsWith("MEMHUB_")) delete process.env[key];
  }
  Object.assign(process.env, env);
}
