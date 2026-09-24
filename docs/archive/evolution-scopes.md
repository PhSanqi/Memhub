# L1-L4, Skill and scope model

The current Memhub taxonomy is evidence depth, not the legacy Policy / World Model taxonomy.

## Durable products

| Product | Scope | Source | Meaning |
| --- | --- | --- | --- |
| L1 Original Conversation | account + optional project | captured turn | original user/assistant evidence and bounded audit summaries |
| L2 Project Timeline | exactly one project | L1 | chronological project development and Current Truth history |
| L3 Project Rules & Experience | exactly one project | L2 | durable project rules, preferences, habits and experience |
| L4 User Profile | account | L3 from multiple projects | stable cross-project user characteristics and working patterns |
| Skill | account or exactly one project | relevant evidence | reusable executable procedure |

Raw Capture, Episode, worker jobs and reward/reflection data are internal processing state, not additional product layers.

## Hard scope rules

- L2 requires project scope.
- L3 requires project scope.
- L4 requires account scope and cannot carry `projectId`.
- A project Skill belongs to exactly one canonical project.
- Cross-project Skill use happens only through the explicit reusable capability channel.
- Business memory from project A is never recalled as business memory for project B.

If project resolution is ambiguous, project memory is omitted rather than guessed.

## Distillation pipeline

```text
complete L1 turns
  -> L2 job(project)
  -> canonical L2 project timeline
  -> L3 job(project)
  -> canonical L3 project rules/experience

completed L3(project A)
completed L3(project B)
  -> L4 job(account)
  -> canonical L4 user profile
```

A Harness leases evidence with `memhub_distill action=next`. It either submits one evidence-grounded artifact with `action=submit`, or explicitly records that the evidence does not justify promotion with `action=skip`.

Memhub validates scope, evidence and provenance and commits the canonical artifact. The Harness/model is the semantic executor; Memhub does not silently call a provider.

## Legacy data

Schema v8 does not relabel old Policy/World Model products as new L2/L3 semantics. Active legacy L2/L3 rows are archived and marked as legacy. Old `user_memories` are also archived. They remain available for audit/history but are not Current layer artifacts.

## Skills

Skill is orthogonal to L1-L4. A Skill contains a reusable executable procedure, not merely a remembered event or personality statement. Project and account scope remain explicit.

## Promotion stopping rules

- Do not turn one-off L1 events into L3 rules without durable support.
- Do not create L4 from one project's L3.
- Do not infer sensitive personal traits.
- Prefer updating the canonical artifact over creating duplicates.
- Use `skip` when evidence is insufficient.
