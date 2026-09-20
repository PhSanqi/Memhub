# Control Plane, capture and distillation

## Product taxonomy

The management UI exposes only:

```text
Overview / Projects / L1 / L2 / L3 / L4 / Skills / Processing
```

Raw Capture and Episode remain internal processing mechanisms. They are not separate user/admin memory layers.

## Routes

- `/memhub` — public landing page.
- `/memhub/user` — authenticated user workspace.
- `/memhub/admin` — authenticated administrator Control Plane.

Public administration requires Cloudflare Access identity plus the stable Memhub account role. Loopback administration uses the local-admin token.

## L1 capture

`memmy_turn` is the model-facing L1 lifecycle contract:

- `open` records the original user turn;
- `checkpoint` can append bounded audit-safe reasoning/tool summaries;
- `commit` records the assistant final and completes the turn;
- `failed` / `truncated` preserve incomplete terminal state;
- `resume` reads recent turns for the same continuity ID.

When a turn omits an explicit project, Memhub resolves the current conversation binding and writes that canonical project back to the L1 record. This keeps project-filtered L1 views complete.

Raw host capture can also arrive through the Bridge/capture HTTP path. Complete captures are ingested into Memory Core; incomplete fragments remain internal evidence until completed.

## Distillation jobs

`memhub_distill` is the only high-level semantic distillation tool. Supported targets are `l2`, `l3`, `l4`, and `skill`.

`action=next` leases one pending evidence job. The Harness/model reads the supplied evidence and current Memhub context, then either:

- `action=submit` with one durable artifact; or
- `action=skip` when the evidence is insufficient.

Memhub validates target/scope, provenance, evidence references, contamination rules and canonical artifact identity before commit.

## Layer promotion

### L1 -> L2

L2 requires complete L1 turns from one resolved project. Evidence is chronological. The result is the canonical human-readable project timeline.

### L2 -> L3

Completing an L2 job enqueues a project-scoped L3 job. L3 should contain durable project rules, preferences, working habits and experience, not a replay of transient events.

### L3 -> L4

Completing L3 only creates an account-scoped L4 job when completed L3 evidence exists for at least two projects. L4 represents stable cross-project user traits/work patterns and must not infer sensitive traits.

### Skill

Skill is orthogonal to the depth chain. It stores a reusable executable procedure and may be account-scoped or project-scoped.

## Canonical artifacts

Memhub updates stable artifact identities instead of creating arbitrary duplicates:

- L2: `project-timeline:<project>`
- L3: `project-profile:<project>`
- L4: `user-profile:<account>`

Evidence source and distillation executor are stored separately. A ChatGPT-originated conversation distilled by Codex remains sourced from ChatGPT while recording Codex as the executor.

## Automatic processing

Automatic distillation is opt-in. Turn thresholds or idle rules may enqueue evidence jobs, but the server does not silently invoke an LLM. Without a connected Harness/model, the evidence remains pending.

The Processing view exposes distillation job status. Failed jobs can be retried; completed jobs retain result/evidence provenance.

## Project isolation

Current-turn explicit project/workspace evidence overrides stale conversation binding. A request with ambiguous project evidence is global-only.

Business project memory and authoritative architecture come from one primary project. Other projects may contribute only explicit reusable Skills through the capability channel.

## Legacy state

Schema v8 archives legacy Policy/World Model style L2/L3 products and legacy `user_memories` rather than presenting them as Current L2/L3/L4 semantics. Raw historical data remains available for audit and migration evidence.
