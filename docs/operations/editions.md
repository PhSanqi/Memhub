# Editions and runtime layout

Memhub publishes Local and Server packages, but both packages contain the same runtime implementation.

## Canonical stack

Linux:

```text
memhub-core.service   -> 127.0.0.1:18960
memhub.service        -> 127.0.0.1:3001/mcp
memhub-stack.target   -> owns both services
memhub.env            -> shared runtime environment
```

Windows:

```text
Memhub-Stack -> runtime/stack.cmd -> scripts/run-stack.mjs
```

The managed direct process stack also owns exactly two children: Core and MCP runtime.

## Local package

Local clients connect directly to:

```text
http://127.0.0.1:3001/mcp
```

No public host is required.

## Server package

Server is the same loopback stack with `MEMHUB_PUBLIC_HOST` configured and an authenticated reverse proxy/Tunnel publishing the endpoint:

```text
https://<public-host>/mcp -> 127.0.0.1:3001/mcp
```

The public transport never exposes Memory Core directly.

## Installer design

Linux and Windows each have one common installer/uninstaller implementation. Edition entrypoints are wrappers that set defaults such as account name or public host. Runtime ownership, credentials, ports and state layout are not duplicated per edition.

Fresh installers fail closed when existing Memhub state or historical owners are detected. Existing installations require a reviewed upgrade rather than an overwrite.

## Persistent state

Repository/runtime code is replaceable. Persistent user state is external and protected:

- `~/.memmy` on Linux;
- `%LOCALAPPDATA%\Memhub` by default on Windows packages.

A cleanup or upgrade must never infer that old runtime code implies old user data is disposable.

## Packaging

Release packages include the selected edition wrapper plus the common runtime implementation. Complete bundles include Node, dependencies, Core, MCP runtime and web assets. Local/Server package identity is installation UX, not an architectural fork.
