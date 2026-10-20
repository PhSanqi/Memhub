import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MemoryDb } from "../vendor/memory-core/src/storage/db.js";
import { Repositories } from "../vendor/memory-core/src/storage/repositories.js";
import { MemoryService } from "../vendor/memory-core/src/service/memory-service.js";
import {
  buildIdentitiesMatch,
  probeServiceHealth,
  readLocalBuildIdentity,
  waitForService
} from "../dist/service-readiness.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const at = "2026-10-19T00:00:00.000Z";

// U2: startup summary repairs must not starve interactive embedding work.
function enqueue(repos, id, jobType, payload, targetMemoryId) {
  return repos.runtime.enqueueJob({
    id, jobType, status: "queued", userId: "p5", targetMemoryId, payload,
    attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at
  });
}
const db = new MemoryDb({ path: ":memory:" });
try {
  const repos = new Repositories(db.db);
  enqueue(repos, "p5-embedding", "embedding", { reason: "startup.processing_repair" }, "m-embed");
  enqueue(repos, "p5-summary", "trace_summary", { source: "startup.processing_repair" }, "m-summary");
  const interactive = repos.runtime.leaseQueuedJobs(1);
  assert.equal(interactive.length, 1);
  assert.equal(interactive[0].jobType, "embedding", "interactive embedding is leased before startup repair");
} finally {
  db.close();
}
const summaryDb = new MemoryDb({ path: ":memory:" });
try {
  const repos = new Repositories(summaryDb.db);
  enqueue(repos, "p5-summary", "trace_summary", { source: "startup.processing_repair" }, "m-summary");
  enqueue(repos, "p5-plain", "trace_summary", { source: "memory.processing" }, "m-plain");
  const summary = repos.runtime.leaseQueuedJobs(1);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].id, "p5-plain", "only startup repair summary jobs are deprioritized");
} finally {
  summaryDb.close();
}

// U3/U4: honest health and the Core build identity.
const healthDb = new MemoryDb({ path: ":memory:" });
try {
  const service = new MemoryService({ db: healthDb });
  const manifest = JSON.parse(await readFile(join(root, "vendor", "manifest.json"), "utf8"));
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const healthy = service.health();
  assert.equal(healthy.ok, true, "a model-free install is healthy");
  assert.deepEqual(healthy.degraded, []);
  assert.deepEqual(healthy.build, {
    vendorSha256: manifest.components.memory.sha256,
    memhubVersion: packageJson.version
  });

  const modelStatus = (overrides = {}) => ({
    provider: "local", model: "test", configured: true, remote: false, lastOkAt: null, lastError: null,
    ...overrides
  });
  const originalResolveContext = service.modelTasks.resolveContext;
  service.modelTasks.resolveContext = () => ({
    summary: { status: () => modelStatus({ configured: false, lastError: "summary model unavailable" }) },
    evolution: { status: () => modelStatus({ configured: false }) },
    embedding: { status: () => modelStatus({ lastError: "onnx load failed" }) }
  });
  try {
    const optionalOnly = service.health();
    assert.equal(optionalOnly.ok, false);
    assert.deepEqual(optionalOnly.degraded, ["embedding"]);
    service.modelTasks.resolveContext = () => ({
      summary: { status: () => modelStatus({ configured: false, lastError: "summary model unavailable" }) },
      evolution: { status: () => modelStatus({ configured: false }) },
      embedding: { status: () => modelStatus() }
    });
    assert.equal(service.health().ok, true, "unconfigured optional models never fail health");
  } finally {
    service.modelTasks.resolveContext = originalResolveContext;
  }

  const originalSchemaVersion = healthDb.schemaVersion.bind(healthDb);
  healthDb.schemaVersion = () => ({ version: 0, lastMigrationId: null });
  try {
    const unmigrated = service.health();
    assert.equal(unmigrated.ok, false);
    assert.ok(unmigrated.degraded.includes("schema"));
  } finally {
    healthDb.schemaVersion = originalSchemaVersion;
  }
} finally {
  healthDb.close();
}

const localBuild = readLocalBuildIdentity();
assert.ok(localBuild.vendorSha256 && localBuild.memhubVersion);
assert.equal(buildIdentitiesMatch(localBuild, localBuild), true);
assert.equal(buildIdentitiesMatch(localBuild, { ...localBuild, vendorSha256: "stale" }), false);
assert.equal(buildIdentitiesMatch(localBuild, undefined), false);

// U4: the readiness script rejects a stale Core against a fake health server.
const coreHealth = {
  ok: true,
  serviceVersion: "2.1.2",
  protocolVersion: 1,
  storage: { ready: true },
  degraded: ["embedding"],
  build: { ...localBuild }
};
const port = await freePort();
const server = createServer((request, response) => {
  if (request.url !== "/health") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(coreHealth));
});
await new Promise((resolveReady) => server.listen(port, "127.0.0.1", resolveReady));
try {
  const url = `http://127.0.0.1:${port}/health`;
  const healthy = await probeServiceHealth(url, "core");
  assert.equal(healthy.ok, true);
  assert.deepEqual(healthy.degraded, ["embedding"], "degraded parts are surfaced without failing readiness");
  assert.deepEqual(healthy.build, localBuild);
  const ready = await waitForService({ url, kind: "core", timeoutMs: 2_000, expectedBuild: localBuild });
  assert.deepEqual(ready.build, localBuild);

  await assert.rejects(
    () => waitForService({
      url, kind: "core", timeoutMs: 2_000,
      expectedBuild: { ...localBuild, vendorSha256: "stale".padEnd(64, "0") }
    }),
    /core build mismatch/
  );

  coreHealth.build = { vendorSha256: "stale".padEnd(64, "0"), memhubVersion: localBuild.memhubVersion };
  const script = join(root, "scripts", "wait-for-service.mjs");
  await assert.rejects(
    () => promisify(execFile)(process.execPath, [script, "--url", url, "--kind", "core", "--timeout-ms", "3000"]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /core build mismatch/);
      assert.match(error.stderr, /stale after an upgrade/);
      return true;
    }
  );
} finally {
  await new Promise((resolveClosed) => server.close(resolveClosed));
}

// U5: the upstream baseline is recorded and discoverable.
const manifest = JSON.parse(await readFile(join(root, "vendor", "manifest.json"), "utf8"));
assert.deepEqual(manifest.upstream, {
  repo: "https://github.com/MemTensor/memmy-agent",
  tag: "v1.1.4",
  commit: "98146714",
  memoryServiceVersion: "2.1.2",
  reviewedThrough: "4da4f9e0 (v1.2.2)",
  absorbed: ["478ae78c"]
});
const upstreamDoc = await readFile(join(root, "docs", "maintainers", "upstream.md"), "utf8");
assert.ok(upstreamDoc.includes("vendor/manifest.json"));
assert.ok(upstreamDoc.includes("docs/reviews/2026-10-19-upstream-review.md"));

console.log("memhub-p5-upstream-memhub: ok");

async function freePort() {
  const probe = createServer();
  await new Promise((resolveReady) => probe.listen(0, "127.0.0.1", resolveReady));
  const assigned = probe.address().port;
  await new Promise((resolveClosed) => probe.close(resolveClosed));
  return assigned;
}
