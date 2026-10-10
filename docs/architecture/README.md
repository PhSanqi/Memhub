# Architecture documents

- [Overview](overview.md)
- [Transport and identity](transport-and-identity.md)
- [Control Plane and distillation](control-plane-and-distillation.md)
- [Boundaries](boundaries.md)
- [Privacy boundary](privacy-boundary.md)

The canonical topology is one Core + one MCP runtime. Local clients connect directly to loopback; remote clients reach that same runtime through Cloudflare. The durable memory axis is L1 -> L2 -> L3 -> L4; Skill is orthogonal; Todo is Project Registry state; Branch is explicit project-local workstream scope.
