// Isolated real-Core crash fixture. Exit after Core commit but before the marker.
import { createMemhubRuntime } from "../dist/runtime.js";
import { recoverCaptureIngest } from "../dist/capture-recovery.js";
import { listCaptureEvents, withCaptureIngestAttempt } from "../dist/capture.js";
import { ingestCaptureIntoMemory } from "../dist/capture-ingest.js";

const [stateRoot, accountId, eventId, coreEndpoint, token, projectRegistryPath, mode = "after-core"] = process.argv.slice(2);
if (![stateRoot, accountId, eventId, coreEndpoint, token, projectRegistryPath].every(Boolean)) {
  throw new Error("isolated Core crash fixture requires six positional arguments");
}
const runtime = createMemhubRuntime({
  accountId, ownerAccountId: accountId, ownerUserId: "local-user",
  memoryEndpoint: coreEndpoint, memoryToken: token, projectRegistryPath, controlRoot: stateRoot
});
if (mode === "after-marker") {
  const event = (await listCaptureEvents(stateRoot, accountId, { eventId }))[0];
  if (!event) throw new Error("L1 event unavailable for marker crash fixture");
  const actor = { account_id: accountId, actor_id: event.actor_id };
  const attempt = await withCaptureIngestAttempt({
    stateRoot, accountId, eventId, expectedEvent: event,
    ingest: (current) => ingestCaptureIntoMemory({
      event: current, actor, runtime, projectId: "stack-smoke"
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
