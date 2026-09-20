# Memhub editions

Memhub is developed as one shared core with two deployment editions. They must not become two diverging memory implementations.

## Shared core

Both editions use the same:

- Memory Core and schema;
- Context Router;
- project/global isolation rules;
- Architecture Reader for existing authoritative project Markdown;
- MCP tool contract;
- capture event schema;
- distillation pipeline;
- host plugin/adapter packages;
- local bridge implementation.

Only topology, authentication and storage placement differ.

## Server Edition

Target user: someone who has a VPS/server and can configure Cloudflare or another authenticated reverse proxy.

```text
device A plugin ----\
device B plugin -----+--> Cloudflare/Auth --> Memhub Server
hosted MCP ----------/                         |- Memory Core
                                               |- Context Router
                                               |- Architecture Reader
                                               `- capture/distillation
```

Properties:

- one central long-term memory source of truth;
- multi-device access;
- account + device identity;
- authenticated remote Streamable HTTP MCP;
- authenticated capture endpoint;
- server-side database and architecture data;
- local device queue is temporary transport only;
- Cloudflare is identity/transport, not a memory-processing backend.

Server Edition is the right choice for the current deployment.

### Server public routes

The current Server Edition exposes two logical routes behind the authenticated reverse proxy:

```text
/memhub/mcp      model/tool traffic
/memhub/capture  background plugin capture
```

Interactive/hosted MCP clients may authenticate through the human Cloudflare Access identity flow. Local Bridge installations use a Cloudflare Access service credential for the outer proxy plus a revocable Memhub device token for account/device identity at the origin.

## Local Edition

Target user: no server, or someone who explicitly wants all memory to remain on one machine.

```text
local AI plugins
       |
       v
Memhub Local Bridge / MCP
       |
       +--> local Memory Core / SQLite
       `--> local architecture data
```

Properties:

- zero server requirement;
- no Cloudflare requirement;
- loopback-only by default;
- local SQLite and local architecture data;
- the same plugin/bridge API as Server Edition;
- optional manual export/backup, but no peer-to-peer merge protocol in the initial version.

Local Edition should feel identical to an AI host: the host talks to the Memhub plugin/bridge and uses the same MCP tools.

## Edition selection belongs below the plugin

Plugins should not have independent Server and Local variants.

The same installed adapter chooses one backend profile:

```text
mode = server
endpoint = https://example.com/memhub/mcp

or

mode = local
endpoint = http://127.0.0.1:<local-port>/mcp
```

This avoids doubling every Codex/Claude/Gemini/CoWorker integration.

## Repository direction

Recommended long-term layout:

```text
Memhub/
├── core/                 # router/contracts shared by editions
├── bridge/               # local daemon, queue, device identity
├── adapters/             # host packaging/hook overlays
│   ├── agent-plugin/
│   ├── openai/
│   ├── claude/
│   ├── gemini/
│   └── coworker/
├── editions/
│   ├── server/           # authenticated HTTP deployment
│   └── local/            # all-local launcher/bundle
└── docs/
```

The current `src/` implementation is the starting shared gateway and should be migrated toward this layout incrementally rather than rewritten.

## Release naming

Suggested artifacts:

- `memhub-server` — server deployment bundle;
- `memhub-local` — standalone local bundle;
- `memhub-plugin` — portable adapter package where the host supports Agent Plugins;
- `memhub` — installer/manager CLI that selects edition and installs host adapters.

The Memhub gateway workspace package is named `memhub`; inherited Memory Core workspaces retain their upstream package names for compatibility during the refactor.

## No database synchronization between editions

Server Edition does not synchronize full databases between devices. Devices upload events to one server-side source of truth.

Local Edition owns its local source of truth.

If migration between Local and Server Editions is needed later, implement an explicit export/import migration protocol rather than live multi-master SQLite synchronization.
