# Memhub stability and automation audit — 2026-09-25

Scope: canonical Memhub v0.2.5 code, capture → Memory Core → discovery → distillation jobs, MCP/HTTP boundary, cross-process state locks, and the two ChatGPT scheduled workflows. This is an evidence-bounded review, not a claim that ChatGPT host safety controls can be modified from the repository.

## Confirmed and addressed in this change

| Area | Failure mode | Mitigation / verification |
| --- | --- | --- |
| Config concurrency | `setDistillationConfig` previously read and wrote without the state lock. Two admin updates could lose a field or the ingestion cutover. | Serialize the entire read/modify/write with `withFileMutationLock`; regression exercises concurrent patches and disable/re-enable cutover. |
| Config validation | Non-finite numeric inputs could produce `NaN` settings and an invalid persisted policy. | Normalize non-finite values to documented defaults; regression. |
| Discovery report | `pending_jobs` / `leased_jobs` / `failed_jobs` were captured before enqueueing, misleading an automation into reporting an empty queue after creating work. | Re-read durable job state after reconciliation; regression. |
| Cross-host lock safety | A foreign-host lock older than five minutes was eligible for automatic deletion even though its owner could still be alive. Malformed owner metadata was also age-reclaimed. | Fail closed for foreign/malformed owner. Only a verifiably dead local PID is automatically recoverable; regression. |
| Stale lock recovery race | Two contenders could both decide a local owner was dead and the slower contender could unlink the faster contender's new lock. | Separate exclusive recovery guard and recheck owner under the guard; two-process mutual-exclusion regression. |
| Automation single point of failure | OursMemory's earlier scheduled instructions made Memhub context retrieval a prerequisite for Server progress checks. | Scheduled task now checks Server canonical checkpoint and live writer first, with Memhub used only for final status synchronization. |
| Stability blind spot | The stability script looked for Core under the Memhub state root, silently skipped the actual production Core, and concealed a stale vendor manifest after intentional Core source changes. | Detect the same Core DB locations as the migration checker, rebaseline the committed vendor tree, and run a manifest fingerprint regression on every test. A real Core check must execute rather than be reported as skipped. |
| Generic error interpretation | Host safety block, tool result loss, Core 401, Core idempotency 409, and normal empty queue were conflated. | Separate stage-specific operator runbook and explicit status reporting in both scheduled tasks. |

## Boundaries and remaining architecture risks

- `src/mcp.ts` is a large mixed transport/UI/tool module. The extraction of discovery into `src/distillation-discovery.ts` is a useful seam, but a further split of embedded UI and HTTP administration should be a separate, behavior-preserving change with browser and auth regression gates. A large file alone does not establish an exploitable vulnerability.
- Capture storage and Memory Core are distinct durable stores. A crash between Core completion and the `.ingested` marker is not an atomic transaction; recovery must verify Core state and original idempotency keys before replay. A complete-but-uningested item must not be silently declared processed.
- Existing failed legacy migration jobs are historical evidence and must not be bulk-retried as if they met the current contract.
- An empty job queue does not imply ChatGPT conversations were captured. The server cannot read uncaptured host history or invoke a subscription-model Harness. The connected host may cache an older MCP action schema even when the deployed server implements `discover`; the existing `next` compatibility path remains necessary.
- A host-side pre-execution safety block has no guaranteed Gateway request ID and cannot be repaired by changing Memory Core credentials, deleting a lock, or adding a user-provided approval string.
- Lock recovery is deliberately fail-closed for unverifiable ownership. A stranded foreign/malformed lock requires a separate operator investigation rather than unsafe automatic reclamation.

## Acceptance gates

Run `npm test`, including discovery, concurrent config, cross-process lock recovery, MCP, context routing, Bridge/process stack, packaging and runtime checks. Before deployment, compare the canonical worktree against concurrent edits and avoid overwriting unrelated changes. After deployment, verify actual service health and authenticated MCP separately; report the Git commit, build, service, and host connector schema as distinct states.
