# Memhub architecture

Memhub is the account/project control layer around durable AI memory. Human identity resolves to a stable Memhub account; machine clients are explicit account-bound devices. Source provenance is kept separate from the Harness/model that later performs semantic distillation.

## Product layers

```text
L1 original conversation
        |
        v
L2 project timeline
        |
        v
L3 project rules & experience
        |
        +---- project B L3 ----+
        |                      |
        +---- project C L3 ----+--> L4 cross-project user profile

Skill ------------------------------ orthogonal reusable capability
```

- L1 is append-oriented source evidence. Raw Capture and Episode are internal implementation details.
- L2 is one canonical project-scoped chronological narrative.
- L3 is one canonical project-scoped durable profile of rules, preferences and experience.
- L4 is one canonical account-scoped profile derived from repeated/cross-project L3 evidence.
- Skill remains an independently scoped executable procedure.

## Runtime boundaries

- Gateway: remote MCP, capture and web HTTP boundary.
- Identity: authenticated human/device principal to stable `account_id`.
- Project Registry: canonical slug, aliases, description and state.
- Context Router: resolves exactly one primary project for project business memory; ambiguity becomes global-only.
- L1 Turn Log: stores original conversation turns and continuity metadata.
- Distillation Jobs: evidence-bounded L2/L3/L4/Skill work queue.
- Memory Core: durable memory storage, search and read models.
- Architecture Reader: read-only compatibility access to existing project architecture Markdown.
- Control Plane: inspection and governance. Raw Capture and Episode are not product navigation layers.

Current-turn explicit project/workspace evidence has priority over an older conversation binding. Reusable Skills can cross project boundaries only through the separate capability channel.

L1 storage deliberately separates authority from indexing. The authoritative source is the per-turn capture JSON under the Memhub state root; `capture-index.sqlite` only stores rebuildable metadata used for project/conversation filtering, counts, threshold scheduling and idle scheduling. A dirty ledger is written before raw/index state transitions, so an interrupted update causes the affected account index to be rebuilt from the original capture files on the next read. The Control Plane pages the original turn bodies instead of loading the complete L1 corpus.

Normal context recall prefers L4 account memory plus the current project's L3/L2 artifacts and reusable Skills. During bootstrap or immediately after a migration, if the resolved project has no L2/L3 hit yet, Memhub may fall back to relevant project-scoped L1 evidence. As soon as L2/L3 exists, raw L1 is excluded from normal context again and remains the evidence layer for later distillation.

## Distillation ownership

The connected ChatGPT/Codex/Claude/other Harness model performs semantic synthesis. Memhub owns evidence boundaries, target layer/scope validation, contamination rejection, canonical artifact identity, provenance, job leasing/completion/retry and durable commit.

Canonical artifacts are:

- `project-timeline:<project>` for L2;
- `project-profile:<project>` for L3;
- `user-profile:<account>` for L4.

L2 completion can enqueue L3. L3 completion only enqueues L4 after completed L3 evidence exists for at least two projects.

## Project architecture compatibility

The old Normify runtime is retired. Memhub no longer vendors or executes that engine.

`FileProjectArchitectureSource` only reads existing authoritative Markdown from account-scoped legacy `.normify/accounts/<account-hash>/normify-<project>` trees and bounded repo-local `normify-<project>` fallback trees.

The current configuration is `architecture-root` / `MEMHUB_ARCHITECTURE_ROOT`. `--normify-root`, `--no-normify` and `MEMHUB_NORMIFY_ROOT` remain compatibility aliases for existing deployments. `memmy_project action=architecture` is read-only.

## Storage migration

Memory Core schema v8 changes the durable memory taxonomy to L1/L2/L3/L4/Skill while preserving historical rows. Legacy L2/L3 and `user_memories` are archived rather than deleted; retired evolution jobs are dead-lettered.

`scripts/core-migration.mjs` provides:

- `preflight`: vendored-runtime integrity check plus online rollback snapshot and durable fingerprint;
- `verify`: exact frozen-copy comparison;
- `preserved`: schema-changing cutover verification based on database integrity, durable table presence and preservation of baseline durable row identities.

See [CORE_MIGRATION.md](CORE_MIGRATION.md).

## Long-term-content hygiene

All editions keep AgentSource history scanning opt-in. Continuous history should enter through capture/lifecycle. Legacy imports do not automatically become durable user-profile claims.

`scripts/long-term-repair.mjs` remains the read-first audit/repair path for old scope contamination and historical legacy records.
