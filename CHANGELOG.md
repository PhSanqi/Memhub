# Changelog

## v0.2.5 — 2026-09-25

Memhub 0.2.5 is a release-hygiene pass over the current v0.2 runtime. It does not introduce a new memory hierarchy; it makes the repository, documentation, release packages, and hosted entrypoint match the production system that is already running. The v0.2.3/v0.2.4 source checkpoints were not published as releases after Windows Complete smoke exposed packaging and installer issues.

### Documentation and repository cleanup

- Reorganized the public documentation around one current source of truth: product guides, architecture, operations, Skills, maintainer notes, and repository-tooling contracts.
- Removed superseded repair/simplification/evolution documents from the active tree. Their provenance remains available in Git history instead of competing with current architecture.
- Kept legacy runtime compatibility only where the code still supports it; retired deployment URLs and obsolete implementation guidance are no longer presented as active instructions.
- Refreshed the English and Chinese READMEs around the current account/project model, L1–L4 memory, Retrieval v1, Branches, Skills, Todos, MCP, browser workspace, Local/Server editions, and Linux/Windows installation paths.

### Production and release alignment

- The canonical hosted entrypoint is `https://memhub.sanqi.org/`.
- Linux systemd deployments use `memhub-stack.target` to own the Core → Gateway → optional Bridge lifecycle.
- Release metadata and package manifests are regenerated from the clean public release tree.
- GitHub repository metadata, documentation navigation, release notes, and downloadable artifacts are aligned to the same release.
- Complete archives now include the Web logo assets required by the Gateway; the Complete runtime smoke verifies both images before installation.
- Windows Local/Server installers handle absent legacy scheduled tasks without failing on native stderr, and use the correct username expansion for state-directory ACLs.
- Windows Memory tokens now use PowerShell-native cryptographic randomness instead of a shell-quoted Node inline expression. The Windows Complete CI verifies nonempty 64-character tokens for both editions and clears expected cleanup exit codes.

## v0.2.2 — 2026-09-24

Memhub 0.2.2 is the first release where the L1–L4 memory model, project routing, Retrieval v1, Branch context, executable Skill lifecycle, bounded result transport, production process supervision, and the reorganized public documentation ship together.

### Retrieval, project context and Skills

- Account/project governance now bounds the legal candidate set before relevance ranking. Retrieval v1 performs deterministic second-stage semantic + BM25-style lexical fusion, exact-content deduplication and bounded Top-K selection without broadening project scope.
- `memmy_context` defaults to a compact Context Capsule with aggregate/per-item byte budgets, compact provenance and lane-level retrieval diagnostics; standard/full modes remain available for deeper inspection.
- Project Branches provide project-local workstream context without creating a second memory hierarchy. Branches can narrow retrieval but cannot expose another project's business memory.
- Skill Router returns compact candidates first, then `memhub_skill action=load` loads the selected full procedure. Execution telemetry records selected/loaded/invoked/success/failure/user-correction state.
- Skill revision/retirement uses an explicit plan → approval → execute contract, preserves stable `source_skill_id`, archives predecessors and retains historical telemetry.
- `memhub_result` provides account-scoped progressive transport for unusually large generic MCP responses; transport spool data is never treated as durable memory.

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

### Process ownership and production recovery

- Linux deployment has an explicit systemd stack target with ordered Core → Gateway → optional Bridge readiness and lifecycle propagation.
- Direct/Windows installs use one `run-stack.mjs` supervisor instead of independent child login tasks, with singleton ownership, health supervision, bounded restart budgets and graceful reverse-order shutdown.
- Bridge queue claims survive upstream failures and supervisor restarts with at-least-once/idempotent replay semantics.
- The optional dedicated Cloudflare watchdog requires repeated failure, checks local origin health before recovery, enforces cooldown, and verifies the connector after restart.
- Process, systemd, network-report and watchdog behavior have deterministic regression coverage.

### Complete packages

- Linux Complete and Windows Complete packages bundle the target-OS Node.js runtime, production `node_modules`, and prebuilt Memhub output.
- One Complete archive supports both Local and Server installation and does not require Node/npm on the destination host.
- Complete artifacts are built natively on their target operating system so native modules such as `better-sqlite3` match the host ABI.
- Existing `install.sh` / `install.ps1` remain the convenience/source installation path.

### Documentation and public project surface

- GitHub README has been rewritten around the current product: project-aware memory, L1–L4, Project Registry/Todos, Branch, Retrieval, Skill and the Local/Server deployment choice.
- Public documentation is now grouped under `docs/architecture/`, `docs/operations/`, `docs/maintainers/`, `docs/internal/` and `docs/archive/`, with `docs/README.md` as the navigation source of truth.
- Superseded repair/simplification documents are retained only under `docs/archive/` so historical implementation notes are not confused with current architecture.
- The canonical hosted deployment is `https://memhub.sanqi.org/`; the previous `plugin.sanqi.org/memhub` route is retired.

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

