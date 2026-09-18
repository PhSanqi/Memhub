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
Memhub/editions/
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

See [Memhub edition design](Memhub/docs/EDITIONS.md).

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

See [Evolution and scope model](Memhub/docs/EVOLUTION_SCOPES.md).

## MCP and capture

The current high-level MCP surface is intentionally small:

- `memmy_context` — composed account/project memory plus authoritative project architecture;
- `memmy_remember` — explicit durable memory;
- `memhub_distill` — submit a Harness-produced Skill, scoped summary, or curated knowledge artifact without bypassing native L2/L3 evolution;
- `memmy_project` — project listing/binding.

The tool names retain `memmy_` temporarily for compatibility. The product and distribution are Memhub.

Background capture is separate from MCP. A host plugin/hook sends complete or partial turns to the local Bridge; the Bridge queues them durably and uploads them when connectivity is available.

## Install from source

Node.js 20+ is required. The first source install may run the workspace build.

Local Linux:

```bash
bash Memhub/editions/local/linux/install.sh
```

Local Windows (PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -File .\Memhub\editions\local\windows\install.ps1
```

Server Linux:

```bash
MEMHUB_USERNAME=owner bash Memhub/editions/server/linux/install.sh
```

Server Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\Memhub\editions\server\windows\install.ps1 -Username owner
```

Server Edition intentionally does not create Cloudflare configuration for you. It binds Memhub to loopback; publish `/memhub/mcp` and `/memhub/capture` through your authenticated tunnel/reverse proxy.

## Repository status

Memhub is currently an active fork/refactor. The shared Memory Core is derived from the open-source Memmy project by MemTensor; Memhub adds private gateway, device capture, project isolation, Bridge transport, deployment editions, and a different product boundary. See [upstream attribution](docs/UPSTREAM.md).

## License

Retain the upstream repository license and notices for inherited code. New Memhub-specific code follows the repository license unless a file states otherwise.
