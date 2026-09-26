# Windows recovery candidate: isolated execution evidence (2026-09-26)

This report is **not** a production deployment or a signed/complete Windows
release acceptance. The Windows Group checkout remains the pre-recovery
`0.2.2` baseline. A disposable `0.2.5` candidate was constructed under
`.review-runtime/win-recover-candidate-transfer-20260926/candidate` by
copying the actual Linux candidate `src/`, `dist/`, tests and package
metadata, plus the matching `web-assets/` and `docs/site/` content. The
source archive SHA-256 was verified as
`1549a15a236ecd5f6463a136a1377bef273e97b55d89ebec0b75918c97ccc299`;
the asset archive SHA-256 was
`f4ef95c90d640e96d672887f1fcebce244318256f80e7622e953e482c0c804f7`.
The isolated candidate links the Windows checkout's existing
`node_modules/` and `vendor/`, and uses its current Windows
`scripts/run-stack.mjs`. No changes were copied into the canonical Windows
source tree, and no system installation was performed.

## Executed Windows candidate validation

From the disposable candidate directory, the following command finished
successfully with Node 24 on Windows:

```text
npm run build
node tests/core-e2e.mjs
node tests/mcp-e2e.mjs
node tests/distillation-discovery-e2e.mjs
node tests/stack-runtime-smoke.mjs
```

The MCP test exercises the new `recover_ingest` tool schema and actual HTTP
Capture / MCP same-event race against a held Core response, including
request-ID reuse, project mismatch and Core 409 fail-closed. Discovery tests
cover concurrent evidence claims; the real-stack smoke covers process loss
after Core success before marker, after marker before enqueue, Gateway/Core
restart convergence and Bridge authentication failure/retry. A Windows-only
adaptation of the smoke recognizes an intentional Node 24 native
`UV_HANDLE_CLOSING` fail-fast (`0xC0000409`) after the fixture has already
emitted a Core-committed marker, and retries cleanup of a briefly locked
SQLite file. Both portability accommodations have been incorporated into the
Linux canonical smoke without relaxing the verified commit/marker boundary.

The initial attempt to run the Linux smoke unchanged exposed those two
Windows-specific fixture limitations; the final rerun passed after the
test-only adaptation. It did not require weakening product-side recovery or
changing production data.

## Installer lifecycle evidence and remaining release gap

In the Windows Group checkout, actual PowerShell Local and Server installers
were each exercised against disposable StateRoots and real managed
Core/Gateway(/Bridge) processes. The Task Scheduler and ACL commands were
shimmed deliberately; the real user Task Scheduler and ACLs were **not**
changed. Each edition performed an initial install, refused an invalid
existing credential before stopping the owner, then executed three live
stop/restart passes designated reinstall, upgrade and rollback, uninstall
without purge, and reinstall after uninstall. Both reported five owner
launches and preserved the credential, protected data and unrelated Node.
Separate credential tests checked exact config-byte preservation for JSON
and Core-rewritten YAML. These passes **simulate** upgrade/rollback with
the same installer version: they are not a cross-version artifact migration.

The disposable `0.2.5` candidate is intentionally hybrid. Its
`npm run release:check` failed because the linked Windows checkout's
plugin metadata still reports `0.2.2` while candidate `package.json`
reports `0.2.5`. A clean, fully version-aligned Windows complete artifact
must be packaged and accepted, including actual scheduled-task lifecycle,
real cross-version upgrade/rollback and all Capture/recovery tests against
that exact artifact. Until then, the P0 Capture release gate and Windows
Installer lifecycle TODO remain open. Do not treat this isolated runtime
pass as authorization to deploy or to bulk-replay legacy captures.
