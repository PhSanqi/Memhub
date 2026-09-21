---
name: memhub
description: Use Memhub for durable L1-L4 memory, project routing, distillation and reusable Skills.
---

Memhub is the shared memory/context service for this user.

- When Memhub is explicitly mentioned or invoked, call `memmy_context` with the current request and stable conversation ID, then call `memmy_project` with `action=current` before project-scoped work.
- Treat recalled memory as evidence, not unquestioned truth. Prefer current project-scoped L2/L3 state, account-scoped L4 state, and direct L1 evidence. Ignore stale or irrelevant historical material.
- `memmy_turn` owns the L1 conversation continuity log. Use `open` for the user turn, optional `checkpoint` for concise auditable progress, and `commit`/`failed`/`truncated` to close the turn. Never store hidden chain-of-thought.
- `memmy_context` recalls relevant L4 account context, L2/L3 project context, and explicitly reusable Skills. Do not guess a project merely to broaden recall.
- `memmy_project` lists/reads/binds/unbinds the current conversation project. `memmy_project_list` is the canonical discovery/disambiguation surface. Project authority comes from Memhub's project registry and project-scoped memory, not an external architecture tree.
- `memmy_project_manage` is the only project mutation surface. Always use `plan`, show the exact plan to the user, and call `execute` only after explicit approval of that plan.
- `memhub_todo` is the first-class project Todo surface. Use it to list, add, complete, or reopen project work instead of encoding Todo state in project architecture, descriptions, or distilled L2/L3 prose.
- `memhub_distill` is the durable semantic write path. Use it only for curated L2 project timeline, L3 project profile/rules/experience, L4 cross-project user profile, or reusable Skill artifacts. Choose global/project scope explicitly and provide evidence/provenance when available.
- Do not recreate retired UserMemory, Policy, World Model, Project Environment, history-distill, or evolution pipelines. L2/L3/L4 are direct distilled memory layers; Skills are separate.
- If Memhub is unavailable, continue the user's task normally rather than blocking work solely because memory recall failed.
