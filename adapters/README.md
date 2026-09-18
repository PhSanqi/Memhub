# Memhub adapters

This directory is reserved for host integration packages.

The adapter rule is strict: adapters translate host lifecycle/configuration into the common Memhub bridge/MCP/capture protocols. They do not implement memory semantics themselves.

Planned adapters:

- `plugin/` — Agent Plugins 1.0 portable projection (`plugin.json`, `mcp.json`, `skills/`).
- `plugin/` — canonical Agent Plugins package; OpenAI/Codex hooks live as a client extension inside it.
- `claude/` — Claude Code hook/plugin overlay.
- `gemini/` — Gemini CLI extension + hooks projection.
- `coworker/` — native CoWorker integration.

The portable Agent Plugins package should be the primary distribution form wherever the host implements it. Client-specific files should extend the portable package, not replace it.
