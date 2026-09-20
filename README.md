# Memhub

[简体中文](README.zh-CN.md)

Memhub is a private, project-aware memory and context hub for AI harnesses. Codex, Claude Code, ChatGPT-style remote MCP clients, CoWorker, and other hosts can share one durable memory system without sharing one integration mechanism.

Current release line: **v0.2.0**. See [CHANGELOG.md](CHANGELOG.md).

## Current memory model

Memhub exposes four memory layers plus an orthogonal Skill layer:

- **L1 — Original Conversation**: source user/assistant turns plus bounded, auditable reasoning/tool summaries. Raw Capture and Episode remain internal processing mechanisms.
- **L2 — Project Timeline**: a human-readable chronological account of project development, decisions, state changes, superseded history, and current truth.
- **L3 — Project Rules & Experience**: durable project-scoped rules, preferences, working habits, and experience distilled from L2.
- **L4 — User Profile**: account-scoped cross-project traits and stable working patterns distilled from evidence across multiple project L3 artifacts.
- **Skill**: reusable executable procedures. Skills are not another memory depth and may be project-scoped or explicitly reusable across projects.

L2 and L3 are always project-scoped. L4 is always account-scoped. Project business memory never silently crosses into another project.

## Architecture

```text
AI host / plugin / remote MCP
            |
            v
      Memhub Bridge
   queue + credentials
            |
            v
       Memhub Server
   +----------------------+
   | Context Router       |
   | L1 Turn Log          |
   | Distillation Jobs    |
   | Memory Core          |
   | Project Registry     |
   | Architecture Reader  |
   +----------------------+
```

The architecture reader is deliberately small. It can read existing authoritative project architecture Markdown from legacy `normify-<project>` trees, but it does not execute or vendor the old Normify engine. New CLI/config naming is `architecture-root`; `--normify-root` remains a deprecated compatibility alias so existing service units can restart safely.

Memhub supports Local and Server editions from the same codebase:

```text
editions/
├── local/
│   ├── linux/
│   └── windows/
└── server/
    ├── linux/
    └── windows/
```

Local Edition keeps MCP, capture, SQLite and processing on one machine. Server Edition keeps the authoritative memory service on one server while device Bridges upload captured turns through authenticated transport.

See [Memhub edition design](docs/EDITIONS.md).

## MCP surface

The high-level MCP surface is intentionally small:

- `memmy_turn` — open/checkpoint/commit/resume the L1 original-conversation turn log.
- `memmy_context` — resolve the current project and recall L4, project L2/L3, reusable Skills, recent L1 continuity, and read-only project architecture.
- `memhub_distill` — lease or submit L2/L3/L4/Skill distillation work. The connected Harness/model performs semantic synthesis; Memhub enforces evidence, scope, provenance and canonical artifact identity.
- `memmy_project_list` — list/suggest canonical projects.
- `memmy_project_manage` — controlled project create/update/delete/merge via plan then explicit authorization.
- `memmy_project` — list/current/bind/unbind project context and read project architecture.

`memmy_project action=current` uses a persistent conversation binding when the Harness exposes a stable `conversation_id`. If a transport cannot provide one, Memhub does not invent an ID: the tool reports `binding_available=false`, while `memmy_context.resolvedProjectId` and explicit current-turn project/workspace evidence remain authoritative for that request.

A completed L2 job can enqueue L3. Completed L3 artifacts from at least two projects can form an L4 job. Memhub itself does not silently invoke an LLM.

## Capture and Control Plane

Capture is a host capability, not an MCP side effect. A host plugin/hook can write complete or partial turns to the local Bridge, which queues them durably and uploads them when connectivity is available.

The browser routes are:

- `/memhub` — public landing page.
- `/memhub/user` — authenticated user workspace.
- `/memhub/admin` — authenticated admin Control Plane.

The management model is intentionally the product taxonomy: Overview, Projects, L1, L2, L3, L4, Skills and Processing. Raw Capture and Episode are internal implementation details and are not management layers.

Explicit current-turn project/workspace evidence overrides an older conversation binding. If project resolution is ambiguous, Memhub falls back to global-only recall rather than leaking project context.

## Data migration and maintenance

The current SQLite schema migration is v8. During v7 → v8 migration Memhub:

- changes the durable memory-layer constraint to L1/L2/L3/L4/Skill;
- preserves old rows and archives legacy L2/L3 products instead of deleting them;
- archives legacy `user_memories`;
- dead-letters retired evolution jobs;
- remaps embedding retry targets to the new artifact names.

Production cutover is guarded by:

```bash
npm run core:preflight
npm run core:verify -- --manifest <manifest>
npm run core:preserved -- --manifest <manifest>
```

`core:preflight` verifies vendored runtime integrity and creates an online SQLite rollback snapshot. `core:preserved` is intended for schema-changing cutovers: schema/version changes are reported, while SQLite integrity, durable table presence and preservation of every baseline durable row identity are enforced.

Long-term cleanup remains read-first:

```bash
npm run memory:audit
npm run memory:repair
```

`memory:repair` creates an online backup and report before applying changes.

See [Core migration](docs/CORE_MIGRATION.md), [architecture](docs/ARCHITECTURE.md), [memory scopes](docs/EVOLUTION_SCOPES.md), and [Control Plane / distillation](docs/CONTROL_PLANE_AND_DISTILLATION.md).

## Install from source

Node.js 20+ is required.

Local Linux:

```bash
bash editions/local/linux/install.sh
```

Local Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\Memhub\editions\local\windows\install.ps1
```

Server Linux:

```bash
MEMHUB_USERNAME=owner bash editions/server/linux/install.sh
```

Server Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\Memhub\editions\server\windows\install.ps1 -Username owner
```

Server Edition binds Memhub to loopback and does not create Cloudflare configuration. Public access should remain behind an authenticated reverse proxy such as Cloudflare Access; device/account authentication remains enforced by Memhub itself.

## Release packages

Every v0.2.x release is produced from one source commit and carries four platform/edition assets:

- `memhub-vX.Y.Z-linux-local.tar.gz`
- `memhub-vX.Y.Z-linux-server.tar.gz`
- `memhub-vX.Y.Z-windows-local.zip`
- `memhub-vX.Y.Z-windows-server.zip`

`SHA256SUMS.txt` and `release-manifest.json` bind all four packages to the same commit. Maintainers can verify release inputs with `npm run release:check` and generate the four assets with `npm run release:package`.

## Repository status

Memhub is under active development. The embedded Memory Core originates from the open-source Memmy lineage and is maintained here as part of the Memhub runtime boundary. See [upstream notes](docs/UPSTREAM.md).

## License

See [LICENSE](LICENSE).
