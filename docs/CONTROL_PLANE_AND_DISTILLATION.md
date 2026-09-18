# Control Plane, capture and distillation

Memhub deliberately separates four concerns that are easy to conflate:

```text
capture      = preserve observed raw turns
memory       = durable scoped recall data
distillation = a capable Harness interprets evidence and proposes durable artifacts
evolution    = Memory Core's native L2/L3/Skill lifecycle and validation
```

Memhub is the storage, evidence-boundary, scope, provenance, job, schema,
validation and commit layer. It does not run a hidden rule-based summarizer and
does not silently spend model quota to imitate semantic distillation.

## Control Plane authentication

The HTTP listener remains bound to `127.0.0.1`. Human administration has two
strictly separate authentication paths.

### Local administration

Requests are considered local-control requests only when all of these are true:

1. the TCP peer is loopback;
2. the HTTP `Host` is `127.0.0.1`, `localhost`, or `::1`;
3. Cloudflare forwarding/Access headers are absent;
4. HTTP Basic authentication contains the Memhub local-admin token; and
5. the selected stable Memhub account has role `admin`.

This is intentionally stricter than trusting `remoteAddress=127.0.0.1` because
a local `cloudflared` process also reaches the origin from loopback.

Show the token on the server:

```bash
cd /home/z/codex-workspace/Memhub
node dist/mcp.js admin-token show --state-root ~/.memmy/memhub
```

The token is stored at `~/.memmy/memhub/local-admin-token` with mode `0600`.
Rotate it with:

```bash
node dist/mcp.js admin-token rotate --state-root ~/.memmy/memhub
```

For remote access through SSH, forward the loopback listener:

```bash
ssh -L 3001:127.0.0.1:3001 <server>
```

Then open `http://127.0.0.1:3001/memhub/admin`. The browser Basic-auth username
may be `memhub`; the password is the token above.

### Public administration

Public control-plane requests never use the local-token path. Configure
`MEMHUB_PUBLIC_HOST=<memhub-domain>` in `~/.memmy/memhub/memhub.env`, publish
the loopback origin through Cloudflare Tunnel, and protect the application with
Cloudflare Access. Memhub validates the signed Access JWT and maps the verified
identity onto a stable internal `account_id`. `/memhub/admin` additionally
requires that account to have role `admin`; `/memhub` is the ordinary
account-scoped workspace surface.

The local-token path does not weaken `/memhub/mcp` or `/memhub/capture`:
machine capture still requires a Memhub device token, and public human/MCP
identity continues to use the configured Cloudflare boundary.

## Account roles

Roles can be changed from the Control Plane Accounts view or from the CLI:

```bash
node dist/mcp.js account role <username|account_id|email> admin --state-root ~/.memmy/memhub
node dist/mcp.js account role <username|account_id|email> user  --state-root ~/.memmy/memhub
```

The Control Plane refuses to demote the final administrator.

## Raw capture lifecycle

The checked-in Codex/OpenAI hook adapter uses `UserPromptSubmit` and `Stop`:

```text
UserPromptSubmit(user_text) ---+
                              +--> same event_id --> Bridge --> /memhub/capture
Stop(assistant_text) ----------+                         |
                                                        v
                                               raw capture store
                                                        |
                                      only complete user+assistant turn
                                                        v
                                            Memory Core session/turn
```

Partial fragments remain visible as raw captures but are not promoted into
Memory Core until both sides are present. Capture failure never blocks the AI
turn; the adapter/Bridge queues data for retry.

The Control Plane exposes raw captures separately from Memory Core L1 traces so
operators can see whether a host conversation was captured, whether a turn is
partial or complete, and whether it was ingested.

## ChatGPT is not passive capture

Connecting Memhub as an MCP app gives ChatGPT tools; it does not grant Memhub a
continuous feed of every user and assistant message. Without a host lifecycle
hook, ChatGPT Web can use `memmy_context`, explicit durable writes, distillation
jobs and evolution tools, but Memhub cannot claim automatic full-conversation
capture merely because the MCP connection exists.

The repository currently contains an automatic raw-capture implementation for
the Codex/OpenAI lifecycle-hook adapter. Claude/Gemini/other host overlays are
not yet checked in, so those hosts are MCP-only until a real lifecycle adapter
is implemented for them.

## Distillation jobs

`memhub_distill` supports two modes:

- direct submit: the current model already has appropriate evidence and submits
  a `skill`, `summary`, or curated `knowledge` artifact;
- job mode: `action=next` leases evidence, the Harness reasons over it, then
  calls `action=submit` or `action=skip`.

`skip` is important: temporary discussion should be explicitly allowed to
produce no durable artifact instead of forcing pollution into long-term memory.

Job evidence stores source conversation IDs and stable capture references.
Evidence batches are hash-deduplicated. Automatic batches exclude evidence that
has already participated in a non-failed job.

### Manual distillation

In the Control Plane, open **Raw Captures**, inspect a conversation, and choose
**Queue distillation**. A connected capable Harness can then be instructed to
process Memhub's pending distillation jobs. The Harness leases a job through
`memhub_distill(action=next)`, evaluates the evidence, and submits or skips it.

This is the preferred way to deliberately use the current ChatGPT/Codex/Claude
model's reasoning ability without giving Memhub its own model credentials.

### Optional automatic job creation

Automatic distillation is **off by default** because model execution consumes
quota. Enabling it does not itself call a model. It only creates evidence jobs
when either condition is met:

- a conversation reaches the configured turn threshold (default: 8 complete
  ingested turns, then subsequent threshold boundaries); or
- a conversation is idle for the configured interval (default: 30 minutes)
  and has new, unused evidence.

The Control Plane Distillation Jobs view changes these settings. A Harness still
has to claim and execute the job, so model cost remains explicit and observable.

Idle is an evidence-boundary signal, not a fabricated host `SessionEnd` event.
The current capture adapter only sends turn fragments, so Memhub does not close
a deterministic Memory Core session merely because the wall clock was idle;
doing so could conflict with a later continuation of the same host conversation.
When a host adapter supplies a reliable session-end event, that event can be
added as a stronger episode/distillation boundary.
If a Memory Core commit fails, the job stores the failure and can be retried from
the Control Plane. Retry reuses the same job, evidence hash and conversation
provenance instead of creating a duplicate evidence batch.

## Relationship to Memory Core evolution

Do not build a second L2/L3 pipeline in Memhub. Memory Core already owns Episode
processing, L2 policy induction, Skill lifecycle and L3 World Model evolution.
`memhub_evolution` is an external-executor bridge into the native L3 lease and
submit protocol; Memory Core retains ownership/evidence/hash validation.

Likewise, `memhub_distill(kind=knowledge)` is a curated durable L1 artifact. It
is not a substitute for native L2 policy induction. Skills are written to the
Skill layer; summaries/curated knowledge are grounded durable artifacts; L2/L3
remain native evolution products.

## Control Plane lifecycle views

The administrator UI separates:

```text
Raw Captures
    -> Conversations / Episodes
    -> Distillation Jobs
    -> Memories / L1 Traces
    -> Skills
    -> L2 Knowledge
    -> World Models (L3)
```

Raw captures and distillation jobs live in Memhub state. Episode/L1/L2/Skill/L3
views come from the loopback Memory Core viewer API. Detail drawers expose raw
metadata/provenance so evidence can be traced back to source conversations.

Actions that mutate Memory Core are archive/delete memory, archive Skill,
archive World Model, successful distillation submission, complete-turn capture
ingestion, and successful native evolution submission. Queueing/skipping a
distillation job, changing its trigger configuration, rotating a local admin
token, or changing account roles modifies Memhub control state rather than the
Memory Core SQLite contents.
