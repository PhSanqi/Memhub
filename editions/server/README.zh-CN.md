# Memhub Server Edition

## 一键安装

Linux：

```bash
curl -fsSL https://github.com/PhSanqi/Memhub/releases/latest/download/install.sh | \
  bash -s -- --edition server --public-host memory.example.com
```

Windows PowerShell：

```powershell
$p=Join-Path $env:TEMP 'memhub-install.ps1'; iwr https://github.com/PhSanqi/Memhub/releases/latest/download/install.ps1 -OutFile $p; & $p -Edition server -PublicHost memory.example.com; rm $p
```

Bootstrap 会下载当前平台最新的 Server Release 包、校验 SHA-256、把应用文件保存在持久安装目录，然后调用正式 Server 安装器。

Server Edition 在服务器 loopback 上运行中央 Memory Core 和 Memhub Gateway。只应通过 Cloudflare Access 等认证反向代理发布 `/memhub/mcp` 与 `/memhub/capture`。

- Linux：`MEMHUB_PUBLIC_HOST=memory.example.com bash linux/install.sh`
- Windows：`powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 -PublicHost memory.example.com`

设备端另行安装 Bridge，Cloudflare Service Token 和 Memhub Device Token 不进入 AI 插件配置。
