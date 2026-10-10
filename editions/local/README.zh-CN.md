# Memhub Local Edition

Local Edition 在一台机器上运行 Memory Core 和 Memhub MCP runtime，不需要 VPS/Cloudflare，服务默认只监听 loopback。

- Linux：`bash linux/install.sh`
- Windows：`powershell -ExecutionPolicy Bypass -File .\windows\install.ps1`

MCP 客户端直接连接 `http://127.0.0.1:3001/mcp`。
