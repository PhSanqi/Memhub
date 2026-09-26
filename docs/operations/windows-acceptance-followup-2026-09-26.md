# Windows acceptance follow-up: isolated runtime versus complete artifact

Status: **release gate remains open**. This is an isolated QA result, not a
deployment, a signed release, or approval to replay legacy production data.

The disposable Windows 0.2.5 candidate in
`.review-runtime/win-recover-candidate-transfer-20260926/candidate`
passed `npm run build`, `node tests/core-e2e.mjs`,
`node tests/distillation-discovery-e2e.mjs`, `node tests/mcp-e2e.mjs`,
and `node tests/stack-runtime-smoke.mjs` on Windows Node 24. SHA-256
comparison against the current Linux candidate confirmed byte equality for
`src/capture.ts`, `src/capture-recovery.ts`, `src/mcp.ts`,
`src/distillation-discovery.ts`, and `tests/mcp-e2e.mjs`. The Windows
stack-smoke fixture differs intentionally for process-exit and SQLite
cleanup portability; its real-Core crash/recovery assertions passed.

The Windows `npm run stability:check` **did not pass** on this hybrid
candidate. Its `test` step failed at
`tests/skill-version-scope-e2e.mjs` with "Skill key must separate
accounts": the candidate links the older Windows `vendor/`, whose
`memoryAddKey` hashes only skill source identity/version, whereas the
Linux canonical vendor also hashes account and project scope. Both
`release-check` and `release-complete-check` failed because candidate
`package.json` says 0.2.5 while the borrowed
`adapters/plugin/plugin.json` says 0.2.2. Typecheck and state audit
succeeded. These are concrete **transfer/package parity blockers**;
passing Capture smoke does not make the hybrid tree a valid complete
release. Do not patch its version number alone and claim source parity.

Separately, Windows Group's Local and Server installer lifecycle tests
were run on disposable StateRoots with real managed Core/Gateway(/Bridge)
processes. Each edition completed five owner launches through initial
install, same-version reinstall/upgrade/rollback simulation, uninstall
without purge and reinstall after uninstall. Task Scheduler and ACL calls
were shimmed; no real scheduled tasks or ACLs were changed. Credential
tests verified JSON and Core-rewritten YAML byte preservation, rejection
of missing/invalid credentials before stopping an owner, and protection
of unrelated Node processes. Windows stack smoke, process-stack E2E, and
edition regressions also passed. **Real cross-version artifact migration,
rollback and actual scheduled-task lifecycle are still untested**.

Required next gate: transfer a complete version-aligned candidate including
the canonical vendor and plugin metadata; compare source and vendor
checksums, pass full Windows stability and release checks, then use that
exact artifact for a genuine isolated cross-version installer
install→restart→upgrade→rollback/reinstall with real task ownership.
The Linux/Windows P0 Capture release gate and Windows installer lifecycle
TODO must remain open until those conditions are met.

## Follow-up: version-aligned isolated QA, 2026-09-26

The previous hybrid failure is historical, not the latest QA outcome. The
published v0.2.5 Windows Server ZIP was downloaded to a disposable directory;
its SHA-256 (`045d5cdb9ace9200f6fc005643bf41dca4a2256129fe5a6bb57b4be153e3294d`)
matched the published `SHA256SUMS.txt`. A separate `candidate-aligned` tree
combines its v0.2.5 plugin metadata and assets, current Linux candidate
source/tests/scripts, and the `vendor/` from public `main`, whose manifest
matches Linux canonical SHA-256
`2b0871bf0a5b2a0e068e54ba4549d166e61c6f6007186a97cf05e95e1164b849`.
The original release vendor and installer files were retained separately.
Neither canonical Windows checkout nor production data was overwritten.

On this isolated, **source-aligned but not packaged release** candidate,
Windows `npm test`, `npm run stability:check`, Core E2E, Discovery E2E,
MCP E2E, real stack smoke, edition regressions, vendor manifest and both
release checks returned exit code 0. Linux canonical `npm run stability:check`
also returned exit code 0 after the same change. The seven Cloudflare tunnel
watchdog cases are Bash/systemd-specific: the test now runs on Linux (7 pass)
and explicitly skips on Windows (7 skip). This is platform scoping, not a
Windows implementation of the Linux watchdog.

**Remaining gate:** package the exact version-aligned candidate as a clean
Windows Complete artifact and test that same artifact. Perform genuine
isolated cross-version install/upgrade/rollback/reinstall and real scheduled
task lifecycle (previous runs shimmed Task Scheduler/ACL calls), verify
protected credentials/data and unrelated processes, then repeat read-only
production preflight immediately before any authorized deployment. The P0
Capture release gate, P1 Windows installer lifecycle and their parent TODOs
remain pending. No production restart, push or bulk legacy replay occurred.

## Further acceptance: source-aligned package and production audit

The isolated `candidate-aligned` tree passed the full Windows
`npm run stability:check`, `npm run release:check` and
`npm run release:complete:check` in one successful command chain. A separate
`npm run release:package -- --worktree` produced a Windows Server ZIP with
SHA-256 `f29efdc873bc998bd6e57c0e3e4e47d30fbe0a0e50c35a5f1c36b90b383756fe`.
The ZIP was unpacked into a fresh `package-smoke` directory; its vendor manifest
matched Linux SHA-256 `2b0871bf0a5b2a0e068e54ba4549d166e61c6f6007186a97cf05e95e1164b849`
and its plugin reported `0.2.5`. On this **actual archive content**, Windows
build, Core E2E, MCP E2E, Discovery E2E and real-stack smoke all returned 0.
The archive is an isolated worktree package, not a signed Complete installer:
QA used a junction to the existing Windows `node_modules`, and the worktree
manifest's ancestor Git commit is not a commit of the uncommitted candidate.

Linux production was audited read-only using the current candidate's
`auditDistillationPipeline` against the existing account-scoped durable index.
Snapshot: 423 captures (91 incomplete, 331 ingested, 1 complete/un-ingested),
5 unresolved-project ingested events, 4 unqueued events still legitimately
waiting for threshold/idle, 0 ready for reconciliation, and 85 pending jobs.
The sole complete/un-ingested capture has **no frozen ingest intent** and
requires individual provenance/Core-outcome review; no automatic replay was
attempted. Index, job and registry size/mtime were unchanged across the audit.
Bridge backlog was not inspected. The private diagnostic is
`.review-runtime/capture-production-readonly-audit-20260926.json`.

A bounded Windows preflight probe held loopback port 3001 with a disposable
listener and invoked the packaged Server installer against a new QA StateRoot.
It rejected the occupied port before writing config/environment, and no real
Task Scheduler changes were made. This verifies fail-closed behavior, **not**
the desired migration from v0.2.2 legacy scheduled tasks: an active legacy
listener is a separate cross-version upgrade blocker until its exact task
ownership and safe stop/migration are verified. The disposable probe listener
was stopped and port 3001 was confirmed free afterward.

## Task Scheduler ownership guard (uncommitted, 2026-09-26)

The Local and Server Windows installers and uninstallers now dot-source
`scripts/windows-task-ownership.ps1` before stopping a managed owner.
The shared guard reads only root Task Scheduler registrations, requires the
exact task name, expected StateRoot launcher path, one action with no extra
arguments, and the caller's Windows principal. Unknown or inaccessible task
metadata fails closed; a legacy task with the expected identity also fails
closed pending an explicit cross-version migration. An existing managed task
is revalidated immediately before its exact-name removal. New task creation
does not use `/F` to overwrite an unknown concurrent registration. Neither
installer nor uninstaller scans or force-kills other Node processes by path.

`tests/windows-task-ownership-e2e.ps1` covers exact-owner acceptance,
foreign launcher, unexpected action arguments, foreign principal, legitimate
legacy-task rejection, time-of-check/change rejection, and exact-name removal
against an in-process mock. Group Windows Local and Server installer
lifecycle tests passed against disposable StateRoots with a Task Scheduler
shim and actual managed Core/Gateway/Bridge processes. The separate
`edition-regressions.mjs` now checks the shared guard and prohibits blind
task replacement/removal. Linux and Group checks are separate; none of these
tests registers, ends or deletes an actual Windows scheduled task.

A source-aligned Windows 0.2.5 candidate with these installer changes and
Group's existing credential-preservation helper passed Windows
`stability:check`, `release:check` and `release:complete:check`.
Its re-generated thin Server ZIP has SHA-256
`04b8803b2c4b69478660d86bb6cb27f061a0818316b25de668b6acbc1583c8b2`.
The archive was unpacked into a new QA directory: build, task-ownership test,
Core/MCP/Discovery E2E, real-stack smoke and Server installer lifecycle passed.
The whole-tree `edition-regressions.mjs` is not an archive-level test of a
Server-only ZIP because the package intentionally omits Local/Linux edition
paths; it passed against the full source-aligned candidate. QA package
generation was `--worktree`, so its manifest is not a clean committed
release provenance claim.

**Remaining:** no genuine legacy v0.2.2 task was stopped or migrated; no
production Task Scheduler operation, Complete release publication, Git push
or production service restart was authorized in this turn. A real
cross-version install/upgrade/rollback and Complete archive acceptance
remain separate gates. An operator must preserve the old task XML,
launcher paths, credentials and data, verify exact user/StateRoot ownership,
and obtain explicit authorization before stopping/removing legacy tasks.

## Windows Complete native-module ABI regression

The first assembled Windows Complete QA archive passed its bundled
`runtime/node/node.exe scripts/complete-runtime-smoke.cjs` native dependency
check, but the Server installer lifecycle failed at Core readiness. The
preserved disposable stack stderr showed that `better_sqlite3.node` was
built for Node ABI 127 (bundled Node 22.20.0), while the actual Core process
expected ABI 137 (system Node 24). The Group installer had checked only the
obsolete `runtime/node.exe` location and fell back to PATH; the Server
canonical installer also gave `$env:NODE` priority over the bundled runtime.

Both platforms' Local/Server Windows installers and uninstallers now resolve
`runtime/node/node.exe` first, then the legacy `runtime/node.exe`, then
`$env:NODE`, then PATH. The edition regression test locks that precedence.
In the disposable extracted Complete QA tree, with an explicit system
Node 24 override present, both Local and Server live-stack lifecycle
tests subsequently passed all five launches and credential/data preservation
checks using the bundled Node 22.20.0. Task Scheduler was still shimmed.
The first Complete archive remains retained as a failed provenance case;
only a **newly repackaged, unchanged archive** can be accepted for release.

## Clean Complete artifact retest after ABI fix

The second isolated Windows Complete archive was built from the corrected
source-aligned candidate with `--worktree --only windows` and a separate
output directory. Its ZIP SHA-256 is
`1b96e2be190dfd0a2e365b2d4ae8a6624830cc2091e160c35b8c58dcf5d706b6`,
matching `complete-assets.json`. A fresh extraction confirmed bundled
Node 22.20.0, the task ownership script and both edition installers.
Its bundled runtime smoke passed for `better-sqlite3`, `sqlite-vec` and
`onnxruntime`. The external Windows lifecycle harness was run against
**that extracted package** with system `$env:NODE` pointing to Node 24.19.0:
Server and Local both passed five owner launches with credential and protected
data preservation, without changing the real Task Scheduler.

The Complete archive intentionally does not ship development tests. For
additional acceptance, the QA extraction received the candidate's test
folder only; the product `dist/mcp.js` hash was checked unchanged. Bundled
Node 22.20.0 then passed Core E2E, MCP E2E, Discovery E2E and real-stack
smoke. These are isolated runtime/package results, **not** a signed release,
real Task Scheduler migration or production deployment.

A second read-only Linux production audit recorded 429 captures: 90
incomplete, 338 ingested and one legacy complete/un-ingested event without
a frozen intent; five ingested events have unresolved projects, five
unqueued events are waiting legitimately, and zero are currently due for
enqueue. The capture index, job file and project registry metadata were
unchanged across the audit. Bridge backlog was not inspected. The private
report is `.review-runtime/capture-production-readonly-audit-20260926-nodefix.json`.
Linux `npm run stability:check && git diff --check` returned 0 after the
Node selection and task guard changes.

Release limitation: the archive was generated from an uncommitted worktree;
its Git commit field represents the ancestor, not a reviewed release
revision. Before closing the remaining parent TODOs, obtain an authorized
reviewed commit/clean rebuild, real isolated Task Scheduler and v0.2.2
legacy migration/rollback acceptance, and separately authorize any
production deployment. Never replay the legacy capture automatically.

## Exact-source Complete QA and recurring Windows installer gate

An additional QA pass found that an earlier transferred Local installer
omitted the bundled/system Node selection assignment, and both transferred
installers retained an ambiguous `$env:USERNAME:` ACL expression. That ZIP
was retained only as a rejected fixture. The isolated Windows candidate's
Local/Server installer SHA-256 values were reconciled exactly with Linux
canonical: `60ff401c507e3751f38e57e8a1b94210ec50242e110101800254bd0db16ee48f`
and `307f31bcf5ef530ac6fdcab7bd9b8fcaf1dce6cc9a388f08a7f7f0aa7af6d1f2`.
The source regression now requires an explicit Node assignment and braced
ACL username. Windows credential and task-ownership E2E are invoked through
`context:check` on Windows; the credential test skips explicitly on Linux.

A new `--worktree --only windows` Complete ZIP from the exact-source
candidate has SHA-256
`e8baa02aed85943fe3ff365004b4adc24553e94851aced6a19f6c8205065e26a`,
matching its `complete-assets.json`. A fresh unmodified extraction passed
bundled Node 22.20.0 native smoke for better-sqlite3/sqlite-vec/onnxruntime.
Against that extraction, the external Local and Server lifecycle harness
passed five real managed-stack launches per edition, credential/protected-data
preservation, and uninstall without purge. Task Scheduler operations were
shimmed, not performed on the host. Windows full stability and both release
checks, plus Linux full stability and diff check, returned exit code 0.
This QA ZIP is **not** a signed or committed release artifact: its manifest
uses the source worktree's ancestor commit. The legacy v0.2.2 scheduled-task
migration, actual scheduler lifecycle and authorized production deployment
remain open release gates.

## Legacy split-task read-only evidence and source provenance

The old **split-task** installer source was verified at commit
`a00fba9281c83803381993b8b7fe083b0ced9e58` (2026-09-22, v0.2.2 RC).
The currently resolved `v0.2.2` tag points instead to
`8ad133d0abe391600ee57aadfe36e55410338788` (2026-09-25), which already
registers `Memhub-Server-Stack` / `Memhub-Local-Stack` and has a different
installation/stop model. Thus the semver label alone **does not establish**
which lineage is installed. The repository-only, read-only
`tests/windows-legacy-source-lineage-e2e.mjs` asserts both authentic source
families against those Git objects; it passed on Linux canonical.
Windows Group contains the historical split-task commit but not the later
`v0.2.2` tag object. It ran the same test with explicit
`--legacy-only`: historical Local/Server lineage verified, while
`tagged_revision_verified=false` and tag commit `null` are reported rather
than implying that the missing tag was independently checked there. Both
the Linux full check and Windows legacy-only check modify no tasks or files
outside their source workspace.

The split-task Server source uses `memory-server.cmd` / `gateway-server.cmd`, but
Local uses **`memory.cmd` / `gateway.cmd` / `bridge.cmd`**. The shared ownership
guard had incorrectly expected `*-server.cmd` for Local. The exact Local task
mapping is now corrected on Linux canonical and Windows Group; legitimate
legacy tasks reach the explicit migration refusal rather than being
misreported as foreign launchers. Foreign launchers still fail closed.

The new `scripts/windows-legacy-migration-audit.ps1` is **read-only** and
does not install, stop, run or delete tasks or processes. It verifies the
complete expected old registration set, each task's exact Action and current
principal, StateRoot launcher path, essential legacy command fragments and
Core-token correspondence. It reports launcher/config SHA-256 and whether a
database path exists; it does not export the credential. Its report explicitly
sets `detected_task_layout=split-task`,
`installed_source_revision_verified=false`, and
`authorized_to_migrate=false`. A matching layout does not prove the
installed package SHA/revision. The audit does not attribute a live PID to a
specific task, provide a full task XML backup, or grant migration authority. These remain separate
requirements before any controlled stop/rollback.
It also refuses a mixed state with any managed-stack task present alongside
the split-task registrations; Windows Local/Server mock regression for this
condition passed. Such a mixed installation must be investigated rather
than assigned to either lineage automatically.

`tests/windows-legacy-migration-audit-e2e.ps1` passed on Windows for both
Server and Local disposable fixture task sets, mismatched action/credential
and incomplete-set fail-closed cases. The Task Scheduler API was stubbed and
no real task was changed. Windows credential/ownership and edition regression
tests also passed; the helper and new read-only audit/test files matched the
Linux copies byte-for-byte. The test uses split-task-compatible fixtures rather
than a genuine running legacy instance. The code is still uncommitted and no
new signed or production package was produced by this follow-up.

## Legacy Task XML and candidate-process evidence

The read-only legacy audit now uses Task Scheduler's exported XML in memory
to require exactly one LogonTrigger and one Exec action targeting the exact
launcher without extra arguments. It records only the XML SHA-256 (not raw
XML), then re-reads task identity, XML and launcher digests before returning
the report; this narrows but does not eliminate a later race. Full XML
backups must be handled separately under a reviewed rollback procedure.

It additionally reads Win32_Process **without changing any process** and
matches candidates only when both quoted Node executable and entrypoint
match the verified old launcher. It records candidate PID, parent PID, start
time and paths without raw process command lines. Duplicate candidates are
flagged; one matching command line is *not* task ownership, so every report
retains task_to_pid_verified=false and authorized_to_migrate=false.
Windows fixture tests passed for the XML trigger/TOCTOU cases and missing,
unique, duplicate and wrong-executable process candidates. Current Windows
Group has none of the seven expected root Memhub tasks, established via
read-only exact-name queries; no live v0.2.2 migration can be certified
from that host's current Task Scheduler state.

## Managed stack PID / creation-time / principal proof

The Local and Server installers and uninstallers now load
`scripts/windows-stack-owner.ps1` **after** exact scheduled-task ownership
and existing Core credential validation, but **before** any cooperative stop
request. The helper reads the existing lock and one exact `Win32_Process`
PID; it requires the matching Windows principal SID (`GetOwnerSid`), selected
Node executable path, exact `run-stack.mjs --mode ... --home ...` invocation,
and OS process creation time within a 30-second lock-creation window. It
rejects missing/ambiguous PID, invalid lock timestamp, foreign executable,
foreign principal, alternate argv, and stale/reused PID. This time window is
a conservative identity check, not a cryptographic OS birth certificate;
the actual cooperative stop still requires the live owner process to accept
its unique lock token. No path scan, unrelated PID kill or lock removal was
introduced. A failure aborts the installer/uninstaller before stopping a
process or deleting tasks.

`tests/windows-stack-owner-e2e.ps1` passed with mocked read-only CIM data
for accepted and rejected ownership cases. Both editions' real disposable
managed-stack lifecycle tests then passed five launches each through
reinstall/upgrade/rollback simulation and uninstall/reinstall, with the new
guard enabled. Those tests **shim Task Scheduler** and do not exercise a
genuine v0.2.2 Task Scheduler migration. The Windows Group working checkout
also received two previously missing source-alignment fixes: Local's
explicit bundled/system Node assignment and Local/Server's unambiguous
braced ACL username. Existing credential and edition regression tests passed.
The new helper and its test, plus both uninstall scripts, have matching
SHA-256 on Linux canonical and Windows Group. This remains an uncommitted
QA candidate, not a production release or authorization to modify tasks.

The Windows **actual installer** lifecycle harness now also injects two
forged lock states while the disposable stack is running: an old start time
on the correct PID, and a PID belonging to a separate unrelated Node. For
both Server and Local, the installer rejects each case before a Scheduler
request or owner replacement; the live stack and unrelated Node remain
running, and Core config, Gateway environment and protected test marker are
unchanged. After restoring the original lock **bytes**, both editions pass
the normal five-launch lifecycle again. An initial test-fixture failure was
caused by PowerShell's UTF-8 BOM when restoring JSON via `Set-Content`; it
was corrected to byte-exact restoration, not hidden or counted as a pass.
This harness is now also present in Linux canonical under
`tests/windows-installer-lifecycle-e2e.ps1` so Windows release QA can run
the same scenarios from the canonical source. Its Task Scheduler remains a
shim and it never exercises a real v0.2.2 scheduled-task migration.

The thin/Complete release-source checks now explicitly require the Windows
task-ownership, stack-owner, credentials and legacy-audit helpers in addition
to `run-stack.mjs`; the Complete Windows stage checks those helpers and both
editions' installer/uninstaller files before creating its ZIP. This avoids a
false native-binary smoke pass with an indirectly dot-sourced PowerShell
helper omitted. `release:check`, `release:complete:check`, edition regressions
and `git diff --check` passed for the current worktree. This is not a fresh
packaged-artifact lifecycle run or evidence of a clean Git release.

**Historical source-alignment caution (addressed below):** Earlier this
day, the uncommitted Windows Group `run-stack.mjs` recorded additional owner
metadata and self-verification that Linux canonical did not yet contain.
The following reconciliation addresses that source difference. It does not
replace a fresh packaged-artifact lifecycle test or a reviewed Git release;
the PowerShell and direct Node guards remain separate verification layers.

### Direct Node CLI identity reconciliation

The previously divergent `scripts/run-stack.mjs` has now been reconciled
between Linux canonical and Windows Group (normalized source text matches).
The owner lock includes PID, random token, timestamp, executable, entrypoint,
home and mode. Windows direct `status`/`stop` checks the actual process's
user SID, executable path, OS creation time and **fully anchored** Node
invocation with exact entrypoint/home/mode and optional distinct TCP port
flags. In particular, a nested StateRoot whose string begins with the other
instance's home must not pass merely on substring containment. The
cross-release case may verify an already-running previous `scripts/run-stack.mjs`
without executing that old path, and only issues a cooperative token-matched
stop request; it does not kill a PID. Missing identity fails closed.

The Windows real-stack negative fixture now runs two independent live
instances with nested StateRoots and intentionally forges the first lock
with the second PID/start metadata. Both `status` and `stop` refuse that
false ownership, both processes remain live and original lock bytes are
restored before the ordinary graceful-stop and restart checks. This fixture
is copied to Linux canonical as `tests/stack-runtime-smoke-windows.mjs` and
is wired into the Windows-only credential/owner regression runner. Linux
Core/Bridge full-stack smoke, Windows real-stack smoke, Windows credentials/
ownership/legacy audit and edition-regressions passed. Linux stability and
release **checks** passed. The Linux direct-CLI non-Windows process branch
does not claim Windows CIM/SID verification; Linux production continues
using systemd as sole supervisor.

These are source/worktree QA results, not a clean provenance-tagged Complete
artifact acceptance, nor a genuine v0.2.2 scheduled-task upgrade/rollback.

### Fresh 0.2.5 Complete worktree artifact, 2026-09-26 22:39 +08

Linux canonical generated a fresh worktree Complete pair after the owner,
legacy-audit and package dependency guards above:

- `memhub-v0.2.5-linux-x64-complete.tar.gz`:
  `03865ca6841e4d1238c443eb09e419dfec1679b20066b5a1502ee8e3968258c3`
- `memhub-v0.2.5-windows-x64-complete.zip`:
  `3be4dce7dc6c57fd0baba97159ca5c82d0ddd300037ce32b915be32dc5b8fa57`

The bundled Linux Node 22.20.0 native smoke passed for better-sqlite3,
sqlite-vec and ONNX Runtime. The Windows ZIP was unpacked read-only on Linux;
its installer/uninstaller and run-stack/task-owner/stack-owner/credentials/
legacy-audit/legacy-plan helpers matched the exact canonical worktree bytes.
The connected Windows QA host was not reachable from Linux over the tested
private addresses, so this exact ZIP was **not** executed on Windows in this
turn. The Windows checkout itself reports package version 0.2.2 and is not a
valid substitute for execution of the canonical 0.2.5 archive. This remains
worktree QA provenance, not a clean committed release.

The exact Linux Complete archive was then unpacked into a disposable QA
directory. Only the existing stack-smoke test files were copied into that
temporary extraction; using the archive's **bundled Node** and its packaged
code, the real Core/Gateway/Bridge stack smoke passed on disposable state and
random ports, including supervised restart and Capture/recovery assertions.
The extraction was deleted afterward. No Linux installer/systemd unit or
production StateRoot was invoked by this artifact-level runtime test.

### Cross-release installer guard alignment

After the CLI alignment above, the PowerShell installer/uninstaller guard
still compared the current package's Node and `run-stack.mjs` paths against
the live process. A legitimate managed owner launched from a **previous
release directory** therefore failed before the new CLI had an opportunity
to authenticate and request its cooperative shutdown. The guard now permits
that exact previous managed owner only when its lock supplies the **complete**
`entrypoint`, `exec_path`, `home` and `mode` identity. It requires the
same StateRoot and edition, a declared `scripts/run-stack.mjs`, and matching
actual OS PID, principal SID, process creation time, Node binary and fully
anchored launch arguments. It never executes the previous entrypoint, scans
other Node processes or bypasses the token-matched CLI stop.

A same-release, old-format lock with only PID/token/start remains eligible
for exact **same-package** verification, preserving the existing tagged
managed-stack reinstall path. Such an incomplete lock does **not** authorize
cross-release stop: the actual prior executable/entrypoint cannot match the
new package's selected invocation and the operation fails closed. This is
especially relevant because the current `v0.2.2` tag's managed owner did
not record the full later identity schema. A separate, explicitly reviewed
upgrade procedure and real isolated lifecycle are still required for that
older owner and for split-task installations.

`tests/windows-stack-owner-e2e.ps1` now covers old-release positive
verification, no-metadata refusal, foreign StateRoot/edition, untrusted
entrypoint directory, wrong executable and partial metadata. The Windows
credential/ownership runner includes it; Task Scheduler remains shimmed.

The same Windows runner now exercises a verified owner that deliberately
ignores its cooperative stop request. The CLI fails after its bounded
20-second deadline (about 21 seconds including process overhead), leaves the
verified owner running, preserves the owner lock and never escalates to
Stop-Process/taskkill/name scanning. This closes the timeout/no-force-kill
branch of process-ownership QA, not legacy task migration.

### Stale-lock and read-only rollback-plan QA

The direct Node `serve` path previously auto-unlinked a valid lock when
its PID appeared dead, although installer preflight refused every remaining
lock. `acquireLock` now makes one exclusive creation attempt and never
deletes an EEXIST lock: apparent PID liveness is not ownership proof.
Linux and Windows real isolated smoke tests verify that direct serve
rejects an apparently stale owner and leaves the lock unchanged.
Any lock recovery remains a separate, explicitly reviewed action.

`scripts/windows-legacy-migration-plan.ps1` is a strictly read-only
decision artifact layered on the split-task audit. It requires valid
source-layout, task/XML/launcher/config evidence; checks the exact task
set without missing or duplicate registrations; and emits deterministic
SHA-256 evidence without revealing credentials. It permanently reports
`ready_to_apply=false`, `authorized_to_migrate=false` and blockers for
actual source provenance, task XML backups, exact Task-to-PID proof,
separate authorization and real isolated rollback. Its phases are
instructions, not executable task/process/data operations. Windows mocked
Local/Server regressions cover deterministic plan generation and refusal
of invented provenance. Thin/Complete packagers require the new helper.
This does not prove an actual Task Scheduler upgrade or authorize one.

### Historical split-task executable rehearsal (Scheduler shim only)

Windows Group exported the actual historical `a00fba92` source with
`git archive` into a dedicated QA folder; ZIP SHA-256:
`003ef122165d50ebabf36c011c870720f472b9deb9cecf78cc53585a9db64cbb`.
Its `npm ci` and TypeScript build passed. The pristine exported source is
retained, and both original Local/Server installer backups were independently
checked against their historical Git blob hashes.

The **unmodified** split-task installer could not complete on this Windows
PowerShell/Node 24 combination: its legacy `node -e` token-generation
argument loses the expected quotes and Node raises a syntax error. This is
a historical compatibility blocker, not a passed original-install test.
For the separate downstream safety rehearsal,
`tests/windows-historical-split-upgrade-failclosed-e2e.ps1` uses the extracted
QA copy only, optionally replacing **that one token-generation line**
with PowerShell's cryptographic RNG (`-CompatTokenQuote`). The original
archive/installer backup is never rewritten by that compatibility shim.
The original installer also creates a fresh Memory token and overwrites the
Core config; it must **not** be invoked as a rollback shortcut against a
protected existing StateRoot. Rollback requires the exact saved XML,
launchers, configuration and compatible old package, not a new installation.

With that explicit test-only adaptation, both real old process groups
(Server: Core/Gateway; Local: Core/Gateway/Bridge) started through the
historical installer with a **shimmed** `schtasks.exe`. The current candidate
installer then refused both unauthorized split-task families before
mutating task registrations, managed environment, Core config or protected
marker. The original Gateway remained healthy and old database existed.
Disposal targeted only tracked QA process trees; loopback ports 18960,
3001 and 17861 were confirmed free afterward. This establishes a
cross-source **fail-closed upgrade attempt**, not a successful migration,
rollback, artifact provenance, or any real Task Scheduler lifecycle.

### Cross-version operator gate (not executed)

The safe order for an explicitly authorized, disposable v0.2.2 migration is:

1. Identify the exact edition, user SID, StateRoot, old package revision and
   version-aligned target artifact. Collect a clean read-only audit. Preserve
   the **actual** old task XML (not only its hash), launcher bytes, config,
   environment, account/device registry, bridge config and service settings
   in a restricted, independently verified rollback location. Do not publish
   token-bearing XML/launcher content in the diagnostic report.
2. Correlate each runtime PID, start time, executable, entrypoint and parent
   chain with the exact scheduled task instance. Mere command-line similarity
   does not authorize a stop. If correlation or original XML is unavailable,
   halt for manual review. Obtain a fresh exact 123456 authorization before
   any real Scheduler or instance change.
3. End only the verified old tasks in a controlled order; confirm that each
   old Core/Gateway(/Bridge) writer has exited and all required ports are
   free. Do not use name/path scans, clear another owner's lock or force-kill
   leftover processes. If any writer survives or a foreign listener remains,
   abort the upgrade and restore the old task registrations where safe.
4. After confirmed quiescence, take a consistent protected SQLite/state
   snapshot including relevant sidecars; verify backups and preserve the
   original Core token and account/device identities. Then install the exact
   reviewed target artifact against the original StateRoot, run health and
   idempotent Capture/Core/MCP/Bridge checks, and verify protected content.
5. On a failure, stop only the verified new managed stack, restore the exact
   saved prior configuration/data and XML/launchers with their original
   principal, verify the original service health and record both artifact
   hashes. Never silently replay ambiguous legacy captures or rotate tokens.

The current QA covers mocked Task Scheduler and actual disposable managed
processes, **not** the stop/import/re-registration sequence above. There is
no eligible live v0.2.2 scheduled-task sample on the currently inspected
Group host. Pending TODO 14dc... and its parent therefore remain open.
