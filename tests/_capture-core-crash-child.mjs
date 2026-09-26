// Isolated real-Core crash fixture. Exit after Core commit but before the marker.
import { createMemhubRuntime } from "../dist/runtime.js";
import { recoverCaptureIngest } from "../dist/capture-recovery.js";
import { listCaptureEvents, listDevices, withCaptureIngestAttempt } from "../dist/capture.js";
import { ingestCaptureIntoMemory } from "../dist/capture-ingest.js";

const [stateRoot, accountId, eventId, coreEndpoint, token, projectRegistryPath, bindingsPath, mode = "after-core"] = process.argv.slice(2);
if (![stateRoot, accountId, eventId, coreEndpoint, token, projectRegistryPath, bindingsPath].every(Boolean)) {
  throw new Error("isolated Core crash fixture requires seven positional arguments");
}
const runtime = createMemhubRuntime({
  accountId, ownerAccountId: accountId, ownerUserId: "local-user",
  memoryEndpoint: coreEndpoint, memoryToken: token, projectRegistryPath, bindingsPath
});
if (mode === "after-marker") {
  const event = (await listCaptureEvents(stateRoot, accountId, { eventId }))[0];
  const device = (await listDevices(stateRoot, accountId)).find((item) =>
    item.device_id === event?.device_id && !item.revoked_at);
  if (!event || !device) throw new Error("capture or device unavailable for marker crash fixture");
  const attempt = await withCaptureIngestAttempt({
    stateRoot, accountId, eventId, expectedEvent: event,
    ingest: (current) => ingestCaptureIntoMemory({
      event: current, device, runtime, projectId: "stack-smoke"
    })
  });
  if (attempt.alreadyIngested || !attempt.result?.ingested) throw new Error("expected first successful Core ingestion");
  process.stderr.write("CORE_AND_MARKER_COMMITTED_BEFORE_QUEUE\n");
  process.exit(74);
}
if (mode !== "after-core") throw new Error("unknown isolated crash mode");
const completeTurn = runtime.memoryClient.completeTurn.bind(runtime.memoryClient);
runtime.memoryClient.completeTurn = async (turnId, request) => {
  const committed = await completeTurn(turnId, request);
  process.stderr.write("CORE_COMMITTED_BEFORE_MARKER:" +
    JSON.stringify({ turnId, requestId: request.requestId }) + "\n");
  // Deliberate ungraceful exit also leaves an ingest-attempt lock to reclaim.
  process.exit(73);
  return committed;
};
await recoverCaptureIngest({ stateRoot, runtime, eventId, projectId: "stack-smoke", dryRun: false });
throw new Error("crash fixture unexpectedly returned");
