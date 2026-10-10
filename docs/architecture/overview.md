# Memhub architecture

Memhub is a self-hosted account/project memory control layer exposed through one MCP runtime. The authoritative runtime topology is intentionally small:

```text
Local client ───────────────> 127.0.0.1:3001/mcp ──┐
                                                   ├─ Memhub MCP Runtime ─> Memory Core :18960
Remote client -> Cloudflare -> 127.0.0.1:3001/mcp ─┘
```

Cloudflare is an authenticated transport boundary, not a second Memhub implementation. Local and remote callers use the same tool schema, project registry, L1 evidence, distillation jobs and Memory Core.

## Durable memory model

```text
L1 original turn evidence
        |
        v
L2 project timeline
        |
        v
L3 project durable profile
        |
        v
L4 account-wide durable profile

Skill  = orthogonal reusable capability
Todo   = project registry state
Branch = explicit project-local workstream scope
```

- L1 is append-oriented source evidence. `memmy_turn open/checkpoint/commit` is the normal write contract.
- L2 is canonical project chronology.
- L3 is canonical project-scoped durable rules, preferences and experience.
- L4 is canonical account-scoped durable profile supported by cross-project evidence.
- Skill is a separately governed reusable procedure.
- Todo and Branch are control concepts, not memory layers.

## Identity and transport

The product user boundary is the stable Memhub `account_id`. A model, host application, OS, connection and transport are provenance only.

- Loopback MCP uses the explicitly configured local account.
- Remote MCP validates Cloudflare identity and resolves it to the same Memhub account model.
- Client-supplied account identity is never trusted as authorization.
- Host conversation/session identifiers may be retained as historical provenance, but they do not select project, Branch or distillation scope.

## Project routing

Project scope is resolved from current-turn evidence only:

1. explicit `project` / authenticated namespace;
2. explicit `workspace_project`;
3. exact registered alias;
4. one unambiguous semantic candidate;
5. otherwise global-only recall.

Memhub does not persist conversation-to-project routing. If project and workspace evidence conflict, the operation fails closed rather than guessing.

Branch is also explicit. `memhub_branch` manages `create/list/close/reopen`; `memmy_context` receives a Branch id/name when a workstream should narrow retrieval. There is no conversation-to-Branch state.

## MCP runtime responsibilities

The runtime owns:

- authentication and account resolution;
- Project Registry, Todo and Branch metadata;
- L1 turn storage and ingest idempotency;
- Context Router and bounded retrieval;
- Skill selection/telemetry;
- L2/L3/L4 distillation job control and evidence validation;
- Project Architecture governance;
- Control Plane HTTP views;
- MCP result chunking for large responses.

Memory Core owns durable memory storage/search/read models. The connected Harness/model owns semantic synthesis. Memhub validates scope, evidence and revision fences; it does not invent semantic conclusions when no model executor is present.

## L1 durability

The authoritative L1 body is stored as per-event JSON under the Memhub state root. `capture-index.sqlite` is a rebuildable index used for pagination, project filtering, counts and scheduling. The historical field names remain storage compatibility details; they are not a second HTTP ingestion API.

Core ingestion uses stable event-derived request ids. If a process dies after Core commits but before the local marker or downstream queue update, recovery replays the same deterministic request and then reconciles the durable marker/job state. This behavior is covered by the real two-process stack smoke test.

## Distillation

Automatic distillation groups complete, ingested L1 evidence by account + project, not by host conversation. L2 completion may enqueue L3. L3 can contribute to L4 only through exact, validated project evidence.

Explicit user-authored L3/L4 mutation is separate from automatic distillation: `memhub_memory plan` produces the complete resulting body, the user approves that exact text, the confirmation is captured as L1, and `execute` commits only if the base revision and confirmation evidence are still valid.

## Project Architecture

Project Architecture is stable structural context: ownership, source-of-truth declarations, interfaces and hard constraints. The writable canonical document lives in Memhub private state. Repository Markdown and legacy architecture sources may be read as migration/context inputs but are never silently mutated.

`memmy_project architecture_plan -> explicit approval -> architecture_execute` performs a full-document replacement with fingerprint fencing and revision history.

## Runtime layout

A managed installation uses one logical stack:

- `memhub-core.service` — Memory Core on loopback `18960`;
- `memhub.service` — MCP runtime on loopback `3001`;
- `memhub-stack.target` — stack ownership on Linux;
- `Memhub-Stack` — equivalent single Windows scheduled task wrapper;
- `memhub.env` — one runtime environment file.

Server exposure is configuration (`MEMHUB_PUBLIC_HOST` plus Cloudflare), not a second runtime mode.
