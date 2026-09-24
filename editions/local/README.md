# Memhub Local Edition

Local Edition runs Memory Core, Memhub Gateway and Memhub Bridge on one machine. It requires no Cloudflare/VPS and binds all services to loopback.

- Linux: `bash linux/install.sh`
- Windows: `powershell -ExecutionPolicy Bypass -File .\windows\install.ps1`

The plugin-facing endpoint is always `http://127.0.0.1:17861/mcp`.
