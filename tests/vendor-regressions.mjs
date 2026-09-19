import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createLlmClient } from "../vendor/memory-core/src/model/llm.js";
import { scanLocalProject } from "../vendor/memory-core/src/service/project-environment/local-scanner.js";
import { Repositories } from "../vendor/memory-core/src/storage/repositories.js";
import { migrate } from "../vendor/memory-core/src/storage/schema.js";

const root = await mkdtemp(join(tmpdir(), "memhub-vendor-regression-"));
try {
  testUnavailableAssignedModelIsNotConfigured();
  testWorkerCanExcludeModelDependentJobs();
  await testProjectScannerSkipsUnreadableChild();
  console.log("memhub-vendor-regressions: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function testProjectScannerSkipsUnreadableChild() {
  if (process.platform === "win32") return;
  const project = join(root, "scan-project");
  const blocked = join(project, "blocked");
  await mkdir(blocked, { recursive: true });
  await writeFile(join(project, "package.json"), '{"name":"scan-project"}\n', "utf8");
  await chmod(blocked, 0o000);
  try {
    const scan = await scanLocalProject(pathToFileURL(project).toString());
    assert.ok(scan.entries.some((entry) => entry.relativePath === "package.json"));
  } finally {
    await chmod(blocked, 0o700);
  }
}

function testUnavailableAssignedModelIsNotConfigured() {
  const llm = createLlmClient({
    provider: "openai",
    vendor: "openai",
    endpoint: "https://example.invalid",
    model: "unavailable-model",
    apiKey: "not-a-real-key",
    selectionError: "model_selection_unavailable",
    enableThinking: false,
    temperature: 0,
    maxTokens: 128,
    timeoutMs: 1_000,
    maxRetries: 0,
    malformedRetries: 0
  });
  assert.equal(llm.isConfigured(), false);
}

function testWorkerCanExcludeModelDependentJobs() {
  const db = new Database(join(root, "jobs.sqlite"));
  try {
    migrate(db);
    const at = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO evolution_jobs (
        id, job_type, status, user_id, scope_key, scope_seq, payload_json,
        attempts, max_attempts, created_at, updated_at
      ) VALUES (?, ?, 'queued', 'test-user', ?, ?, '{}', 0, 3, ?, ?)
    `);
    insert.run("job-l3", "l3_world_model_update", "scope:test", 1, at, at);
    insert.run("job-env", "project_environment_profile", null, null, at, at);
    insert.run("job-normal", "reflection", null, null, at, at);

    const repos = new Repositories(db);
    const leased = repos.runtime.leaseQueuedJobs(
      10,
      60,
      undefined,
      false,
      ["l3_world_model_update", "project_environment_profile"]
    );
    assert.deepEqual(leased.map((job) => job.id), ["job-normal"]);
    assert.equal(repos.runtime.getJob("job-l3")?.status, "queued");
    assert.equal(repos.runtime.getJob("job-env")?.status, "queued");
    assert.equal(repos.runtime.getJob("job-normal")?.status, "leased");
  } finally {
    db.close();
  }
}
