# Transport and identity

Memhub has one product identity boundary and two transport entries.

```text
Local MCP: 127.0.0.1:3001/mcp
Remote MCP: Cloudflare Access/Tunnel -> the same 127.0.0.1:3001/mcp
```

A stable Memhub `account_id` is authoritative. `platform`, `transport`, authenticated principal and connection identifiers are provenance fields only.

Loopback MCP is accepted only from a loopback peer with a loopback host header and without Cloudflare forwarding headers. When a public host is configured, all non-loopback public-host MCP requests require valid Cloudflare authentication before they resolve to an account.

Project and Branch routing never derive from connection or conversation identity. Callers provide current `project` / `workspace_project` evidence and an explicit Branch when needed.

L1 provenance records an `actor_id` for the submitting Harness. Historical L1 files that contain `device_id` are normalized on read, but current identity authority remains the authenticated Memhub account, not a device registry.
