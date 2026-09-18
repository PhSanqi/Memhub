---
name: memhub
summary: Use Memhub for durable cross-device memory and authoritative project context.
---

Memhub is the shared memory/context service for this user.

- For a non-trivial task where prior decisions or project context could matter, call the Memhub MCP tool `memmy_context` with the current request. Pass a project only when it is explicit or deterministically known; do not guess a project merely to broaden recall.
- Treat project architecture returned by Memhub/Normify as authoritative project context. Ordinary remembered context is useful background but does not silently override authoritative architecture.
- Use `memmy_remember` only for an explicit durable fact, decision, preference, or correction that should be available later. Do not use it to upload every chat turn; automatic turn capture is handled by the Memhub plugin hooks.
- Use `memhub_distill` when the current Harness has actually synthesized a reusable Skill, scoped summary, or curated knowledge artifact. Always choose `global` versus `project` explicitly; never promote a project artifact into global scope merely because it may be useful elsewhere.
- Use `memhub_evolution` only for pending native L3 World Model work. Call `action=next` with an explicit global/project scope, follow the returned `systemPrompt` against exactly the returned `dynamicInput`, and submit exactly one schema-constrained `candidate` with `action=submit`. Do not add facts that are absent from the supplied evidence. If the server reports a stale base, lease the refreshed job context before retrying.
- `memhub_evolution` may update account-level general rules or the current project's project contract/domain knowledge. It must never be used to overwrite Normify architecture; Normify remains authoritative and read-only through Memhub.
- Use `memmy_project` to inspect or explicitly change a conversation's project binding when needed.
- If Memhub is unavailable, continue the user's task normally rather than blocking work solely because memory recall failed.
