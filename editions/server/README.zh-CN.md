# Memhub Server Edition

Server Edition 在服务器 loopback 上运行中央 Memory Core 和 Memhub MCP runtime。只应通过 Cloudflare Access/Tunnel 等认证反向代理发布 `/mcp`；公网入口最终落到与本机客户端相同的 loopback MCP runtime。

- Linux：`MEMHUB_PUBLIC_HOST=memory.example.com bash linux/install.sh`
- Windows：`powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 -PublicHost memory.example.com`

远程 MCP 客户端在反向代理边界完成认证。
