# Memhub Web Redesign Brief v2

Memhub is an account/project control layer for durable AI memory.

Core model:
- L1 original conversation evidence.
- L2 canonical project chronology.
- L3 durable project rules, preferences, experience, and working habits.
- L4 stable account-level profile derived from repeated cross-project L3 evidence.
- Skill is reusable executable capability orthogonal to L1–L4.

## Landing
Audience: technical users evaluating Memhub and existing users returning to it.
Goal: complete the path `understand → install → connect → use → maintain` without forcing a new user to leave immediately for README/GitHub.
The first viewport must show real product proof: semantic backend flow plus a real workspace preview. L1–L4 form one horizontal desktop rail; Skill is explicitly an orthogonal plane, not a fifth layer. Transparent logo assets provide the brand anchor without turning the site into a gradient SaaS theme.

## User
Audience: account owner using Memhub day-to-day.
Goal: answer `What should I continue?`, `What did this project last establish?`, and `Where did this memory come from?` before showing aggregate counts.
`Continue working` exists only on Overview. All Projects is a portfolio of multiple compact project records; selecting one project unlocks Current Truth/TODO/layer/provenance detail. Projects use a two-row/two-column scan-first ledger on desktop and a three-part stack on mobile.


## Docs
Audience: a user who should be able to install, connect, operate, protect, diagnose, and recover Memhub without leaving the site for essential steps.
Goal: each formal page is task-complete, not an outline. Each Chinese page is 3000+ Chinese characters and includes prerequisites, steps, command/UI examples, success verification, failure diagnosis, recovery, platform differences, FAQ, and related navigation. All five pages require 1440/1024/768/390 review evidence plus middle/example/bottom long-document captures.

## Admin
Audience: Memhub administrator/operator.
Goal: make active scope, failures, processing state, account roles, project boundaries, and high-impact management actions explicit and safe.

## Required capabilities
- CN/EN and light/dark.
- account context and project selector; Admin account selector.
- Overview, Projects, L1, L2, L3, L4, Skills, Processing; Accounts in Admin.
- search/filter, project create/edit/merge/delete, project TODOs, distillation configuration in Admin, detail drawer.
- URL state, keyboard/focus accessibility, actionable load/error states, localized mutation busy guards.
- true CSS viewport verification at 1440/1024/768/390.
- no root horizontal overflow; 390 visible targets >=44×44.
- Local/Server × Linux/Windows product guidance.

The UI may be reorganized substantially but must not invent backend capabilities or change L1/L2/L3/L4 semantics.
