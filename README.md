# Memhub

[简体中文](README.zh-CN.md)

Memhub is a private, project-aware memory and context hub for AI harnesses. It lets Codex, Claude Code, ChatGPT-style remote MCP clients, CoWorker, and other hosts share the same durable memory without forcing every host to use the same integration mechanism.

Memhub keeps two knowledge scopes deliberately separate:

- **Account scope** — personal preferences, reusable workflows, cross-project rules, personal skills and general world-model knowledge.
- **Project scope** — project memories, project-only skills, project environment profile, project contract, domain knowledge and authoritative architecture context.

A project skill never silently merges into an account-level skill or another project's skill.

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
   +-------------------+
   | Context Router    |
   | Memory Core       |
   | Evolution         |
   | Project scopes    |
   | Normify adapter   |
   +-------------------+
```

Memhub supports two editions built from the same core:

```text
editions/
├── local/
│   ├── linux/
│   └── windows/
└── server/
    ├── linux/
    └── windows/
```

### Local Edition

Everything runs on one machine. No VPS or Cloudflare is required. MCP, capture, SQLite, evolution and optional Normify context stay local.

### Server Edition

One server becomes the source of truth. Devices run the local Bridge and send captured turns through an authenticated reverse proxy such as Cloudflare Access. Remote MCP clients can use the same server endpoint.

See [Memhub edition design](docs/EDITIONS.md).

## Durable knowledge and evolution

The original Memory Core capabilities are retained instead of being reduced to a simple chat-history store. The current codebase still contains:

- L1 trace capture and recall;
- reflection/reward processing;
- L2 policy induction;
- Skill crystallization and lifecycle management;
- L3 World Model;
- project environment profiling;
- project contract and domain knowledge;
- account-level general rules;
- project/global retrieval isolation.

Memhub's target evolution execution model supports three backends:

1. **Direct provider** — the server uses an explicitly configured model provider/API key.
2. **Harness worker** — an already authenticated Codex/Claude/other harness pulls an evolution job over MCP, produces a structured candidate, and submits it for validation/commit.
3. **Deferred/local-only** — raw memory remains usable while model-dependent jobs stay pending until an executor becomes available.

See [Evolution and scope model](docs/EVOLUTION_SCOPES.md).

## MCP and capture

The current high-level MCP surface is intentionally small:

- `memmy_context` — composed account/project memory plus authoritative project architecture;
- `memmy_remember` — explicit durable memory;
- `memhub_history_distill` — manually start incremental project-history or whole-account memory/Skill distillation, with processed-evidence ledgers and continuation from the previous canonical result;
- `memhub_distill` — lease pending evidence or submit/skip a Harness-produced Skill, scoped summary, or curated knowledge artifact without bypassing native L2/L3 evolution;
- `memhub_evolution` — lease and complete native L3 World Model jobs with an already-authenticated Harness while Memory Core retains scope/evidence/hash validation;
- `memmy_project` — project listing/binding.

The tool names retain `memmy_` temporarily for compatibility. The product and distribution are Memhub.

Background capture is separate from MCP. A host plugin/hook sends complete or partial turns to the local Bridge; the Bridge queues them durably and uploads them when connectivity is available.

The Codex/OpenAI lifecycle adapter also performs per-turn recall on
`UserPromptSubmit`: it asks the local Bridge for Memhub account + resolved
project context and injects the result as hook `additionalContext`. The active
model is instructed to filter noisy/stale candidates before use and to persist
only durable task deltas near task completion. Hosted ChatGPT MCP still has no
server-push lifecycle equivalent, so its per-turn recall depends on the host
actually invoking `memmy_context`.

Automatic capture is a host capability, not an MCP side effect. The checked-in
Codex/OpenAI hook adapter captures complete turns automatically. A plain hosted
ChatGPT MCP connection does not passively stream the full conversation to
Memhub, and the repository does not yet contain Claude/Gemini lifecycle capture
overlays.

The browser routes are intentionally split:

- `/memhub` — public project introduction / landing page;
- `/memhub/user` — authenticated account workspace;
- `/memhub/admin` — authenticated admin Control Plane.

An administrator can switch between User and Admin from the web header; role
authorization still decides whether `/memhub/admin` is allowed.
Loopback administration uses a separate local-admin token; public administration
continues to require Cloudflare Access identity plus the stable Memhub account
role. Distillation evidence can be queued manually, while optional automatic
job creation is disabled by default and never invokes a model itself.

`memmy_context` returns relevant account/global memory plus relevant memory for
the one resolved project; it is not a full database dump. Historical
consolidation is available through `memhub_history_distill`, which remembers
exactly which evidence refs were already processed and supplies the previous
canonical result to the next batch.

See [Control Plane, capture and distillation](docs/CONTROL_PLANE_AND_DISTILLATION.md)
and [remote authentication](docs/REMOTE_AUTH.md).

## Install from source

Node.js 20+ is required. The first source install may run the workspace build.

Local Linux:

```bash
bash editions/local/linux/install.sh
```

Local Windows (PowerShell):

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

Server Edition intentionally does not create Cloudflare configuration for you. It binds Memhub to loopback; protecting `/memhub/*` with Cloudflare Access is appropriate when the same Access application should cover MCP, Control Plane and public capture traffic. Automated clients that traverse Access must use an allowed Service Auth policy/token in addition to Memhub's own device/account authentication.

## Repository status

Memhub is currently an active fork/refactor. The shared Memory Core is derived from the open-source Memmy project by MemTensor; Memhub adds private gateway, device capture, project isolation, Bridge transport, deployment editions, and a different product boundary. See [upstream attribution](docs/UPSTREAM.md).

## License

Retain the upstream repository license and notices for inherited code. New Memhub-specific code follows the repository license unless a file states otherwise.
