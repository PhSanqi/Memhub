# Memhub Local Edition

## 安装

### 完整安装版 — 推荐

不要求预装 Node/npm。

Linux：

```bash
curl -fsSL https://github.com/PhSanqi/Memhub/releases/latest/download/install-complete.sh | bash
```

Windows PowerShell：

```powershell
$p=Join-Path $env:TEMP 'memhub-install-complete.ps1'; iwr https://github.com/PhSanqi/Memhub/releases/latest/download/install-complete.ps1 -OutFile $p; & $p; rm $p
```

### 便捷安装版 — 下载更小

要求已有 Node.js 20+ 与 npm。

Linux：

```bash
curl -fsSL https://github.com/PhSanqi/Memhub/releases/latest/download/install.sh | bash
```

Windows PowerShell：

```powershell
$p=Join-Path $env:TEMP 'memhub-install.ps1'; iwr https://github.com/PhSanqi/Memhub/releases/latest/download/install.ps1 -OutFile $p; & $p; rm $p
```

两种 Bootstrap 都会校验 SHA-256，并把应用文件保存在持久安装目录。无需先 clone 仓库。

Local Edition 在一台机器上运行 Memory Core、Memhub Gateway 和 Memhub Bridge，不需要 VPS/Cloudflare，服务默认只监听 loopback。

- Linux：`bash linux/install.sh`
- Windows：`powershell -ExecutionPolicy Bypass -File .\windows\install.ps1`

插件统一连接 `http://127.0.0.1:17861/mcp`。
