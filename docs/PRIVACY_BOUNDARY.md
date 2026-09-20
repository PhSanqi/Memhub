# Memhub privacy and data-flow boundary

Memhub stores conversation history, durable user memory and project context. These are private data by default, including project architecture read from existing local architecture Markdown.

## Default policy

Memory Core is **local-only**. Merely configuring a remote URL does not authorize data egress.

The first enforcement point is the vendored Memory Core at
`vendor/memory-core/src/privacy/network-policy.js`. The following core
paths use it:

- model/embedding HTTP requests;
- remote storage backend construction;
- raw Memory REST clients.

Loopback HTTP/HTTPS targets are allowed. Non-loopback targets are denied unless the caller makes an explicit code-level `allowRemote: true` decision. This compatibility escape hatch is deliberately not exposed as a normal end-user Memhub configuration.

## Data classes

| Data | Sensitivity | Default network policy |
| --- | --- | --- |
| Raw conversation turns | high | local only |
| Long-term/global memory | high | local only |
| Project memory and decisions | high | local only |
| Project architecture/contracts | high | local only |
| Embeddings derived from private content | high | local only |
| Account/project identifiers | private | gateway/auth use only |
| Installer/release metadata | low | network allowed outside Memory Core |

Derived data is not considered less sensitive merely because it is summarized or embedded.

## Known network-capable surfaces

The baseline contains several different kinds of network behavior. They must not be conflated.

### Memory-content egress paths

`vendor/memory-core/src/model/http.js` can send prompts, summaries,
evolution input and embedding input to configured model providers.
`openmem-cloud-rest` represents a remote storage mode. These are private-data
egress paths and are default-denied by the core privacy boundary.

### Adapter-to-Memory transport

Agent integration templates and workspace bridges may submit/recall memory through configured endpoints. Raw Memory Core remains loopback-only in supported Memhub deployments; remote hosts use the authenticated Memhub Gateway/Bridge boundary rather than exposing Memory Core directly.

### Installer/update traffic

The runtime installer downloads release/runtime artifacts. This traffic does not need conversation or project content and is outside the Memory data plane. It should remain separately auditable rather than being disabled by the Memory privacy guard.

## Authentication topology

Target deployment:

```text
Internet AI host
     |
     | authenticated HTTPS / MCP
     v
Cloudflare Access / tunnel
     |
     v
Memhub MCP Gateway (identity + account scope)
     |
     | loopback only
     v
Memory Core ---- local SQLite / local embedding
     |
     +---- Architecture Reader -> local/account-scoped architecture Markdown
```

Memory Core itself should remain bound to loopback. The gateway is the only intended public ingress. Cloudflare receives authentication traffic; it is not the storage or model-processing destination for memory contents.

## Remote processing policy

Remote model/storage support is deferred, not silently trusted. If it is reintroduced later, the policy must be capability-specific, for example allowing a user to authorize `memory_summary` without automatically authorizing raw turns, project architecture, embeddings or storage replication.

An authorization should record at least: account, data class/capability, destination, purpose, creation time and revocation state. A generic provider login must never imply permission to process every memory class.

## Current ownership

- Memhub owns the vendored Memory Core runtime and AgentSourceCore helper.
- Memhub owns the lightweight Architecture Reader compatibility layer.
- The production Memory Core remains loopback-only.
- Legacy standalone Memory/AgentSourceCore/Normify source trees are retired.
