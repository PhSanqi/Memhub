# Memhub Local Edition

## Install

### Complete Install — recommended

No preinstalled Node/npm required.

Linux:

```bash
curl -fsSL https://github.com/PhSanqi/Memhub/releases/latest/download/install-complete.sh | bash
```

Windows PowerShell:

```powershell
$p=Join-Path $env:TEMP 'memhub-install-complete.ps1'; iwr https://github.com/PhSanqi/Memhub/releases/latest/download/install-complete.ps1 -OutFile $p; & $p; rm $p
```

### Quick Install — smaller download

Requires Node.js 20+ and npm.

Linux:

```bash
curl -fsSL https://github.com/PhSanqi/Memhub/releases/latest/download/install.sh | bash
```

Windows PowerShell:

```powershell
$p=Join-Path $env:TEMP 'memhub-install.ps1'; iwr https://github.com/PhSanqi/Memhub/releases/latest/download/install.ps1 -OutFile $p; & $p; rm $p
```

Both bootstraps verify SHA-256 and keep the application files in a persistent install directory. Repository cloning is optional.

Local Edition runs Memory Core, Memhub Gateway and Memhub Bridge on one machine. It requires no Cloudflare/VPS and binds all services to loopback.

- Linux: `bash linux/install.sh`
- Windows: `powershell -ExecutionPolicy Bypass -File .\windows\install.ps1`

The plugin-facing endpoint is always `http://127.0.0.1:17861/mcp`.
