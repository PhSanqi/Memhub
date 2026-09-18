# Memhub adapter portability

Status: design baseline, 2026-09-18.

Memhub should present one product-level installation concept — a **Memhub plugin/adapter** — while keeping the implementation split between a portable core and host-specific capture extensions.

## Why this split exists

The portable Agent Plugins 1.0 format standardizes a shared plugin manifest, Agent Skills and MCP server configuration. It deliberately does **not** standardize lifecycle hooks, commands, agents or other host-specific runtime extensions yet.

That means Memhub can make discovery, installation and model-facing tools portable, but automatic conversation capture still needs a thin adapter for each harness that exposes suitable lifecycle events.

## Portable core

Every supported local AI harness should receive the same logical Memhub package:

```text
Memhub Plugin
├── portable plugin metadata
├── MCP connection
├── Memhub skill/instructions
├── local bridge launcher/config
└── host adapters
    ├── OpenAI/Codex hooks
    ├── Claude hooks/plugin overlay
    ├── Gemini extension hooks
    ├── CoWorker native adapter
    └── future client adapters
```

The model-visible tool contract stays stable:

- `memmy_context`
- `memmy_remember`
- `memhub_distill`
- `memmy_project`

Tool names are compatibility contracts and are intentionally independent from the product/package name.

## Capability levels

Memhub adapters are classified by what the host actually permits.

### Level 0 — Remote MCP only

The host connects directly to the hosted Memhub Streamable HTTP MCP endpoint.

Capabilities:

- contextual recall;
- explicit memory writes when the host permits write tools;
- project resolution and architecture lookup;
- no guaranteed passive capture of every conversation turn.

Best for browser/hosted chat surfaces.

### Level 1 — Portable plugin + MCP

The host installs a portable plugin that automatically declares Memhub's MCP connection and usage instructions.

Capabilities:

- no manual MCP configuration;
- same model-facing tools everywhere;
- portable skills/instructions;
- capture still depends on host lifecycle support.

### Level 2 — Plugin + lifecycle capture

The plugin additionally installs host-specific hooks that observe the user prompt/final response/session lifecycle and submit normalized capture events to the local bridge.

Capabilities:

- automatic upload of conversation turns;
- automatic project/workspace signals;
- recall injection at session/turn start where the host allows it;
- offline queue through the local bridge.

### Level 3 — Native harness adapter

For a harness under our control (for example CoWorker), Memhub is a first-class integration rather than an external hook package.

Capabilities:

- reliable conversation IDs;
- exact turn boundaries;
- direct workspace/project identity;
- deterministic capture and context injection;
- richer device/runtime telemetry without scraping logs.

## Current host strategy

| Host family | MCP | Installable plugin/extension | Lifecycle hooks suitable for capture | Memhub target |
| --- | --- | --- | --- | --- |
| ChatGPT hosted chat | Remote MCP/plugin-backed tools | Yes on supported surfaces | Hosted lifecycle is not a local hook surface | Level 0/1 |
| Codex CLI / ChatGPT Work runtime | stdio + Streamable HTTP MCP | Agent Plugins / OpenAI plugins | Yes | Level 2 |
| Claude Code | stdio + HTTP MCP | Claude-specific packaging/config | Yes, host-specific | Level 2 |
| Gemini CLI | stdio + HTTP MCP | Gemini extensions | Yes | Level 2 |
| VS Code | Agent Plugins MCP | Agent Plugins | Client-dependent | Level 1 first |
| Cursor | Agent Plugins MCP | Agent Plugins | Client-dependent | Level 1 first |
| GitHub Copilot | Agent Plugins MCP | Agent Plugins | Client-dependent | Level 1 first |
| Kiro | Agent Plugins MCP | Agent Plugins | Client-dependent | Level 1 first |
| Hermes / OpenClaw / similar | Agent Plugins MCP | Agent Plugins where supported | Client-dependent | Level 1 first |
| CoWorker | native tool/plugin surface | Native | Native | Level 3 |

## Capture belongs to the adapter, not to the LLM

The model should not be responsible for remembering to upload every turn. Automatic capture is an integration responsibility.

```text
host lifecycle event
       |
       v
Memhub adapter
       |
       v
local bridge queue
       |
       v
capture API
       |
       v
server/local distillation pipeline
```

The first capture protocol supports monotonic fragments. Adapters that receive `UserPromptSubmit` and `Stop`/`AfterAgent` separately may emit both lifecycle fragments using the same stable `event_id`; the Bridge/Server fills only missing fields and rejects conflicting rewrites. Distillation begins only after both `user_text` and `assistant_text` are present.

The MCP tool `memmy_remember` remains useful for explicit semantic memory decisions, but it is not the primary transport for raw conversation history.

## One package, multiple host overlays

Do not create independent full products such as `memhub-codex`, `memhub-claude`, and `memhub-gemini` that fork core logic.

Keep one Memhub plugin source tree with:

1. a portable Agent Plugins projection for clients supporting that standard;
2. small host-specific overlay manifests/hooks;
3. one local bridge protocol;
4. one normalized capture event schema.

Host adapters may differ in installation mechanics, but their output into Memhub must be identical.

## Normalized capture event

All host-specific capture adapters should reduce their event data to the same payload before queueing/uploading:

```text
event_id
account/device identity
host
host_version
conversation_id
turn_id
timestamp
workspace identity/path
project hint/binding
user text
assistant text
tool summary/provenance (optional)
event source
```

Raw host-specific fields can be attached under provenance, but the Memory/distillation layer should not depend on vendor schemas.

## Installation policy

The desired user experience is:

```text
memhub install
memhub login              # Server Edition only
memhub plugin install     # auto-detect supported harnesses
memhub status
```

Advanced users may still connect the remote MCP endpoint directly, but direct manual MCP configuration should be an escape hatch rather than the default local-harness experience.
