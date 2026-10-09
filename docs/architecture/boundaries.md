# Memhub boundaries

## Memhub owns

- stable account/device identity mapping;
- canonical project registry and conversation binding;
- L1 original-conversation capture and continuity;
- L2/L3/L4/Skill evidence contracts and canonical artifact identity;
- distillation job control state;
- Memory Core storage/retrieval;
- Control Plane presentation and administrative authorization.

## The Harness/model owns

- semantic interpretation of supplied evidence;
- deciding whether evidence justifies an L2/L3/L4/Skill update;
- producing the candidate artifact within the Memhub contract.

Memhub validates candidates but does not fabricate semantic conclusions when no model executor is present.

## Project boundary

At most one primary project contributes business memory to a context capsule. Current-turn explicit evidence overrides stale conversation binding. Ambiguity yields global-only recall.

Cross-project reuse is limited to explicit Skill artifacts. L2/L3 content from another project is not imported as ordinary project context.

## Architecture boundary

Project architecture is authoritative project context for stable structure, ownership, source-of-truth declarations, interfaces and hard constraints. The writable canonical document is Memhub-managed private state; repository Markdown and legacy `normify-<project>` trees are read-only discovery/migration inputs, and the Normify engine itself is retired.

`memmy_project action=architecture` is read-only. Architecture mutation is a separate governed full-document replacement: `architecture_plan` returns the exact proposed body, the model must show it to the user in full, and `architecture_execute` is allowed only after explicit approval. Plans are one-shot and fingerprint-bound. Writes are confined to Memhub private state; repository Architecture files and legacy `normify-*` content are never write targets.

Architecture is not a substitute for L2/L3/L4 or Todo. Dynamic project history belongs to L2, durable project working rules belong to L3, cross-project user rules/profile belong to L4, and actionable pending work belongs to Project Todo.

## Internal processing boundary

Raw Capture and Episode are internal. They may be used as evidence lineage, but they are not user/admin product layers.

The management taxonomy is:

```text
Overview / Projects / L1 / L2 / L3 / L4 / Skills / Processing
```

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

Project mutation uses plan -> explicit authorization -> execute. Destructive Control Plane actions remain outside ordinary recall flow.

Explicit user-authored L3/L4 mutation also uses plan -> full-text review -> explicit confirmation -> execute. The confirmation itself must be captured as L1 evidence. This path changes only the requested canonical L3 or L4 and does not silently promote into another layer.

## Storage migration boundary

Schema v8 preserves historical data while retiring old semantics. A cutover must use an online baseline snapshot and post-migration preservation verification. A successful service restart alone is not evidence that the migration is safe.
