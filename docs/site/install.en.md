# Installation & deployment

**New users should perform a fresh install.** Local serves one machine; Server serves your own account across devices. The public website and GitHub Pages are informational, not a hosted memory or sign-in service. Only existing early-version installations with preserved state need a migration path; never install an old version merely to simulate that scenario.

This page covers Local / Server × Linux / Windows and treats installation as more than an installer exit code. A deployment is complete only when runtime processes, loopback boundaries, identity, public ingress, project scope, and recovery evidence have all been checked.

## Understand the boundaries first

Memory Core is the private data plane and should remain loopback-only. The Memhub MCP runtime is the identity/project/context/tool boundary. Local clients connect to it directly on loopback; Server publishes that same `/mcp` endpoint through authenticated ingress. Do not expose Memory Core on the Internet to make an MCP client easier to configure.

State under `MEMHUB_HOME` or the default state root is durable material. It is not just cache. Backups must consider raw capture, Memory Core durable state, project registry, account/device state, and bindings.

## Local Linux

```bash
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
bash editions/local/linux/install.sh
```

The installer creates systemd user units for Memory Core and the local MCP runtime. Verify:

```bash
systemctl --user status memhub-core.service
systemctl --user status memhub.service
ss -ltn | grep -E '3001|18960'
```

MCP clients use `http://127.0.0.1:3001/mcp` directly. Clients use the MCP endpoint directly.

## Local Windows

For a first Windows installation, use the fresh-install path directly. **Do not install an old release or create legacy Scheduled Tasks just to run a migration.** Migration from an actually installed early split-task release is a separate, audited scenario; disposable compatibility tests are not proof of a live migration.

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

Verify `memhub-core.service`, `memhub.service`, and `memhub-stack.target`. The origin MCP is `http://127.0.0.1:3001/mcp`. Validate origin before adding Tunnel/Access; the public `/mcp` route should terminate at that same loopback runtime.

## Server Windows

Fresh installation and upgrading an existing installation are different procedures. Follow the fresh-install steps below only when there is no prior Memhub instance. If state or Memhub Scheduled Tasks already exist, establish their provenance, backup and ownership before changing anything.

```powershell
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
powershell -ExecutionPolicy Bypass -File .\editions\server\windows\install.ps1 -PublicHost memory.example.com
```

Keep Gateway on the private origin and publish it through authenticated ingress.

## Cloudflare Access

Cloudflare authenticates remote clients at the edge. Memhub still maps identity to a stable account and enforces internal roles. OAuth/Access credentials must not be placed in prompts or project memory.

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

Verify from the inside out: Core → loopback MCP runtime → authenticated proxy → public browser/MCP. Record protocol results and the point at which behavior changes. A public landing page being 200 does not prove the MCP endpoint works, and a successful MCP handshake does not prove Admin authorization is correct.

## Platform differences

Linux uses systemd user services and journal. Windows uses PowerShell-generated launch paths. The memory model and ports do not change. Repository moves or Node path changes can invalidate service launch commands on either platform.

## FAQ

### Can I bind Gateway directly to 0.0.0.0?
That is not the recommended Server boundary. Keep origin private and publish through authenticated ingress.

### Can Local later become Server?
Yes, but migrate durable state/account/project context as a coherent unit and verify before/after fingerprints. Do not copy only one SQLite file and assume the entire control plane moved.
