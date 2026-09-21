# Memhub Server Edition

## One-line install

Linux:

```bash
curl -fsSL https://github.com/PhSanqi/Memhub/releases/latest/download/install.sh | \
  bash -s -- --edition server --public-host memory.example.com
```

Windows PowerShell:

```powershell
$p=Join-Path $env:TEMP 'memhub-install.ps1'; iwr https://github.com/PhSanqi/Memhub/releases/latest/download/install.ps1 -OutFile $p; & $p -Edition server -PublicHost memory.example.com; rm $p
```

The bootstrap downloads the latest Server package for the current platform, verifies SHA-256, keeps the application files in a persistent install directory, and runs the normal Server installer.

Server Edition runs the central Memory Core and Memhub Gateway on loopback. Publish `/memhub/mcp` and `/memhub/capture` only through an authenticated reverse proxy such as Cloudflare Access.

- Linux: `MEMHUB_PUBLIC_HOST=memory.example.com bash linux/install.sh`
- Windows: `powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 -PublicHost memory.example.com`

Device-side Bridges are installed separately and keep Cloudflare Service Tokens/device tokens off AI plugin configuration.
