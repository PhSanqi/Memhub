# Remote authentication modes

## Human identity and Control Plane

Server Edition deliberately uses Cloudflare Access as the single human identity provider. Memhub validates the signed Access JWT (issuer, audience, signature, `sub`, and verified `email`) and maps it to a stable internal `account_id`. `sub` is preferred for an existing binding; verified email is the continuity fallback because Cloudflare may issue a new `sub` if a user is removed and re-added to the Zero Trust organization.

The browser Control Plane is available at `/memhub`; administrators also get `/memhub/admin`. Roles are stored on the stable Memhub account, not trusted from browser headers. `/cdn-cgi/access/logout` is used for the UI logout action so the Cloudflare Access application session is cleared rather than merely hiding the Memhub page.

Machine credentials remain separate from human login: a device token selects an already-bound Memhub `account_id`; it does not create or merge a human account.

Memhub has two remote-client classes. They intentionally use different authentication flows.

## 1. Local Bridge / installed plugin

The local Bridge is a machine client. It owns a Memhub device credential and may also carry a Cloudflare Access service token.

```text
AI harness -> localhost Memhub Bridge
             |- X-Memhub-Device-Token (to Memhub)
             `- CF-Access-Client-Id / CF-Access-Client-Secret (to Cloudflare Access)
                    |
                    v
             Cloudflare Tunnel / Access
                    |
                    v
             Memhub Server
```

This flow is ready for Server Edition testing. Cloudflare documents the two service-token headers for non-interactive Access clients.

The Memhub origin still validates its own per-device credential after the request passes Cloudflare. Cloudflare credentials identify/authorize the machine at the edge; Memhub device credentials select the local Memhub account/device and are independently revocable.

## 2. Hosted/browser AI connecting directly to remote MCP

Remote MCP clients are expected to use the MCP authorization profile, which is based on OAuth 2.1. A hosted client cannot be assumed to know how to obtain or attach Cloudflare's internal `CF-Access-Jwt-Assertion` header.

Therefore the current origin-side Cloudflare JWT verification is **not** the final client-facing authorization design for hosted ChatGPT/Claude/other web MCP clients.

Target flow:

```text
hosted MCP client
      |
      | MCP OAuth 2.1
      v
Memhub authorization layer
      |
      | upstream login / identity
      v
Cloudflare Access (or another IdP)
      |
      v
Memhub account_id
```

Cloudflare Access can act as the upstream OAuth identity provider, but Memhub still needs the standards-compliant MCP authorization endpoints/metadata expected by remote MCP clients.

## Rollout rule

It is safe to expose `/memhub/*` through a Cloudflare Tunnel once Cloudflare Access policies are in place, but test in this order:

1. `/memhub/capture` through Memhub Bridge + Access service token + Memhub device token;
2. `/memhub/mcp` through Memhub Bridge's local MCP proxy using the same machine credentials;
3. only after Memhub MCP OAuth is implemented, connect hosted/browser MCP clients directly to the public `/memhub/mcp` URL.

Do not weaken the public MCP endpoint to anonymous access just to make a hosted client connect before OAuth is implemented.
