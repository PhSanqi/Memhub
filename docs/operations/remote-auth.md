# Remote authentication

Memhub exposes one MCP runtime. Remote access authenticates at the Cloudflare boundary before the request reaches that same loopback runtime.

```text
Remote MCP client
  -> Cloudflare Access / Tunnel
  -> https://memhub.example.com/mcp
  -> 127.0.0.1:3001/mcp
  -> Memhub account/project memory
```

Human identity resolves to a stable Memhub `account_id`. The Cloudflare subject is preferred as the stable external principal; verified email may bootstrap or locate an existing account according to local account policy. A client cannot authorize itself by sending an account id.

The local path is independent of Cloudflare:

```text
Local MCP client -> http://127.0.0.1:3001/mcp
```

A loopback request is accepted as local only when the socket peer and Host are loopback and no Cloudflare forwarding headers are present. When `MEMHUB_PUBLIC_HOST` is configured, non-loopback/public-host MCP requests still require Cloudflare authentication.

Transport, host application and connection ids are provenance only. They do not create separate memory users and do not select Project or Branch scope.
