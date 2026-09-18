---
name: memhub
summary: Use Memhub for durable cross-device memory and authoritative project context.
---

Memhub is the shared memory/context service for this user.

- For a non-trivial task where prior decisions or project context could matter, call the Memhub MCP tool `memmy_context` with the current request. Pass a project only when it is explicit or deterministically known; do not guess a project merely to broaden recall.
- Treat project architecture returned by Memhub/Normify as authoritative project context. Ordinary remembered context is useful background but does not silently override authoritative architecture.
- Use `memmy_remember` only for an explicit durable fact, decision, preference, or correction that should be available later. Do not use it to upload every chat turn; automatic turn capture is handled by the Memhub plugin hooks.
- Use `memmy_project` to inspect or explicitly change a conversation's project binding when needed.
- If Memhub is unavailable, continue the user's task normally rather than blocking work solely because memory recall failed.
