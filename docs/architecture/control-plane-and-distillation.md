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

The browser/Control Plane is therefore a scheduler and governance surface, not a subscription-model runtime. Chat/Codex-style clients can execute semantic synthesis only while an active Harness is connected and calls `memhub_distill` (`next` -> synthesize -> `submit`/`skip`). DevSpace/Serena-style tooling may assist that active Harness with retrieval/editing, but Memhub does not invoke those tools or a ChatGPT subscription session from the web server process.

The same boundary applies to executable Skills. `memmy_context` performs capability candidate retrieval but returns only compact Skill Router metadata. `memhub_skill action=load` is an explicit request for the full Skill, and the Harness records `invoked` plus terminal outcome through `memhub_skill action=record`. Memhub stores selection/execution telemetry for reliability and revision decisions; it does not execute arbitrary tools on its own.

The Processing view exposes distillation job status. Failed jobs can be retried; completed jobs retain result/evidence provenance.

## Process ownership and connection recovery

There is one process owner per installation. Linux editions use the `memhub-local-stack.target` or `memhub-server-stack.target` systemd group (the existing `deploy/` installation uses `memhub-stack.target`). Its Core, Gateway and optional Bridge units have ordered readiness probes, bounded systemd restarts and stop/restart propagation. Do **not** run `run-stack.mjs` against the same ports or state directory while systemd owns them.

Direct/Windows installations use one `scripts/run-stack.mjs --mode local|server --home <state-directory>` parent instead of separate login tasks for each child. It verifies executable/config/port ownership, starts Core -> Gateway -> Bridge in order, checks real loopback health and exact service identity, and supervises only its own children. A child exit or repeated health failure triggers group recovery with exponential backoff/jitter and a restart budget; startup retries are bounded. `--action status` reads the singleton process lock without starting another copy. Signal shutdown stops owned children in reverse order and releases the lock. The installer runs the independent `scripts/wait-for-service.mjs` probe before reporting success.

Bridge capture files remain durable through upstream failures and supervisor restarts. An in-flight `.sending-*` claim counts as pending; failed uploads restore it, concurrently active uploads are not replayed, and claims abandoned by dead owners are recovered before flushing. Upload semantics remain at-least-once and rely on the capture event ID for idempotent server ingestion; an upstream success immediately followed by a process crash may cause a safe replay.

Use `npm run process:check` for deterministic lifecycle/fault-injection tests and `npm run process:smoke` for a real isolated Core/Gateway/Bridge runtime test. On a Linux host with a running user systemd, `npm run process:systemd-smoke` launches uniquely named transient units and verifies the dependency recovery contract: Core failure restarts Core/Gateway/Bridge, Gateway failure restarts Gateway/Bridge without touching Core, and Bridge failure restarts Bridge only. The transient units are removed at the end and the command never targets production Memhub unit names. These checks do not restart production services. Windows native runtime acceptance should use the Complete package's bundled Node/runtime dependencies so native modules are validated against the shipped Node ABI rather than the developer machine ABI.

In the generic `deploy/` path the Bridge remains optional. After `deploy/install-bridge-user-service.sh` is installed and enabled, it joins `memhub-stack.target`, waits for the configured Gateway health endpoint before starting, and follows Gateway/stack stop and restart propagation. `tests/deploy-systemd-e2e.mjs` executes both deploy installers against a temporary HOME with a fake `systemctl` so rendered base paths and lifecycle dependencies are validated without touching production units.

## Project isolation

Current-turn explicit project/workspace evidence overrides stale conversation binding. A request with ambiguous project evidence is global-only.

Business project memory and authoritative architecture come from one primary project. Other projects may contribute only explicit reusable Skills through the capability channel.

## MCP tool ownership matrix

| Tool | Primary state | Writes | Project resolution | Cross-tool guard |
| --- | --- | --- | --- | --- |
| `memmy_turn` | L1 turn log | L1 capture; optional conversation binding | current `workspace_project` / `project`, then stable conversation binding | incomplete checkpoint summaries may advance; completed L1 evidence is immutable |
| `memmy_context` | context router | only deterministic conversation binding refresh | current-turn project/workspace evidence overrides old binding; ambiguity becomes global-only | does not write L2/L3/L4 artifacts |
| `memhub_distill` | distillation jobs + Memory Core | job lease/complete/fail and L2/L3/L4/Skill artifacts | explicit workspace/project or job scope | lease owner, target, evidence and canonical project are revalidated on submit |
| `memmy_project_list` | Project Registry | none | account scoped | read-only discovery before create/bind of uncertain projects |
| `memhub_todo` | Project Registry todos | add/complete/reopen todo | current workspace/project first; conversation binding is fallback | Todo state is not duplicated into architecture or memory artifacts |
| `memhub_branch` | project-local workstream state | create/update/close/bind Branch context | only after one primary project is resolved | Branch narrows project retrieval; it never becomes L1/L2/L3/L4 or crosses project boundaries |
| `memhub_skill` | Skill artifacts + execution telemetry | load/record/plan/execute Skill lifecycle | explicit project/account Skill scope | full procedures load explicitly; revision/retirement requires short-lived authorization |
| `memhub_result` | short-lived result spool | read progressive result chunks | account-scoped result ownership | spool data is transport state only and is never distilled |
| `memmy_project_manage` | Project Registry lifecycle | create/update/delete/merge | explicit project references only | one-shot plan/execute authorization; delete is blocked while unfinished distillation jobs exist; merge preserves historical storage aliases |
| `memmy_project` | project binding + architecture reader | bind/unbind only | explicit workspace/project overrides old binding | architecture is read-only; project lifecycle mutations belong to `memmy_project_manage` |

The Control Plane must enforce the same state invariants as MCP tools. In particular, project deletion is rejected while pending, leased, or failed distillation jobs still reference that project. Project merge keeps historical evidence valid through Project Registry storage aliases instead of rewriting provenance.

## Long-content and transport boundaries

- JSON HTTP request bodies are measured in UTF-8 bytes, not JavaScript character count. Memhub and Bridge accept up to 4,000,000 bytes and return HTTP `413 request_body_too_large` above that boundary; malformed JSON returns `400 invalid_json_body`.
- L1 capture still enforces semantic field limits independently of the HTTP envelope: `user_text` / `assistant_text` are capped at 300,000 characters and reasoning/tool summaries at 100,000 characters.
- `memmy_context` uses progressive disclosure rather than returning the maximum available context by default. The default `response_mode=compact` uses a 32,000-byte aggregate content budget, an 8,000-byte per-item budget, compact provenance, at most 6 recalled items per category, and project candidates only when the primary project is unresolved. `response_mode=standard` restores the previous 96,000/24,000-byte envelope and full provenance; `full` is an explicit deep-inspection mode. Callers can further override the two byte budgets or disable architecture/recent-session recall. Persistent Memory and architecture are never truncated in storage.
- Recent L1 continuity is part of the same `contextBudget`; it cannot bypass the aggregate/per-item limits. Context items that exceed their allowance preserve head and tail text and mark `provenance.contextTruncated`, while `contextBudget` reports emitted/truncated/dropped counts.
- Compact provenance keeps only routing/debug fields needed for host decisions. Full tags/retrieval routes remain available through `provenance_mode=full`; `provenance_mode=none` strips item provenance from the host-facing response entirely.
- Host-facing Memory provenance keeps at most 32 tags and 16 retrieval routes per item, with original counts recorded when truncation occurs.
- Large distillation evidence is read incrementally through `memhub_distill action=next`: `evidence_chunk_chars` defaults to 120,000 and may be set from 10,000 to 200,000 characters; continue with the returned `next_offset` under the same lease owner until `evidence_transport.complete=true`.
- Bridge streams MCP/context/lifecycle upstream responses with backpressure instead of buffering the full response in memory. The normal upstream timeout is 15 seconds and can be adjusted with `MEMHUB_BRIDGE_UPSTREAM_TIMEOUT_MS` (100 ms to 300 s). Timeout and connection failures are distinguished as `504 upstream_timeout` and `502 upstream_unavailable`.
- Bridge capture uploads remain queue-backed and idempotent: transient upload failure leaves the event pending for a later flush rather than discarding it.

## Legacy state

Schema v8 archives legacy Policy/World Model style L2/L3 products and legacy `user_memories` rather than presenting them as Current L2/L3/L4 semantics. Raw historical data remains available for audit and migration evidence.
