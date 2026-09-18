# Memhub

[English](README.md)

Memhub 是一个面向 AI Harness 的私有、项目感知型长期记忆与上下文中心。Codex、Claude Code、ChatGPT 类远程 MCP、CoWorker 以及其他 AI 可以共享同一套长期记忆，但不要求所有客户端使用同一种接入方式。

Memhub 明确把知识拆成两层：

- **账号级**：个人偏好、跨项目工作方式、通用规则、个人 Skill、通用场域认知。
- **项目级**：项目记忆、项目独立 Skill、项目环境画像、项目 Contract、领域知识、权威架构上下文。

项目 Skill 不会静默合并进个人 Skill，也不会跨项目合并。

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
   +---------------------+
   | Context Router      |
   | Memory Core         |
   | Evolution           |
   | Project Scopes      |
   | Normify Adapter     |
   +---------------------+
```

Memhub 使用同一套核心代码提供两个 Edition：

```text
Memhub/editions/
├── local/
│   ├── linux/
│   └── windows/
└── server/
    ├── linux/
    └── windows/
```

### Local Edition

所有内容都在单台机器运行，不需要 VPS，也不需要 Cloudflare。MCP、capture、SQLite、沉淀管线以及可选的 Normify 上下文都保持本地。

### Server Edition

服务器作为唯一长期记忆源。各设备只运行本地 Bridge，通过 Cloudflare Access 等认证反向代理上传 turn；线上 AI 也可以直接通过远程 MCP 使用同一服务器。

详细设计见 [Edition 设计](Memhub/docs/EDITIONS.md)。

## 记忆沉淀能力仍然保留

Memhub 并没有把原 Memory Core 简化成“聊天记录数据库”。当前代码仍保留：

- L1 对话/操作 Trace；
- reflection / reward；
- L2 Policy induction；
- Skill 提炼与生命周期管理；
- L3 World Model；
- Project Environment Profile；
- Project Contract；
- Domain Knowledge；
- 账号级 General Rules；
- 项目/全局隔离检索。

因此可以形成：

```text
个人账号
├── 个人长期记忆
├── 个人 Skill
└── 通用场域认知

A 项目
├── A 项目记忆
├── A 项目 Skill
├── A Project Environment
├── A Project Contract
└── A Domain Knowledge

B 项目
└── 完全独立的一套项目沉淀
```

模型执行层规划为三种模式：

1. **Direct Provider**：服务器显式配置模型 API / provider，后台自动跑沉淀。
2. **Harness Worker**：服务器不保存模型 API Key，已经登录的 Codex / Claude / 其他 Harness 通过 MCP 拉取 evolution job，生成结构化候选，再提交给 Memhub 校验并 commit。
3. **Deferred / Local-only**：没有可用模型时，L1 和记忆检索仍正常，需要模型的高级沉淀保持 pending，等以后有执行器再跑。

这意味着“用已经登录的 Codex/Claude 帮 Memhub 提炼 Skill/项目认知”是正式设计，而不是临时 hack。

详细见 [沉淀与 Scope 模型](Memhub/docs/EVOLUTION_SCOPES.md)。

## MCP 与自动采集

当前高层 MCP 保持很小：

- `memmy_context`：组合个人记忆、项目记忆和权威项目架构；
- `memmy_remember`：显式长期记忆；
- `memmy_project`：项目查询和绑定。

工具名暂时保留 `memmy_` 是为了兼容已有客户端，产品和发行名称已经是 Memhub。

自动 capture 不依赖模型每轮主动调用 MCP。Plugin/Hook 把 turn 交给本地 Bridge，Bridge 先落本地队列，再上传服务器；断网不会丢。

## 源码安装

要求 Node.js 20+。第一次源码安装在缺少构建产物时会执行 workspace 安装/构建。

Local Linux：

```bash
bash Memhub/editions/local/linux/install.sh
```

Local Windows：

```powershell
powershell -ExecutionPolicy Bypass -File .\Memhub\editions\local\windows\install.ps1
```

Server Linux：

```bash
MEMHUB_USERNAME=owner bash Memhub/editions/server/linux/install.sh
```

Server Windows：

```powershell
powershell -ExecutionPolicy Bypass -File .\Memhub\editions\server\windows\install.ps1 -Username owner
```

Server Edition 只监听 loopback，不会替你自动创建 Cloudflare 配置。将 `/memhub/mcp` 和 `/memhub/capture` 通过你自己的认证 Tunnel / 反向代理发布即可。

## 当前状态与上游来源

Memhub 目前处于持续重构阶段。共享 Memory Core 源自 MemTensor 的开源 Memmy 项目；Memhub 在此基础上增加了私有 Gateway、设备 Capture、项目隔离、Bridge、多设备 Server Edition 和新的产品边界。详见 [上游说明](docs/UPSTREAM.md)。

## License

继承代码继续遵循上游仓库 License 与 Notice；Memhub 新增代码默认使用本仓库 License，除非具体文件另有说明。
