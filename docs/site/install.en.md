# Installation & deployment

This page covers Local / Server × Linux / Windows and treats installation as more than an installer exit code. A deployment is complete only when runtime processes, loopback boundaries, identity, public ingress, project scope, and recovery evidence have all been checked.

## Understand the boundaries first

Memory Core is the private data plane and should remain loopback-only. Gateway is the identity/project/context boundary. Bridge is the machine/plugin entry point used by Local Edition. Do not expose Memory Core on the Internet to make an MCP client easier to configure.

State under `MEMHUB_HOME` or the default state root is durable material. It is not just cache. Backups must consider raw capture, Memory Core durable state, project registry, account/device state, and bindings.

## Local Linux

```bash
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
bash editions/local/linux/install.sh
```

The installer creates systemd user units for Memory Core, local Gateway, and Bridge. Verify:

```bash
systemctl --user status memhub-core.service
systemctl --user status memhub-local.service
systemctl --user status memhub-bridge.service
ss -ltn | grep -E '17861|3001|18960'
```

Plugins use `http://127.0.0.1:17861/mcp`.

## Local Windows

```powershell
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
powershell -ExecutionPolicy Bypass -File .\editions\local\windows\install.ps1
```

The product boundaries and ports are the same as Linux. Do not change the user's global proxy configuration just to make Local work; diagnose loopback and host behavior explicitly.

## Server Linux

```bash
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
MEMHUB_PUBLIC_HOST=memory.example.com bash editions/server/linux/install.sh
```

Verify `memhub-core.service` and `memhub-server.service`. The origin MCP is `http://127.0.0.1:3001/memhub/mcp`. Validate origin before adding Tunnel/Access.

## Server Windows

```powershell
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
powershell -ExecutionPolicy Bypass -File .\editions\server\windows\install.ps1 -PublicHost memory.example.com
```

Keep Gateway on the private origin and publish it through authenticated ingress.

## Cloudflare Access

Cloudflare authenticates people or machines at the edge. Memhub still maps identity to a stable account and enforces internal roles. A machine Bridge may use a Cloudflare Service Token plus a separate revocable Memhub Device Token. Do not put either credential into prompts or project memory.

Anonymous `/user` or `/admin` returning 401 can be correct. The security failure would be anonymous access being accepted when the deployment is intended to be protected.

## Post-install health checks

```bash
npm run core:check
npm run memory:audit
npm run state:audit
```

These check different layers. Also verify the User workspace account/project scope and Admin processing state.

## Upgrade and backup

Before schema-changing work:

```bash
npm run core:preflight
```

After the change:

```bash
npm run core:verify -- --manifest <manifest>
npm run core:preserved -- --manifest <manifest>
```

Keep rollback snapshots and durable fingerprints. A rebuildable capture index alone is not a backup.

## Firewall, proxy, and DNS

Local loopback ports normally do not need inbound firewall exposure. Server Memory Core/Gateway origin should not be opened directly to the Internet. DNS should point to your authenticated proxy/Tunnel. If Host validation fails, fix `MEMHUB_PUBLIC_HOST` or proxy forwarding rather than disabling validation.

Corporate proxy configuration should be explicit in the deployment environment. The installer should not rewrite the user's global network settings.

## Release verification

Verify from the inside out: Core → Gateway/Bridge → authenticated proxy → public browser/MCP. Record status codes and the point at which behavior changes. A public landing page being 200 does not prove the MCP endpoint works, and a successful MCP handshake does not prove Admin authorization is correct.

## Platform differences

Linux uses systemd user services and journal. Windows uses PowerShell-generated launch paths. The memory model and ports do not change. Repository moves or Node path changes can invalidate service launch commands on either platform.

## FAQ

### Can I bind Gateway directly to 0.0.0.0?
That is not the recommended Server boundary. Keep origin private and publish through authenticated ingress.

### Can Local later become Server?
Yes, but migrate durable state/account/project context as a coherent unit and verify before/after fingerprints. Do not copy only one SQLite file and assume the entire control plane moved.
