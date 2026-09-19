# Memhub portable plugin

This is the canonical Memhub Agent Plugins package. Portable clients use its MCP
components. OpenAI/Codex harnesses that support these lifecycle hook events can
additionally use the bundled capture extension.

It uses the portable `mcp.json` to point the model at the local Memhub Bridge and OpenAI lifecycle hooks to recall context, capture turns, restore context after compaction and close Memory Core sessions cleanly.

The hooks intentionally use only documented lifecycle fields:

- `UserPromptSubmit`: `session_id`, `turn_id`, `prompt`, `cwd`, `model`;
- `Stop`: `session_id`, `turn_id`, `last_assistant_message`, `cwd`, `model`.
- `SessionStart`, `PostCompact`, `SessionEnd`: `session_id`, `cwd`.

The transcript file is not parsed because OpenAI documents it as a convenience format rather than a stable hook interface.

Recall + capture behavior:

1. `UserPromptSubmit` recalls account + resolved-project context through `127.0.0.1:17861/context` and returns it as documented Codex `additionalContext`, so every Codex turn gets a memory pass before model work. Recall failure is fail-open.
2. The same hook writes the user side to the plugin outbox and attempts to hand it to `127.0.0.1:17861/capture`.
3. `Stop` sends the assistant side using the same stable `event_id`.
4. Memhub Bridge/server merges the two halves.
5. Only a complete turn is ingested into Memory Core.
6. If the bridge is temporarily unavailable, `PLUGIN_DATA/outbox` retains the event and a later hook retries it.
7. `SessionStart` and `PostCompact` reload Memhub context through the same account/project boundary; `SessionEnd` closes the corresponding Memory Core session so episode/evolution closure remains explicit.

Hooks always return `{ "continue": true }`; capture failure does not block the Codex agent loop.

For a deterministic project binding, set `MEMHUB_PROJECT_ID` in the harness environment. Otherwise the existing conversation binding is used and unresolved conversations remain global-only.
