# Memhub adapter portability

Status: current implementation baseline.

Memhub should present one product-level installation concept while keeping a portable core and thin host-specific lifecycle adapters.

## Portable core

Every supported local harness should receive the same logical Memhub package:

```text
Memhub Plugin
├── portable metadata/instructions
├── MCP connection
├── local bridge launcher/config
└── host lifecycle adapter
```

The stable model-facing tool surface is:

- `memmy_turn`
- `memmy_context`
- `memhub_distill`
- `memmy_project_list`
- `memmy_project_manage`
- `memmy_project`

Tool names are compatibility contracts and are independent from the product/package name.

## Capability levels

### Level 0 — Remote MCP only

The host connects directly to Memhub Streamable HTTP MCP. It can recall context, resolve projects, read architecture and perform explicit MCP actions, but passive full-conversation capture is not guaranteed.

### Level 1 — Portable plugin + MCP

The host installs a plugin that declares the MCP connection and usage instructions. Capture still depends on lifecycle support.

### Level 2 — Plugin + lifecycle capture

Host-specific hooks observe prompt/final/session lifecycle and submit normalized turn fragments to the local bridge. This enables automatic L1 capture, workspace/project signals and offline queueing.

### Level 3 — Native harness adapter

A harness under our control can provide exact conversation/turn IDs, deterministic project identity and first-class capture/context injection.

## Current host coverage

| Host family | Current checked-in integration | Automatic L1 capture |
| --- | --- | --- |
| Hosted ChatGPT | Remote MCP | No passive full-conversation capture |
| Codex/OpenAI hook-compatible harness | MCP + lifecycle hooks | Yes |
| Claude Code | MCP only in this repository | No |
| Gemini CLI | MCP only in this repository | No |
| VS Code/Cursor/Copilot/Kiro | MCP/plugin portability only | Client-dependent |
| CoWorker | No first-class adapter in this repository | No |

## Capture belongs to the adapter

The model should not be responsible for remembering to upload every turn.

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
capture API / memmy_turn
       |
       v
L1 original conversation
```

Adapters may emit monotonic fragments using one stable event ID. The server fills missing fields, rejects conflicting rewrites, and only treats a turn as complete when both user and assistant text are present.

Semantic L2/L3/L4/Skill distillation is a later, separate Harness job.

## One package, multiple overlays

Do not fork independent products per harness. Keep one Memhub core with small host-specific overlays and one normalized capture schema.

Normalized capture fields include stable event/conversation/turn IDs, host/version, timestamp, workspace/project hints, user text, assistant text, bounded reasoning/tool summaries and provenance.
