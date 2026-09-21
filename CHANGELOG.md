# Changelog

## v0.2.2 — 2026-09-21

Memhub 0.2.2 adds self-contained Complete installers alongside the existing lightweight bootstrap path.

### Complete installation

- Adds **Linux Complete** and **Windows Complete** packages with a bundled Node.js 22.20.0 runtime.
- Complete packages include production dependencies and prebuilt native runtime components so users do not need a preinstalled Node/npm for normal installation.
- Both Complete packages support Local and Server installation modes from the same archive.
- Adds `install-complete.sh` and `install-complete.ps1` as stable Complete bootstrap assets.
- Complete bootstraps verify SHA-256 before extraction and then use the bundled runtime from the package itself.

### Quick installation

- Existing `install.sh` / `install.ps1` remain the smaller **Quick Install** path.
- Quick Install still expects Node.js 20+ and npm on the target machine, then downloads the smaller Local/Server package for that platform.

### Release verification

- Release metadata now distinguishes Quick packages, Quick/Complete bootstraps, and Complete packages in one manifest/checksum set.
- Linux Complete is smoke-tested without relying on the user's Node/npm installation.
- Windows Complete has a dedicated GitHub Windows runner smoke that executes `install-complete.ps1 -PrepareOnly` against the generated Windows package and bundled Node runtime.

## v0.2.1 — 2026-09-21

Memhub 0.2.1 focuses on installation, first-run ergonomics, and the reliability improvements shipped on main after v0.2.0.

### Installation

- Adds stable `install.sh` and `install.ps1` bootstrap assets to every Release.
- The bootstrap resolves the latest stable Release, selects the requested Local/Server package for the current OS, verifies SHA-256, installs the archive into a persistent application directory, and then runs the existing edition installer.
- Linux and Windows both support Local and Server installs without cloning the repository first.
- Manual Git clone installation remains available for development and troubleshooting.

### Release packaging

- Release manifests now include bootstrap installer checksums.
- `SHA256SUMS.txt` covers the four platform archives plus both bootstrap installers.

### Workspace and Todos

- Adds `memhub_todo` as a first-class MCP surface for listing, adding, completing, and reopening project Todos.
- The Web Workspace shows pending Todos directly and renders L2 as a chronological activity timeline, with readable L3 project rules/experience and L4 cross-project profile views.
- Control Plane job summaries avoid repeatedly transferring large distillation evidence payloads during normal UI refreshes.

### Bridge and Plugin reliability

- Capture queue uploads use claim files so a concurrent Stop update cannot be deleted by an older flush.
- PostCompact and SessionEnd drain pending capture work before closing lifecycle state.
- Colon-bearing L1 evidence IDs are preserved end-to-end.
- Codex Plugin Skill metadata uses the host-recognized `description` field.

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

