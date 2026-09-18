# Memmy Context Hub boundaries

This fork narrows Memmy around one job: provide private, durable context to many AI hosts without mixing unrelated projects.

## Product boundary

The core product is:

```text
AI hosts (ChatGPT, Codex, Claude, DevSpace, others)
                    |
                    v
          authenticated MCP gateway
                    |
                    v
             Context Router
          /         |          \
         v          v           v
 global memory  project memory  recent session
                    |
                    +----> authoritative project sources
                              (Normify adapter first)
```

Memory Core remains a loopback service and durable local store. The public network boundary belongs to a separate authenticated gateway. AI hosts must not receive direct access to the raw Memory HTTP API.

## Core responsibilities

The maintained core is intentionally small:

1. **Long-term memory**: capture, recall, correction, evolution and provenance.
2. **Context routing**: resolve account, conversation and project scope before recall.
3. **Project context**: combine project-scoped memory with authoritative architecture sources.
4. **MCP gateway**: expose a small host-neutral context surface with identity and account isolation.

The existing Agent chat loop, Goal runtime, provider login, channel login and multi-channel gateway are not required by this product direction. They are retained temporarily for compatibility but are **deferred surfaces**, not dependencies of the core.

## Context classes

Context returned to a host must preserve source and authority instead of flattening everything into one vector search result.

| Class | Scope | Authority | Examples |
| --- | --- | --- | --- |
| Global memory | account | remembered | user preferences, recurring working rules, cross-project habits |
| Project memory | account + project | remembered | prior decisions, unfinished work, project-specific history |
| Project architecture | account + project | authoritative | modules, ownership, dependency rules, current/target contracts from Normify |
| Recent session | account + conversation | observed | current thread, recent task state, unresolved follow-up |

Remembered context may evolve or be corrected. Authoritative project context must only change through its owning system; conversation text must never silently rewrite Normify architecture.

## Project isolation rule

Project selection is a security and correctness boundary, not merely a search hint.

Resolution order:

1. explicit authenticated `projectId`/workspace binding;
2. an existing conversation-to-project binding;
3. an exact project registry alias or repository/workspace identity;
4. semantic classification only when it produces one unambiguous candidate.

If no project is resolved, recall **global memory only**. If multiple projects are plausible, do not merge their memories. Return candidates to the host or require a project binding.

Cross-project retrieval must be explicit in the request and visible in the response provenance.

## Normify boundary

Normify remains the owner of deterministic architecture truth. Memmy consumes it through an adapter.

```text
Context Router -> Normify Adapter -> Normify engine/data
```

Do not copy Normify module graphs into ordinary memory and then treat the copy as authoritative. A cached rendering may be stored for performance only when it includes project identity, source revision/hash and staleness metadata.

## Identity boundary

The target gateway reuses the account model proven by the local Normify MCP work:

```text
Cloudflare Access identity (email + sub)
               |
               v
          local account_id
               |
        +------+------+
        |             |
   global memory   projects
```

`account_id` is the hard tenant boundary. A friend's account must never search, evolve or enumerate another account's memories or projects unless a future explicit project ACL is introduced.

Cloudflare is an authentication boundary, not a data-processing backend. Conversation history, project architecture and memory contents stay in the local Memmy data plane.

## Initial MCP surface

Prefer a small semantic surface rather than exposing internal L1/L2/L3 operations directly:

- `memmy_context`: resolve scope and return a bounded Context Capsule.
- `memmy_remember`: capture an explicit durable fact/decision with scope and provenance.
- `memmy_project`: inspect or bind project identity and authoritative project context.

Host adapters remain responsible for automatic turn capture when a host does not send every conversation turn through MCP. MCP recall and host capture are complementary responsibilities.

## Context Capsule contract

The eventual `memmy_context` result should be structurally separated:

```text
identity
resolved_project
global_memory[]
project_memory[]
project_architecture[]
recent_session[]
provenance[]
ambiguities[]
```

The router, not the model, enforces account/project filtering. The model may help classify an ambiguous request, but it must not bypass deterministic namespace filters.
