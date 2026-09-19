# Memhub

**给 AI Agent 使用的共享长期记忆，支持本地部署和服务器部署。**

[English](README.md)

Memhub 为支持 MCP 的 AI Agent 提供一个可以跨对话、跨项目、跨设备延续的长期记忆空间。它适合希望 Agent 真正记住重要上下文，同时又不想把每一句聊天都永久塞进记忆的人。

## 主要功能

- **跨对话长期记忆**：长期事实、决定、偏好和纠正可以在后续任务中重新召回。
- **全局记忆 + 项目记忆**：账号级上下文和项目级上下文分开管理，避免不同项目互相污染。
- **跨 Agent、跨设备继续工作**：多个支持 MCP 的客户端可以接入同一套记忆。
- **自动保存对话历史**：支持的 Host 集成可以自动保留完整轮次。
- **手动蒸馏历史**：把长期积累的历史整理成连续、干净的综合记忆，而不是每次重复读取旧对话。
- **提炼可复用 Skill**：把可重复执行的方法和流程单独沉淀为技能。
- **项目上下文**：在长期记忆之外同步召回项目级上下文。
- **网页管理**：用户页和管理员页面可以查看项目、设备、记忆和生命周期数据。
- **Local / Server 两种部署模式**：既可以只在一台电脑上运行，也可以把记忆放在中央服务器供多设备使用。

## 四个版本

| 版本 | 适合场景 | 平台 |
| --- | --- | --- |
| Local | 单机使用，不需要 VPS 或公网入口 | Linux |
| Local | 单台 Windows 工作站 | Windows |
| Server | 多设备、多 Agent 共用中央记忆 | Linux |
| Server | 在 Windows 主机上运行中央记忆 | Windows |

每个 Memhub 版本都会发布对应的四个 GitHub Release。

## 环境要求

- Node.js 20 或更高版本，推荐 Node.js 22。
- npm。
- Linux 版本需要可用的 user-level systemd。
- Windows 版本使用 Windows Task Scheduler 保持后台运行。

## 安装

先下载与你的平台和部署模式对应的 Release，并解压。

### Linux Local

```bash
tar -xzf memhub-v0.1.0-linux-local.tar.gz
cd memhub-v0.1.0-linux-local
bash editions/local/linux/install.sh
```

安装完成后，把 AI 客户端的 MCP 地址配置为：

```text
http://127.0.0.1:17861/mcp
```

### Windows Local

解压 `memhub-v0.1.0-windows-local.zip`，在解压目录打开 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\editions\local\windows\install.ps1
```

然后把 AI 客户端的 MCP 地址配置为：

```text
http://127.0.0.1:17861/mcp
```

### Linux Server

解压 `memhub-v0.1.0-linux-server.tar.gz` 后运行：

```bash
cd memhub-v0.1.0-linux-server
MEMHUB_PUBLIC_HOST=memory.example.com bash editions/server/linux/install.sh
```

Server Edition 默认只监听本机回环地址。对公网开放前，请把 `/memhub/*` 放在带身份认证的反向代理后面。

对外的 MCP 地址通常是：

```text
https://memory.example.com/memhub/mcp
```

### Windows Server

解压 `memhub-v0.1.0-windows-server.zip` 后运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\editions\server\windows\install.ps1 -PublicHost memory.example.com
```

同样建议只通过带身份认证的反向代理公开 `/memhub/*`。

## 使用

把 MCP 地址连接到 AI 客户端以后，Memhub 会提供用于以下工作的工具：

- 召回相关长期上下文；
- 写入长期有效的记忆；
- 读取和维护项目记忆；
- 手动整理长期历史；
- 从历史中形成可复用 Skill；
- 管理长期记忆的演进。

为了获得更连续的体验，建议让 Agent 在每一轮有实际任务的对话开始时先读取 Memhub，上下文使用前先清理无关或过时噪声；任务结束时只写回真正长期有效的事实、决定、偏好和纠正，而不是把每一句聊天都当成长期记忆。

### 项目路由与长期内容维护

项目解析按“当前轮”进行，而不是把整个 conversation 永久锁死到一个项目。当前轮明确的项目、workspace 或唯一项目证据可以覆盖旧 conversation binding；旧 binding 只在本轮没有项目证据时兜底。业务记忆和 authoritative architecture 仍严格属于 primary project，其他项目只能通过独立 capability 通道复用明确的 Skill artifact。

四个发行版都默认关闭 AgentSource 历史自动扫描；即使手动导入旧 AgentSource 历史，导入 trace 也不会再自动升级成长期 `user_memories`。

长期内容维护采用只读优先：

```bash
npm run memory:audit
npm run memory:repair
npm run normify:audit
npm run normify:migrate
```

`memory:repair` 在改动长期状态前会先生成 SQLite 备份和 JSON report。没有可用 evolution model 时，L3 / Project Environment 任务保持 queued，不再消耗重试次数进入 dead-letter。

### 网页入口

使用 Server Edition 时：

- `/memhub`：项目介绍主页；
- `/memhub/user`：认证后的用户工作区；
- `/memhub/admin`：管理员 Control Plane。

## 致谢

感谢以下开源项目：

- [Memmy](https://github.com/MemTensor/memmy-agent)，[@MemTensor](https://github.com/MemTensor) —— 面向 AI Agent 的共享长期记忆项目。
- [DSH-Normify](https://github.com/yan-mc/dsh-normify)，[@yan-mc](https://github.com/yan-mc) —— 项目架构与 Agent 工作流工具。

第三方及 vendored 组件原有的许可证与版权声明应继续保留。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
