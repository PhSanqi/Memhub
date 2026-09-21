# Memhub Local Edition

## One-line install

Linux:

```bash
curl -fsSL https://github.com/PhSanqi/Memhub/releases/latest/download/install.sh | bash
```

Windows PowerShell:

```powershell
$p=Join-Path $env:TEMP 'memhub-install.ps1'; iwr https://github.com/PhSanqi/Memhub/releases/latest/download/install.ps1 -OutFile $p; & $p; rm $p
```

The bootstrap downloads the latest Linux/Windows Local release package, verifies SHA-256, keeps the application files in a persistent install directory, and runs the normal Local installer. Repository cloning is optional.

Local Edition runs Memory Core, Memhub Gateway and Memhub Bridge on one machine. It requires no Cloudflare/VPS and binds all services to loopback.

- Linux: `bash linux/install.sh`
- Windows: `powershell -ExecutionPolicy Bypass -File .\windows\install.ps1`

The plugin-facing endpoint is always `http://127.0.0.1:17861/mcp`.
