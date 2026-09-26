# MCP module boundaries (local candidate)

The Gateway keeps HTTP routing, Cloudflare/device/local-admin authentication,
account selection, tool registration and authorization of MCP scope in
`src/mcp.ts`. A module called by the Gateway does **not** authenticate an
arbitrary HTTP request on its own unless that capability is explicit below.

| Module | Responsibility and trust boundary |
| --- | --- |
| `capture-http.ts` | Authenticates a capture device token and validates HTTP body/project before durable event and Core ingestion. |
| `capture-recovery.ts` | Exact-event recovery and matching frozen-intent reconciliation; checks project/device and never bulk-replays legacy no-intent captures. |
| `distillation-control.ts` | Audit/discover/recover/next/renew/skip; the MCP caller resolves scope and supplies the already authenticated runtime. |
| `distillation-submit.ts` | Evidence and lease validation, dry-run, Core artifact write and downstream L3/L4 enqueue. Scope resolution and evidence-chain verification remain callbacks from the authenticated MCP boundary. |
| `distillation-transport.ts` | Pure inline/chunked evidence presentation; preserves offsets, manifests and contract payloads. |
| `memory-control-http.ts` | Authenticated console read API. Gateway first verifies the caller and selected account; the handler applies view/project checks. |
| `memory-control-actions.ts` | Authenticated console mutation API. Gateway checks identity, while the handler checks admin-only operations, project blockers and managed memory IDs. |
| `web-ui.ts` | Pure HTML/CSS/inline JavaScript rendering for landing, docs, unprovisioned identity, user and admin consoles; no network listener or account authorization. |

The `memhub_distill` tool name, input schema, lease-token opt-in, legacy
lease compatibility, evidence transport and result envelope are unchanged by
the staged extraction. Regression evidence: `npm run build`,
`node tests/mcp-e2e.mjs` (including user/admin HTTP routes and
inline/chunked evidence), `node tests/distillation-discovery-e2e.mjs`,
`node tests/stack-runtime-smoke.mjs`, and the complete
`npm run stability:check` gate. These are local build/test results, not
production deployment or a Windows port of new Capture recovery.
