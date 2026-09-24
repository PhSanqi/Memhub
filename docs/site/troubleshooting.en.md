# Troubleshooting & recovery

Diagnose from the most deterministic layer outward: process/port → HTTP ingress → identity → account scope → project scope → L1 → Processing → L2/L3/L4 → UI. “Memory is broken” is a symptom, not a root cause.

## Service or port missing

On Linux inspect the units appropriate to the Edition and then the listening ports. If Memory Core is down, fix it before Gateway/Bridge. Use journal output to find path, permission, Node, state-root, or port conflicts.

## Local MCP cannot connect

Local plugins normally use `http://127.0.0.1:17861/mcp`. If 17861 is down but 3001 is healthy, investigate Bridge. If 3001 is down, move upstream to Gateway/Core. Do not “fix” this by exposing Memory Core directly.

## Public Server returns 401

Determine whether the 401 is expected. Anonymous User/Admin should be rejected on a protected deployment. Test the 3001 origin locally; if origin works and public auth fails, inspect Cloudflare policy/JWT/Host mapping instead of changing Memory Core.

## 404 or wrong path

Internal deployments may use `/memhub/*` while a root-base deployment rewrites to `/`, `/user`, `/admin`, `/docs`. Server origin MCP is `/memhub/mcp`. Do not assume browser and MCP routes are interchangeable.

## Wrong account

Check authenticated identity and stable account mapping. Do not use a front-end query parameter to bypass account scope. Accidental duplicate accounts require identity-link analysis, not direct database row merging.

## Wrong project

Check Project Scope, current workspace/project evidence, registry slug/aliases/description, and stale conversation binding. Explicit current evidence must beat the old binding. Fix routing before repairing contaminated content.

## All Projects shows one project

Confirm project selector is truly empty and the API request has no project filter. Check the Project Registry for multiple active projects. The expected All Projects UI is a portfolio, not one expanded project.

## L1 is missing

Inspect harness capture, Bridge/capture endpoint, Device Token, and ingestion. Per-turn capture is the authoritative source; the index is rebuildable metadata.

## L1 exists but L2/L3 does not update

Inspect Processing. Pending/leased can be normal; failed requires action. Check policy thresholds, target, project, evidence refs, and the actual error before editing durable artifacts.

## L3/L4 looks wrong

Trace provenance. L3 should be supported by project chronology; L4 should be supported across projects. Legacy imported data must not silently become current user-profile truth.

## Long-lived leased jobs

Determine whether the worker still exists and whether the lease/retry mechanism can recover. Do not run multiple unisolated workers or manually mark jobs completed without verifying durable output.

## Merge/Delete surprise

Merge changes canonical routing and turns the source into a historical alias; delete is logical and removes active routing. Neither physically rewrites all durable history. Always confirm account scope and project IDs.

## Upgrade/schema problem

Use `core:preflight` before schema-changing work and `core:verify` / `core:preserved` afterward. If database integrity is compromised, stop new writes and restore from a verified rollback snapshot. Rebuild indexes instead of rolling back durable state when only indexes are damaged.

## Browser/UI regression

Separate API correctness from presentation. Responsive acceptance must use real CSS viewports, not merely a 390-pixel screenshot file produced by a wider layout. Drawer focus, Escape, focus restore, loading/error/busy states, and URL restore should be exercised in the browser gate.

## Record the incident

Capture Edition/OS/version, exact symptom, first reproducible command, last known-good layer, account/project, job/event IDs, network/proxy involvement, changes attempted, and rollback point. A precise incident record dramatically reduces repeated guesswork.

## Recovery drill

Practice recovery in an isolated state root before an actual incident. Validate fingerprint, project count, one chronology artifact, one TODO, and account/project routing after restore. Also practice a logical routing incident; not every failure requires database rollback.

## Stop automatic work when necessary

If database integrity fails, backup status is unknown, project contamination is broad, or credentials may be exposed, stop new writes/jobs and preserve evidence. Continuing automated distillation can make the recovery surface larger.

## Verification after a fix

Repeat the original failing scenario, verify the adjacent layer, and verify the user goal. A page becoming 200 is not enough if account/project routing is still wrong. Record the running PID/build after deployment so disk changes are not confused with the live process.

## FAQ

### Should I reinstall first?
Usually no. Reinstalling can hide the root cause or overwrite evidence. Diagnose the failing layer first.

### Can I delete failed jobs?
Inspect the failure and evidence refs first. Deleting diagnostic history without fixing the cause may only produce new failures.
