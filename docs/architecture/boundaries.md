# Memhub boundaries

## Memhub owns

- stable account identity and authenticated transport mapping;
- canonical Project Registry, Todo and explicit Branch metadata;
- L1 original-turn evidence and deterministic ingest recovery;
- L2/L3/L4/Skill evidence contracts and canonical artifact identity;
- distillation job control state;
- Memory Core integration and bounded retrieval;
- Project Architecture governance;
- Control Plane inspection and authorized mutation.

## Harness/model owns

- semantic interpretation of supplied evidence;
- producing candidate L2/L3/L4/Skill content;
- deciding, within the contract, whether evidence justifies a semantic update.

Memhub validates account, project, evidence, layer and revision boundaries. It does not fabricate semantic conclusions.

## Project boundary

At most one primary project contributes ordinary project business memory. Current-turn project/workspace evidence is authoritative. Host conversation identity is not a routing fallback. Ambiguity becomes global-only recall.

Cross-project reuse is limited to explicitly allowed account-level L4 context and reusable Skill capability; one project's L2/L3 is never imported as another project's ordinary context.

## Branch boundary

Branch is explicit project-local workstream metadata. It may narrow retrieval inside an already-resolved project; it never broadens project scope and is never bound to a chat window.

## Transport boundary

Both local and remote callers terminate at the same MCP runtime. Loopback requests use local identity. Requests arriving through the public host require the authenticated Cloudflare boundary. Transport metadata is provenance, not a memory partition.

## MCP boundary

Current high-level tools:

- `memmy_turn`
- `memmy_context`
- `memhub_memory`
- `memhub_distill`
- `memmy_project_list`
- `memmy_project_manage`
- `memhub_todo`
- `memmy_project`
- `memhub_branch`
- `memhub_skill`
- `memhub_result`

Project mutation and architecture replacement use plan -> explicit authorization -> execute. Explicit L3/L4 user authority uses complete-text review plus L1 confirmation evidence.

## Storage boundary

Persistent user data under `~/.memmy` is protected state. Runtime releases and source trees are replaceable code. A service restart is not proof of a safe migration: schema/data changes require a verified snapshot and preservation checks.
