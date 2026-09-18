# Memhub Server Edition

Server Edition 在服务器 loopback 上运行中央 Memory Core 和 Memhub Gateway。只应通过 Cloudflare Access 等认证反向代理发布 `/memhub/mcp` 与 `/memhub/capture`。

- Linux：`MEMHUB_PUBLIC_HOST=memory.example.com bash linux/install.sh`
- Windows：`powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 -PublicHost memory.example.com`

设备端另行安装 Bridge，Cloudflare Service Token 和 Memhub Device Token 不进入 AI 插件配置。
