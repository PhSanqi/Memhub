import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactSecrets } from "../dist/secret-redaction.js";
import {
  listCaptureEvents,
  normalizeCaptureEvent,
  readCaptureIngestIntentStatus,
  storeCaptureEvent,
  withCaptureIngestAttempt
} from "../dist/capture.js";
import { ingestCaptureIntoMemory } from "../dist/capture-ingest.js";
import { createTestRoot } from "./test-isolation.mjs";

const A = (n, ch = "A") => ch.repeat(n);
const cases = [
  ["private_key", `-----BEGIN RSA ${"PRIVATE"} KEY-----\n${A(40, "x")}\n-----END RSA ${"PRIVATE"} KEY-----`],
  ["authorization_bearer", "Authorization: Bearer abc.def-123"],
  ["anthropic_api_key", `key sk-${"ant"}-api03-${A(40)}`],
  ["api_key", `key sk-proj-${A(45, "B")}`],
  ["google_api_key", `key AIza${A(35, "C")}`],
  ["github_token", `key ghp_${A(36, "D")}`],
  ["github_token", `key github_pat_${A(30, "E")}`],
  ["aws_access_key", "key AKIA" + "IOSFODNN7EXAMPLE"],
  ["slack_token", `key xoxb-${A(20, "1")}`],
  ["jwt", "key eyJhbGciOi.eyJzdWIiOi.SflKxwRJ"],
  ["secret_assignment", "password=hunter2"],
  ["secret_assignment", 'api_key: "my secret"'],
  ["url_password", "https://user:hunter2@example.com/x"],
  ["large_base64", `blob ${A(1100, "QUJD")}`]
];
for (const [kind, input] of cases) {
  const result = redactSecrets(input);
  assert.ok(result.kinds.includes(kind), `${kind}: expected kind, got ${result.kinds}`);
  assert.ok(!result.text.includes("hunter2") && !result.text.includes(input.slice(-20)),
    `${kind}: secret must be removed`);
  const again = redactSecrets(result.text);
  assert.equal(again.text, result.text, `${kind}: redaction must be idempotent`);
}

// Ids, hashes and opaque hex are evidence, not secrets.
for (const untouched of [
  `artifact:${A(32, "a")}`,
  A(40, "b"),
  createHash("sha256").update("evidence").digest("hex"),
  "123e4567-e89b-12d3-a456-426614174000",
  `event_${A(40, "c")}`
]) {
  assert.equal(redactSecrets(untouched).text, untouched);
  assert.equal(redactSecrets(untouched).count, 0);
}
assert.equal(redactSecrets(A(5000, "a")).text, A(5000, "a"), "large pure-hex runs are never redacted");

const RAW = {
  event_id: "p5-redaction-event",
  host: "test",
  conversation_id: "conv",
  continuity_id: "conv",
  timestamp: "2026-10-19T00:00:00.000Z",
  user_text: `use key sk-${"ant"}-api03-${A(40)} and password=hunter2`,
  assistant_text: "stored Authorization: Bearer tok123 at https://u:p@example.com",
  reasoning_summary: "token: abc123def456",
  capture_status: "complete"
};
const expectedKinds = ["anthropic_api_key", "secret_assignment", "authorization_bearer", "url_password"];
const normalized = normalizeCaptureEvent(RAW);
assert.ok(!normalized.user_text.includes("sk-ant-"));
assert.equal(normalized.provenance.memhub_privacy.redactions.count, 5);
assert.deepEqual([...normalized.provenance.memhub_privacy.redactions.kinds].sort(), [...expectedKinds].sort());
assert.deepEqual(normalizeCaptureEvent(normalized), normalized, "normalization is idempotent");

const root = await createTestRoot("memhub-p5-redaction-");
const actor = { account_id: "acct-p5", actor_id: "actor-p5" };
const eventPath = join(root, "captures",
  createHash("sha256").update(actor.account_id, "utf8").digest("hex"),
  `${createHash("sha256").update(RAW.event_id, "utf8").digest("hex")}.json`);
try {
  // Store: redacted before persistence, and a retry hashes identically.
  const first = await storeCaptureEvent(root, actor, RAW);
  const second = await storeCaptureEvent(root, actor, RAW);
  assert.equal(second.created, false);
  assert.equal(second.updated, false, "retried commit must not look like an update");
  assert.deepEqual(second.event, first.event);
  const persisted = JSON.parse(await readFile(eventPath, "utf8"));
  assert.ok(!JSON.stringify(persisted).includes("sk-ant-api03-"));
  assert.ok(!JSON.stringify(persisted).includes("hunter2"));
  assert.equal(persisted.provenance.memhub_privacy.redactions.count, 5);

  const attempt = await withCaptureIngestAttempt({
    stateRoot: root, accountId: actor.account_id, eventId: RAW.event_id,
    expectedEvent: second.event,
    ingest: async () => ({ ingested: true })
  });
  assert.equal(attempt.alreadyIngested, false);
  assert.equal(await readCaptureIngestIntentStatus(root, actor.account_id, RAW.event_id), "matching");
  const retried = await withCaptureIngestAttempt({
    stateRoot: root, accountId: actor.account_id, eventId: RAW.event_id,
    expectedEvent: second.event,
    ingest: async () => { throw new Error("must not re-ingest"); }
  });
  assert.equal(retried.alreadyIngested, true, "retry must reuse the frozen, redacted hash");

  // Core copy: a legacy raw event is redacted on the way into Memory Core.
  const coreCalls = [];
  const runtime = {
    accountId: actor.account_id,
    userId: "user-p5",
    memoryClient: {
      async openSession() { return {}; },
      async completeTurn(turnId, request) { coreCalls.push(request); return {}; }
    }
  };
  const coreEvent = { ...second.event, event_id: "p5-core-copy", ingested: false };
  await ingestCaptureIntoMemory({
    event: coreEvent, actor, runtime, projectId: "p5"
  });
  assert.equal(coreCalls.length, 1);
  assert.ok(!coreCalls[0].query.includes("sk-ant-api03-"));
  assert.ok(!coreCalls[0].answer.includes("tok123"));
  assert.ok(!coreCalls[0].answer.includes("u:p@"));
  assert.ok(coreCalls[0].reasoningSummary.includes("[REDACTED:secret_assignment]"));
  assert.ok(!coreCalls[0].reasoningSummary.includes("abc123"));

  // Legacy replay: stored raw text with a raw ingest intent must not conflict.
  const legacyRoot = await createTestRoot("memhub-p5-legacy-");
  try {
    const legacyEvent = {
      ...RAW,
      event_id: "p5-legacy-event",
      user_text: `legacy raw sk-${"ant"}-api03-${A(40)} and password=hunter2`,
      assistant_text: "legacy raw Authorization: Bearer tok123",
      reasoning_summary: "token: abc123def456"
    };
    await storeCaptureEvent(legacyRoot, actor, legacyEvent);
    const legacyPath = join(legacyRoot, "captures",
      createHash("sha256").update(actor.account_id, "utf8").digest("hex"),
      `${createHash("sha256").update(legacyEvent.event_id, "utf8").digest("hex")}.json`);
    const record = JSON.parse(await readFile(legacyPath, "utf8"));
    // Simulate a capture written before the redaction policy existed.
    record.user_text = legacyEvent.user_text;
    record.assistant_text = legacyEvent.assistant_text;
    record.reasoning_summary = legacyEvent.reasoning_summary;
    delete record.provenance.memhub_privacy;
    await writeFile(legacyPath, JSON.stringify(record, null, 2) + "\n");
    await writeFile(`${legacyPath}.ingest-intent`, capturePayloadHash(record) + "\n");

    const replayed = await storeCaptureEvent(legacyRoot, actor, legacyEvent);
    assert.equal(replayed.updated, false, "legacy raw retry must merge against the redacted view");
    assert.equal(replayed.event.user_text, legacyEvent.user_text, "stored legacy bytes stay raw");

    const listed = (await listCaptureEvents(legacyRoot, actor.account_id, { eventId: legacyEvent.event_id }))[0];
    assert.equal(listed.user_text, legacyEvent.user_text);
    const legacyCalls = [];
    const legacyRuntime = {
      accountId: actor.account_id,
      userId: "user-p5",
      memoryClient: {
        async openSession() { return {}; },
        async completeTurn(_turnId, request) { legacyCalls.push(request); return {}; }
      }
    };
    const legacyAttempt = await withCaptureIngestAttempt({
      stateRoot: legacyRoot, accountId: actor.account_id, eventId: legacyEvent.event_id,
      expectedEvent: listed,
      ingest: (current) => ingestCaptureIntoMemory({
        event: current, actor, runtime: legacyRuntime, projectId: "p5"
      })
    });
    assert.equal(legacyAttempt.alreadyIngested, false);
    assert.equal(legacyAttempt.result?.ingested, true);
    assert.equal(legacyCalls.length, 1);
    assert.ok(!legacyCalls[0].query.includes("sk-ant-api03-"));
    assert.ok(!legacyCalls[0].answer.includes("tok123"));
    assert.ok(!legacyCalls[0].reasoningSummary.includes("abc123"));
  } finally {
    await rm(legacyRoot, { recursive: true, force: true });
  }
  console.log("memhub-p5-capture-redaction: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

function capturePayloadHash(event) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]));
    }
    return value;
  };
  const { ingested: _ingested, ...persistent } = event;
  return createHash("sha256").update(JSON.stringify(canonical(persistent)), "utf8").digest("hex");
}

// Architect review: keyed assignment rule must not eat ordinary config/prose.
for (const benign of [
  "max_tokens: 512",
  "input_tokens: 1234, output_tokens=88",
  "token_count = 5",
  "secret_redaction: on",
  "tokenizer: cl100k_base",
  "api_key: ${OPENAI_API_KEY}",
  "GITHUB_TOKEN=process.env.GITHUB_TOKEN",
  "password: <your password>",
  "token: true",
  "artifact:a28d6152400554437c55fb7480337166 sha 4bd7281b3c5e9f00112233445566778899aabbcc"
]) {
  const result = redactSecrets(benign);
  assert.equal(result.text, benign, `must not redact: ${benign}`);
  assert.equal(result.count, 0);
}
for (const secret of ["GITHUB_TOKEN=abcd1234efgh5678", "client_secret: 'q8Zr4mN2pX7w'", "db.password=x1"]) {
  assert.match(redactSecrets(secret).text, /\[REDACTED:secret_assignment\]/, secret);
}
console.log("p5 redaction false-positive guard: ok");
