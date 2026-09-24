# Privacy & data boundaries

Memhub stores sensitive material: raw turns, project chronology, durable project rules, cross-project profile, architecture, embeddings, and identifiers. Privacy must be understood as separate storage, network, model, identity, project, and device boundaries.

## Default: Memory Core is local-only

Vendored Memory Core applies a default-deny network policy for model/embedding HTTP, remote storage construction, and raw Memory REST clients. Loopback is allowed. Non-loopback access requires an explicit code-level remote decision and is not a normal end-user toggle.

Summaries and embeddings are still sensitive derived data. Do not treat them as automatically safe because they are less readable than raw text.

## Local Edition

Memory Core, Gateway, and Bridge remain on one machine and loopback. Plugins use Bridge. Local storage does not mean a cloud-model harness can never receive context; model processing is a separate boundary controlled by the harness/model configuration.

## Server Edition

The intended topology is Internet client → authenticated HTTPS/MCP → Cloudflare Access/Tunnel → Memhub Gateway → loopback Memory Core. Gateway is the intended public ingress. Memory Core should not be published directly.

Cloudflare provides authentication/transport, not long-term-memory storage or model inference.

## Human and machine identity

Human Access JWT identity maps to a stable Memhub account. Internal roles live in Memhub. Machine Bridge clients may use both an edge Service Token and a separate revocable Memhub Device Token. These credentials should never enter prompts, TODOs, or project memory.

## Project isolation

One account may contain many projects. Project A business facts must not automatically enter project B. Current explicit project evidence overrides stale bindings; ambiguous evidence can remain global-only.

L4 requires repeated evidence across project L3 artifacts. Skill is a separate capability channel and must not smuggle project facts across boundaries.

## Model-processing boundary

The connected AI harness performs semantic synthesis. Memhub owns evidence bounds, target scope/layer validation, provenance, canonical artifact identity, job lease/retry, and durable commit. Whether context reaches a remote model depends on the harness/model configuration you choose.

## Capture and indexes

Per-turn capture JSON is authoritative L1 evidence. `capture-index.sqlite` is rebuildable metadata used for filtering/counts/scheduling. Backups must not rely on the index alone.

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
