# Control Plane and distillation

## Product taxonomy

The management surface exposes durable memory and processing state as:

```text
Overview / Projects / L1 / L2 / L3 / L4 / Skills / Processing
```

L1 is raw/auditable turn evidence. L2 is project chronology. L3 is durable project rules/experience. L4 is account-wide durable profile/rules. Skill is an orthogonal reusable procedure layer.

## Runtime topology

One Memhub installation has one Memory Core and one MCP runtime:

```text
Memory Core        127.0.0.1:18960
     ^
     |
Memhub MCP runtime 127.0.0.1:3001/mcp
```

Local clients connect directly to loopback. A Server deployment may expose the same MCP runtime through Cloudflare Access/Tunnel or another authenticated reverse proxy. Local and remote clients therefore use one tool schema, one control state and one Memory Core.

## L1 turn contract

`memmy_turn` is the model-facing L1 lifecycle:

- `open` records the user turn;
- `checkpoint` may store bounded audit-safe reasoning/tool summaries;
- `commit` records the assistant final and completes the turn;
- `failed` / `truncated` preserve terminal incomplete state;
- `resume` is an explicit continuity read when the caller provides a stable continuity/conversation key.

Project scope is explicit current-turn evidence. A host session identifier is not a routing key. When no stable host conversation ID exists, the MCP layer uses an event-scoped internal storage key so the durable capture schema can remain backward-compatible without creating a binding.

Memory Core still requires a session envelope for its write API, but Memhub creates that envelope deterministically from `account_id + L1 event_id`. Each L1 event therefore has its own Core session; host conversation/continuity identifiers do not group Core writes or distillation batches.

## Project resolution

The routing order is:

```text
explicit project/workspace
  > exact registered alias
  > unique semantic project candidate
  > global-only
```

Conflicting or unknown current-turn project evidence fails closed to global-only. Business memory and Project Architecture are recalled only from the one resolved primary project. Cross-project retrieval is limited to explicit reusable Skills.

`memmy_project` does not bind or unbind conversations. It provides project listing/current explicit scope plus Project Architecture read/plan/execute/history. Project create/update/delete/merge governance remains in `memmy_project_manage`.

## Branch Context

`memhub_branch` manages explicit project-local workstreams through `list`, `create`, `close` and `reopen`. A Branch narrows retrieval within the resolved Project. It is not attached to a chat window, does not duplicate L1, and does not become L2/L3/L4.

## Distillation jobs

`memhub_distill` is the semantic distillation work queue. `action=next` leases evidence to the connected Harness/model; the Harness then calls `submit` or `skip`. Memhub validates account/project scope, evidence references, canonical artifact identity and lease ownership before commit.

### L1 -> L2

Discovery scans complete, ingested, project-resolved L1 evidence and groups unconsumed events by account + canonical project. Host conversations do not partition a batch. Threshold/idle policy decides when a project batch is ready.

### L2 -> L3

Completed L2 evidence can derive a project-scoped L3 job. L3 contains durable project rules, preferences, constraints and learned operating patterns rather than a transcript replay.

### L3 -> L4

L4 is account-scoped and synthesizes durable cross-project evidence. It must preserve evidence provenance and must not infer sensitive traits without appropriate evidence and governance.

### Skill

Skill stores reusable procedures. `memmy_context` returns compact Skill candidates; `memhub_skill action=load` hydrates the selected procedure and `action=record` stores execution telemetry. Skill revision/retirement uses explicit plan/execute governance.

## Canonical artifacts and evidence

Durable derived artifacts use stable identities and immutable revision evidence references. When `memmy_context` returns an exact L2/L3/L4 `evidenceRef`, downstream tools pass that reference unchanged instead of reconstructing a reference from a stable memory ID.

The connected Harness/model is the semantic executor. The Memhub server schedules, validates and persists; it does not silently invoke a subscription model session from the background.

## Automatic processing

Automatic distillation is opt-in. Enabling it records an ingestion-time cutover so existing history is not unexpectedly reprocessed. Discovery is idempotent: evidence already claimed by an existing job is not silently duplicated. Queueing failure is reported separately from successful L1 ingestion and can be reconciled later.

Crash recovery uses durable L1 evidence plus the ingest intent/marker. It does not require a registered device record. Ambiguous legacy evidence without a trustworthy intent remains a review case rather than being guessed into Core.

New L1 files persist the submitting Harness as `actor_id`. The reader accepts historical `device_id` only as a migration-compatible alias and normalizes it to `actor_id`; there is no current device registry or device-token authority behind that field.

## Process ownership

Linux current installs use:

```text
memhub-core.service
memhub.service
memhub-stack.target
```

Windows/direct installs use one `scripts/run-stack.mjs --home <state-root>` owner for Core + MCP runtime. The singleton lock is `.memhub-stack.lock` and configuration is `memhub.env`. Readiness is checked on real loopback health endpoints. Child failure triggers bounded group recovery; stop/status operate only on a verified owner.

## Control Plane invariants

The browser Control Plane and MCP tools must enforce the same state rules. In particular:

- project deletion is blocked while unfinished distillation work references it;
- project merge preserves historical storage aliases/evidence instead of rewriting provenance;
- Todo state lives in Project Registry, not duplicated into L3 or Project Architecture;
- Project Architecture full replacement requires plan -> explicit approval -> execute and keeps revision history;
- direct L3/L4 governance requires explicit user confirmation evidence;
- ambiguous project scope never falls back to a remembered chat binding.

## Transport and content boundaries

MCP is the only model/tool ingress. Large tool results use progressive result/evidence transport rather than a separate proxy process. `memmy_context` applies bounded context budgets and progressive disclosure; `memhub_memory action=load` hydrates selected exact revisions.

The durable L1 schema still contains historical conversation/continuity fields for compatibility and explicit resume provenance. Those fields are not Project/Branch state and are not an L1 -> L2 grouping key.

## Legacy state

Historical runtime/configuration artifacts may remain only inside protected recovery evidence. They are not loaded as current runtime authority.
