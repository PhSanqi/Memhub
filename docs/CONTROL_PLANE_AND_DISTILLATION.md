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

## MCP tool ownership matrix

| Tool | Primary state | Writes | Project resolution | Cross-tool guard |
| --- | --- | --- | --- | --- |
| `memmy_turn` | L1 turn log | L1 capture; optional conversation binding | current `workspace_project` / `project`, then stable conversation binding | incomplete checkpoint summaries may advance; completed L1 evidence is immutable |
| `memmy_context` | context router | only deterministic conversation binding refresh | current-turn project/workspace evidence overrides old binding; ambiguity becomes global-only | does not write L2/L3/L4 artifacts |
| `memhub_distill` | distillation jobs + Memory Core | job lease/complete/fail and L2/L3/L4/Skill artifacts | explicit workspace/project or job scope | lease owner, target, evidence and canonical project are revalidated on submit |
| `memmy_project_list` | Project Registry | none | account scoped | read-only discovery before create/bind of uncertain projects |
| `memhub_todo` | Project Registry todos | add/complete/reopen todo | current workspace/project first; conversation binding is fallback | Todo state is not duplicated into architecture or memory artifacts |
| `memmy_project_manage` | Project Registry lifecycle | create/update/delete/merge | explicit project references only | one-shot plan/execute authorization; delete is blocked while unfinished distillation jobs exist; merge preserves historical storage aliases |
| `memmy_project` | project binding + architecture reader | bind/unbind only | explicit workspace/project overrides old binding | architecture is read-only; project lifecycle mutations belong to `memmy_project_manage` |

The Control Plane must enforce the same state invariants as MCP tools. In particular, project deletion is rejected while pending, leased, or failed distillation jobs still reference that project. Project merge keeps historical evidence valid through Project Registry storage aliases instead of rewriting provenance.

## Long-content and transport boundaries

- JSON HTTP request bodies are measured in UTF-8 bytes, not JavaScript character count. Memhub and Bridge accept up to 4,000,000 bytes and return HTTP `413 request_body_too_large` above that boundary; malformed JSON returns `400 invalid_json_body`.
- L1 capture still enforces semantic field limits independently of the HTTP envelope: `user_text` / `assistant_text` are capped at 300,000 characters and reasoning/tool summaries at 100,000 characters.
- `memmy_context` is a bounded host-facing view. Persistent Memory and architecture files are never truncated in storage, but returned context defaults to a 96,000-byte content budget and a 24,000-byte per-item budget. Oversized items preserve head and tail text and mark `provenance.contextTruncated`, while `contextBudget` reports emitted/truncated/dropped counts.
- Host-facing Memory provenance keeps at most 32 tags and 16 retrieval routes per item, with original counts recorded when truncation occurs.
- Large distillation evidence is read incrementally through `memhub_distill action=next`: `evidence_chunk_chars` defaults to 120,000 and may be set from 10,000 to 200,000 characters; continue with the returned `next_offset` under the same lease owner until `evidence_transport.complete=true`.
- Bridge streams MCP/context/lifecycle upstream responses with backpressure instead of buffering the full response in memory. The normal upstream timeout is 15 seconds and can be adjusted with `MEMHUB_BRIDGE_UPSTREAM_TIMEOUT_MS` (100 ms to 300 s). Timeout and connection failures are distinguished as `504 upstream_timeout` and `502 upstream_unavailable`.
- Bridge capture uploads remain queue-backed and idempotent: transient upload failure leaves the event pending for a later flush rather than discarding it.

## Legacy state

Schema v8 archives legacy Policy/World Model style L2/L3 products and legacy `user_memories` rather than presenting them as Current L2/L3/L4 semantics. Raw historical data remains available for audit and migration evidence.
