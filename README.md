# Memhub

[简体中文](README.zh-CN.md)

![Release](https://img.shields.io/github/v/release/PhSanqi/Memhub?display_name=tag)
![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)
![Platforms](https://img.shields.io/badge/Linux%20%7C%20Windows-5b67d6)
![MCP](https://img.shields.io/badge/MCP-ready-7c3aed)
![License](https://img.shields.io/github/license/PhSanqi/Memhub)

**Project-aware long-term memory for AI agents.**

Memhub gives ChatGPT, Codex, MCP clients, and other AI harnesses a durable memory layer that survives individual chats and devices without collapsing unrelated projects into one context.

It keeps original conversation evidence, builds a chronological project history, distills durable project knowledge, maintains a carefully scoped cross-project profile, and exposes reusable Skills, project Todos, retrieval, provenance, and a browser workspace from one self-hosted runtime.

- **Current release:** v1.0.0
- **Public documentation:** https://phsanqi.github.io/Memhub/
- **GitHub Pages (public, static mirror):** https://phsanqi.github.io/Memhub/
- **Downloads:** https://github.com/PhSanqi/Memhub/releases

**Start with [installation](docs/site/install.en.md), not someone else's
workspace.** Memhub is self-hosted: each person or team runs their own Local
or Server Edition and accesses their own authenticated workspace. The public
website and GitHub Pages mirror are product documentation, not a shared
memory-hosting service. All workspace previews on public pages are synthetic
examples; no personal account or project data is published there.

---

## Why Memhub

Most AI memory systems answer “what should I remember?” Memhub also answers:

- **Whose memory is this?** One stable account represents one person; devices and harnesses are provenance, not separate users.
- **Which project may use it?** Project boundaries are resolved before retrieval. Unrelated project memory is not mixed into the current task.
- **Where did it come from?** Durable memory keeps evidence and provenance back to original L1 turns.
- **How much context should the model receive?** Retrieval ranks only legal candidates and emits a bounded Context Capsule.
- **How did this project evolve?** Project State turns canonical L2 chronology into a per-project view of the current head, parallel workstreams, versions, and historical state without creating a second source of truth.
- **What should remain executable instead of becoming prose memory?** Reusable procedures live as Skills, separate from the L1–L4 memory depth.

## Memory model

```text
L1  Original conversation evidence
 │
 ▼
L2  Canonical project timeline
 │
 ▼
L3  Durable project rules, experience and Current Truth
 │
 ├── other project L3 ──┐
 │                      ▼
 └────────────────────► L4  Stable cross-project account profile

Skill  ──────────────── orthogonal reusable capability plane
```

| Layer | Scope | Purpose |
| --- | --- | --- |
| **L1** | Project/account evidence | Original conversation turns and provenance |
| **L2** | Project | Chronological project history |
| **L3** | Project | Durable rules, preferences, lessons and Current Truth |
| **L4** | Account | Stable patterns supported across multiple projects |
| **Skill** | Project or account | Reusable executable procedure with lifecycle telemetry |

Project **Todos** live in the Project Registry. **Branches** are project-local workstream filters. Neither is an additional memory layer.

## Runtime

```text
AI Harness / MCP
          │
          ▼
      Memhub Gateway
          │
   ┌──────┼───────────────┐
   ▼      ▼               ▼
Identity  Project Router  Skill Router
          │               │
          ▼               ▼
     Retrieval v1      Skill lifecycle
          │
          ▼
   Context Capsule
          │
          ▼
      Memory Core

Capture → L1 → evidence-bounded distillation → L2 → L3 → L4
```

Memhub owns identity, project scope, evidence boundaries, canonical artifact IDs, retrieval, job lifecycle, provenance, and durable commit. The connected model/harness owns semantic synthesis; the server does not silently invoke an LLM subscription.

## Editions

| Edition | Use it when | Network model |
| --- | --- | --- |
| **Local** | One computer, private local memory | Loopback only |
| **Server** | Multiple devices or AI clients share one account | Loopback origin behind authenticated proxy/Tunnel |

Both editions support Linux and Windows.

### Quick install

Download the matching package from the [latest GitHub Release](https://github.com/PhSanqi/Memhub/releases).

Complete Linux:

```bash
bash install-complete.sh --edition local
# or
bash install-complete.sh --edition server --public-host memory.example.com
```

Complete Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-complete.ps1 -Edition local
# or
powershell -ExecutionPolicy Bypass -File .\install-complete.ps1 -Edition server -PublicHost memory.example.com
```

Source install:

```bash
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
bash editions/local/linux/install.sh
```

The Linux Local/Server edition installers are **fresh-install only**. They
refuse an existing StateRoot or Memhub systemd unit before changing credentials,
data, or services. Do not rerun them to upgrade an existing deployment; preserve
the current state and use a separately reviewed migration procedure.

See [Documentation](docs/README.md) for Server deployment, Windows, authentication, Cloudflare, migration, and architecture.

## Connect

Local Edition exposes the Memhub MCP runtime directly on loopback:

```text
http://127.0.0.1:3001/mcp
```

Server Edition runs the same MCP runtime on loopback and publishes that endpoint through the configured authenticated reverse proxy, such as Cloudflare Access/Tunnel. Local and remote clients therefore use one tool schema and one Memhub state; both paths terminate at the same runtime.

## Everyday workflows

```text
“Load this project's Current Truth and continue.”
“Add ‘finish the Windows installer test’ to this project's Todo.”
“What changed in this project over the last week?”
“Show the evidence behind this project rule.”
“Replace this project's Architecture with this complete version; show me the full text before writing it.”
“Add this durable project rule to L3; show me the complete resulting L3 and wait for my confirmation.”
“Use the same Memhub account on my other machine.”
```

The model-facing MCP surface includes:

- `memmy_context` — bounded account/project recall and Skill candidates;
- `memmy_turn` — L1 turn lifecycle;
- `memhub_memory` — exact L1/L2/L3/L4 hydration plus explicitly authorized L3/L4 replacement;
- `memmy_project`, `memmy_project_list`, `memmy_project_manage` — project resolution, lifecycle, and governed Project Architecture;
- `memhub_todo` — first-class project Todos;
- `memhub_branch` — project-local workstream context;
- `memhub_skill` — Skill load, telemetry, revision and retirement;
- `memhub_distill` — evidence-bounded L2/L3/L4/Skill distillation;
- `memhub_result` — progressive transport for unusually large MCP results.

## Browser workspace

The Web Workspace provides:

- **Overview / Projects** — scope, Current Truth and Todos;
- **L1 / L2 / L3 / L4** — evidence, timeline, durable project knowledge and cross-project profile;
- **Project State** — an L2-first project evolution view: time runs horizontally, parallel workstreams run vertically, and the canonical L2 head remains explicit. Exact revisions, evidence, and pending Todos stay in drill-down rather than becoming a second state store;
- **Skills** — reusable procedures and execution state;
- **Processing** — distillation and runtime state;
- **Admin** — account/project governance and high-impact operations.

Project State is derived from canonical L2 plus its exact revision ledger. The browser keeps the complete project view. Optional Archify lifecycle export is a disposable communication artifact with a smaller representative snapshot; it never owns or writes project state.

### Governed Project Architecture and direct user rules

Project Architecture is separate from project memory. It is reserved for stable structure, ownership, source-of-truth declarations, interfaces, and hard constraints. Project history stays in L2, durable project working rules stay in L3, cross-project user rules/profile stay in L4, and unfinished work stays in Project Todo.

Architecture replacement is deliberately fail-closed: `memmy_project architecture_plan` returns the complete proposed canonical document, the model must show that full text to the user, and `architecture_execute` is allowed only after explicit approval of that exact plan. Memhub stores the writable canonical copy inside its private state root; repository Architecture files and legacy `normify-*` documents remain read-only discovery/migration sources. Architecture history is auditable and rollback is performed as a new reviewed replacement rather than an invisible rewind.

Explicit user-authored L3/L4 changes use the same review principle. `memhub_memory plan` prepares the complete resulting L3 or L4 body. The model must show it in full, then wait for a new explicit confirmation turn. That confirmation is captured as L1 evidence before `memhub_memory execute` can commit the replacement. Existing L3/L4 state is fenced by an exact revision reference, so a stale approval cannot overwrite a newer concurrent update. This direct-authority path does not auto-promote L3 into L4.

The [public documentation mirror](https://phsanqi.github.io/Memhub/) and
[GitHub Pages mirror](https://phsanqi.github.io/Memhub/) document the
product; neither provides a public login to another person's memory.
Access the workspace of **your own installation** after configuring its
authentication boundary.

## Security and privacy

- Local and Server origins bind to loopback by default.
- Public Server deployments should sit behind authenticated reverse proxy/Tunnel access.
- Human identity resolves to one stable `account_id`; different accounts are strict tenant boundaries and do not share Projects, Todos, L1–L4 memory, Skills, Branches, Architecture, or distillation state.
- Ordinary users can access only their own account scope; only an Admin role may enumerate or manage other accounts.
- Project routing is enforced before retrieval; relevance cannot broaden scope.
- L4 requires cross-project evidence and must not be used to infer sensitive traits.
- Destructive project and Skill lifecycle changes use explicit authorization contracts.
- Project Architecture and direct user-authored L3/L4 replacements require full-text review before explicit authorization; stale plans fail closed.

Read [Privacy boundary](docs/architecture/privacy-boundary.md) and [Remote authentication](docs/operations/remote-auth.md).

## Development

```bash
npm ci
npm run build
npm test
```

Useful checks:

```bash
npm run core:check
npm run memory:audit
npm run state:audit
npm run network:check
npm run process:smoke
```

## Documentation

Start at **[docs/README.md](docs/README.md)**.

The current documentation is organized into:

- product and installation guides;
- architecture and data boundaries;
- operations and deployment;
- maintainer notes;
- internal review contracts used by repository tooling.

Superseded repair plans and migration-era design notes are kept in Git history instead of the current documentation tree, so old implementation guidance cannot be mistaken for Current Truth.

## Project status

Memhub is under active development. Memory Core is vendored from the open-source Memmy lineage and maintained as part of the runtime. See [Changelog](CHANGELOG.md) and [Upstream attribution](docs/maintainers/upstream.md).

## License

See [LICENSE](LICENSE).
