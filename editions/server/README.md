# Memhub Server Edition

## Install

### Complete Install — recommended

No preinstalled Node/npm required.

Linux:

```bash
curl -fsSL https://github.com/PhSanqi/Memhub/releases/latest/download/install-complete.sh | \
  bash -s -- --edition server --public-host memory.example.com
```

Windows PowerShell:

```powershell
$p=Join-Path $env:TEMP 'memhub-install-complete.ps1'; iwr https://github.com/PhSanqi/Memhub/releases/latest/download/install-complete.ps1 -OutFile $p; & $p -Edition server -PublicHost memory.example.com; rm $p
```

### Quick Install — smaller download

Requires Node.js 20+ and npm.

Linux:

```bash
curl -fsSL https://github.com/PhSanqi/Memhub/releases/latest/download/install.sh | \
  bash -s -- --edition server --public-host memory.example.com
```

Windows PowerShell:

```powershell
$p=Join-Path $env:TEMP 'memhub-install.ps1'; iwr https://github.com/PhSanqi/Memhub/releases/latest/download/install.ps1 -OutFile $p; & $p -Edition server -PublicHost memory.example.com; rm $p
```

Both bootstraps verify SHA-256 and keep the application files in a persistent install directory. Complete Install uses the Node runtime bundled in the package.

Server Edition runs the central Memory Core and Memhub Gateway on loopback. Publish `/memhub/mcp` and `/memhub/capture` only through an authenticated reverse proxy such as Cloudflare Access.

- Linux: `MEMHUB_PUBLIC_HOST=memory.example.com bash linux/install.sh`
- Windows: `powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 -PublicHost memory.example.com`

Device-side Bridges are installed separately and keep Cloudflare Service Tokens/device tokens off AI plugin configuration.
