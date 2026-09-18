# Memmy Context Hub simplification scope

The Context Hub fork is intentionally narrower than the existing all-in-one Memmy application.

## Primary product

Keep the product centered on four capabilities:

1. private long-term memory;
2. deterministic account/project context routing;
3. authoritative project context through adapters such as Normify;
4. a small authenticated MCP surface for many AI hosts.

These capabilities form the supported core. New work should strengthen them before expanding the agent application surface.

## Keep in the core path

- Memory HTTP service bound to loopback.
- Local SQLite persistence and local indexes/embeddings.
- Session/turn capture, recall, correction and provenance.
- Existing user/project L3 ownership model.
- Agent-source import when it supplies conversation history to Memory.
- Project/workspace identity and conversation bindings.
- Privacy/network policy.
- Context Router and Context Capsule contracts.
- Normify adapter boundary.
- Authenticated MCP Gateway.

## Defer from the core path

The following existing features are compatibility surfaces, not dependencies of Context Hub:

- Memmy's own general-purpose AI chat agent;
- persistent Goal execution;
- multi-provider account/login management used to run Memmy as an AI assistant;
- social/chat channel logins and channel gateway;
- image generation and unrelated assistant tools;
- remote/cloud memory storage;
- remote memory summarization/evolution/embedding.

Do not delete these in the first restructuring phase. Stop new core code from depending on them, then remove or split packages only after the Context Hub path is independently buildable and deployable.

## Dependency direction

Target dependency direction:

```text
Host adapters ----+
                  |
MCP Gateway ------+--> Context Router --> Memory Core
                           |
                           +-----------> Project Context Adapter --> Normify

Deferred Agent/Goal/Channels -----------------------------> compatibility only
```

The core must never depend on provider-login, channel-login or general agent runtime code.

## Removal rule

A deferred surface can be removed or moved out only after all of the following are true:

1. Context Hub has its own entrypoint and tests;
2. Memory capture/recall still works without the surface;
3. no migration, installer or agent-source integration requires it;
4. installed user data remains readable;
5. the change does not weaken privacy or account/project isolation.

This keeps simplification reversible and prevents a cleanup from becoming a data migration incident.
