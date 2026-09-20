# Changelog

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

