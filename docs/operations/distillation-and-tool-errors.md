# Distillation and tool failures

Memhub distinguishes durable source evidence, Core writes and downstream distillation queue state. Failure recovery must preserve that ordering.

## L1 ingest

`memmy_turn` writes durable L1 event state first. A complete turn is then sent to Memory Core with deterministic session/turn/request identifiers. The local ingest marker is written only after Core returns success.

If a worker dies after Core commits but before the marker is written, the durable ingest intent allows recovery to replay the exact same request. If the marker is already durable but downstream L2 enqueue failed, recovery queues only the missing derived work and never replays the completed Core write.

## Read-only audit

Use `memhub_distill action=audit` before recovery. The audit reports:

- complete but un-ingested L1 that requires review;
- ingested evidence that is ready/waiting for L2 grouping;
- unresolved project evidence;
- current pending/leased/failed distillation jobs;
- completed derived jobs whose next-layer claim is missing or conflicting.

Audit does not call Core or enqueue jobs. It reads the existing L1 index strictly; dirty or contradictory index state fails closed and must be repaired separately.

## Project grouping

Automatic L1 -> L2 grouping is account + project scoped. Host conversation identifiers are not batching keys. Threshold/idle scheduling may split project evidence into chronological batches, but each L1 evidence ref is claimed by at most one L2 job.

## Error handling

Operational failures should retain machine-readable boundaries:

- malformed MCP/HTTP input -> 4xx;
- authorization failure -> 401/403;
- evidence/revision conflict -> fail closed without mutation;
- transient Memory Core/network failure -> retryable only when the operation uses stable idempotency identifiers;
- downstream queue failure after a durable Core commit -> warning/recovery state, not rollback of the Core write.

Secrets must not be echoed in HTTP errors, structured logs or tool results.

## Verification

Treat these as separate evidence layers:

1. source/typecheck/build;
2. deterministic unit/E2E tests;
3. real two-process stack smoke;
4. actual running service build and listeners;
5. authenticated MCP invocation through the intended transport.

A health endpoint alone is not proof that a client can invoke the MCP schema it has cached.
