# Evolution, skills and knowledge scopes

Memhub keeps the original Memory evolution machinery but gives its outputs explicit ownership boundaries.

## Knowledge products

| Product | Account scope | Project scope | Notes |
| --- | --- | --- | --- |
| User memory / preferences | yes | optional contextual use | personal durable facts |
| L1 trace | yes | yes | raw/derived interaction evidence |
| L2 policy | yes | yes | reusable experience/rules |
| Skill | yes | yes | account skill or exactly one project skill |
| General rules | yes | no | L3 global field |
| Project environment profile | no | yes | L3/project environment pipeline |
| Project contract | no | yes | L3 project field |
| Domain knowledge | no | yes | L3 project field |
| Normify architecture | no | yes | authoritative adapter, not mutable memory |

## Hard scope rule

A missing `projectId` means account/global scope. A non-empty `projectId` means exactly that project.

For evolution products, scope equality is strict:

```text
global == global          allowed
A == A                    allowed
A == B                    forbidden
global == A               forbidden
```

This applies to skill-policy compatibility and skill-skill merging. Project memories may still be composed with account memory at recall time, but they are not merged into the same durable evolution artifact.

## Existing Memory Core pipelines

The fork retains:

- `reflection` and reward processing;
- `policy-induction`;
- `skill-pipeline`;
- `l3-world-model`;
- `project-environment/profile-pipeline`;
- lifecycle/trial logic for skills;
- L3 storage scopes keyed by `user_id` and `project_id`.

The L3 repository already enforces field ownership: no-project world models own only general rules, while project scopes own project fields.

## Evolution executors

Memhub separates **what should be evolved** from **which model performs the evolution**.

### Direct provider executor

Memory Core uses a configured provider/API token. This is suitable for unattended server-side evolution.

### Harness worker executor

A connected AI harness can use its already-authenticated model session instead of giving Memhub a separate provider key.

Target protocol:

```text
Memory Core
  -> creates scoped evolution job
Memhub MCP
  -> leases job to authenticated harness
Codex / Claude / other harness
  -> produces schema-constrained candidate
Memhub
  -> validates scope + provenance + schema
  -> commits candidate or rejects it
```

A harness worker may create memory/evolution candidates. It must not directly overwrite authoritative Normify architecture.

### Deferred executor

When no model executor is available, L1 capture and retrieval remain functional. Model-dependent jobs stay pending and can be processed later.

## Planned MCP worker surface

The intended worker-oriented surface is separate from normal recall tools:

- `memhub_evolution_next` — lease one scoped pending job;
- `memhub_evolution_submit` — submit a structured candidate;
- `memhub_evolution_status` — inspect account/project evolution state.

These tools should require an explicit capability scope and must bind account/project identity server-side.
