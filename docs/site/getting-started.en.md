# From install to your first continuous memory

**For first-time users:** choose Local or Server and install it on your own device or server before connecting an AI client. This public site and the GitHub Pages mirror explain the product; they do not provide a shared memory account. Your workspace lives only in your own authenticated installation. The homepage preview is fictional.

This page takes the shortest path from a clean machine to one verified continuity loop. Choose Local or Server Edition, start Memhub, connect an MCP-capable harness, produce real project evidence, then open a new chat or device and confirm that project scope, follow-up, chronology, and evidence remain available.

## Choose Local or Server

Use Local Edition when one workstation is enough and you want the entire runtime on that machine. Memory Core and the Memhub MCP runtime stay on loopback; MCP clients connect directly to `http://127.0.0.1:3001/mcp`. Local is the best first installation because it removes the reverse-proxy and remote-auth layers from the initial problem.

Use Server Edition when several devices or hosted MCP clients need one durable source of truth. Memory Core and the same MCP runtime still run on server loopback. Publish `/mcp` only through an authenticated reverse proxy such as Cloudflare Access/Tunnel. Cloudflare is an identity/transport boundary, not a second Memhub implementation.

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

On Linux, verify `memhub-core.service`, `memhub.service`, and `memhub-stack.target`. Memory Core normally listens on 18960 and the MCP runtime on 3001. The AI client connects to the MCP runtime, never directly to Memory Core.

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

Verify the loopback origin before configuring Cloudflare. The origin MCP path is `http://127.0.0.1:3001/mcp`. A remote client should use the authenticated public `/mcp` URL, which terminates at that same loopback runtime.

## Open the User workspace

Confirm the stable account and project scope before creating a large history. A device, operating system, ChatGPT, or Codex is not a separate user persona; those are provenance/entry points for the same account.

When Project Scope is “All projects,” the workspace should show a portfolio of projects. Only after selecting one project should it expand Current Truth, TODOs, chronology, memory layers, and provenance.

## Connect an AI harness

Connect an MCP-capable client directly to the appropriate endpoint. Clients use the MCP endpoint directly. The model-facing contract is simple: at the start of each Memhub turn call `memmy_context` with the current request and explicit `project`/`workspace_project` evidence, then call `memmy_turn action=open`; before the final answer call `memmy_turn action=commit`. Host conversation/session IDs are optional provenance, not routing keys. Start with a small real project and a few turns before importing a large history.

## Verify project routing

Current-turn explicit project/workspace evidence is authoritative. Switch between two test projects and confirm business memory does not cross the boundary. Host conversation identity does not select projects; if current evidence is ambiguous, global-only behavior is safer than guessing.

A reusable Skill may be explicitly used across projects, but it must not carry the source project's business facts with it.

## Verify L1 and Processing

After a few real turns, check L1 for source evidence, timestamps, project attribution, and provenance. If L1 exists but L2 has not changed, inspect Processing. Pending or leased does not necessarily mean failure; failed is the actionable state.

Do not manually manufacture L2 just to make the UI look populated. The point of the pipeline is evidence-bounded durable synthesis.

## Verify a new session can continue

Open a fresh chat or another correctly bound device. Provide only the current project/workspace signal and ask the harness to recall context. It should recover recent project chronology, stable rules, and follow-up without requiring the entire previous conversation to be pasted again.

This is the real acceptance test. A 200 response from the web UI alone does not prove durable continuity.

## Success checklist

- Expected Local or Server services are running.
- MCP client uses `127.0.0.1:3001/mcp` locally or the authenticated public `/mcp` endpoint remotely.
- The User workspace resolves the intended account.
- All-project scope shows multiple project records when multiple projects exist.
- L1 contains real source evidence.
- Processing has no unexplained long-lived failed jobs.
- A new session recovers recent continuity or TODOs.
- Project B does not inherit Project A business memory.

## Common failures

A 401 on protected Server pages may be expected for anonymous requests. Diagnose identity before weakening access control. Wrong project context usually requires checking current project/workspace evidence and aliases/descriptions—not deleting all memory. Missing L1 usually means the Agent did not execute the `memmy_turn open/commit` contract; L1 present with no L2/L3 points to Processing.

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
