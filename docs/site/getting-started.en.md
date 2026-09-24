# From install to your first continuous memory

This page takes the shortest path from a clean machine to one verified continuity loop. The goal is not to study every internal component first. Choose Local or Server Edition, start Memhub, connect an MCP/Bridge-capable harness, produce real project evidence, then open a new chat or device and confirm that project scope, follow-up, chronology, and evidence remain available.

## Choose Local or Server

Use Local Edition when one workstation is enough and you want the entire runtime on that machine. Memory Core, Gateway, and Bridge stay on loopback; plugins normally connect to `http://127.0.0.1:17861/mcp`. Local is the best first installation because it removes the reverse-proxy and remote-auth layers from the initial problem.

Use Server Edition when several devices or hosted MCP clients need one durable source of truth. Memory Core and Gateway still run on server loopback. Publish the Gateway only through an authenticated reverse proxy such as Cloudflare Access. Cloudflare is an identity/transport boundary, not the long-term-memory database.

Release builds provide two installation paths. **Complete** packages bundle Node.js, production dependencies, and prebuilt output for one target OS, so Node/npm do not need to be preinstalled. The repository `install.sh` / `install.ps1` scripts remain the **convenience/source** path and may install dependencies or build on the target host.

Complete Linux:

```bash
bash editions/complete/linux/install.sh --mode local
# or
MEMHUB_PUBLIC_HOST=memory.example.com bash editions/complete/linux/install.sh --mode server
```

Complete Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\editions\complete\windows\install.ps1 -Mode Local
# or
powershell -ExecutionPolicy Bypass -File .\editions\complete\windows\install.ps1 -Mode Server -PublicHost memory.example.com
```

## Install Local Edition

Linux:

```bash
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
bash editions/local/linux/install.sh
```

Windows PowerShell:

```powershell
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
powershell -ExecutionPolicy Bypass -File .\editions\local\windows\install.ps1
```

On Linux, verify `memhub-core.service`, `memhub-local.service`, and `memhub-bridge.service`. Memory Core normally listens on 18960, the internal Gateway on 3001, and Bridge on 17861. Your plugin should use Bridge rather than exposing Memory Core directly.

## Install Server Edition

Linux:

```bash
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
MEMHUB_PUBLIC_HOST=memory.example.com bash editions/server/linux/install.sh
```

Windows:

```powershell
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
powershell -ExecutionPolicy Bypass -File .\editions\server\windows\install.ps1 -PublicHost memory.example.com
```

Verify the loopback origin before configuring Cloudflare. The origin MCP path is `http://127.0.0.1:3001/memhub/mcp`; capture is `/memhub/capture`. A remote client should use the authenticated public URL, not the loopback origin.

## Open the User workspace

Confirm the stable account and project scope before creating a large history. A device, operating system, ChatGPT, or Codex is not a separate user persona; those are provenance/entry points for the same account.

When Project Scope is “All projects,” the workspace should show a portfolio of projects. Only after selecting one project should it expand Current Truth, TODOs, chronology, memory layers, and provenance.

## Connect an AI harness

Connect an MCP-capable client to the appropriate endpoint. The repository also provides `adapters/plugin/` with MCP configuration, Memhub Skill support, and lifecycle integration for hosts that support it. Start with a small real project and a few turns. Do not import a large legacy history before the basic scope/capture path is proven.

## Verify project routing

Current-turn explicit project/workspace evidence takes precedence over a stale conversation binding. Switch between two test projects and confirm business memory does not cross the boundary. If evidence is ambiguous, global-only behavior is safer than guessing a project.

A reusable Skill may be explicitly used across projects, but it must not carry the source project's business facts with it.

## Verify L1 and Processing

After a few real turns, check L1 for source evidence, timestamps, project attribution, and provenance. If L1 exists but L2 has not changed, inspect Processing. Pending or leased does not necessarily mean failure; failed is the actionable state.

Do not manually manufacture L2 just to make the UI look populated. The point of the pipeline is evidence-bounded durable synthesis.

## Verify a new session can continue

Open a fresh chat or another correctly bound device. Provide only the current project/workspace signal and ask the harness to recall context. It should recover recent project chronology, stable rules, and follow-up without requiring the entire previous conversation to be pasted again.

This is the real acceptance test. A 200 response from the web UI alone does not prove durable continuity.

## Success checklist

- Expected Local or Server services are running.
- MCP client uses the correct Bridge/public endpoint.
- The User workspace resolves the intended account.
- All-project scope shows multiple project records when multiple projects exist.
- L1 contains real source evidence.
- Processing has no unexplained long-lived failed jobs.
- A new session recovers recent continuity or TODOs.
- Project B does not inherit Project A business memory.

## Common failures

A 401 on protected Server pages may be expected for anonymous requests. Diagnose identity before weakening access control. Wrong project context usually requires checking current project evidence, aliases/descriptions, and stale bindings—not deleting all memory. L1 missing points to the capture/Bridge path; L1 present with no L2/L3 points to Processing.

Before a schema-changing upgrade, use the migration preflight/verify/preserved flow rather than copying only a rebuildable index.

## A practical first 30-minute drill

Spend five minutes checking services and ports, ten minutes doing real work in one test project, five minutes checking L1/Processing, and ten minutes opening a new chat and recovering the project. Add one explicit TODO before switching sessions. The drill exercises transport, identity, scope, capture, distillation, recall, and the workspace without requiring a large dataset.

## FAQ

### Should I import all historical chats first?
No. Prove the current capture/scope/continuity path with a small clean project first, then migrate history.

### Why not put all history in every prompt?
That destroys project boundaries and time-state semantics. Memhub recalls the most relevant durable context and keeps L1 available for evidence tracing.

### Is Skill L5?
No. Skill is an orthogonal reusable capability channel, not the next step in L1→L4 distillation.
