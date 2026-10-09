import assert from "node:assert/strict";
import { normalizeCaptureEvent, captureIsFullyExcludedFromMemory } from "../dist/capture.js";
import { retryableIngestError } from "../dist/capture-http.js";
import { MemoryCoreHttpError } from "../dist/local-memory-client.js";

const mixed = normalizeCaptureEvent({
  event_id: "privacy-mixed",
  host: "test",
  conversation_id: "conversation-1",
  timestamp: "2026-10-09T00:00:00.000Z",
  user_text: "Keep this <private>do not remember this secret</private> and this.",
  assistant_text: "Visible <no-memory>hidden assistant detail</no-memory> answer.",
  capture_status: "complete"
});
assert.equal(mixed.user_text, "Keep this  and this.");
assert.equal(mixed.assistant_text, "Visible  answer.");
assert.equal(mixed.provenance.memhub_privacy.excluded_sections, 2);
assert.equal(mixed.provenance.memhub_privacy.fully_excluded, false);
assert.equal(captureIsFullyExcludedFromMemory(mixed), false);
assert.deepEqual(normalizeCaptureEvent(mixed), mixed);

const fullyPrivate = normalizeCaptureEvent({
  event_id: "privacy-all",
  host: "test",
  conversation_id: "conversation-2",
  timestamp: "2026-10-09T00:00:00.000Z",
  user_text: "<private>never persist this</private>",
  assistant_text: "<no-memory>nor this</no-memory>",
  capture_status: "complete"
});
assert.equal(fullyPrivate.user_text, undefined);
assert.equal(fullyPrivate.assistant_text, undefined);
assert.equal(captureIsFullyExcludedFromMemory(fullyPrivate), true);
assert.deepEqual(normalizeCaptureEvent(fullyPrivate), fullyPrivate);

const noLongerFullyPrivate = normalizeCaptureEvent({
  ...fullyPrivate,
  user_text: "Visible follow-up"
});
assert.equal(noLongerFullyPrivate.user_text, "Visible follow-up");
assert.equal(noLongerFullyPrivate.provenance.memhub_privacy.fully_excluded, false);
assert.equal(captureIsFullyExcludedFromMemory(noLongerFullyPrivate), false);

const failClosed = normalizeCaptureEvent({
  event_id: "privacy-unclosed",
  host: "test",
  conversation_id: "conversation-3",
  timestamp: "2026-10-09T00:00:00.000Z",
  user_text: "public prefix <private>everything after this is private",
  capture_status: "partial"
});
assert.equal(failClosed.user_text, "public prefix");

assert.equal(retryableIngestError(new MemoryCoreHttpError(503, "offline")), true);
assert.equal(retryableIngestError(new MemoryCoreHttpError(409, "conflict")), false);
assert.equal(retryableIngestError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })), true);
assert.equal(retryableIngestError(new Error("schema bug")), false);

console.log("capture-privacy-graceful-e2e: ok");
