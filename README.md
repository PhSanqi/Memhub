# Memhub

**Shared long-term memory for AI agents, with local and server deployment.**

[简体中文](README.zh-CN.md)

Memhub gives MCP-capable AI agents a durable memory space that can follow work across conversations, projects and machines. It is designed for people who want their agents to remember important context without turning every chat into permanent noise.

## What you can do

- **Keep long-term memory across conversations** — durable facts, decisions, preferences and corrections can be recalled later.
- **Separate global and project memory** — keep account-wide context while preserving project-specific boundaries.
- **Continue work across agents and machines** — connect multiple MCP-capable clients to the same memory space.
- **Capture conversation history** — supported host integrations can preserve completed turns automatically.
- **Distill history on demand** — turn accumulated history into cleaner cumulative memory instead of repeatedly rereading old conversations.
- **Extract reusable skills** — preserve procedures and repeatable workflows separately from ordinary memory.
- **Keep project context** — recall project-level context alongside ordinary long-term memory.
- **Manage memory from the web** — user and administrator views make projects, devices, memories and lifecycle data visible.
- **Run locally or centrally** — choose a single-machine Local Edition or a multi-device Server Edition.

## Editions

| Edition | Best for | Platform |
| --- | --- | --- |
| Local | One machine, no VPS or public endpoint required | Linux |
| Local | One Windows workstation | Windows |
| Server | Central memory service for multiple devices/agents | Linux |
| Server | Central memory service on a Windows host | Windows |

Four matching GitHub Releases are published for each Memhub version.

## Requirements

- Node.js 20 or newer; Node.js 22 is recommended.
- npm.
- Linux packages expect a user-level systemd session.
- Windows packages use Windows Task Scheduler for background startup.

## Install

Download the Release matching your platform and deployment mode, then extract it.

### Linux Local

```bash
tar -xzf memhub-v0.1.0-linux-local.tar.gz
cd memhub-v0.1.0-linux-local
bash editions/local/linux/install.sh
```

After installation, connect your AI client to:

```text
http://127.0.0.1:17861/mcp
```

### Windows Local

Extract `memhub-v0.1.0-windows-local.zip`, open PowerShell in the extracted directory, then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\editions\local\windows\install.ps1
```

Connect your AI client to:

```text
http://127.0.0.1:17861/mcp
```

### Linux Server

Extract `memhub-v0.1.0-linux-server.tar.gz`, then run:

```bash
cd memhub-v0.1.0-linux-server
MEMHUB_PUBLIC_HOST=memory.example.com bash editions/server/linux/install.sh
```

The server binds its services to loopback. Put the `/memhub/*` routes behind your authenticated reverse proxy before exposing them publicly.

Your MCP endpoint is then typically:

```text
https://memory.example.com/memhub/mcp
```

### Windows Server

Extract `memhub-v0.1.0-windows-server.zip`, then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\editions\server\windows\install.ps1 -PublicHost memory.example.com
```

Put `/memhub/*` behind your authenticated reverse proxy before exposing the service publicly.

## Use

Once the MCP endpoint is connected to your AI client, Memhub exposes tools for:

- recalling relevant long-term context;
- saving durable memory;
- working with project memory;
- distilling accumulated history;
- creating reusable skills from history;
- managing memory evolution.

For the best continuity, configure your agent to recall Memhub context at the start of each meaningful turn and only write back durable information rather than every raw message.

### Web pages

When using Server Edition:

- `/memhub` — project landing page;
- `/memhub/user` — authenticated user workspace;
- `/memhub/admin` — administrator Control Plane.

## Acknowledgements

Memhub is grateful to:

- [Memmy](https://github.com/MemTensor/memmy-agent) by [@MemTensor](https://github.com/MemTensor) — an open-source shared memory project for AI agents.
- [DSH-Normify](https://github.com/yan-mc/dsh-normify) by [@yan-mc](https://github.com/yan-mc) — project architecture and agent workflow tooling.

Please also retain the license notices shipped with third-party and vendored components.

## License

MIT. See [LICENSE](LICENSE).
