# MCP module boundaries

The current runtime has one MCP implementation and a deliberately small transport boundary.

| Module | Responsibility |
| --- | --- |
| `mcp.ts` | MCP tool registration, CLI entry and top-level HTTP dispatch. |
| `gateway-http.ts` | HTTP path/header parsing, loopback discrimination and web security helpers. |
| `runtime.ts` | Constructs account-scoped Project/Branch/Memory runtime dependencies. |
| `context-router.ts` | Resolves current-turn project scope and explicit Branch retrieval. |
| `turn-log.ts` | `memmy_turn` L1 lifecycle and durable ingest entry. |
| `capture.ts` | Internal L1 event storage/index/idempotency compatibility layer. |
| `capture-ingest.ts` | Deterministic L1 -> Memory Core ingest. |
| `capture-recovery.ts` | Crash recovery from durable L1 events and ingest intents. |
| `distillation-*` | Evidence grouping, job leases, validation and derived-layer recovery. |
| `project-registry.ts` | Canonical project metadata, aliases, Todo and lifecycle. |
| `branch-store.ts` | Explicit Branch metadata only. |
| `architecture-*` | Read/govern canonical Project Architecture. |
| `memory-control-*` | Control Plane reads/actions. |

There is no second MCP proxy implementation. Public Cloudflare traffic and local loopback clients terminate at the same `mcp.ts` runtime.
