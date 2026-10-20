import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isCaptureIngested,
  markCaptureIngested,
  storeCaptureEvent,
  withCaptureIngestAttempt
} from "../dist/capture.js";
import {
  captureCoreRawTurnId,
  captureSessionId,
  captureTurnId,
  ingestCaptureIntoMemory
} from "../dist/capture-ingest.js";
import { EmbeddedMemoryCore } from "../dist/embedded-memory-core.js";
import { LocalMemoryRestClient } from "../dist/local-memory-client.js";
import { readMemoryControlData } from "../dist/memory-control-plane.js";
import { listL1Turns } from "../dist/turn-log.js";
import { rawTurnIdForSessionTurn } from "../vendor/memory-core/src/service/turn/turn-normalization.js";
import { stableHash } from "../vendor/memory-core/src/utils/id.js";

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function waitFor(check, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const accountId = "acct-p6";
const userId = "user-p6";
const root = await mkdtemp(join(tmpdir(), "memhub-p6-l1-"));
const unitRoot = join(root, "unit-state");
const realRoot = join(root, "real-state");
const coreRoot = join(root, "core");
const device = { actor_id: "p6-deploy", account_id: accountId };
const now = Date.now();
const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
let core;

try {
  // Core derives rawTurnId as raw_<stableHash(sessionId:turnId)[0..20]>, not as
  // the request turnId. Pin the local helper against the vendored Core module
  // for several inputs, including unicode and long ids.
  for (const [account, host, eventId] of [
    [accountId, "claude-code", "paired-1"],
    ["acct-unicode-测试", "codex", "event with spaces"],
    ["acct-colons", "host:port", "event:id:1"],
    ["acct-long", "h".repeat(120), "e".repeat(240)]
  ]) {
    assert.equal(
      captureCoreRawTurnId(account, host, eventId),
      rawTurnIdForSessionTurn(captureSessionId(account, eventId), captureTurnId(account, host, eventId)),
      `captureCoreRawTurnId must mirror Core for ${account}/${host}/${eventId.slice(0, 12)}`
    );
  }
  const pinnedSession = captureSessionId(accountId, "paired-1");
  const pinnedTurn = captureTurnId(accountId, "claude-code", "paired-1");
  assert.equal(
    captureCoreRawTurnId(accountId, "claude-code", "paired-1"),
    `raw_${stableHash(`${pinnedSession}:${pinnedTurn}`).slice(0, 20)}`,
    "the local stableHash string path matches the vendored implementation"
  );
  assert.notEqual(
    captureCoreRawTurnId(accountId, "claude-code", "paired-1"),
    captureTurnId(accountId, "claude-code", "paired-1"),
    "Core never stores the request turn id as rawTurnId"
  );

  const rawTurns = [];
  async function capture(event, ingested = false) {
    const stored = await storeCaptureEvent(unitRoot, device, { project_hint: "p6", ...event });
    if (ingested) await markCaptureIngested(unitRoot, accountId, event.event_id);
    return stored.event;
  }
  function rawTurn(event, overrides = {}) {
    rawTurns.push({
      rawTurnId: captureCoreRawTurnId(accountId, event.host, event.event_id),
      sessionId: captureSessionId(accountId, event.event_id),
      conversationId: captureSessionId(accountId, event.event_id),
      projectId: "p6",
      sessionSource: "memhub-capture",
      userText: event.user_text,
      assistantText: event.assistant_text,
      status: "succeeded",
      createdAt: event.timestamp,
      ...overrides
    });
  }

  // 1. Identity pairing: the raw turn carries Core's derived id and deliberately
  // different text, so only the identity branch can pair it.
  const paired = await capture({
    event_id: "paired-1",
    host: "claude-code",
    conversation_id: "conv-paired",
    timestamp: iso(-2 * 60 * 60 * 1000),
    user_text: "Pair by identity",
    assistant_text: "Paired",
    capture_status: "complete"
  }, true);
  rawTurn(paired, {
    userText: "Core-side text deliberately differs",
    assistantText: "Core-side answer deliberately differs"
  });

  // 2. Legacy fallback: no matching turn id, text differs only by trailing
  // whitespace, and the stored capture text is already redacted.
  const legacy = await capture({
    event_id: "legacy-secret",
    host: "claude-code",
    conversation_id: "conv-legacy",
    timestamp: iso(-3 * 60 * 60 * 1000),
    user_text: "Use sk-" + "ant-api03-abcdefghijklmnopqrstuvwxyz now",
    assistant_text: "OK",
    capture_status: "complete"
  }, true);
  assert.match(legacy.user_text, /\[REDACTED:anthropic_api_key\]/);
  rawTurn(legacy, {
    rawTurnId: "raw_legacy_unknown",
    userText: `${legacy.user_text}   `,
    assistantText: `${legacy.assistant_text}\n`
  });

  // 3. An unrelated Core raw turn from another source must stay listed.
  rawTurns.push({
    rawTurnId: "raw-other",
    projectId: "p6",
    sessionSource: "cursor",
    userText: "Unrelated raw turn",
    assistantText: "Kept",
    status: "succeeded",
    createdAt: iso(-4 * 60 * 60 * 1000)
  });

  // 4. Stale open/partial captures: older than 6h, or older than 30min with a
  // later turn in the same continuity.
  const staleOld = await capture({
    event_id: "stale-6h",
    host: "claude-code",
    conversation_id: "conv-stale-old",
    continuity_id: "continuity-stale-old",
    timestamp: iso(-7 * 60 * 60 * 1000),
    user_text: "Seven hours old",
    capture_status: "partial"
  });
  const staleContinuity = await capture({
    event_id: "stale-continuity",
    host: "claude-code",
    conversation_id: "conv-cont",
    continuity_id: "continuity-cont",
    timestamp: iso(-45 * 60 * 1000),
    user_text: "Superseded turn",
    capture_status: "open"
  });
  await capture({
    event_id: "continuity-later",
    host: "claude-code",
    conversation_id: "conv-cont",
    continuity_id: "continuity-cont",
    timestamp: iso(-5 * 60 * 1000),
    user_text: "Later turn",
    assistant_text: "Done",
    capture_status: "complete"
  });
  const freshOpen = await capture({
    event_id: "fresh-open",
    host: "claude-code",
    conversation_id: "conv-fresh",
    continuity_id: "continuity-fresh",
    timestamp: iso(-5 * 60 * 1000),
    user_text: "Still in flight",
    capture_status: "open"
  });

  const unitRuntime = {
    accountId,
    userId,
    projects: {
      async storageIds(_accountId, projectId) { return [projectId]; }
    },
    memoryClient: {
      async viewerGet(path) {
        const url = new URL(`http://local${path}`);
        if (url.pathname === "/api/v1/raw-turns") {
          const projectId = url.searchParams.get("projectId");
          const items = rawTurns.filter((turn) => !projectId || turn.projectId === projectId);
          return {
            items,
            total: items.length,
            hasNext: false,
            stats: {
              total: items.length,
              succeeded: items.filter((turn) => turn.status === "succeeded").length,
              captureManaged: items.filter((turn) => turn.sessionSource === "memhub-capture").length,
              captureManagedSucceeded: items.filter((turn) => turn.sessionSource === "memhub-capture" && turn.status === "succeeded").length
            }
          };
        }
        return { items: [], total: 0, hasNext: false };
      }
    }
  };
  const request = {
    stateRoot: unitRoot,
    runtime: unitRuntime,
    kind: "l1",
    projects: [],
    projectId: "p6"
  };

  const byDefault = await readMemoryControlData(request);
  const listedRawIds = byDefault.items
    .filter((item) => item.source_kind === "raw-turn")
    .map((item) => item.rawTurnId);
  assert.deepEqual(listedRawIds, ["raw-other"], "paired raw turns are not listed; unrelated ones are kept");

  const captureRows = byDefault.items.filter((item) => item.source_kind === "capture");
  const pairedRow = captureRows.find((item) => item.id === "paired-1");
  assert.ok(pairedRow, "identity-paired capture is listed once");
  assert.equal(pairedRow.core_ingested, true);
  assert.equal(captureRows.filter((item) => item.id === "paired-1").length, 1);
  const legacyRow = captureRows.find((item) => item.id === "legacy-secret");
  assert.ok(legacyRow, "trimmed/redacted legacy text still pairs");
  assert.equal(legacyRow.core_ingested, true);
  assert.equal(byDefault.items.some((item) => item.source_kind === "raw-turn" && item.rawTurnId === "raw_legacy_unknown"), false);

  assert.equal(captureRows.some((item) => item.id === "stale-6h"), false, "6h stale open turn hidden by default");
  assert.equal(captureRows.some((item) => item.id === "stale-continuity"), false, "continuity-superseded open turn hidden by default");
  assert.equal(captureRows.some((item) => item.id === freshOpen.event_id), true, "recent open turn stays visible");
  assert.equal(byDefault.counts.incomplete, 4, "overview counts stay truthful while stale rows are hidden");

  const withIncomplete = await readMemoryControlData({ ...request, includeIncomplete: true });
  const staleOldRow = withIncomplete.items.find((item) => item.id === "stale-6h");
  const staleContinuityRow = withIncomplete.items.find((item) => item.id === "stale-continuity");
  const freshRow = withIncomplete.items.find((item) => item.id === freshOpen.event_id);
  assert.equal(staleOldRow?.status, "abandoned");
  assert.equal(staleOldRow?.abandoned, true);
  assert.equal(staleContinuityRow?.status, "abandoned");
  assert.equal(freshRow?.status, "open");
  assert.equal(freshRow?.abandoned, undefined);

  // Classification is read-side only: the stored capture keeps its status.
  const storedAfter = await listL1Turns({ stateRoot: unitRoot, accountId, limit: 500 });
  assert.equal(storedAfter.find((turn) => turn.event_id === staleOld.event_id)?.status, "partial");
  assert.equal(storedAfter.find((turn) => turn.event_id === staleContinuity.event_id)?.status, "open");

  // 5. Real Memory Core round-trip: open session + complete turn through the
  // vendored Core, then prove the Control Plane pairs that one capture row.
  await mkdir(coreRoot, { recursive: true });
  const port = await freePort();
  const token = "p6-core-token";
  const configPath = join(coreRoot, "config.yaml");
  const dbPath = join(coreRoot, "memory.sqlite");
  await writeFile(configPath, JSON.stringify({
    memmyMemory: {
      version: 1,
      userId,
      roleRouting: { summary: "follow", evolution: "follow" },
      storage: {
        mode: "local",
        backend: "sqlite",
        sqlitePath: dbPath,
        endpoint: `http://127.0.0.1:${port}`,
        token
      },
      algorithm: {
        enableMemoryAdd: true,
        enableMemorySearch: true,
        enableQueryRewrite: false,
        retrieval: { llmFilterEnabled: false }
      },
      agentAccess: { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false }
    },
    providers: {},
    modelAssignments: {
      default: null,
      memorySummary: null,
      memoryEvolution: null,
      embedding: null,
      asr: null,
      imageGeneration: null
    },
    modelPresets: {},
    app: {}
  }) + "\n");
  core = new EmbeddedMemoryCore({ stateRoot: coreRoot, port, configPath, dbPath });
  await core.start();
  const realRuntime = {
    accountId,
    userId,
    projects: {
      async storageIds(_accountId, projectId) { return [projectId]; },
      async resolve(_accountId, projectRef) { return projectRef; }
    },
    memoryClient: new LocalMemoryRestClient({ endpoint: core.endpoint, token })
  };

  const realEvent = {
    event_id: "real-roundtrip",
    host: "claude-code",
    conversation_id: "conv-real",
    timestamp: iso(-60 * 1000),
    project_hint: "p6",
    // The public store trims and redacts before persistence; the Core copy must
    // still pair by identity, not by comparing the two texts.
    user_text: "Use sk-" + "ant-api03-abcdefghijklmnopqrstuvwxyz now   \n",
    assistant_text: "OK\n",
    capture_status: "complete"
  };
  const stored = await storeCaptureEvent(realRoot, device, realEvent);
  assert.match(stored.event.user_text, /\[REDACTED:anthropic_api_key\]/);
  assert.equal(stored.event.user_text, "Use [REDACTED:anthropic_api_key] now");

  const attempt = await withCaptureIngestAttempt({
    stateRoot: realRoot,
    accountId,
    eventId: realEvent.event_id,
    expectedEvent: stored.event,
    ingest: (event) => ingestCaptureIntoMemory({
      event,
      actor: device,
      runtime: realRuntime,
      projectId: "p6"
    })
  });
  assert.equal(attempt.result?.ingested, true);
  assert.equal(await isCaptureIngested(realRoot, accountId, realEvent.event_id), true);

  const coreRawTurnId = captureCoreRawTurnId(accountId, realEvent.host, realEvent.event_id);
  const rawPayload = await realRuntime.memoryClient.viewerGet(
    `/api/v1/raw-turns?limit=100&page=1&userId=${userId}&projectId=p6`
  );
  assert.equal(rawPayload.total, 1, "the real Core stored exactly one raw turn");
  assert.equal(rawPayload.items[0].rawTurnId, coreRawTurnId, "Core rawTurnId equals captureCoreRawTurnId");
  assert.equal(rawPayload.items[0].sessionId, captureSessionId(accountId, realEvent.event_id));
  assert.equal(rawPayload.items[0].sessionSource, "memhub-capture");
  assert.equal(rawPayload.items[0].userText, stored.event.user_text, "Core text is trimmed and redacted");
  assert.equal(rawPayload.items[0].assistantText, stored.event.assistant_text);

  // The Control Plane consumes the Core L1 summary row only once Core has
  // settled it; wait so the one-row assertion is deterministic.
  await waitFor(async () => {
    const l1 = await realRuntime.memoryClient.viewerGet(
      `/api/v1/l1?limit=100&page=1&userId=${userId}&projectId=p6`
    );
    return Array.isArray(l1.items) && l1.items.some((item) => item.summary === stored.event.user_text);
  }, "Memory Core L1 summary to settle");

  const realPayload = await readMemoryControlData({
    stateRoot: realRoot,
    runtime: realRuntime,
    kind: "l1",
    projects: [],
    projectId: "p6"
  });
  const realCaptureRows = realPayload.items.filter((item) => item.source_kind === "capture");
  assert.equal(realCaptureRows.length, 1, "the real round-trip has one capture row");
  assert.equal(realCaptureRows[0].id, realEvent.event_id);
  assert.equal(realCaptureRows[0].core_ingested, true);
  assert.equal(
    realPayload.items.filter((item) => item.source_kind === "raw-turn").length,
    0,
    "the Core raw turn is paired by identity and not listed"
  );
  assert.equal(realPayload.items.length, 1, "one L1 row for the real Core round-trip");
} finally {
  if (core) await core.stop();
  await rm(root, { recursive: true, force: true });
}

console.log("p6-l1-dedupe: ok");
