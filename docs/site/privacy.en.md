# Privacy & data boundaries

**Public presentation and private workspace are separate boundaries.** The product site and GitHub Pages contain only static documentation, product assets, and clearly labelled fictional examples—not real memories, account or device IDs, tokens, or production screenshots. Each self-hosted Local/Server installation stores its own users’ data. /user and /admin require authentication on that installation; GitHub Pages runs no Memory Core, MCP, or account API.

Memhub stores sensitive material: raw turns, project chronology, durable project rules, cross-project profile, architecture, embeddings, and identifiers. Privacy must be understood as separate storage, network, model, identity, project, and device boundaries.

## Default: Memory Core is local-only

Vendored Memory Core applies a default-deny network policy for model/embedding HTTP, remote storage construction, and raw Memory REST clients. Loopback is allowed. Non-loopback access requires an explicit code-level remote decision and is not a normal end-user toggle.

Summaries and embeddings are still sensitive derived data. Do not treat them as automatically safe because they are less readable than raw text.

## Local Edition

Memory Core and the Memhub MCP runtime remain on one machine and loopback. MCP clients connect directly to `127.0.0.1:3001/mcp`; clients use the MCP endpoint directly. Local storage does not mean a cloud-model harness can never receive context; model processing is a separate boundary controlled by the harness/model configuration.

## Server Edition

The intended topology is Internet client → authenticated HTTPS/MCP → Cloudflare Access/Tunnel → the same loopback Memhub MCP runtime → Memory Core. The public `/mcp` route and local `/mcp` route enter the same runtime. Memory Core should not be published directly.

Cloudflare provides authentication/transport, not long-term-memory storage or model inference.

## Human and machine identity

Authenticated remote identity maps to a stable Memhub account. Internal roles live in Memhub. OAuth/Access credentials belong to the transport/control plane and should never enter prompts, TODOs, or project memory.

## Project isolation

One account may contain many projects. Project A business facts must not automatically enter project B. Current explicit workspace/project evidence selects the business project; host conversation identity does not. Ambiguous evidence can remain global-only.

L4 requires repeated evidence across project L3 artifacts. Skill is a separate capability channel and must not smuggle project facts across boundaries.

## Model-processing boundary

The connected AI harness performs semantic synthesis. Memhub owns evidence bounds, target scope/layer validation, provenance, canonical artifact identity, job lease/retry, and durable commit. Whether context reaches a remote model depends on the harness/model configuration you choose.

## Capture and indexes

Per-turn capture JSON is authoritative L1 evidence. `capture-index.sqlite` is rebuildable metadata used for filtering/counts/scheduling. Backups must not rely on the index alone.

When a section must not enter long-term memory, mark it at the capture edge with `<private>…</private>` or `<no-memory>…</no-memory>`. Memhub removes the marked span before the durable capture is written and retains only count-style provenance that an exclusion occurred; the excluded body is not retained. If the entire turn is excluded, the event is treated as handled but is not ingested into Memory Core. An unclosed marker fails closed: everything from the marker to the end of the text is excluded. This is a “do not remember this span” mechanism, not a replacement for account ACLs, project isolation, or model-provider privacy controls.

Capture adapters also follow a graceful-degradation boundary. If the durable capture is already stored but Memory Core temporarily returns a timeout, 429, or 5xx, HTTP Capture can return `202 accepted` with a recoverable pending state instead of blocking the upstream agent. 409 conflicts, scope errors, and schema errors still fail closed; availability must not hide consistency failures.

## Browser control plane

User/Admin pages belong behind the deployment's authentication boundary. Admin actions such as roles, project merge/delete, and distillation policy require internal Admin authorization and should expose the active account/project scope.

## Backup and migration

Backups contain sensitive memory. Store them according to the same risk model as the live system. Use migration preflight and durable fingerprints. Recovery must verify account/project scope as well as database integrity.

## Threat model

Identify at least local OS users, server administrators, authenticated IdP users, connected devices, reverse-proxy operators, and model providers. For each, document what they can see, what they can change, how credentials are revoked, and what logs are retained.

## Minimum-privilege checks

Normal users need their memory/projects/TODOs/status, not account-role or policy controls. Device credentials identify a machine entry point, not an Admin browser session. Rotate edge, device, and local-admin credentials independently so failures have bounded impact.

## Data minimization

Long-term storage minimization and per-request recall minimization are different. Even when L1 is retained for audit, normal recall should prefer L4 + current L3/L2 + Skill rather than sending the whole raw corpus to a model.

## Privacy verification checklist

Check that Memory Core remains loopback, public Gateway remains authenticated, anonymous Admin is rejected, device revocation affects only that device, project isolation still holds, remote-model usage is intentional, backups are protected, and logs do not contain tokens or raw prompts unexpectedly.

## FAQ

### Does Cloudflare store Memory Core?
No. In the target architecture Cloudflare is an identity/transport layer. Your Cloudflare configuration still has its own logging/metadata implications.

### Does Local guarantee no data leaves the computer?
Not if the connected harness uses a cloud model. Storage and model-processing boundaries are separate.

### Does logical project delete erase all history?
No. It changes active routing while durable provenance remains. A true purge requires a separate deletion design.
