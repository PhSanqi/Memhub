# Memmy privacy and data-flow boundary

Memmy stores conversation history, durable user memory and project context. In this fork these are treated as private data by default, including project architecture obtained from Normify.

## Default policy

Memory Core is **local-only**. Merely configuring a remote URL does not authorize data egress.

The first enforcement point is `Memory/src/privacy/network-policy.ts`. The following core paths use it:

- model/embedding HTTP requests;
- remote storage backend construction;
- raw Memory REST clients.

Loopback HTTP/HTTPS targets are allowed. Non-loopback targets are denied unless the caller makes an explicit code-level `allowRemote: true` decision. This compatibility escape hatch is deliberately not exposed as a normal end-user configuration in the first Context Hub phase.

## Data classes

| Data | Sensitivity | Default network policy |
| --- | --- | --- |
| Raw conversation turns | high | local only |
| Long-term/global memory | high | local only |
| Project memory and decisions | high | local only |
| Normify architecture/contracts | high | local only |
| Embeddings derived from private content | high | local only |
| Account/project identifiers | private | gateway/auth use only |
| Installer/release metadata | low | network allowed outside Memory Core |

Derived data is not considered less sensitive merely because it is summarized or embedded.

## Known network-capable surfaces in the v1.1.4 baseline

The baseline contains several different kinds of network behavior. They must not be conflated.

### Memory-content egress paths

`Memory/src/model/http.ts` can send prompts, summaries, evolution input and embedding input to configured model providers. `openmem-cloud-rest` represents a remote storage mode. These are private-data egress paths and are now default-denied by the core privacy boundary.

### Adapter-to-Memory transport

Agent integration templates and workspace bridges use `fetch()` to submit/recall memory through a configured Memory endpoint. The shared workspace bridge now enforces a loopback-only endpoint before sending conversation content. Several legacy generated/plugin templates still carry their own transport copies; they remain compatibility surfaces and must receive the same guard (or be retired) before they can be considered part of the supported Context Hub path. A future remote host must use the authenticated MCP Gateway rather than exposing raw Memory HTTP publicly.

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
Memmy MCP Gateway (identity + account scope)
     |
     | loopback only
     v
Memory Core ---- local SQLite / local embedding
     |
     +---- Normify adapter -> local/account-scoped architecture data
```

Memory Core itself should remain bound to loopback. The gateway is the only intended public ingress. Cloudflare receives authentication traffic; it is not the storage or model-processing destination for memory contents.

## Remote processing policy

Remote model/storage support is deferred, not silently trusted. If it is reintroduced later, the policy must be capability-specific, for example allowing a user to authorize `memory_summary` without automatically authorizing raw turns, project architecture, embeddings or storage replication.

An authorization should record at least: account, data class/capability, destination, purpose, creation time and revocation state. A generic provider login must never imply permission to process every memory class.

## What is deliberately not changed yet

- Existing local memory schema and L1/L2/L3 algorithms.
- Agent source import/scanning.
- L3 project/global ownership rules.
- Installed production service under `~/.local/share/memmy-agent/current`.
- Existing Agent/Goal/Channel source code; these are deferred until the new MCP/context path is working end to end.
- Legacy agent integration transport copies in Hermes/OpenClaw/DeepSeek/OpenCode/resume-hook templates. They are inventoried network-capable surfaces, not approved remote-memory paths.

This keeps the first change reversible while establishing an enforceable boundary before deeper restructuring.
