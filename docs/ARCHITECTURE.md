# Memhub architecture

Memhub is the account/project control layer around long-term memory. Human
identity is currently Cloudflare Access; machine clients are explicit devices.
All memory writes retain source provenance separately from the model/harness
that later distills them.

## Current boundaries

- gateway: Remote MCP, capture and web control-plane HTTP boundary.
- identity: Cloudflare identity -> stable Memhub account_id; devices remain
  account-bound principals rather than independent human identities.
- projects: deterministic project resolution. Ambiguity is global-only.
- memory: account/project memory access over the Memhub-owned embedded Memory Core.
- provenance: source platform/transport/principal/account/conversation/evidence.
- distillation: the connected ChatGPT/Codex/Claude/DSH model performs
  semantic distillation. Memhub supplies the contract, evidence boundary,
  schema validation, provenance and commit rules.
- controlplane: inspection and governance; destructive administration stays
  out of the default five-tool MCP surface.

Content source and distillation executor are different fields. A ChatGPT
conversation distilled by Codex remains sourced from ChatGPT and records Codex
as the distillation executor.

## Distillation contract

memhub_distill exposes the current contract with inspect_contract=true.
Candidates may cite evidence_refs, source_conversations and confidence.
Memhub rejects known host/system/developer prompt contamination and records the
contract version with committed artifacts.

Memhub intentionally does not require its own LLM API for semantic
distillation. The connected MCP/harness model does that work.

## Embedded-core consolidation

Memhub now vendors the runtime cores needed by the server distribution:

1. a headless Memory Core runtime under vendor/memory-core;
2. the small AgentSourceCore used by Memory capture under
   vendor/agent-source-core;
3. the host-independent architecture engine under vendor/normify.

The architecture adapter uses the embedded engine; the external Normify
CLI/MCP is not required. EmbeddedMemoryCore can launch the vendored headless
memory service. Existing ~/.memmy config/database files are adopted in place
when present so current data is preserved; a clean installation uses
~/.memhub/core. The server systemd deployment now runs the Memhub-owned
`vendor/memory-core` launcher and the gateway requires that unit. The legacy
`memmy-memory.service`, standalone Memory/AgentSourceCore packages and external
Normify runtime have been retired.

The vendored Memory runtime is rewired to the vendored AgentSourceCore, so a
server restart does not need the old `AgentSourceCore` workspace either.

Memhub also declares the runtime dependencies required by the vendored Memory
Core itself. The server distribution must not rely on dependencies being
hoisted from the old `Memory` workspace merely because both directories happen
to exist in one development checkout.

The cutover is guarded by `scripts/core-migration.mjs`. It creates an online
SQLite rollback snapshot, verifies source/vendor runtime parity, fingerprints
the schema and durable tables, and provides an exact post-cutover verifier.
See [CORE_MIGRATION.md](CORE_MIGRATION.md).

The `memhub.core` architecture module is active for this implementation.

