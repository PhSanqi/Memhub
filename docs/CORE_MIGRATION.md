# Memhub Core lossless migration

This migration removes the server's runtime dependency on a separately
installed Memmy Memory Core, AgentSourceCore workspace and Normify CLI without
rewriting existing memory data.

## Status

Completed on the active server deployment.

- production Memory Core runs from `vendor/memory-core`;
- AgentSource helper runs from `vendor/agent-source-core`;
- project architecture uses the embedded vendored architecture runtime;
- `Memory/` and `AgentSourceCore/` standalone packages are retired and removed;
- the external Normify CLI/MCP is not a production dependency;
- the existing SQLite path is intentionally retained for lossless continuity;
- preflight, post-cutover verification, preservation checks, typecheck and
  Memhub end-to-end tests passed before legacy package retirement.

## Non-negotiable invariants

1. The existing SQLite database is adopted; memory IDs are not regenerated.
2. L1/L2/L3 records, project scope, provenance, evolution jobs, skills,
   sessions, episodes and user memories remain in the same schema.
3. The embedded Memory Core must be source-parity with the currently deployed
   built Memory runtime before cutover. The only intentional rewrite is the
   package import for AgentSourceCore, redirected to Memhub's vendored copy.
4. The embedded architecture runtime must be source-parity with the currently
   deployed Normify library before the legacy CLI is removed.
5. A consistent online SQLite backup and semantic fingerprint are created
   before any service ownership change.
6. The rollback snapshot remains available after cutover. Legacy service/source
   packages are removed once the post-cutover verifier passes.

## Phase 1: preflight and snapshot

From the repository:

```bash
npm run core:preflight
```

The command:

- verifies `vendor/memory-core/src` against the pinned vendor manifest;
- verifies `vendor/agent-source-core` against the pinned vendor manifest;
- verifies `vendor/normify/lib` against the pinned vendor manifest;
- runs SQLite `quick_check`;
- creates an online backup below
  `~/.memmy/memhub/core-migrations/<timestamp>/`;
- fingerprints the schema and every durable table;
- copies the active config with owner-only permissions;
- writes a `manifest.json` without exposing the storage token.

The snapshot is the rollback boundary. Do not delete it during the migration.

## Phase 2: shadow validation

Never run the vendored Memory Core directly against the immutable rollback
snapshot. First copy the snapshot database/config to a disposable shadow
directory, then run the new core against that copy on a different port.
Validate health, representative recall, project filtering, L3 lease/submit
contract and the Memhub test suite.

The embedded architecture adapter is the production/default implementation.
The external Normify source tree, CLI and MCP are no longer required by the
runtime.

## Phase 3: quiesced cutover

During the final ownership switch:

1. stop capture/gateway writers;
2. stop the legacy Memory service;
3. run one final preflight to establish the cutover baseline;
4. start the Memhub-owned embedded core on the same loopback endpoint;
5. start Memhub gateway/capture;
6. run smoke tests before accepting new writes.

The database path remains unchanged during this phase. Moving it to
`~/.memhub/core` is a separate optional maintenance operation and is not part
of the core ownership migration.

The server unit installed by `deploy/install-user-service.sh` is
`memhub-core.service`. It runs
`vendor/memory-core/src/server/index.js` and the gateway requires that
unit. The gateway uses the vendored architecture core by default and no longer
needs a `normify` executable.

## Phase 4: lossless verification

Before accepting any new write after the quiesced cutover, run:

```bash
npm run core:verify -- --manifest \
  ~/.memmy/memhub/core-migrations/<timestamp>/manifest.json
```

The verifier compares SQLite integrity, schema hash, durable-table row counts
and cryptographic row fingerprints. Request/recall logs are recorded but are
excluded from the content fingerprint because validation itself appends those
rows. Migration IDs, versions and checksums are compared separately while
their startup-updated timestamps are ignored. Any content mismatch blocks
retirement of the legacy unit and preserves the rollback snapshot.

After verification succeeds, re-enable writers and retain the snapshot for an
operator-defined rollback window.

For this deployment verification has succeeded and the standalone
`Memory/` / `AgentSourceCore/` packages have been retired. Rollback data is
the immutable migration snapshot rather than a second live legacy runtime.

Once normal writes have resumed, the live database will legitimately diverge
from the frozen baseline. Use the preservation check instead of exact verify:

```bash
npm run core:preserved -- --manifest \
  ~/.memmy/memhub/core-migrations/<timestamp>/manifest.json
```

This checks that the schema is unchanged and every primary-key identity from
the baseline still exists in every durable table. New rows and legitimate
post-cutover state updates do not create false failures.

## What is not migrated

- Cloudflare remains an authentication/reverse-proxy boundary.
- Conversation capture and Bridge remain Memhub adapters.
- Harness models remain external execution engines for semantic distillation.
- Project architecture stays authoritative architecture data; it is not
  flattened into ordinary memory.
