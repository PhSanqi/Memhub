# Memhub Server Edition

## 安装

### 完整安装版 — 推荐

不要求预装 Node/npm。

Linux：

```bash
curl -fsSL https://github.com/PhSanqi/Memhub/releases/latest/download/install-complete.sh | \
  bash -s -- --edition server --public-host memory.example.com
```

Windows PowerShell：

```powershell
$p=Join-Path $env:TEMP 'memhub-install-complete.ps1'; iwr https://github.com/PhSanqi/Memhub/releases/latest/download/install-complete.ps1 -OutFile $p; & $p -Edition server -PublicHost memory.example.com; rm $p
```

### 便捷安装版 — 下载更小

要求已有 Node.js 20+ 与 npm。

Linux：

```bash
curl -fsSL https://github.com/PhSanqi/Memhub/releases/latest/download/install.sh | \
  bash -s -- --edition server --public-host memory.example.com
```

Windows PowerShell：

```powershell
$p=Join-Path $env:TEMP 'memhub-install.ps1'; iwr https://github.com/PhSanqi/Memhub/releases/latest/download/install.ps1 -OutFile $p; & $p -Edition server -PublicHost memory.example.com; rm $p
```

两种 Bootstrap 都会校验 SHA-256，并把应用文件保存在持久安装目录；完整安装版直接使用包内 Node runtime。

Server Edition 在服务器 loopback 上运行中央 Memory Core 和 Memhub Gateway。只应通过 Cloudflare Access 等认证反向代理发布 `/memhub/mcp` 与 `/memhub/capture`。

- Linux：`MEMHUB_PUBLIC_HOST=memory.example.com bash linux/install.sh`
- Windows：`powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 -PublicHost memory.example.com`

设备端另行安装 Bridge，Cloudflare Service Token 和 Memhub Device Token 不进入 AI 插件配置。
