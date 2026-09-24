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

- **Current release:** v0.2.5
- **Canonical hosted deployment:** https://memhub.sanqi.org/
- **Downloads:** https://github.com/PhSanqi/Memhub/releases

---

## Why Memhub

Most AI memory systems answer “what should I remember?” Memhub also answers:

- **Whose memory is this?** One stable account represents one person; devices and harnesses are provenance, not separate users.
- **Which project may use it?** Project boundaries are resolved before retrieval. Unrelated project memory is not mixed into the current task.
- **Where did it come from?** Durable memory keeps evidence and provenance back to original L1 turns.
- **How much context should the model receive?** Retrieval ranks only legal candidates and emits a bounded Context Capsule.
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
AI Harness / MCP / Plugin
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

See [Documentation](docs/README.md) for Server deployment, Windows, authentication, Cloudflare, migration, and architecture.

## Connect

Local Edition exposes the Bridge MCP endpoint at:

```text
http://127.0.0.1:17861/mcp
```

Server Edition exposes the authenticated MCP endpoint configured for your deployment. The bundled [Agent Plugin](adapters/plugin/README.md) provides MCP configuration plus optional lifecycle capture/recall integration for compatible hosts.

## Everyday workflows

```text
“Load this project's Current Truth and continue.”
“Add ‘finish the Windows installer test’ to this project's Todo.”
“What changed in this project over the last week?”
“Show the evidence behind this project rule.”
“Use the same Memhub account on my other machine.”
```

The model-facing MCP surface includes:

- `memmy_context` — bounded account/project recall and Skill candidates;
- `memmy_turn` — L1 turn lifecycle;
- `memmy_project`, `memmy_project_list`, `memmy_project_manage` — project resolution and lifecycle;
- `memhub_todo` — first-class project Todos;
- `memhub_branch` — project-local workstream context;
- `memhub_skill` — Skill load, telemetry, revision and retirement;
- `memhub_distill` — evidence-bounded L2/L3/L4/Skill distillation;
- `memhub_result` — progressive transport for unusually large MCP results.

## Browser workspace

The Web Workspace provides:

- **Overview / Projects** — scope, Current Truth and Todos;
- **L1 / L2 / L3 / L4** — evidence, timeline, durable project knowledge and cross-project profile;
- **Skills** — reusable procedures and execution state;
- **Processing** — distillation and runtime state;
- **Admin** — account/project governance and high-impact operations.

The project deployment is available at https://memhub.sanqi.org/.

## Security and privacy

- Local and Server origins bind to loopback by default.
- Public Server deployments should sit behind authenticated reverse proxy/Tunnel access.
- Human identity and account-bound devices resolve to one stable `account_id`.
- Project routing is enforced before retrieval; relevance cannot broaden scope.
- L4 requires cross-project evidence and must not be used to infer sensitive traits.
- Destructive project and Skill lifecycle changes use explicit authorization contracts.

Read [Privacy boundary](docs/architecture/privacy-boundary.md), [Identity and devices](docs/architecture/identity-and-devices.md), and [Remote authentication](docs/operations/remote-auth.md).

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
