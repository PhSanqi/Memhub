# Changelog

## v0.2.2 — 2026-09-22

Memhub 0.2.2 focuses on runtime stability, concurrent-state safety, bounded long-context transport, and self-contained installation packages.

### Stability and concurrency

- Shared JSON read-modify-write stores now use path-scoped in-process and cross-process locks; project bindings, todos, device/account state, capture metadata, distillation jobs, and Bridge queue updates have concurrent regression coverage.
- L1 checkpoint summaries can advance while a turn is incomplete, while completed source evidence remains immutable.
- Project/workspace scope is explicit across the primary project-scoped MCP tools; current workspace evidence outranks stale conversation bindings and conflicting scope is rejected.
- Project merge/delete now respects distillation-job lifecycle. Pending, leased, or failed jobs prevent project deletion; historical project aliases remain valid provenance after merge.
- `npm run stability:check` records typecheck, full tests, state audit, core check, and release checks under the private Memhub diagnostics directory.

### Long content and network transport

- JSON HTTP bodies are limited by UTF-8 byte size with explicit `400 invalid_json_body` and `413 request_body_too_large` errors.
- Bridge MCP/context/lifecycle responses stream with backpressure; upstream timeout and connection failures are classified separately.
- `memmy_context` now exposes a bounded host-facing view instead of allowing one oversized memory or architecture document to expand the tool response without limit.
- Large distillation evidence supports incremental `evidence_offset` / `evidence_chunk_chars` reads under the same job lease.
- Memhub and Bridge HTTP origins use longer keepalive intervals aligned with Cloudflare Tunnel origin connection reuse, and Memhub exposes a minimal health endpoint.
- `npm run network:check` inspects origin/public health plus available cloudflared Prometheus metrics without requiring Cloudflare account API access.

### Complete packages

- Linux Complete and Windows Complete packages bundle the target-OS Node.js runtime, production `node_modules`, and prebuilt Memhub output.
- One Complete archive supports both Local and Server installation and does not require Node/npm on the destination host.
- Complete artifacts are built natively on their target operating system so native modules such as `better-sqlite3` match the host ABI.
- Existing `install.sh` / `install.ps1` remain the convenience/source installation path.

## v0.2.0 — 2026-09-20

Memhub 0.2.0 is the first unified L1-L4 release. The same source commit ships Server and Local editions on Linux and Windows.

### Memory model

- L1 is the authoritative original-conversation evidence layer. Per-turn JSON remains the source of truth; `capture-index.sqlite` is a rebuildable metadata index for filtering, counts and scheduling.
- L2 is the canonical project timeline.
- L3 is the canonical project rules/experience profile.
- L4 is the account-scoped cross-project user profile and requires evidence from at least two project L3 artifacts.
- Skill remains an orthogonal reusable capability layer.

### MCP and distillation

- The public MCP surface is reduced to six tools: `memmy_turn`, `memmy_context`, `memhub_distill`, `memmy_project_list`, `memmy_project_manage`, and `memmy_project`.
- Retired `memmy_remember`, `memhub_history_distill`, and `memhub_evolution` tool surfaces are removed.
- Distillation jobs now enforce lease ownership, evidence-layer provenance, project scope and cross-project L4 evidence.
- Canonical L2/L3/L4 artifacts update in place through stable `sourceArtifactId` identities while write idempotency keys change only when the write body changes.
- `memmy_project action=current` no longer fails when a transport cannot expose a stable `conversation_id`; it returns `binding_available=false` and can canonicalize an explicit project without persisting a fake binding.

### Runtime and Control Plane

- L1 indexing is moved to SQLite with crash-recovery dirty tracking; large L1 histories no longer require full raw-file scans for normal UI counts, threshold scheduling or idle scheduling.
- Admin Control Plane adds project create/update/merge/logical-delete, L1→L4 lifecycle visibility, processing policy controls and layer-specific views.
- Web mutation endpoints require JSON and add clickjacking/CSP/referrer protections.
- Cloudflare JIT first-request account refresh is fixed.
- Configurable base-path deployment is retained, including root-path production deployments.

### Platform and release

- One shared runtime now backs four supported installation targets: Linux Local, Linux Server, Windows Local and Windows Server.
- `@huggingface/transformers` is upgraded to 4.3.x; production dependency audit is clean at release preparation time.
- The old Normify runtime is not vendored or executed. Existing architecture Markdown can still be read through the lightweight Architecture Reader compatibility layer.

### Migration

Memory Core schema v8 preserves historical rows while moving the durable taxonomy to L1/L2/L3/L4/Skill. Use `npm run core:preflight` before a production cutover and the documented verify/preserved checks when migrating an existing database.

