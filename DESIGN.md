# Memhub Design Contract v2

## Product posture

Memhub is a durable AI-memory product, not a marketing demo and not a generic SaaS dashboard. The interface should make three things obvious: current scope, what changed, and where a memory came from.

The three primary surfaces are intentionally different:
- Landing: understand → install → connect → use → maintain.
- User: continue work from durable memory.
- Admin: operate boundaries, failures, accounts, projects, and processing.

## Visual direction

Use a restrained technical-product language. System sans is the default for Chinese and all operational surfaces. Serif may appear only as a limited brand/editorial accent on Landing; it must never carry routine workspace hierarchy.

### Typography

No external font dependency.

- UI / Chinese / body: `ui-sans-serif`, system UI, PingFang SC, Microsoft YaHei, Noto Sans CJK compatible fallback.
- Technical metadata: system monospace.
- Optional Landing accent only: system serif fallback.

Type scale:
- Product display: 48–64px desktop, 36–44px mobile; Landing only.
- Page title: 28–36px desktop, 24–30px mobile.
- Section title: 20–24px.
- Body: 14–16px.
- Secondary: 12–13px.
- Metadata: minimum 11px.

Rules:
- Never use 8–9px for information that must be read.
- Chinese headings use neutral tracking and line-height >= 1.15.
- Mono is reserved for IDs, timestamps, layer labels, and runtime state.

### Color and contrast

Use a quiet neutral canvas and low-chroma trace accent. Color has one semantic job at a time.

Light:
- canvas `#f5f6f8`
- surface `#ffffff`
- surface-secondary `#f0f2f5`
- ink `#171a21`
- text-secondary `#515865`
- text-muted `#626a78`
- line `#d8dce3`
- trace accent `#4b61b8`
- trace accent soft `#edf0fb`
- admin warning `#8a5b16`
- danger `#a34235`
- success `#337454`

Dark:
- canvas `#101216`
- surface `#171a20`
- surface-secondary `#1d2128`
- ink `#f2f4f7`
- text-secondary `#c5cad3`
- text-muted `#a4abb7`
- line `#343943`
- trace accent `#91a2ea`
- admin warning `#e3b763`
- danger `#ef9a8d`
- success `#79bf98`

All ordinary text must meet WCAG AA contrast. Accent colors are not used for small ordinary copy unless the contrast requirement is met.

### Shape and density

- Prefer grouping, whitespace, and background contrast over hairlines everywhere.
- Hairlines organize tables, ledgers, and timelines; they are not the default separator for every block.
- Radius 6–10px; avoid pill-heavy UI.
- Shadows only for modal/drawer elevation.
- No glass, neon gradients, AI sparkle decoration, or fake charts.

## Landing contract

Landing answers in order:
1. What problem Memhub solves.
2. What the product actually remembers and how boundaries work.
3. How to install it.
4. How to connect a Harness.
5. Everyday workflows: continue a project, TODO, cross-device, inspect evidence.
6. Privacy/data boundary.
7. Maintenance: backup, upgrade, troubleshooting.

Primary navigation must point to real site routes, not only anchor fragments. Required public information architecture:
- `/memhub` — product overview.
- `/memhub/docs` — Getting Started hub.
- `/memhub/docs/install` — Local / Server, Linux / Windows installation.
- `/memhub/docs/workflows` — continuity, project scope, TODO, evidence inspection.
- `/memhub/docs/privacy` — data boundaries and what leaves the machine/server.
- `/memhub/docs/troubleshooting` — common failures and recovery.

Landing first viewport keeps the strong value proposition on the left and uses the right side for real product proof: a semantic topology (`Harness/MCP/Hook → L1 Capture → Distillation → L2/L3/L4 → Project Registry/Evidence`) plus a small real workspace preview. Do not use fake charts. The Memhub logo mark may act as the topology hub.

The memory model is shown as one horizontal L1→L2→L3→L4 rail on desktop so the full system fits in one visual field. Each layer answers only: what it is, where it comes from, and who uses it. On narrow screens use a compact 2×2 arrangement with no root overflow. Skill is not L5: render it as an orthogonal capability plane spanning beneath L1–L4.

Brand usage: derive transparent `logo-mark` and `logo-lockup` assets from the supplied artwork. Header, Docs, and Console use mark-only; Landing may use the mark as a semantic hub. The cyan/blue/purple brand gradient stays inside the logo rather than becoming a site-wide SaaS gradient.

## User workspace contract

No marketing hero.

Overview first viewport order:
1. current account/project scope;
2. pending work / next actionable TODO;
3. recent continuity / Current Truth;
4. recent provenance/source;
5. deeper records.

`Continue working / 继续工作` belongs only to Overview. Projects, L1, L2, L3, L4, Skills, and Processing use their own page title and retain only a compact scope bar.

When project scope is empty / All Projects, render a true portfolio overview: one compact record per project with identity, updated time, pending TODO, recent continuity, L1/L2/L3 readiness, and processing exceptions, ordered by pending work then recency. Do not expand one project as if it represented the portfolio. Selecting a project switches to project detail with Current Truth, TODO, continuity, layer links, and provenance.

The lifecycle is a continuous compact rail. It must remain conceptually continuous on mobile; do not turn L1–L4 into four unrelated promotional cards.

Projects render as a scan-first ledger, not equal-weight SaaS tiles. Desktop records use a two-row/two-column semantic layout: left identity cell spans both rows (name, slug, updated time, state), upper-right is Overview / Current Truth, lower-right is TODO. Mobile collapses to identity → overview → TODO. Long prose is summarized to a few lines and full content stays in detail/drawer.

Processing is advanced/system information in User. User must not expose administrator-only distillation policy controls.


## Docs contract

Each formal documentation page (`getting-started`, `install`, `workflows`, `privacy`, `troubleshooting`) contains at least 3000 Chinese characters of task-oriented content. The requirement is structural, not padding. Every page covers prerequisites, step-by-step operation or UI/command examples, success verification, failure diagnosis, recovery, platform differences, FAQ, and related navigation.

Docs use maintained Markdown content sources rather than giant inline HTML strings. Pages expose a task outcome, estimated time, automatic page TOC, readable 65–80-character text measure, code blocks with local overflow containment, and previous/next navigation.

Review evidence for all five docs must include 1440/1024/768/390 top-of-page captures plus long-document evidence for a middle section, a command/UI example region, and bottom pagination.

## Admin contract

Use the product term `Admin / 管理`, not Governance as the primary navigation label.

First viewport order:
1. active account/project scope;
2. failed / pending / leased processing state;
3. project boundary and account-role state;
4. high-impact management actions;
5. memory-layer inspection as supporting evidence.

Admin titles/descriptions must be operator-specific, not reused from User.

Processing and Accounts use ledger/table-like density. Failed state is visually stronger than pending; completed is quiet/successful.

Merge/delete actions must show scope and impact before confirmation. Project selectors used for high-impact actions include disambiguating ID/name information.

## Navigation contract

Desktop may use left navigation. At <=900px use a stable mobile navigation control with an explicit menu/more affordance. Do not hide primary destinations without a replacement.

The current location exposes `aria-current="page"` or equivalent semantic state. View buttons expose current state programmatically.

## Responsive contract

Required browser evidence: 1440 / 1024 / 768 / 390 CSS pixels.

The harness must assert `innerWidth === requestedWidth`; image pixel width alone is not sufficient proof.

390 requirements:
- root horizontal overflow = 0;
- all visible interactive targets >=44×44;
- primary navigation remains reachable;
- project/account selectors fit without truncating critical identity;
- L1→L4 remains understandable and complete.

768 is treated as touch-capable: primary navigation and controls should target >=44px where practical.

## Interaction contract

- URL restores `view` and `project` across reload / Back / Forward.
- Drawer is a true modal: accessible name, focus entry, Tab trap, Escape, focus restore, inert background.
- Mutation busy state is localized and duplicate-safe.
- Loading, error, retry, and disabled/busy states are visually reviewable.
- Light/dark updates browser `theme-color`.
- Motion respects `prefers-reduced-motion`.
- Anchor targets use scroll margin under sticky headers.
- Auto-refresh must not silently disrupt reading. Default to event/focus/manual refresh or a substantially slower cadence with a visible freshness indicator.

## Review-pack contract

Fresh-Eyes receives only:
- `DESIGN.md`
- `BRIEF.md`
- Landing/User/Admin clean screenshots at 1440/1024/768/390
- all five Docs pages at 1440/1024/768/390 plus middle/example/bottom evidence
- required interaction screenshots: dark, English, drawer, keyboard focus, loading, error, busy/disabled
- `deterministic-metrics.json`

No source, implementation history, Chrome profile, debug HTML, prior judge output, or builder notes.
