import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { canonicalJson } from "../vendor/memory-core/src/contracts/index.js";
import { DEFAULT_MEMMY_CONFIG } from "../vendor/memory-core/src/config/index.js";
import { MemoryDb } from "../vendor/memory-core/src/storage/db.js";
import { attachMemoryVector } from "../vendor/memory-core/src/storage/memory-vector-state.js";
import { MemoryService } from "../vendor/memory-core/src/service/memory-service.js";
import { NDJSON_BUNDLE_FORMAT, verifyNdjsonBundle } from "../vendor/memory-core/src/service/bundle-ndjson.js";
import { closeMemoryHttpServer, listenMemoryHttpServer } from "../vendor/memory-core/src/server/http.js";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = "/tmp/p6me1";
const at = "2026-10-20T00:00:00.000Z";
const sha256Empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

async function tempDir() {
  await mkdir(scratch, { recursive: true });
  return mkdtemp(join(scratch, "case-"));
}

function exportConfig(overrides = {}) {
  const config = structuredClone(DEFAULT_MEMMY_CONFIG);
  config.algorithm = { ...config.algorithm, enableMemoryAdd: false, ...overrides };
  return config;
}

function memory(id, value, vector) {
  return attachMemoryVector({
    id, timeline: at, userId: "p6", memoryType: "fact", status: "activated", visibility: "private",
    memoryValue: value, memoryLayer: "L3", tags: ["p6"], info: {}, properties: { internal_info: {} },
    version: 1, createdAt: at, updatedAt: at
  }, vector);
}

async function createFixture() {
  const dir = await tempDir();
  const path = join(dir, "memory.sqlite");
  const db = new MemoryDb({ path });
  const service = new MemoryService({ db, config: exportConfig() });
  service.repos.memories.insert(memory("mem-a", "alpha 你好 ✨", { vectorField: "vec", vector: [0.25, 0.5, 0.75] }));
  service.repos.memories.insert(memory("mem-b", "beta plain", { vectorField: "vec", vector: [1, -1, 0] }));
  // Composite primary key (user_id, project_id), inserted out of order on purpose.
  const insertEnvironment = db.db.prepare(`INSERT INTO l3_world_model_project_environment_state
    (user_id, project_id, project_kind, status, updated_at) VALUES (?, ?, ?, ?, ?)`);
  insertEnvironment.run("u1", "p2", "code", "clean", at);
  insertEnvironment.run("u1", "p1", "folder", "queued", at);
  // A BLOB stored in artifacts.uri exercises the shared bundle Buffer encoding.
  db.db.prepare(`INSERT INTO artifacts (id, user_id, kind, uri, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run("art-1", "u1", "file", Buffer.from([0, 1, 2, 255]), "{}", at);
  // Text primary keys must be ordered with BINARY collation.
  const insertKv = db.db.prepare(`INSERT INTO runtime_kv (key, value_json, updated_at) VALUES (?, ?, ?)`);
  insertKv.run("zeta", "{}", at);
  insertKv.run("alpha", "{}", at);
  return { dir, path, db, service };
}

async function exportToString(service, request = {}) {
  const chunks = [];
  const summary = await service.streamBundleExport(
    { includeRawText: true, includeAudit: true, ...request },
    (chunk) => { chunks.push(Buffer.from(chunk)); }
  );
  return { text: Buffer.concat(chunks).toString("utf8"), summary };
}

function rowsByTable(text) {
  const tables = new Map();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const record = JSON.parse(line);
    if (record.type === "row") {
      if (!tables.has(record.table)) tables.set(record.table, []);
      tables.get(record.table).push(record.data);
    }
  }
  return tables;
}

function sortedJson(rows) {
  return rows.map((row) => canonicalJson(row)).sort();
}

async function expectVerifierFailure(text, pattern) {
  await assert.rejects(
    verifyNdjsonBundle(Readable.from([text])),
    (error) => {
      assert.match(error.message, pattern);
      assert.ok(!error.message.includes("alpha"), "verifier errors must not leak row data");
      assert.ok(!error.message.includes("你好"), "verifier errors must not leak row data");
      return true;
    }
  );
}

test("ME-1 file-backed NDJSON export round-trips, matches legacy rows and verifies", async () => {
  const { dir, db, service } = await createFixture();
  try {
    const { text, summary } = await exportToString(service);
    assert.equal(summary.format, NDJSON_BUNDLE_FORMAT);
    assert.ok(summary.tables.some((table) => table.table === "memory_vectors"));
    const file = join(dir, "bundle.ndjson");
    await writeFile(file, text);

    const verified = await verifyNdjsonBundle(createReadStream(file));
    assert.equal(verified.ok, true);
    assert.equal(verified.exportId, summary.exportId);
    assert.deepEqual(verified.tables, summary.tables);

    // The standalone CLI prints one JSON line and exits zero.
    const cli = await execFileAsync(process.execPath, [join(root, "scripts", "verify-bundle.mjs"), file]);
    const cliSummary = JSON.parse(cli.stdout.trim());
    assert.equal(cliSummary.ok, true);
    assert.equal(cliSummary.manifestSha256, summary.manifestSha256);
    assert.equal(cli.stdout.trim().split("\n").length, 1);

    // Per-table row counts equal SELECT COUNT(*) (vectors use their metadata table).
    for (const table of summary.tables) {
      const source = table.table === "memory_vectors" ? "memory_vector_entries" : table.table;
      const count = Number(db.db.prepare(`SELECT COUNT(*) AS n FROM "${source}"`).get().n);
      assert.equal(table.rows, count, `${table.table} row count`);
    }
    const emptyFeedback = summary.tables.find((table) => table.table === "feedback");
    assert.equal(emptyFeedback.rows, 0);
    assert.equal(emptyFeedback.bytes, 0);
    assert.equal(emptyFeedback.sha256, sha256Empty);
    assert.match(text, /"table":"feedback","type":"table_start"/);

    // Decoded rows equal the legacy exportBundle output after order normalization.
    const legacy = service.exportBundle({ includeRawText: true, includeAudit: true });
    const ndjsonRows = rowsByTable(text);
    const nonEmptyLegacyTables = Object.keys(legacy.tables).filter((table) => legacy.tables[table].length > 0);
    assert.deepEqual([...ndjsonRows.keys()].sort(), nonEmptyLegacyTables.sort());
    for (const [table, rows] of ndjsonRows) {
      assert.deepEqual(sortedJson(rows), sortedJson(legacy.tables[table]), `${table} decoded rows`);
    }

    // Composite-key and text-key tables follow explicit BINARY primary-key order.
    assert.deepEqual(ndjsonRows.get("l3_world_model_project_environment_state").map((row) => row.project_id), ["p1", "p2"]);
    assert.deepEqual(ndjsonRows.get("runtime_kv").map((row) => row.key), ["alpha", "zeta"]);
    assert.deepEqual(ndjsonRows.get("memories").map((row) => row.id), ["mem-a", "mem-b"]);

    // Buffer fields use the existing bundle encoding; Unicode survives.
    const artifact = ndjsonRows.get("artifacts")[0];
    assert.deepEqual(artifact.uri, { __memmy_type: "buffer", base64: Buffer.from([0, 1, 2, 255]).toString("base64") });
    assert.equal(ndjsonRows.get("memories")[0].memory_value, "alpha 你好 ✨");
    assert.equal(ndjsonRows.get("memories")[0].__table, "memories");
  } finally {
    db.close();
  }
});

test("ME-1 includeAudit=false omits audit_logs and oversized rows fail before writing", async () => {
  const { db, service } = await createFixture();
  try {
    const { text } = await exportToString(service, { includeAudit: false });
    const header = JSON.parse(text.split("\n")[0]);
    assert.equal(header.includeAudit, false);
    assert.ok(!header.tables.includes("audit_logs"));
    assert.ok(!text.includes('"table":"audit_logs"'));

    // A single encoded row above the 8 MiB line cap fails before it is emitted.
    db.db.prepare(`INSERT INTO memories
      (id, timeline, user_id, memory_value, tags_json, info_json, properties_json, memory_layer, created_at, updated_at)
      VALUES ('too-big', ?, 'p6', ?, '[]', '{}', '{}', 'L3', ?, ?)`)
      .run(at, "zzzz ".repeat(1_700_000), at, at);
    const chunks = [];
    await assert.rejects(
      service.streamBundleExport({ includeRawText: true }, (chunk) => { chunks.push(Buffer.from(chunk)); }),
      /line limit/
    );
    const written = Buffer.concat(chunks).toString("utf8");
    assert.equal(written.split("\n").filter((line) => line.includes('"type":"row"')).length, 2);
    assert.ok(!written.includes('"ordinal":3'), "oversized row must not be written");
  } finally {
    db.close();
  }
});

test("ME-1 verifier rejects tampering, reordering and trailing data", async () => {
  const { db, service } = await createFixture();
  try {
    const { text } = await exportToString(service);
    const lines = text.split("\n").filter(Boolean);

    // Flip a byte inside a data row while keeping valid JSON.
    const tampered = lines.map((line) => {
      const record = JSON.parse(line);
      if (record.type !== "row" || record.table !== "memories" || record.ordinal !== 1) return line;
      record.data.memory_value = "alpha tampered";
      return canonicalJson(record);
    }).join("\n") + "\n";
    await expectVerifierFailure(tampered, /byte count mismatch|digest mismatch|manifest digest/);

    // Drop the footer.
    await expectVerifierFailure(lines.slice(0, -1).join("\n") + "\n", /missing footer/);

    // Swap two rows so ordinals are no longer contiguous.
    const rowIndexes = lines
      .map((line, index) => ({ index, record: JSON.parse(line) }))
      .filter((entry) => entry.record.type === "row" && entry.record.table === "memories")
      .map((entry) => entry.index);
    const swapped = lines.slice();
    [swapped[rowIndexes[0]], swapped[rowIndexes[1]]] = [swapped[rowIndexes[1]], swapped[rowIndexes[0]]];
    await expectVerifierFailure(swapped.join("\n") + "\n", /ordinal mismatch/);

    // Append a record after the footer.
    await expectVerifierFailure(text + '{"type":"row","table":"memories","ordinal":999,"data":{}}\n', /after the footer/);
  } finally {
    db.close();
  }
});

test("ME-1 NDJSON export requires admin:read and admin:write for raw text", async () => {
  const { db, service } = await createFixture();
  const listening = await listenMemoryHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    auth: {
      scopedApiKeys: {
        "read-token": { scopes: ["admin:read"] },
        "write-token": { scopes: ["admin:read", "admin:write"] },
        viewer: { scopes: ["memory:read"] }
      }
    },
    agentSourceExecutor: { dispose: async () => {} }
  });
  const call = async (path, headers = {}) => {
    const response = await fetch(`${listening.url}${path}`, { headers });
    return { status: response.status, contentType: response.headers.get("content-type"), body: await response.text() };
  };
  try {
    const ndjson = { accept: "application/x-ndjson" };
    assert.equal((await call("/api/v1/export", ndjson)).status, 401, "no token");
    assert.equal((await call("/api/v1/export", { ...ndjson, "x-memmy-viewer": "1" })).status, 401, "viewer header only");
    assert.equal((await call("/api/v1/export", { ...ndjson, authorization: "Bearer viewer" })).status, 403, "viewer scope");
    assert.equal((await call("/api/v1/export", { ...ndjson, authorization: "Bearer read-token" })).status, 200, "admin:read");
    assert.equal(
      (await call("/api/v1/export?includeRawText=true", { ...ndjson, authorization: "Bearer read-token" })).status,
      403,
      "raw text needs admin:write"
    );

    const streamed = await call("/api/v1/export", { ...ndjson, authorization: "Bearer read-token" });
    assert.match(streamed.contentType, /application\/x-ndjson/);
    const verified = await verifyNdjsonBundle(Readable.from([streamed.body]));
    assert.equal(verified.ok, true);

    const raw = await call("/api/v1/export?includeRawText=true", { ...ndjson, authorization: "Bearer write-token" });
    assert.equal(raw.status, 200);
    assert.equal((await verifyNdjsonBundle(Readable.from([raw.body]))).includeRawText, true);

    const admin = await call("/api/v1/admin/export", { ...ndjson, authorization: "Bearer read-token" });
    assert.equal(admin.status, 200);
    assert.equal((await verifyNdjsonBundle(Readable.from([admin.body]))).ok, true);

    // Legacy JSON export keeps its existing behavior and content type.
    const legacy = await call("/api/v1/admin/export", { authorization: "Bearer read-token" });
    assert.equal(legacy.status, 200);
    assert.match(legacy.contentType, /application\/json/);
    assert.equal(JSON.parse(legacy.body).tables.memory_vectors.length, 2);
  } finally {
    await closeMemoryHttpServer(listening.server);
    db.close();
  }
});

test("ME-1 client abort mid-stream releases the snapshot read transaction", async () => {
  const dir = await tempDir();
  const path = join(dir, "abort.sqlite");
  const db = new MemoryDb({ path });
  const service = new MemoryService({ db, config: exportConfig() });
  const inject = db.db.prepare(`INSERT INTO memories
    (id, timeline, user_id, memory_value, tags_json, info_json, properties_json, memory_layer, created_at, updated_at)
    VALUES (?, ?, ?, ?, '[]', '{}', '{}', 'L3', ?, ?)`);
  db.db.transaction(() => {
    const body = "y".repeat(8 * 1024);
    for (let index = 0; index < 400; index += 1) {
      inject.run(`abort-${index}`, at, "p6", `${body}-${index}`, at, at);
    }
  })();

  const rejections = [];
  const onRejection = (error) => rejections.push(error);
  process.on("unhandledRejection", onRejection);
  const listening = await listenMemoryHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    auth: { localServiceToken: "abort-token" },
    agentSourceExecutor: { dispose: async () => {} }
  });
  try {
    await new Promise((resolve, reject) => {
      const request = httpRequest(`${listening.url}/api/v1/export`, {
        headers: { accept: "application/x-ndjson", authorization: "Bearer abort-token" }
      }, (response) => {
        assert.equal(response.statusCode, 200);
        response.once("data", () => {
          response.destroy();
          request.destroy();
          resolve();
        });
        response.on("error", () => {});
      });
      request.on("error", (error) => {
        if (error.code !== "ECONNRESET") reject(error);
      });
      request.end();
    });
    // Let the server observe close and release its snapshot in its finally block.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const raw = service.repos.runtime.db;
    raw.prepare(`INSERT INTO memories
      (id, timeline, user_id, memory_value, tags_json, info_json, properties_json, memory_layer, created_at, updated_at)
      VALUES ('after-abort', ?, 'p6', 'still writable', '[]', '{}', '{}', 'L3', ?, ?)`).run(at, at, at);
    const checkpoint = raw.pragma("wal_checkpoint(TRUNCATE)");
    const row = Array.isArray(checkpoint) ? checkpoint[0] : checkpoint;
    assert.equal(Number(row.busy), 0, "no export reader may still pin the WAL");
    assert.equal(raw.prepare("SELECT memory_value FROM memories WHERE id = 'after-abort'").get().memory_value, "still writable");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onRejection);
    await closeMemoryHttpServer(listening.server);
    db.close();
  }
});

test("ME-1 :memory: databases are refused instead of sharing the service connection", async () => {
  const db = new MemoryDb({ path: ":memory:" });
  const service = new MemoryService({ db });
  try {
    service.repos.memories.insert(memory("mem-1", "memory fallback", { vectorField: "vec", vector: [1, 2, 3] }));
    await assert.rejects(exportToString(service), (error) => error.code === "conflict");
    assert.equal(db.db.inTransaction, false);
    assert.equal(Number(db.db.prepare("SELECT COUNT(*) AS n FROM memories").get().n), 1);
  } finally {
    db.close();
  }
});

const heavySkip = process.env.MEMHUB_SKIP_HEAVY_TESTS === "1"
  ? "MEMHUB_SKIP_HEAVY_TESTS=1 skips the >=150 MB bounded-memory export"
  : false;

test("ME-1 >=150 MB export stays under 128 MB heap and ~256 MiB RSS", { skip: heavySkip }, async () => {
  const dir = await tempDir();
  const dbPath = join(dir, "heavy.sqlite");
  const outPath = join(dir, "heavy.ndjson");
  const dbUrl = new URL("../vendor/memory-core/src/storage/db.js", import.meta.url).href;
  const serviceUrl = new URL("../vendor/memory-core/src/service/memory-service.js", import.meta.url).href;
  const childScript = `
import { readFileSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { MemoryDb } from ${JSON.stringify(dbUrl)};
import { MemoryService } from ${JSON.stringify(serviceUrl)};
const at = "2026-10-20T00:00:00.000Z";
const count = 160;
const db = new MemoryDb({ path: process.env.P6_DB });
const insert = db.db.prepare(\`INSERT INTO memories
  (id, timeline, user_id, memory_value, tags_json, info_json, properties_json, memory_layer, created_at, updated_at)
  VALUES (?, ?, ?, ?, '[]', '{}', '{}', 'L3', ?, ?)\`);
const body = "x".repeat(1024 * 1024);
db.db.transaction(() => {
  for (let index = 0; index < count; index += 1) {
    insert.run("heavy-" + index, at, "p6", body + "-" + index, at, at);
  }
})();
const service = new MemoryService({ db });
const out = createWriteStream(process.env.P6_OUT, { highWaterMark: 64 * 1024 });
const write = (chunk) => new Promise((resolve, reject) => {
  const cleanup = () => { out.off("drain", onDrain); out.off("error", onError); };
  const onDrain = () => { cleanup(); resolve(); };
  const onError = (error) => { cleanup(); reject(error); };
  if (out.write(chunk)) { resolve(); return; }
  out.once("drain", onDrain);
  out.once("error", onError);
});
const summary = await service.streamBundleExport({ includeRawText: true, includeAudit: true }, write);
await new Promise((resolve, reject) => out.end((error) => error ? reject(error) : resolve()));
db.close();
const status = readFileSync("/proc/self/status", "utf8");
const vmHwmKb = Number((status.match(/VmHWM:\\s+(\\d+) kB/) || [])[1] || 0);
console.log("P6_RESULT " + JSON.stringify({ rows: summary.rows, bytes: summary.bytes, vmHwmKb }));
`;
  const child = spawn(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", childScript], {
    cwd: root,
    env: { ...process.env, P6_DB: dbPath, P6_OUT: outPath },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let peakKb = 0;
  const sample = () => {
    try {
      const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
      const match = status.match(/VmHWM:\s+(\d+) kB/);
      if (match) peakKb = Math.max(peakKb, Number(match[1]));
    } catch {
      // The child may already have exited.
    }
  };
  const sampler = setInterval(sample, 20);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
  const exit = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearInterval(sampler);
  clearTimeout(timeout);
  assert.equal(exit.code, 0, `heavy export child failed (${exit.signal ?? "no signal"}): ${stderr.slice(-500)}`);
  const resultLine = stdout.split("\n").find((line) => line.startsWith("P6_RESULT "));
  assert.ok(resultLine, "heavy child must report its result");
  const result = JSON.parse(resultLine.slice("P6_RESULT ".length));
  const size = (await stat(outPath)).size;
  assert.ok(size >= 150 * 1024 * 1024, `expected >=150 MB export, got ${size} bytes`);
  assert.ok(result.bytes <= size && size - result.bytes < 64 * 1024, "row bytes plus framing should equal the file");
  assert.equal(result.rows, 160);
  const selfPeakKb = result.vmHwmKb;
  const observedPeakKb = Math.max(peakKb, selfPeakKb);
  assert.ok(observedPeakKb > 0, "VmHWM was sampled");
  assert.ok(observedPeakKb < 256 * 1024, `peak RSS ${observedPeakKb} kB must stay under ~256 MiB`);

  const verified = await verifyNdjsonBundle(createReadStream(outPath));
  assert.equal(verified.ok, true);
  assert.equal(verified.bytes, size);
  const memories = verified.tables.find((table) => table.table === "memories");
  assert.equal(memories.rows, 160);
});
