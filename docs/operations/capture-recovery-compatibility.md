# Capture / Core / Queue compatibility and release gate

## Linux edition fresh-install boundary

`editions/local/linux/install.sh` and `editions/server/linux/install.sh`
now reject an existing StateRoot (including a symlink) or any existing
Memhub user systemd unit before dependency installation or state/service
mutation. StateRoot creation is exclusive after that check. Disposable
fresh-install/reinstall and protected-config/DB/foreign-unit regressions
run in `tests/edition-regressions.mjs`, with systemctl shimmed. This is a
fail-closed fresh-install guard, **not** an in-place upgrade mechanism; an
existing deployment requires separate configuration, account, Bridge endpoint
and credential preservation, exact artifact verification and a rollback plan.
The existing Linux production routing baseline remains `/mcp` and
`/capture`; the edition installers' new-install defaults differ and must not
silently replace the live route configuration.

The generic `deploy/install-user-service.sh` and
`deploy/install-bridge-user-service.sh` also reject existing Memhub user
systemd units before writing new unit definitions. This closes the separate
generic deployment path that could otherwise replace the live Gateway route
or Bridge dependencies even when edition installers refused a reinstall.
`tests/deploy-systemd-e2e.mjs` verifies fresh installation, repeat-install
refusal under a different base path, protected partial/foreign units, dangling
Bridge unit symlinks and unchanged systemctl calls in a disposable HOME.
Neither installer is an authorized upgrade/rollback procedure.

### Read-only generic Linux upgrade evidence

Before planning an upgrade of an existing generic `deploy/` installation,
run `node scripts/linux-upgrade-preflight.mjs` (or
`--home /absolute/disposable/home` for isolated QA). The report contains
SHA-256 digests of the four systemd units, gateway env, Core YAML and Bridge
configuration, together with **paths only** for MCP/Capture routes, token
equality, database/device-token presence and the exact protected-state
inventory (account, device, project, bindings, capture index, Capture and
distillation trees, Bridge queue). It also reports the observed WAL/SHM/
journal sidecars for both the Core and Capture-index SQLite databases.
It never prints raw tokens,
Bridge hostnames or config contents, and never writes, locks or stops the
running stack. It checks that the Gateway's actual `--http-path` and
`--capture-path` agree with the Bridge endpoint paths and that the Core
token matches the Gateway token. Missing, duplicate, symlinked, contradictory
or unsupported evidence fails closed. The data-file bytes are not hashed.
`tests/linux-upgrade-preflight.mjs` covers a disposable matching fixture
and negative credential, routing, state-root, protected-entry, database and
symlink cases.

### Isolated backup and rollback rehearsal

`node tests/linux-upgrade-backup-rehearsal.mjs` exercises only fabricated
temporary data, with both Core and Capture-index databases open in WAL mode.
It uses SQLite's consistent backup API for **both** databases, excludes
active Capture-index database/sidecars from the ordinary Gateway tree copy,
copies the entire Gateway/Bridge state trees, Core config and user systemd
units, validates SQLite integrity and evidence rows, then seals the backed-up
databases to a self-contained journal mode before hashing every snapshot
file. It simulates credential, route, queue, Capture and database changes,
rejects a corrupted snapshot, and verifies that rollback restores the
original file hashes and SQLite rows. The test never reads/copies production
secrets or data. Retain the original migration/history files and their
sidecars in the protected tree; do not run arbitrary cleanup during upgrade.

**This is not a production backup or an old-version binary migration test.**
An authorized cutover needs an exact service/owner and active-writer check,
coordinated quiescence across Gateway, Bridge, Core, Capture and distillation
writers, a secure restricted backup destination outside all live state roots,
verified backup manifest and SQLite integrity, and an independent restore
before touching original files. A standalone `cp memory.sqlite` is unsafe
when WAL is present; backing up Core alone also omits the Capture index,
frozen ingest state, account/device credentials, bindings and Bridge queue.
Do not copy mutable Gateway/Bridge file trees while their writers remain
active. This candidate has **not** established a live quiescence mechanism
or verified an actual production backup, so its migration gate stays closed.

`evidence_complete=true` is **not** an upgrade approval: the report always
sets `authorized_to_migrate=false`, `production_runtime_verified=false`,
`bridge_endpoint_host_verified=false` and `backup_verified=false`.
Operator review must still establish exact artifact/source provenance, live
service PID/owner/port identity, authenticated health and Capture semantics,
exact external hostname/proxy path, a restorable backup of protected state,
and a real isolated old→new→old rehearsal. The read-only result is a
point-in-time snapshot and must be repeated before an authorized cutover.

Status: source-aligned Windows Complete **QA candidate** and Linux recovery tests
pass. This is neither a committed/signed release nor a deployed capability.

| Contract / failure window | Linux canonical local (0.2.5) | Windows isolated 0.2.5 runtime candidate | Release requirement |
| --- | --- | --- | --- |
| Device-token authenticated HTTP Capture and real Core ingest | Real isolated Core/Gateway stack smoke passes | Real Core/MCP/stack smoke passes in disposable candidate | Repeat on clean release artifact with exact target configuration |
| Immutable event payload and per-event Core attempt lock | Matching durable `.ingest-intent`, concurrent mutation fencing, deterministic request IDs tested | New 0.2.5 candidate Core/MCP E2E passes | Run on version-aligned Windows complete package |
| `memhub_distill recover_ingest` with exact `event_id` + resolved project | MCP E2E: dry-run, invalid/revoked device, project mismatch, Core 409, successful replay | New candidate MCP E2E including HTTP-vs-recovery race passes | Confirm exact packaged MCP/HTTP/Bridge paths |
| Core success, process crash **before** marker | Child exits after real Core commit; next Gateway replays matching frozen intent with same IDs | Real Core crash/restart smoke passes with Windows-only fixture exit handling | Repeat on clean Windows package |
| Core + marker success, process crash before L2 enqueue | Real child crash + startup marker reconciliation pass | Real Core/marker/queue recovery passes | Reboot/restart test in release package; one L2 evidence claim per reference |
| Concurrent Discovery and Bridge acknowledgement loss | Four concurrent scans claim each L1 ref once; Bridge retains event on lost ACK and retries unchanged | New candidate MCP/Discovery/Bridge E2E passes | Repeat with version-aligned release dependencies |
| Read-only production state audit | Uses existing clean SQLite index; partitions frozen/legacy/conflict and ready/waiting; Bridge pending can be inspected explicitly | Candidate test behavior passes; no Windows production target inspected | Re-run without writes immediately before deployment |

The Linux candidate's isolated real-Core, MCP and Discovery tests are exercised by
`node tests/stack-runtime-smoke.mjs`, `node tests/mcp-e2e.mjs` and
`node tests/distillation-discovery-e2e.mjs`; the broader gate is
`npm run stability:check`. The new 0.2.5 runtime was also exercised in an
isolated Windows directory with build/Core/MCP/Discovery/real-stack smoke
passing; see `windows-recovery-candidate-2026-09-26.md`. This is a
cross-platform code-path acceptance, **not** a clean signed/package release
acceptance: the ordinary Windows checkout remains 0.2.2 and the isolated
candidate relies on its node_modules/vendor/supervisor.

2026-09-26 follow-up: the disposable `candidate-aligned` Windows tree now
uses v0.2.5 plugin metadata and the same vendor manifest as Linux canonical.
Windows Core/Discovery/MCP/real-stack smoke, `npm test`, release checks and
full `npm run stability:check` passed; Linux full stability also passed.
The separate earlier hybrid candidate failures above remain historical
evidence. See `windows-acceptance-followup-2026-09-26.md` for checksums and
test boundaries. This earlier note preceded the Complete package retest.

2026-09-26 final isolated QA: Windows Complete ZIP SHA-256
`1b96e2be190dfd0a2e365b2d4ae8a6624830cc2091e160c35b8c58dcf5d706b6`
matched its manifest. A fresh extraction passed bundled Node 22.20.0
native-dependency smoke and, with test files added only to the QA extraction
and product `dist/mcp.js` hash unchanged, bundled-node Core/MCP/Discovery
E2E and real-stack crash/recovery smoke. Real managed Local and Server
processes passed the isolated installer lifecycle harness even when system
Node 24.19.0 was offered via `$env:NODE`; Task Scheduler operations were
shimmed. Linux `stability:check` passed after the same code updates.

A fresh read-only production audit (no Core/queue replay) reported 429
captures: 90 incomplete, 338 ingested, one complete/un-ingested legacy
event without frozen intent; five project-unresolved events and zero
currently due for discovery enqueue. Audited index, job and registry
metadata remained unchanged; Bridge backlog was not inspected. The single
legacy event must stay in the individual review queue. The exact package
remains a `--worktree` QA artifact, not a clean reviewed Git release.

**Operational rule:** No production bulk recovery. Legacy complete captures
without a durable intent require per-event Core outcome/provenance review. A
matching frozen intent permits idempotent replay using its original request
IDs; a conflicting intent, missing raw content or revoked device fails closed.
No automatic repair should bypass the per-event intent or queue evidence lock.

The P0 Capture/Core/Queue **candidate-code** subtask can be closed on these
cross-platform and package-level regression results; deployment acceptance
is separate and remains part of its parent task. Before actual deployment,
confirm a reviewed commit and clean release provenance, recheck the live
MCP/HTTP/Bridge schema after authorized service reload, repeat read-only
production preflight, and inspect Bridge backlog explicitly if configured.
No production service restart or data write occurred in this QA matrix.

## Read-only production Bridge/Capture follow-up, 2026-09-26

The currently running `memhub-bridge.service` explicitly uses
`MEMHUB_BRIDGE_HOME=%h/.memhub`. Its existing queue is a real directory,
not a symlink, and the read-only name inspection found **zero** canonical
capture files, zero `.sending` claims and zero unexpected entries. This
resolves the earlier *uninspected Bridge backlog* gap for this point-in-time
snapshot; it does not establish future backlog or delivery behavior.

The current candidate's account-scoped `auditDistillationPipeline` was run
read-only against the existing production Capture index and explicitly
configured Bridge root. Snapshot: 446 captures (352 ingested, 93 incomplete,
one complete/un-ingested); 101 pending, 44 completed, zero leased and seven
failed Jobs; nine eligible/un-queued events all waiting normally below
threshold/idle, **zero** due for discovery enqueue; Bridge pending=0 and
inspected=true. The sole complete/un-ingested event is legacy **without** a
frozen intent and must stay in manual provenance/Core-outcome review. All
five unresolved ingested captures lack a `project_hint`; never guess one.
The seven failed Jobs are historical 2026-09-20 L2 migration rebuild records
with the original Memory Core project-filter error, not fresh failures or
permission to bulk retry. Capture index, Job store and project registry
size/mtime metadata were identical before and after audit. Nothing was
enqueued, recovered, retried, modified, or sent.

Regression coverage now also asserts that a `.sending` Bridge claim counts
as pending in an audit **without** reclaiming or modifying the claim, and
that `bridgeRoot=null` explicitly reports not-inspected rather than probing
an unrelated default directory. `npm run build && node
tests/distillation-discovery-e2e.mjs && git diff --check` passed on Linux.

The remaining parent P0 acceptance is still an authorized exact-artifact
deployment with authenticated live MCP/HTTP/Bridge checks and production
preflight. These read-only results do not close the parent release gate.

### Latest production read-only snapshot, 2026-09-26 22:44 +08

After the fresh Complete worktree package was assembled, the account-scoped
pipeline audit was repeated against the live state and explicit Bridge root.
It observed 465 captures (370 ingested, 94 incomplete, one
complete/un-ingested), 126 pending Jobs, zero leased, 44 completed and seven
historical failed Jobs. Two eligible/un-queued evidence groups were both
still inside normal idle/threshold waiting and zero were due for enqueue.
Bridge pending remained zero. Five ingested captures still have unresolved
project evidence; the sole complete/un-ingested legacy capture still requires
manual provenance/Core-outcome review. The audit did not mutate Capture,
Job or project-registry metadata. Core, Gateway and Bridge remained active
with zero restarts.

The live Gateway environment file and Memory Core YAML were also compared
without printing either secret: both contain a Memory token and the values
are byte-identical. The Bridge config contains a device token and still
targets the configured HTTPS `/mcp` and `/capture` paths. Connected Memhub
MCP read calls remained usable during this review. These are read-only
credential-consistency observations, not an authenticated Capture mutation.

### Live route preflight (read-only)

The running Linux Core/Gateway/Bridge services each reported healthy on
their **configured** `/health` endpoints (HTTP 200; Core reported 2.1.2).
The deployed Gateway is configured for **`/mcp` and `/capture`**, unlike the
Windows installer candidate's explicit `/memhub/mcp` and `/memhub/capture`
paths. On the live loopback, unauthenticated GET `/mcp` returned 401,
GET `/capture` returned 405, while `/memhub/mcp` and `/memhub/health`
returned 404; those 404s reflect the configured route, not a failed Core.
The Bridge config points to the corresponding HTTPS `/mcp` and `/capture`
endpoints and has a device token. No token, raw response body, authenticated
POST, capture or mutation was emitted by this probe. This establishes the
current routing baseline to preserve/verify through proxy rules during the
authorized upgrade, **not** post-deployment acceptance of the candidate.
