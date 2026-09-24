# Memhub core scope

Memhub intentionally keeps its supported runtime narrower than the upstream all-in-one Memmy application.

## Primary product

Keep the product centered on four capabilities:

1. private long-term memory;
2. deterministic account/project context routing;
3. authoritative project architecture through the read-only Architecture Reader;
4. a small authenticated MCP surface for many AI hosts.

These capabilities form the supported core. New work should strengthen them before expanding the agent application surface.

## Keep in the core path

- Memory HTTP service bound to loopback.
- Local SQLite persistence and local indexes/embeddings.
- Session/turn capture, recall, correction and provenance.
- L1/L2/L3/L4/Skill ownership and scope rules.
- Agent-source import when it supplies conversation history to Memory.
- Project/workspace identity and conversation bindings.
- Privacy/network policy.
- Context Router and Context Capsule contracts.
- Architecture Reader boundary for existing authoritative Markdown.
- Authenticated MCP Gateway.

## Defer from the core path

The following inherited features are compatibility surfaces, not dependencies of Memhub:

- Memmy's own general-purpose AI chat agent;
- persistent Goal execution;
- multi-provider account/login management used to run Memmy as an AI assistant;
- social/chat channel logins and channel gateway;
- image generation and unrelated assistant tools;
- remote/cloud memory storage;
- remote memory summarization/evolution/embedding.

New Memhub code must not depend on these surfaces. Retained vendored compatibility code is bounded by regression tests and may be reduced further only when installed user data remains readable.

## Dependency direction

Target dependency direction:

```text
Host adapters ----+
                  |
MCP Gateway ------+--> Context Router --> Memory Core
                           |
                           +-----------> Architecture Reader --> existing Markdown

Deferred Agent/Goal/Channels -----------------------------> compatibility only
```

The core must never depend on provider-login, channel-login or general agent runtime code.

## Removal rule

A deferred surface can be removed or moved out only after all of the following are true:

1. Memhub has its own entrypoint and tests;
2. Memory capture/recall still works without the surface;
3. no migration, installer or agent-source integration requires it;
4. installed user data remains readable;
5. the change does not weaken privacy or account/project isolation.

This keeps simplification reversible and prevents a cleanup from becoming a data migration incident.
