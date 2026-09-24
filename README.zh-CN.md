# Memhub

[English](README.md)

![Release](https://img.shields.io/github/v/release/PhSanqi/Memhub?display_name=tag)
![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)
![Platforms](https://img.shields.io/badge/Linux%20%7C%20Windows-5b67d6)
![MCP](https://img.shields.io/badge/MCP-ready-7c3aed)
![License](https://img.shields.io/github/license/PhSanqi/Memhub)

**面向 AI Agent 的项目感知长期记忆系统。**

Memhub 为 ChatGPT、Codex、MCP 客户端和其他 AI Harness 提供跨对话、跨设备的持久记忆，同时把不同项目严格隔离，避免“所有历史都塞进一个上下文”。

它从原始对话证据出发，构建项目时间线、长期项目知识和跨项目稳定画像，并把 Skill、Todo、检索、来源追踪与浏览器工作区统一到一个可自托管运行时中。

- **当前版本：** v0.2.4
- **项目 canonical 线上入口：** https://memhub.sanqi.org/
- **下载：** https://github.com/PhSanqi/Memhub/releases

---

## Memhub 解决什么

Memhub 不只回答“该记住什么”，还明确回答：

- **这是谁的记忆？** 一个稳定 account 代表一个人；设备和 Harness 是来源，不是不同用户。
- **哪个项目可以使用？** 先确定项目边界，再做检索；其他项目的业务记忆不会因为“很相似”就混进来。
- **这条记忆从哪里来？** 长期记忆保留回到 L1 原始对话的 evidence / provenance。
- **模型到底应该拿多少上下文？** Retrieval 只在合法候选集里排序，再输出有预算的 Context Capsule。
- **哪些内容应该是可执行能力？** 可复用流程进入 Skill，而不是伪装成第五层记忆。

## 记忆模型

```text
L1  原始对话证据
 │
 ▼
L2  项目时间线
 │
 ▼
L3  项目长期规则、经验与 Current Truth
 │
 ├── 其他项目 L3 ─────┐
 │                    ▼
 └──────────────────► L4  跨项目稳定账号画像

Skill  ─────────────── 与 L1–L4 正交的可复用能力层
```

| 层 | 范围 | 作用 |
| --- | --- | --- |
| **L1** | 项目/账号证据 | 原始对话与来源 |
| **L2** | 项目 | 按时间组织的项目历史 |
| **L3** | 项目 | 长期规则、偏好、经验与 Current Truth |
| **L4** | 账号 | 由多个项目共同支持的稳定模式 |
| **Skill** | 项目或账号 | 带执行生命周期与 telemetry 的可复用流程 |

项目 **Todo** 属于 Project Registry；**Branch** 是项目内部的工作流/任务上下文过滤器。它们都不是新的记忆层。

## 运行结构

```text
AI Harness / MCP / Plugin
          │
          ▼
      Memhub Gateway
          │
   ┌──────┼───────────────┐
   ▼      ▼               ▼
Identity  Project Router  Skill Router
          │               │
          ▼               ▼
     Retrieval v1      Skill lifecycle
          │
          ▼
   Context Capsule
          │
          ▼
      Memory Core

Capture → L1 → 有证据边界的蒸馏 → L2 → L3 → L4
```

Memhub 负责身份、项目范围、证据边界、canonical artifact ID、检索、任务生命周期、provenance 与持久化提交；连接进来的模型/Harness 负责语义综合。服务器不会静默调用某个订阅模型替你完成语义蒸馏。

## 版本选择

| 版本 | 适合场景 | 网络模型 |
| --- | --- | --- |
| **Local** | 单台电脑、本地私有记忆 | 仅 loopback |
| **Server** | 多设备或多个 AI 客户端共享一个账号 | loopback origin + 认证代理/Tunnel |

Local / Server 都支持 Linux 和 Windows。

### 快速安装

从 [最新 GitHub Release](https://github.com/PhSanqi/Memhub/releases) 下载对应平台包。

Complete Linux：

```bash
bash install-complete.sh --edition local
# 或
bash install-complete.sh --edition server --public-host memory.example.com
```

Complete Windows：

```powershell
powershell -ExecutionPolicy Bypass -File .\install-complete.ps1 -Edition local
# 或
powershell -ExecutionPolicy Bypass -File .\install-complete.ps1 -Edition server -PublicHost memory.example.com
```

源码安装：

```bash
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
bash editions/local/linux/install.sh
```

Server、Windows、认证、Cloudflare、迁移和架构说明统一从 [文档首页](docs/README.md) 进入。

## 连接 AI 客户端

Local Edition 默认 Bridge MCP：

```text
http://127.0.0.1:17861/mcp
```

Server Edition 使用部署时配置的认证 MCP 地址。仓库内置的 [Agent Plugin](adapters/plugin/README.md) 提供 MCP 配置，并可在兼容 Host 上接入对话生命周期 capture / recall。

## 日常使用

```text
“读取这个项目的 Current Truth，然后继续。”
“把‘完成 Windows 安装测试’加入这个项目的 Todo。”
“过去一周这个项目改了什么？”
“给我看这条项目规则来自哪些证据。”
“在另一台机器继续使用同一个 Memhub 账号。”
```

当前模型侧 MCP 能力包括：

- `memmy_context`：受预算约束的账号/项目召回与 Skill candidate；
- `memmy_turn`：L1 对话生命周期；
- `memmy_project` / `memmy_project_list` / `memmy_project_manage`：项目解析与生命周期；
- `memhub_todo`：项目 Todo；
- `memhub_branch`：项目内部工作流上下文；
- `memhub_skill`：Skill 加载、telemetry、修订与退役；
- `memhub_distill`：有 evidence boundary 的 L2/L3/L4/Skill 蒸馏；
- `memhub_result`：超大 MCP 结果的渐进式传输。

## Web Workspace

浏览器工作区提供：

- **Overview / Projects**：项目范围、Current Truth、Todo；
- **L1 / L2 / L3 / L4**：原始证据、时间线、项目长期知识、跨项目画像；
- **Skills**：可复用流程与执行状态；
- **Processing**：蒸馏与运行状态；
- **Admin**：账号/项目治理与高影响操作。

项目线上入口为 https://memhub.sanqi.org/。

## 安全与隐私

- Local 与 Server origin 默认只绑定 loopback。
- Server 对公网发布时应放在带认证的反向代理/Tunnel 后面。
- 人类身份和绑定设备最终解析到同一个稳定 `account_id`。
- Project Router 先做范围治理，再进入 Retrieval；相关性不能扩大权限边界。
- L4 只接受跨项目稳定证据，不用于推断敏感属性。
- 破坏性项目操作和 Skill 修订/退役使用显式授权流程。

进一步阅读：[隐私边界](docs/architecture/privacy-boundary.md)、[身份与设备](docs/architecture/identity-and-devices.md)、[远程认证](docs/operations/remote-auth.md)。

## 开发

```bash
npm ci
npm run build
npm test
```

常用检查：

```bash
npm run core:check
npm run memory:audit
npm run state:audit
npm run network:check
npm run process:smoke
```

## 文档

统一从 **[docs/README.md](docs/README.md)** 开始。

当前文档按用途分为：

- 产品与安装指南；
- 架构和数据边界；
- 部署与运维；
- Maintainer 文档；
- 仓库工具仍在使用的内部 UI/Review contract。

已经被取代的修复方案、迁移阶段设计记录不再留在当前文档树中，而由 Git 历史保存，避免旧实现说明被误认为 Current Truth。

## 项目状态

Memhub 正在持续开发。Memory Core 源自开源 Memmy lineage，并作为 Memhub runtime 的一部分维护。版本变化见 [CHANGELOG](CHANGELOG.md)，上游说明见 [Upstream attribution](docs/maintainers/upstream.md)。

## License

见 [LICENSE](LICENSE)。
