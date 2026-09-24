# Memhub Local Edition

Local Edition 在一台机器上运行 Memory Core、Memhub Gateway 和 Memhub Bridge，不需要 VPS/Cloudflare，服务默认只监听 loopback。

- Linux：`bash linux/install.sh`
- Windows：`powershell -ExecutionPolicy Bypass -File .\windows\install.ps1`

插件统一连接 `http://127.0.0.1:17861/mcp`。
