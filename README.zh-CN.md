# Memhub

[English](README.md)

![Release](https://img.shields.io/github/v/release/PhSanqi/Memhub?display_name=tag)
![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)
![Platforms](https://img.shields.io/badge/platform-Linux%20%7C%20Windows-5b67d6)
![MCP](https://img.shields.io/badge/MCP-ready-7c3aed)
![License](https://img.shields.io/github/license/PhSanqi/Memhub)

**让 AI 不只记住这一轮对话，而是持续记住你、你的项目，以及你正在做的事情。**

Memhub 是一个私有、项目感知的长期记忆中心。Codex、MCP 客户端和其他 AI Harness 可以在不同会话、不同设备之间共享同一个人的长期记忆，同时继续把不同项目隔离开。

它不是单纯的聊天记录数据库。Memhub 会把原始对话逐步整理成项目时间线、项目规则与经验，以及跨项目的长期用户画像；同时提供项目 Todo、Web 管理界面和可复用 Skill。

当前发布线：**v0.2.x** · [查看 Releases](https://github.com/PhSanqi/Memhub/releases)

---

## 你能用 Memhub 做什么

| 能力 | 使用体验 |
| --- | --- |
| **跨对话记忆** | 新开一个会话，也能继续昨天的项目，不必重新解释背景。 |
| **跨设备记忆** | Server Edition 下，Windows、Linux 和不同 AI 客户端可以使用同一个 Memhub 账号与记忆库。 |
| **项目级记忆隔离** | 每个项目有自己的时间线、规则和经验，不会把所有历史上下文混在一起。 |
| **项目 Todo** | 直接让 AI “记个待办”“标记完成”“重新打开”，Todo 不再藏在聊天或架构文档里。 |
| **按时间回看项目** | L2 把项目经历整理成时间线，可以直接回答“这段时间我做了什么”。 |
| **沉淀项目经验** | L3 保存项目长期有效的规则、偏好、踩坑经验和工作方式。 |
| **跨项目用户画像** | L4 提炼多个项目反复出现的稳定习惯，让新项目也能理解你的工作方式。 |
| **Web 管理界面** | 在浏览器里查看 Projects、Todo、L1/L2/L3/L4、Skills 和处理状态。 |
| **本地优先 / 私有部署** | 可以完全单机运行，也可以部署自己的 Server。 |
| **MCP + Plugin** | MCP 客户端可以直接使用；支持生命周期 Hook 的 Harness 还能自动召回与捕获对话。 |

---

## 它解决的是这种体验

你不需要记住工具名。正常情况下，可以直接和 AI 这样说：

> “继续昨天那个项目。”

> “把‘补 Windows 安装测试’记成这个项目的待办。”

> “这个 Todo 已经完成了，标记一下。”

> “按时间告诉我这个项目最近做了什么。”

> “我在这个项目里已经确定过哪些长期规则？”

> “换到另一台机器继续，读取我这个账号的项目记忆。”

Memhub 的目标是让这些动作变成同一个持续上下文的一部分，而不是每次都从零开始。

---

## 一张图看懂

~~~mermaid
flowchart LR
    A[ChatGPT / Codex / MCP Client] --> M[Memhub Account]
    B[Linux Device] --> M
    C[Windows Device] --> M

    M --> P1[Project A]
    M --> P2[Project B]
    M --> U[Cross-project Profile]

    P1 --> T1[Timeline]
    P1 --> R1[Rules & Experience]
    P1 --> D1[Todos]

    P2 --> T2[Timeline]
    P2 --> R2[Rules & Experience]
    P2 --> D2[Todos]
~~~

同一个人可以从不同客户端、不同设备进入同一个 Memhub 账号。设备和 Harness 只是入口，长期记忆最终汇总到这个人的账号里；项目内容则继续按项目隔离。

---

## Memhub 怎么整理记忆

~~~mermaid
flowchart TD
    L1[L1 · 原始对话] --> L2[L2 · 项目时间线]
    L2 --> L3[L3 · 项目规则与经验]
    L3 --> L4[L4 · 跨项目用户画像]
    S[Skill · 可复用能力] -. 独立于记忆层 .-> L3
~~~

- **L1 · 原始对话**：保留实际发生过的对话，作为可追溯证据。
- **L2 · 项目时间线**：按时间整理“这个项目做过什么、改过什么、决定过什么”。
- **L3 · 项目规则与经验**：沉淀这个项目长期有效的偏好、规则、经验和 Current Truth。
- **L4 · 跨项目用户画像**：只保留多个项目重复证明的稳定工作习惯与偏好。
- **Skill**：可复用的执行方法，不属于更深一层记忆。

Web 界面会直接把 L2 展示成时间流，把 L3/L4 展示成可读条目，而不是要求你去看内部 JSON。

---

## 选择安装方式

Memhub 提供 **Local Edition** 和 **Server Edition**，Linux / Windows 都支持。

现在提供两种安装方式：

| 安装方式 | 本机是否需要 Node/npm | 下载体积 | 适合场景 |
| --- | --- | --- | --- |
| **完整安装版** | **不需要** | 较大 | 大多数用户；第一次安装最省事 |
| **便捷安装版** | 需要 Node.js 20+ 与 npm | 较小 | 已有开发环境、希望快速升级 |

两种方式都支持 Local / Server。

| 你想要的体验 | 推荐 |
| --- | --- |
| 只在这一台电脑使用 | **Local Edition** |
| 不想配置公网、反代或服务器 | **Local Edition** |
| 多台电脑共享同一套记忆 | **Server Edition** |
| Windows + Linux 共用一个长期记忆账号 | **Server Edition** |
| 多个 MCP 客户端共用记忆 | **Server Edition** |
| 先快速试用，再考虑服务器 | 先装 **Local Edition** |

### Local Edition

所有内容都运行在本机，默认只监听 loopback。

#### 完整安装版 — 推荐

Linux：

~~~bash
curl -fsSL https://github.com/PhSanqi/Memhub/releases/latest/download/install-complete.sh | bash
~~~

Windows PowerShell：

~~~powershell
$p=Join-Path $env:TEMP 'memhub-install-complete.ps1'; iwr https://github.com/PhSanqi/Memhub/releases/latest/download/install-complete.ps1 -OutFile $p; & $p; rm $p
~~~

完整安装版会下载包含 Node.js runtime 和生产依赖的自包含包，校验 SHA-256 后直接使用包内 Node 运行，不要求电脑提前安装 Node/npm。

#### 便捷安装版 — 下载更小

Linux：

~~~bash
curl -fsSL https://github.com/PhSanqi/Memhub/releases/latest/download/install.sh | bash
~~~

Windows PowerShell：

~~~powershell
$p=Join-Path $env:TEMP 'memhub-install.ps1'; iwr https://github.com/PhSanqi/Memhub/releases/latest/download/install.ps1 -OutFile $p; & $p; rm $p
~~~

便捷安装版会自动解析最新稳定 Release、下载较小的平台/Edition 包并校验 SHA-256；目标机器需要已有 Node.js 20+ 和 npm。

安装后，本地 MCP / Plugin 可以连接：

~~~text
http://127.0.0.1:17861/mcp
~~~

Local Edition 适合个人单机长期使用，不需要 VPS，也不需要 Cloudflare。

### Server Edition

Server Edition 把长期记忆集中到你自己的服务器，各设备通过自己的身份连接同一个账号。

#### 完整安装版 — 推荐

Linux Server：

~~~bash
curl -fsSL https://github.com/PhSanqi/Memhub/releases/latest/download/install-complete.sh | \
  bash -s -- --edition server --public-host memory.example.com
~~~

Windows Server：

~~~powershell
$p=Join-Path $env:TEMP 'memhub-install-complete.ps1'; iwr https://github.com/PhSanqi/Memhub/releases/latest/download/install-complete.ps1 -OutFile $p; & $p -Edition server -PublicHost memory.example.com; rm $p
~~~

#### 便捷安装版 — 下载更小

Linux Server：

~~~bash
curl -fsSL https://github.com/PhSanqi/Memhub/releases/latest/download/install.sh | \
  bash -s -- --edition server --public-host memory.example.com
~~~

Windows Server：

~~~powershell
$p=Join-Path $env:TEMP 'memhub-install.ps1'; iwr https://github.com/PhSanqi/Memhub/releases/latest/download/install.ps1 -OutFile $p; & $p -Edition server -PublicHost memory.example.com; rm $p
~~~

Server 默认仍只监听 loopback。公网入口建议放在 Cloudflare Access 或其他经过认证的反向代理后。

更详细的安装与部署说明：

- [Local Edition](editions/local/README.zh-CN.md)
- [Server Edition](editions/server/README.zh-CN.md)
- [Release Packages](https://github.com/PhSanqi/Memhub/releases)

如果需要开发、调试或手动控制安装目录，也可以 clone 仓库后直接运行 `editions/<edition>/<platform>/install.*`。

---

## 安装后怎么接入 AI

### MCP 客户端

支持 MCP 的客户端直接连接 Memhub MCP 即可。Local Edition 默认通过本机 Bridge：

~~~text
http://127.0.0.1:17861/mcp
~~~

Server Edition 则连接你部署并完成认证保护的远程 MCP 地址。

### Codex / Agent Plugin

仓库内提供 <code>adapters/plugin/</code>，其中包含 MCP 配置、Memhub Skill，以及对支持生命周期 Hook 的 Harness 提供自动 context recall / turn capture。

当前测试过的 Codex Agent Plugin 可以加载 MCP 与 Skill；Hook 的自动注册能力取决于宿主版本。详见 [Plugin README](adapters/plugin/README.md)。

即使宿主不支持自动 Hook，MCP 本身仍然可以正常使用 Memhub 的查询、项目、Todo 和蒸馏能力。

---

## 最方便的几个功能

### 1. 跨对话继续工作

在新的 AI 会话里直接说：

~~~text
读取这个项目的 Memhub Current Truth，然后继续上次的工作。
~~~

Memhub 会优先给 AI 当前项目的时间线、规则与经验，而不是把所有历史聊天一次性塞回来。

### 2. 项目 Todo

~~~text
把“补 Windows 安装测试”加入这个项目的 Todo。
~~~

之后：

~~~text
现在还有哪些未完成 Todo？
~~~

或者：

~~~text
这个 Todo 做完了，标记完成。
~~~

Todo 是独立的一等项目状态，不依赖聊天摘要、README 或架构文档。

### 3. 按时间回顾项目

~~~text
这个项目最近一周按时间都做了什么？
~~~

L2 会按时间整理项目进展，也可以直接在 Web Workspace 的 **L2** 页面浏览。

### 4. 让 AI 记住项目规则

~~~text
这个项目以后 Linux 优先，Windows 也必须保持同一功能语义。
~~~

这类长期有效的信息可以进入项目 L3，而不是永远埋在某一次聊天里。

### 5. 跨设备继续

Server Edition 下，同一个人的不同设备可以绑定到同一个 Memhub 账号：

~~~text
Windows Codex ─┐
Linux Codex   ─┼─→ same Memhub account
Remote MCP    ─┘
~~~

记忆属于人，不属于某一台电脑或某一个聊天客户端。

---

## Web Workspace

Memhub 提供浏览器管理界面，用来查看和治理长期记忆：

- **Overview**：项目、记忆层和当前未完成 Todo 概览；
- **Projects**：项目列表、描述、Todo 和项目状态；
- **L1**：原始对话记录；
- **L2**：跨项目按日期查看“我做了什么”；
- **L3**：每个项目的长期规则与经验；
- **L4**：跨项目稳定用户画像；
- **Skills**：可复用能力；
- **Processing**：蒸馏任务与运行状态。

Admin 视图额外提供治理能力；普通 User Workspace 只操作当前账号的数据。

---

## 隐私与边界

Memhub 的核心原则是：**一个人的记忆可以跨设备，但不同项目不能因为方便而互相污染。**

- Local Edition 可以完全只在本机运行。
- Server Edition 默认只监听 loopback。
- 公网部署需要独立的认证反向代理。
- 人类 OAuth 身份和机器 Device 身份最终都映射到稳定的 Memhub 账号。
- 项目级 L2/L3 不会静默进入另一个项目。
- L4 只保存真正跨项目稳定的个人模式。
- Plugin 配置不需要暴露 Memhub 内部 account_id。

关于远程账号绑定，见 [Identity Linking](docs/IDENTITY_LINKING.md)。

---

## 面向 Agent 的主要能力

日常使用不需要记住这些名字，但如果你在做 Harness 集成，当前 MCP 提供：

- **memmy_context**：读取账号 + 当前项目的相关长期上下文；
- **memmy_turn**：记录一轮原始对话；
- **memmy_project / memmy_project_list**：项目识别和绑定；
- **memmy_project_manage**：受控的项目管理；
- **memhub_todo**：查看、新增、完成、重开 Todo；
- **memhub_distill**：把 L1 整理成 L2/L3/L4/Skill。

更深入的实现、迁移和维护资料放在 [docs/](docs/) 中，主 README 不展开内部实现细节。

---

## 维护与健康检查

日常检查：

~~~bash
npm run core:check
npm run memory:audit
npm run state:audit
~~~

完整开发测试：

~~~bash
npm test
~~~

涉及真实 migration / repair 时，请先阅读 [Core Migration](docs/CORE_MIGRATION.md)。

---

## Release Packages

每个正式 Release 都从同一个源码 commit 生成 Linux / Windows 的 Local / Server 包：

~~~text
Linux Local
Linux Server
Windows Local
Windows Server
~~~

下载入口：

**https://github.com/PhSanqi/Memhub/releases**

---

## 项目状态

Memhub 仍在持续开发中。Memory Core 来源于开源 Memmy lineage，并在 Memhub 中作为长期记忆运行时的一部分继续维护。

- [Changelog](CHANGELOG.md)
- [Edition Design](docs/EDITIONS.md)
- [Plugin](adapters/plugin/README.md)
- [Identity Linking](docs/IDENTITY_LINKING.md)
- [Upstream Notes](docs/UPSTREAM.md)

## License

见 [LICENSE](LICENSE)。
