# Memhub Long-Term Content Audit

A bounded, read-first audit of Memhub's durable memory, project routing, evidence boundaries, architecture, and reusable Skill execution.

## When to use

Use when Memhub appears to have missing or misrouted memories, projects, Skill candidates, conversation bindings, architecture, or distillation output; or when a read-only assessment of long-term content integrity is requested.

## Boundaries

Read first. Never delete, rewrite, re-scope, merge, restart, or retry a migration solely because an audit finds a discrepancy. Distinguish observed state from inferred explanations. Require separate authorization for mutations. Preserve L1 provenance and prior/superseded versions. Do not treat host prompts, tool instructions, provisional drafts, incomplete turns, or third-party claims as durable user facts.

## Procedure

1. Resolve the authenticated account and the canonical project via Project Registry. Prefer current explicit project/workspace evidence to stale conversation binding; ambiguous project resolution stays global-only. Do not silently create another project or infer account identity from an unverified email or client-supplied ID.
2. Read the project's current `docs/ARCHITECTURE.md` or the read-only Architecture Reader output together with the Project Registry description, aliases, and active status. The Normify runtime is retired. Legacy `normify-*` trees are optional compatibility sources **only**; their absence is not a failed health check and they must not override current project docs or Registry.
3. Inventory L1 source turns, capture status, provenance, and rebuildable capture index/dirty ledger. An `open`, `partial`, or `failed` turn is not complete distillation evidence. Distinguish missing evidence from a missing index and verify account/project/continuity filters before suggesting a repair.
4. Inspect the evidence-bounded distillation queue: pending, leased, completed, failed, and skipped jobs. Do not retry legacy failed jobs without rebuilding valid project-scoped evidence. Compare L2 chronological Current Truth, L3 project rules, and account L4 cross-project profile against actual completed evidence, preserving superseded history and canonical artifact identity.
5. Read-only-check Memory Core's database integrity and storage/retrieval consistency. If a direct SQLite check is authorized, open the DB read-only, inspect quick_check and active-memory/vector references, and never mutate it from the audit path. A passing DB check does not prove semantic correctness or live MCP reachability.
6. Verify account → canonical project scope on ordinary recall. Reusable Skill candidates belong to a separate capability channel; they must not leak another project's business Current Truth. Inspect candidate metadata, `memhub_skill action=load`, actual Harness invocation, `record` telemetry, and reliability separately. A stored Skill or passing unit test alone does not establish real-host invocation.
7. Inspect conversation-project/Branch binding and explicit scope switches; Branch narrows retrieval within one project, never creates another L1/L2/L3/L4 hierarchy. Compare recent L1 to the right continuity ID rather than blending unrelated workstreams.
8. Inspect incomplete captures, stale artifacts, mixed project aliases, stale Skill versions, and release/deployment differences. A versioned Skill revision keeps stable source identity, archives the superseded memory ID, and retains historical telemetry. A stale current Skill requires a reviewed `memhub_skill action=plan` followed by explicit approval before `action=execute`; do not create a duplicate under a new source identity.
9. Report observations as **healthy / degraded / contaminated / missing-or-migration-needed / unknown**, with affected account/project, exact evidence IDs, timestamps and verification limits. Separate repository code, built artifact, active service, and authenticated production MCP results. Suggest bounded, reversible remediation without performing it automatically.

## Verification

Check Project Registry and current docs first; verify capture/source integrity, queued job states, SQLite read-only quick_check, valid scoped retrieval, and canonical L2/L3/L4 uniqueness independently. For a Skill, verify candidate → load → actual invocation → success/failure/user correction, and compare telemetry by version. Never classify legacy `normify-*` path absence as an architecture failure.
