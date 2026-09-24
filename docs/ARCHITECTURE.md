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
- Branch Context: optional project-local task/workstream scope. A Branch has a stable id/name/goal/status and an optional conversation binding, but it is not a memory layer. The Router folds the active Branch goal into retrieval so concurrent workstreams inside one project do not compete for the same context window. Closing a Branch removes its active bindings; canonical L1/L2/L3/L4 remain project-owned.
- Retrieval Pipeline: after account/project governance has bounded the legal candidate set, ranks and compresses memory for the current task before prompt injection.
- Skill Router / Execution Bridge: retrieves reusable capability candidates separately from business memory, activates full procedures on demand, and records execution outcomes as Skill telemetry.
- L1 Turn Log: stores original conversation turns and continuity metadata.
- Distillation Jobs: evidence-bounded L2/L3/L4/Skill work queue.
- Memory Core: durable memory storage, search and read models.
- Architecture Reader: read-only compatibility access to existing project architecture Markdown.
- Control Plane: inspection and governance. Raw Capture and Episode are not product navigation layers.

Current-turn explicit project/workspace evidence has priority over an older conversation binding. Reusable Skills can cross project boundaries only through the separate capability channel.

Branch resolution happens only after the primary project is known. A Branch may further narrow retrieval inside that project but can never broaden the project boundary or expose another project's business memory. The authoritative L1 turn remains stored once; Branch does not create Branch-L1/Branch-L2 copies. Existing project L2/L3/L4 remain shared canonical context and are selected using the current query plus Branch name/goal. This keeps Branch as a filtering/control concept rather than a second memory hierarchy.

L1 storage deliberately separates authority from indexing. The authoritative source is the per-turn capture JSON under the Memhub state root; `capture-index.sqlite` only stores rebuildable metadata used for project/conversation filtering, counts, threshold scheduling and idle scheduling. A dirty ledger is written before raw/index state transitions, so an interrupted update causes the affected account index to be rebuilt from the original capture files on the next read. The Control Plane pages the original turn bodies instead of loading the complete L1 corpus.

Normal context recall prefers L4 account memory plus the current project's L3/L2 artifacts and reusable Skills. During bootstrap or immediately after a migration, if the resolved project has no L2/L3 hit yet, Memhub may fall back to relevant project-scoped L1 evidence. As soon as L2/L3 exists, raw L1 is excluded from normal context again and remains the evidence layer for later distillation.

## Retrieval and Skill intelligence

Governance and relevance are separate stages. Account/project resolution, authorization and scope filtering happen first and define the legal candidate set. Retrieval never broadens that boundary: a highly similar memory from another project is still ineligible when the resolved scope does not allow it.

Within the legal candidate set, Memhub should minimize prompt volume while preserving decision-relevant context. The retrieval path is designed to support multiple signals such as semantic relevance, exact/keyword matching, temporal/current-truth relevance and, where justified by measured value, entity-aware or heavier reranking. Results are deduplicated, diversified and bounded to a small task-relevant set before they enter the Context Capsule. The Context Capsule byte limits remain a final safety boundary, not the primary retrieval mechanism.

Retrieval v1 now implements that first stage explicitly. Memory Core produces a broader legal candidate pool after account/project/layer filtering; Memhub then applies a deterministic second-stage fusion of the upstream semantic score and local BM25-style lexical relevance, exact-content deduplication and a small diversity penalty before emitting the final Top-K. The default Context Router limit is six items per lane and Retrieval v1 hard-caps a lane at 12 even if a caller requests a larger legacy limit. Each emitted memory includes `retrievalV1` diagnostics (semantic, lexical and fused score, rank, matched terms, candidate/dedup counts), and the Context Capsule includes lane-level retrieval diagnostics. This stage never broadens the account/project boundary.

Skill remains orthogonal to L1-L4 and uses a separate capability channel. Normal Skill recall should return compact candidates rather than eagerly injecting every full procedure. A candidate may expose stable selection metadata such as when_to_use, a one-line summary, scope, reliability and executor requirements. The Harness/model can then explicitly load and invoke the full Skill only when the current task warrants it.

Skill Router v1 implements this as a two-step contract. `memmy_context` emits compact Skill candidate cards only: title, summary, `when_to_use`, trigger terms, scope, reliability, executor and a stable `skill_id`. Full Skill content is deliberately omitted. The Harness loads a chosen procedure with `memhub_skill action=load`, which returns the complete Skill plus an `execution_id`.

The Skill execution lifecycle is:

```text
task
  -> skill candidate retrieval / gating
  -> selected
  -> full Skill load
  -> invoked through Harness / MCP / tool executor
  -> success | failure | user correction
  -> Skill telemetry / evidence
  -> reliability, revision or retirement decision
```

Skill revision and retirement use a separate one-time, ten-minute `memhub_skill action=plan` → explicit user approval → `action=execute` contract. Revision requires a strictly newer numeric dotted version, reuses the canonical `source_skill_id` and source agent, creates a distinct versioned memory id and archives its predecessor; the prior content and telemetry remain readable. Retirement archives without deletion. The Core version-supersession path is constrained by user, project and authenticated tenant, including scoped legacy provenance. A stale or cross-account authorization must not change the Skill.

The `Memhub Long-Term Content Audit` procedure is maintained in `docs/skills/memhub-long-term-content-audit-v2.md`. It treats Project Registry and current project docs/Architecture Reader as authoritative; legacy `normify-*` trees are compatibility reads, not mandatory architecture health checks.

Execution traces and outcome signals support Skill improvement, but they do not create a second L1/L2/L3 hierarchy or replace project Current Truth. The durable memory axis remains L1 -> L2 -> L3 -> L4; Skill is the executable capability plane beside it.

## Large result transport

MCP result size is controlled separately from semantic memory selection. Small tool results remain ordinary inline JSON. If a JSON result exceeds the generic inline threshold, Memhub stores the serialized result in an account-scoped short-lived spool and returns only a first chunk plus `result_id`, `next_offset`, `total_chars` and completion metadata. `memhub_result` continues the same result by offset. The spool is transport state only: it is not L1 evidence, is not distilled, and never becomes L2/L3/L4/Skill.

This generic result transport complements, rather than replaces, semantic compression. `memmy_context` should normally stay small through project/Branch governance, Retrieval v1 and Context Capsule byte budgets. Distillation evidence keeps its evidence-specific chunk contract because the lease/job lifecycle has additional semantics; if any other MCP result becomes unusually large, the generic result transport prevents one oversized response from being forced through the connection at once.

The Skill Execution Bridge records `selected -> loaded -> invoked -> success|failure -> user_correction` as account-scoped telemetry. `memhub_skill action=record` is the explicit Harness/MCP/tool bridge; Memhub does not invent an executor or silently invoke a provider. Reliability uses execution outcomes as telemetry and can override static confidence metadata for later candidate selection. Telemetry is stored under the Memhub state root and remains separate from L1-L4 durable memory.

Current product priority is project-centric AI productivity: high-quality retrieval, project continuity, Skill activation and execution feedback come before broad multimodal/personal-life memory coverage. Multimodal image memory is therefore not a current core requirement.

Evaluation should be targeted rather than duplicating external benchmark suites wholesale. The primary acceptance signals are correct project selection, relevant-memory precision, context bytes/useful tokens, Skill candidate accuracy, actual Skill invocation success and improvement after failure/correction. Public memory benchmarks can be used selectively when they diagnose a concrete retrieval failure mode.

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
