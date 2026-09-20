# Memhub

[English](README.md)

Memhub 是一个面向 AI Harness 的私有、项目感知型长期记忆与上下文中心。Codex、Claude Code、ChatGPT 类远程 MCP、CoWorker 等客户端可以共享同一套长期记忆，而不要求所有客户端使用同一种接入机制。

当前发布线：**v0.2.0**。变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 当前记忆模型

Memhub 对外只暴露四层记忆，加一条正交的 Skill 层：

- **L1 — 原始对话**：保存用户/助手原始 turn，以及有限、可审计的 reasoning/tool summary。Raw Capture 与 Episode 只作为内部处理机制存在。
- **L2 — 项目时间线**：把同一项目的 L1 整理成前后连续、可读的项目发展过程，包含状态变化、决策、被替代历史和 Current Truth。
- **L3 — 项目规则与经验**：从 L2 中提取长期稳定的项目规则、偏好、工作方式和经验。
- **L4 — 用户画像**：从多个项目的 L3 交叉总结稳定的跨项目个人特征与工作习惯。
- **Skill**：可复用的可执行流程。Skill 不是更深一层记忆，可以是项目级，也可以显式跨项目复用。

L2/L3 必须是项目级；L4 必须是账号级。普通项目业务记忆不会静默泄漏到另一个项目。

## 架构

```text
AI Harness / Plugin / Remote MCP
              |
              v
        Memhub Bridge
      队列 + 设备凭据
              |
              v
        Memhub Server
   +----------------------+
   | Context Router       |
   | L1 Turn Log          |
   | Distillation Jobs    |
   | Memory Core          |
   | Project Registry     |
   | Architecture Reader  |
   +----------------------+
```

架构读取器现在是 Memhub 内部的小型只读兼容层：它可以读取已有 `normify-<project>` 目录里的权威 Markdown 架构，但不再运行或 vendor 旧 Normify 引擎。新的配置名使用 `architecture-root`；`--normify-root` 仅作为旧 systemd/service 配置的 deprecated alias 保留，确保升级重启不会因参数失配直接失败。

Memhub 同一套代码维护 Local / Server 两种 Edition：

```text
editions/
├── local/
│   ├── linux/
│   └── windows/
└── server/
    ├── linux/
    └── windows/
```

Local Edition 在单机运行 MCP、capture、SQLite 和处理流程。Server Edition 把服务器作为记忆源，各设备通过本地 Bridge 上传 turn。

详见 [Edition 设计](docs/EDITIONS.md)。

## MCP 工具面

当前高层 MCP 只保留六个工具：

- `memmy_turn`：打开、checkpoint、commit、resume L1 原始对话日志。
- `memmy_context`：解析当前项目，并召回 L4、当前项目 L2/L3、可复用 Skills、最近 L1 continuity 和只读项目架构。
- `memhub_distill`：领取或提交 L2/L3/L4/Skill 蒸馏任务。真正的语义整理由当前已登录 Harness/模型完成；Memhub 负责 evidence、scope、provenance 和 canonical artifact 校验。
- `memmy_project_list`：列出/匹配 canonical project。
- `memmy_project_manage`：通过 plan → 明确授权管理项目 create/update/delete/merge。
- `memmy_project`：list/current/bind/unbind 项目上下文，并读取项目架构。

`memmy_project action=current` 在 Harness 能提供稳定 `conversation_id` 时读取持久 conversation binding；如果某个 transport 拿不到稳定会话 ID，Memhub 不会伪造 ID，而是返回 `binding_available=false`，当前请求继续以 `memmy_context.resolvedProjectId` 和本轮明确的 project/workspace 证据为准。

完成 L2 后可以继续排 L3；当至少两个项目已有完成的 L3 后，才会形成 L4 任务。Memhub 后端不会偷偷调用大模型。

## Capture 与管理界面

Capture 是 Host 能力，不是 MCP 的隐式副作用。Plugin/Hook 可以把完整或部分 turn 写入本地 Bridge；Bridge 先持久化队列，再在网络可用时上传。

Web 路由：

- `/memhub`：公开介绍页；
- `/memhub/user`：认证后的用户工作区；
- `/memhub/admin`：认证后的管理员 Control Plane。

管理界面的产品层级固定为 Overview、Projects、L1、L2、L3、L4、Skills、Processing。Raw Capture 和 Episode 不作为管理层展示，只在内部处理。

当前轮明确的项目/workspace 证据优先于旧 conversation binding；项目不明确时只返回 global 范围，避免串项目。

## 数据迁移与维护

当前 SQLite schema migration 为 v8。v7 → v8 会：

- 把 durable memory layer 约束切换为 L1/L2/L3/L4/Skill；
- 保留旧记录，并把旧模型下的 L2/L3 标记为 Legacy/archived，而不是删除；
- archive 旧 `user_memories`；
- dead-letter 已退役 evolution jobs；
- 把 embedding retry target 映射到新的 artifact 名称。

生产切换使用：

```bash
npm run core:preflight
npm run core:verify -- --manifest <manifest>
npm run core:preserved -- --manifest <manifest>
```

`core:preflight` 会检查 vendored runtime 完整性，并生成在线 SQLite 回滚快照。`core:preserved` 专门用于允许 schema 变化的 cutover：schema/version 变化只作为审计信息；真正强制的是 SQLite integrity、durable table 不丢失，以及 baseline 中每一个 durable row identity 都仍存在。

长期内容治理保持 read-first：

```bash
npm run memory:audit
npm run memory:repair
```

`memory:repair` 在 apply 前生成在线备份和报告。

详见 [Core 迁移](docs/CORE_MIGRATION.md)、[架构](docs/ARCHITECTURE.md)、[记忆 Scope](docs/EVOLUTION_SCOPES.md) 和 [Control Plane / Distillation](docs/CONTROL_PLANE_AND_DISTILLATION.md)。

## 源码安装

要求 Node.js 20+。

Local Linux：

```bash
bash editions/local/linux/install.sh
```

Local Windows：

```powershell
powershell -ExecutionPolicy Bypass -File .\Memhub\editions\local\windows\install.ps1
```

Server Linux：

```bash
MEMHUB_USERNAME=owner bash editions/server/linux/install.sh
```

Server Windows：

```powershell
powershell -ExecutionPolicy Bypass -File .\Memhub\editions\server\windows\install.ps1 -Username owner
```

Server Edition 默认只监听 loopback，不会自动创建 Cloudflare 配置。公网入口应继续放在 Cloudflare Access 等认证反代后；Memhub 自身的 device/account 鉴权仍然保留。

## Release 安装包

每个 v0.2.x Release 都从同一个源码 commit 生成四个 Edition/平台安装包：

- `memhub-vX.Y.Z-linux-local.tar.gz`
- `memhub-vX.Y.Z-linux-server.tar.gz`
- `memhub-vX.Y.Z-windows-local.zip`
- `memhub-vX.Y.Z-windows-server.zip`

`SHA256SUMS.txt` 与 `release-manifest.json` 会把四个包绑定到同一个 commit。维护者可以用 `npm run release:check` 检查发布输入，用 `npm run release:package` 一次生成四个平台包。

## 当前状态与上游

Memhub 仍处于持续开发阶段。内嵌 Memory Core 来自开源 Memmy lineage，并作为 Memhub runtime boundary 的一部分维护。详见 [上游说明](docs/UPSTREAM.md)。

## License

见 [LICENSE](LICENSE)。
