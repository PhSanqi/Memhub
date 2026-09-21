# Memhub

[简体中文](README.zh-CN.md)

![Release](https://img.shields.io/github/v/release/PhSanqi/Memhub?display_name=tag)
![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)
![Platforms](https://img.shields.io/badge/platform-Linux%20%7C%20Windows-5b67d6)
![MCP](https://img.shields.io/badge/MCP-ready-7c3aed)
![License](https://img.shields.io/github/license/PhSanqi/Memhub)

**Give your AI continuity beyond a single chat: your projects, your work, and the way you work.**

Memhub is a private, project-aware long-term memory hub for AI harnesses. Codex, MCP clients, and other AI hosts can share one person's durable memory across conversations and devices while keeping unrelated projects separated.

It is more than a chat archive. Memhub turns raw conversations into readable project timelines, durable project rules and experience, and a cross-project user profile. It also provides first-class project Todos, a browser workspace, and reusable Skills.

Current release line: **v0.2.x** · [View Releases](https://github.com/PhSanqi/Memhub/releases)

---

## What you get

| Capability | What it feels like |
| --- | --- |
| **Memory across conversations** | Start a new chat and continue yesterday's project without re-explaining the background. |
| **Memory across devices** | With Server Edition, Windows, Linux, and multiple AI clients can share one Memhub account and memory set. |
| **Project-aware isolation** | Each project keeps its own timeline, rules, and experience instead of mixing everything you have ever discussed. |
| **Project Todos** | Ask the AI to add, complete, reopen, or list Todos without hiding work items inside chat summaries or architecture docs. |
| **Chronological project history** | L2 answers “what did I do, and when?” as a readable project timeline. |
| **Durable project knowledge** | L3 keeps stable rules, preferences, lessons learned, and working conventions for each project. |
| **Cross-project user profile** | L4 captures patterns that repeatedly hold across projects, helping new work start with better context. |
| **Browser workspace** | Inspect Projects, Todos, L1/L2/L3/L4, Skills, and processing state from a web UI. |
| **Local-first / self-hosted** | Run everything on one machine or host your own central Server. |
| **MCP + Plugin support** | MCP clients work directly; hosts with lifecycle hooks can also automate recall and turn capture. |

---

## The experience Memhub is built for

You should not have to remember tool names. In normal use, prompts can stay natural:

> “Continue the project from yesterday.”

> “Add ‘update the Windows installer’ to this project's Todo list.”

> “That Todo is finished. Mark it done.”

> “Show me what I did on this project in chronological order.”

> “What long-term rules have we already established for this project?”

> “I moved to another machine. Load the same account and continue.”

Memhub makes these interactions part of one durable context instead of making every chat start from zero.

---

## At a glance

~~~mermaid
flowchart LR
    A[ChatGPT / Codex / MCP Client] --> M[Memhub Account]
    B[Linux Device] --> M
    C[Windows Device] --> M

    M --> P1[Project A]
    M --> P2[Project B]
    M --> U[Cross-project Profile]

    P1 --> T1[Timeline]
    P1 --> R1[Rules & Experience]
    P1 --> D1[Todos]

    P2 --> T2[Timeline]
    P2 --> R2[Rules & Experience]
    P2 --> D2[Todos]
~~~

One person can enter through different clients and devices while still resolving to the same Memhub account. The entry point is provenance; the memory belongs to the person. Project memory remains project-scoped.

---

## How memory becomes useful

~~~mermaid
flowchart TD
    L1[L1 · Original conversations] --> L2[L2 · Project timeline]
    L2 --> L3[L3 · Project rules & experience]
    L3 --> L4[L4 · Cross-project user profile]
    S[Skill · Reusable capability] -. separate plane .-> L3
~~~

- **L1 · Original conversations** preserves what actually happened as traceable evidence.
- **L2 · Project timeline** organizes project work chronologically: changes, decisions, milestones, and current state.
- **L3 · Project rules & experience** keeps durable project preferences, conventions, lessons learned, and Current Truth.
- **L4 · Cross-project user profile** keeps only stable patterns supported across multiple projects.
- **Skill** is a reusable executable procedure, not another memory depth.

The Web Workspace renders L2 as a timeline and L3/L4 as readable items instead of forcing users to inspect internal JSON.

---

## Choose an edition

Memhub ships as **Local Edition** and **Server Edition**, with Linux and Windows support.

| What you want | Recommended |
| --- | --- |
| Use Memhub on one computer | **Local Edition** |
| Avoid public networking and reverse proxies | **Local Edition** |
| Share memory across multiple computers | **Server Edition** |
| Use Windows and Linux with one memory account | **Server Edition** |
| Share memory across multiple MCP clients | **Server Edition** |
| Try Memhub first and self-host later | Start with **Local Edition** |

### Local Edition

Everything runs on one machine and listens on loopback by default.

Linux:

~~~bash
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
bash editions/local/linux/install.sh
~~~

Windows PowerShell:

~~~powershell
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
powershell -ExecutionPolicy Bypass -File .\editions\local\windows\install.ps1
~~~

After installation, local MCP clients and plugins can connect to:

~~~text
http://127.0.0.1:17861/mcp
~~~

Local Edition is the simplest way to get durable private memory without a VPS or Cloudflare.

### Server Edition

Server Edition keeps durable memory on your own central server while multiple devices connect as authenticated clients.

Linux Server:

~~~bash
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
MEMHUB_PUBLIC_HOST=memory.example.com bash editions/server/linux/install.sh
~~~

Windows Server:

~~~powershell
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
powershell -ExecutionPolicy Bypass -File .\editions\server\windows\install.ps1 -PublicHost memory.example.com
~~~

The Server still binds to loopback by default. Put public access behind an authenticated reverse proxy such as Cloudflare Access.

Detailed setup:

- [Local Edition](editions/local/README.md)
- [Server Edition](editions/server/README.md)
- [Release Packages](https://github.com/PhSanqi/Memhub/releases)

---

## Connect your AI client

### MCP clients

Any supported MCP host can connect to Memhub. Local Edition exposes the Bridge at:

~~~text
http://127.0.0.1:17861/mcp
~~~

Server Edition uses the authenticated remote MCP endpoint from your deployment.

### Codex / Agent Plugin

The repository includes <code>adapters/plugin/</code>. It contains the MCP configuration, the Memhub Skill, and lifecycle capture/recall support for hosts that register the bundled hooks.

The currently tested Codex Agent Plugin path loads MCP and the Skill. Automatic hook registration depends on the host version; see the [Plugin README](adapters/plugin/README.md) for the current compatibility boundary.

Even without automatic hooks, MCP still provides context recall, project routing, Todos, and distillation.

---

## Useful everyday workflows

### 1. Continue work across chats

In a fresh AI session:

~~~text
Load this project's Memhub Current Truth and continue from the previous work.
~~~

Memhub gives the model the relevant project timeline and durable rules instead of replaying every historical conversation.

### 2. Project Todos

~~~text
Add “finish Windows installation tests” to this project's Todo list.
~~~

Later:

~~~text
What Todos are still pending?
~~~

Or:

~~~text
That Todo is finished. Mark it complete.
~~~

Todos are first-class project state, not prose hidden in README files, architecture documents, or chat summaries.

### 3. Review work chronologically

~~~text
What did I do on this project over the last week, in chronological order?
~~~

The same L2 timeline is visible in the Web Workspace.

### 4. Keep durable project rules

~~~text
This project is Linux-first, but Windows must keep the same product semantics.
~~~

Stable rules like this can become part of project L3 instead of disappearing inside an old conversation.

### 5. Continue on another device

With Server Edition, multiple entry points can resolve to one person:

~~~text
Windows Codex ─┐
Linux Codex   ─┼─→ same Memhub account
Remote MCP    ─┘
~~~

Memory belongs to the person, not to a specific browser tab, machine, or harness.

---

## Web Workspace

Memhub includes a browser workspace for inspecting and governing long-term memory:

- **Overview** — projects, memory layers, and current pending Todos;
- **Projects** — project descriptions, Todos, and project state;
- **L1** — original conversations;
- **L2** — chronological “what I did” timeline across projects;
- **L3** — durable project rules and experience;
- **L4** — stable cross-project user profile;
- **Skills** — reusable capabilities;
- **Processing** — distillation work and runtime state.

The Admin view adds governance actions. The normal User Workspace remains scoped to the current account.

---

## Privacy and boundaries

Memhub follows a simple rule: **one person's memory can travel across devices, while unrelated project memory stays isolated.**

- Local Edition can remain entirely on one machine.
- Server Edition binds to loopback by default.
- Public deployment is expected to sit behind an authenticated reverse proxy.
- Human OAuth identity and machine Device identity both resolve to a stable Memhub account.
- Project L2/L3 memory does not silently leak into another project.
- L4 keeps only genuinely cross-project personal patterns.
- Plugins do not need to know or choose the internal Memhub account_id.

See [Identity Linking](docs/IDENTITY_LINKING.md) for remote account binding.

---

## Main MCP capabilities

You do not need these names for everyday use, but harness integrations currently expose:

- **memmy_context** — recall relevant account + current-project context;
- **memmy_turn** — record one original conversation turn;
- **memmy_project / memmy_project_list** — resolve and bind projects;
- **memmy_project_manage** — controlled project management;
- **memhub_todo** — list, add, complete, and reopen project Todos;
- **memhub_distill** — turn L1 evidence into L2/L3/L4/Skill artifacts.

Implementation details, migrations, and maintenance internals live under [docs/](docs/) rather than in the main README.

---

## Health checks

Routine checks:

~~~bash
npm run core:check
npm run memory:audit
npm run state:audit
~~~

Full development test suite:

~~~bash
npm test
~~~

For real migration or repair work, read [Core Migration](docs/CORE_MIGRATION.md) first.

---

## Release packages

Every formal release can publish the same source commit as four packages:

~~~text
Linux Local
Linux Server
Windows Local
Windows Server
~~~

Downloads:

**https://github.com/PhSanqi/Memhub/releases**

---

## Project status

Memhub is under active development. The embedded Memory Core originates from the open-source Memmy lineage and is maintained as part of the Memhub runtime.

- [Changelog](CHANGELOG.md)
- [Edition Design](docs/EDITIONS.md)
- [Plugin](adapters/plugin/README.md)
- [Identity Linking](docs/IDENTITY_LINKING.md)
- [Upstream Notes](docs/UPSTREAM.md)

## License

See [LICENSE](LICENSE).
