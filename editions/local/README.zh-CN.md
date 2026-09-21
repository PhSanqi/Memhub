# Memhub Local Edition

## 一键安装

Linux：

```bash
curl -fsSL https://github.com/PhSanqi/Memhub/releases/latest/download/install.sh | bash
```

Windows PowerShell：

```powershell
$p=Join-Path $env:TEMP 'memhub-install.ps1'; iwr https://github.com/PhSanqi/Memhub/releases/latest/download/install.ps1 -OutFile $p; & $p; rm $p
```

Bootstrap 会下载最新 Linux/Windows Local Release 包、校验 SHA-256、把应用文件保存在持久安装目录，然后调用正式 Local 安装器。无需先 clone 仓库。

Local Edition 在一台机器上运行 Memory Core、Memhub Gateway 和 Memhub Bridge，不需要 VPS/Cloudflare，服务默认只监听 loopback。

- Linux：`bash linux/install.sh`
- Windows：`powershell -ExecutionPolicy Bypass -File .\windows\install.ps1`

插件统一连接 `http://127.0.0.1:17861/mcp`。
