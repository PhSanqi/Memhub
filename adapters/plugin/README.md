# Memhub portable plugin

This is the canonical Memhub Agent Plugins package. Portable clients use its MCP
components. OpenAI/Codex harnesses that support these lifecycle hook events can
additionally use the bundled capture extension.

It uses the portable `mcp.json` to point the model at the local Memhub Bridge and OpenAI lifecycle hooks to capture turns automatically.

The hooks intentionally use only documented stable hook fields:

- `UserPromptSubmit`: `session_id`, `turn_id`, `prompt`, `cwd`, `model`;
- `Stop`: `session_id`, `turn_id`, `last_assistant_message`, `cwd`, `model`.

The transcript file is not parsed because OpenAI documents it as a convenience format rather than a stable hook interface.

Capture behavior:

1. `UserPromptSubmit` writes the user side to the plugin outbox and attempts to hand it to `127.0.0.1:17861/capture`.
2. `Stop` sends the assistant side using the same stable `event_id`.
3. Memhub Bridge/server merges the two halves.
4. Only a complete turn is ingested into Memory Core.
5. If the bridge is temporarily unavailable, `PLUGIN_DATA/outbox` retains the event and a later hook retries it.

Hooks always return `{ "continue": true }`; capture failure does not block the Codex agent loop.

For a deterministic project binding, set `MEMHUB_PROJECT_ID` in the harness environment. Otherwise the existing conversation binding is used and unresolved conversations remain global-only.
