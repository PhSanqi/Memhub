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

### Harness distillation available now

`memhub_distill` is the first implemented Harness-assisted path. It accepts an explicitly scoped artifact produced by an already-authenticated Harness:

- `skill` -> Memory `Skill`, read-only from the native evolution pipeline's perspective;
- `summary` -> curated L1 memory;
- `knowledge` -> curated L1 memory.

Global/project scope must be explicit. A project Skill is stored with that `projectId` and cannot merge into account-level or another project's native Skill evolution.

Curated summaries and knowledge deliberately remain L1. They are not mislabeled as L2 policy or L3 World Model output.

### Native L3 Harness worker available now

`memhub_evolution` exposes the native L3 World Model pipeline to an already-authenticated Harness without giving the Harness direct database/write access.

The tool has two actions:

- `next` — lease one pending L3 field job in exactly one account/project scope;
- `submit` — submit the schema-constrained candidate for that leased job.

The leased work item contains the original L3 system prompt, immutable evidence-derived `dynamicInput`, expected output schema, current field, and optimistic-concurrency hashes. The Memory Core, not the Harness, performs the final validation and commit.

The commit path preserves the native L3 safety properties:

- account/user ownership is checked server-side;
- global and project jobs are leased separately;
- project jobs wait for the project-environment profile barrier;
- raw evidence lineage and immutable batch ownership are revalidated;
- project contract/domain knowledge require the project-profile base hash;
- stale field/profile hashes are rejected with a conflict and the job can be re-leased with fresh context;
- invalid schema candidates do not consume the lease, so the same Harness can repair and resubmit;
- successful `submit` retries are idempotent;
- the Harness cannot target `project_environment_profile` or arbitrary L3 fields;
- Normify architecture is outside this write path and remains authoritative/read-only.

Typical flow:

```text
Harness
  -> memhub_evolution(action=next, scope=project, project=A)
Memhub / Memory Core
  -> returns job + systemPrompt + dynamicInput + expectedSchema + hashes
Harness
  -> produces one JSON candidate from that evidence only
  -> memhub_evolution(action=submit, ...candidate, ...hashes)
Memory Core
  -> revalidates scope/evidence/base hashes
  -> commits native L3 field or rejects the candidate
```

### Deferred executor

When no model executor is available, L1 capture and retrieval remain functional. Model-dependent jobs stay pending and can be processed later.

## Worker surface

Implemented:

- `memhub_evolution action=next`
- `memhub_evolution action=submit`

Still planned:

- scoped evolution status/queue inspection;
- an explicit worker capability/ACL separate from ordinary recall permissions when multi-user sharing is enabled;
- Harness-assisted native L2 policy/Skill jobs, reusing the same lease/candidate/commit pattern rather than allowing arbitrary L2 writes.
