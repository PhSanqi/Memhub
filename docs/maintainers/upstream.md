# Upstream attribution

Memhub started from the open-source Memmy Agent codebase maintained by MemTensor:

- Upstream repository: `https://github.com/MemTensor/memmy-agent`
- Initial Memhub work was based on the upstream `v1.1.4` line.

Inherited source code, notices and license obligations remain attributable to the upstream project. Memhub-specific work adds or changes product boundaries, project/account isolation, privacy defaults, MCP gateway behavior, MCP transport, account/project governance and Local/Server deployment packaging.

EN: The machine-readable baseline lives in the `upstream` block of `vendor/manifest.json` (`repo`, `tag`, `commit`, `memoryServiceVersion`, `reviewedThrough`, `absorbed`); the selection rationale is in `docs/reviews/2026-10-19-upstream-review.md`.
中文：机器可读的基线记录位于 `vendor/manifest.json` 的 `upstream` 块（`repo`、`tag`、`commit`、`memoryServiceVersion`、`reviewedThrough`、`absorbed`）；取舍理由见 `docs/reviews/2026-10-19-upstream-review.md`。
