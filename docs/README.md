# Memhub documentation

This directory is the documentation source of truth for the current Memhub runtime.

Start with the task you are trying to complete. Superseded repair plans and migration-era design records are intentionally removed from the current documentation tree and remain available through Git history, so old guidance cannot be mistaken for Current Truth.

## Use Memhub

| Goal | Document |
| --- | --- |
| Install and start quickly | [Getting Started](site/getting-started.en.md) / [快速开始](site/getting-started.zh.md) |
| Install Local or Server on Linux/Windows | [Install](site/install.en.md) / [安装](site/install.zh.md) |
| Continue projects, use Todos, inspect evidence | [Workflows](site/workflows.en.md) / [工作流](site/workflows.zh.md) |
| Understand privacy and data movement | [Privacy](site/privacy.en.md) / [隐私](site/privacy.zh.md) |
| Diagnose and recover | [Troubleshooting](site/troubleshooting.en.md) / [故障排查](site/troubleshooting.zh.md) |

Edition-specific packaging notes live under [../editions/](../editions/).

## Understand the architecture

- [Architecture overview](architecture/overview.md) — L1/L2/L3/L4, Project Registry, Branch, Retrieval, Skill, Result Transport and Memory Core.
- [Control Plane and distillation](architecture/control-plane-and-distillation.md) — capture, evidence jobs, canonical artifacts and MCP ownership.
- [System boundaries](architecture/boundaries.md) — what Memhub owns versus what the connected model/Harness owns.
- [Identity and devices](architecture/identity-and-devices.md) — stable account identity, device binding and provenance.
- [Privacy boundary](architecture/privacy-boundary.md) — data-flow and isolation rules.
- [Adapter portability](architecture/adapter-portability.md) — host/plugin integration boundary.

## Operate a deployment

- [Editions and release packages](operations/editions.md)
- [Remote authentication](operations/remote-auth.md)
- [Cloudflare Tunnel](operations/cloudflare-tunnel.md)
- [Memory Core migration](operations/migration.md)

The canonical hosted project deployment is **https://memhub.sanqi.org/**. Self-hosted documentation uses `memory.example.com` as a placeholder.

## Maintain the project

- [Upstream attribution](maintainers/upstream.md)
- [Long-term content audit Skill](skills/memhub-long-term-content-audit-v2.md)
- [Internal UI/review contracts](internal/)

Current Truth belongs in the Project Registry, current architecture, and the active documents linked above. Historical implementation records belong to Git history rather than the active documentation navigation.
