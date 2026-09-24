# 从安装到第一次连续记忆

这页的目标不是让你先理解所有内部架构，而是让你在最短路径上完成一次可验证的连续工作：选定 Local 或 Server Edition，启动服务，连接一个支持 MCP 或 Bridge 的 AI Harness，产生一段真实对话，然后换到另一个对话或设备，确认项目范围、待办、时间线和证据仍然能够继续使用。完成这条链路之后，再去研究 L1/L2/L3/L4、蒸馏策略和迁移细节会更有意义。

## 适用场景与完成标准

如果你只在一台个人电脑上使用 ChatGPT、Codex 或其他本地 Agent，希望记忆完全留在本机，优先使用 Local Edition。如果你有多台电脑、Windows 与 Linux 混用、需要远程 MCP 客户端，或者希望长期运行一个统一事实来源，使用 Server Edition。两种 Edition 的产品语义一致：账号是“人”的稳定边界，设备与 Harness 只是入口和 provenance；项目是业务记忆的主要边界，Skill 是独立的可复用能力通道。

本页完成标准有五项：服务进程健康；本地或远程 MCP 地址可达；User Workspace 能看到正确账号；当前工作能解析到预期项目；换一个新会话后仍能看到该项目的最近 continuity 或待办。只有“页面能打开”不算完成，因为真正要验证的是长期连续性而不是一个 HTTP 服务。

## 第一步：选择 Local 还是 Server

Local Edition 在一台机器上运行 Memory Core、Memhub Gateway 和 Memhub Bridge。插件统一连接 `http://127.0.0.1:17861/mcp`，不需要 VPS，也不需要 Cloudflare。它最适合第一次试用、个人单机工作站和不希望引入公网入口的环境。Memory Core、Gateway、Bridge 都默认使用 loopback；安装器会为本机账号生成状态目录、Memory Core token 和 Device token。

Server Edition 把 Memory Core 与 Gateway 放在你的服务器 loopback 上，各设备通过经过认证的入口连接同一个稳定账号。Gateway 默认仍不是直接公网暴露的服务；推荐在外层使用 Cloudflare Access 或其他经过认证的反向代理。Cloudflare 负责身份与传输，不是记忆存储或模型推理后端。Memory Core 保持 loopback-only，这条边界不要因为“远程访问方便”而破坏。

如果你不确定，先用 Local。确认产品工作方式符合预期以后，再迁移到 Server。不要为了“以后可能会多设备”一开始就把 Cloudflare、Tunnel、反向代理和远程身份全部加入问题空间。

Release 提供两条安装路径。**完整安装版（Complete）**会把目标系统对应的 Node.js、生产依赖和预构建输出放进包里，不要求预先安装 Node/npm；仓库里的 `install.sh` / `install.ps1` 则继续作为**便捷/源码安装版**，必要时会在目标机器执行依赖安装和 build。

Linux Complete：

```bash
bash editions/complete/linux/install.sh --mode local
# 或
MEMHUB_PUBLIC_HOST=memory.example.com bash editions/complete/linux/install.sh --mode server
```

Windows Complete：

```powershell
powershell -ExecutionPolicy Bypass -File .\editions\complete\windows\install.ps1 -Mode Local
# 或
powershell -ExecutionPolicy Bypass -File .\editions\complete\windows\install.ps1 -Mode Server -PublicHost memory.example.com
```

## 第二步：安装 Local Edition

Linux 上从仓库根目录执行：

```bash
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
bash editions/local/linux/install.sh
```

安装器会准备 Memory Core、Memhub Gateway、Bridge 和本地状态目录，并创建 systemd user services。安装完成以后，插件侧使用：

```text
http://127.0.0.1:17861/mcp
```

Linux 上可以先检查服务：

```bash
systemctl --user status memhub-core.service
systemctl --user status memhub-local.service
systemctl --user status memhub-bridge.service
```

三个服务都应该处于 active/running。Memory Core 默认监听 `127.0.0.1:18960`；Gateway 内部监听 3001；Bridge 对插件提供 17861。插件应该连 Bridge，而不是直接把 Memory Core 暴露给 AI 客户端。

Windows PowerShell 使用：

```powershell
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
powershell -ExecutionPolicy Bypass -File .\editions\local\windows\install.ps1
```

Windows 安装器同样会准备本地 Memory Core、Gateway 和 Bridge。安装后 MCP 地址仍然是 `http://127.0.0.1:17861/mcp`。如果你启用了全局代理，不要为了 Memhub 关闭或修改系统代理；本地 loopback 访问应保持本机路径，远程访问再由你自己的网络策略处理。

## 第三步：安装 Server Edition

Linux Server 示例：

```bash
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
MEMHUB_PUBLIC_HOST=memory.example.com bash editions/server/linux/install.sh
```

Windows Server 示例：

```powershell
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
powershell -ExecutionPolicy Bypass -File .\editions\server\windows\install.ps1 -PublicHost memory.example.com
```

Server Linux 安装器会创建 `memhub-core.service` 和 `memhub-server.service`。Origin MCP 地址是 `http://127.0.0.1:3001/memhub/mcp`，capture 地址是 `http://127.0.0.1:3001/memhub/capture`。这些 origin 地址用于服务器内部验证，不应该直接当作公网客户端配置。公网入口要先通过认证反向代理，再映射到 Gateway。

安装完成以后先在服务器本机验证 origin，再配置外层 Cloudflare Access。顺序不要反过来。否则当远程访问失败时，你无法判断问题来自 Memhub、Tunnel、DNS、Access policy 还是客户端 OAuth。

## 第四步：第一次打开 User Workspace

Local 管理入口使用本地管理员 token；Server 的浏览器入口通常由 Cloudflare Access 身份保护。进入 User Workspace 后首先看两件事：当前账号是否正确，Project Scope 是否符合当前工作。设备名、操作系统、ChatGPT/Codex 并不是新的“用户”，它们只是同一个账号的不同来源。

在“全部项目”范围下，正确行为是看到 project portfolio：多个项目按待办和更新时间排序，而不是自动把某一个项目完全展开。只有明确选中一个项目以后，才应该看到该项目的 Current Truth、TODO、最近 continuity、L1–L4 和 provenance。这个差异是判断项目路由是否正常的最直接方法之一。

## 第五步：连接 AI Harness

支持 MCP 的客户端连接 Memhub MCP。Local Edition 通常连接 `http://127.0.0.1:17861/mcp`。Server Edition 使用你已经完成认证保护的远程 MCP 地址。仓库中的 `adapters/plugin/` 提供 Plugin/MCP 配置和 Memhub Skill；支持生命周期 Hook 的 Harness 还可以自动做 context recall 与 turn capture，但 Hook 的注册能力取决于宿主版本。

第一次连接时不要一次导入大量历史记录。更好的验证方法是用一个具体项目开始一段短工作：先明确 workspace/project 证据，让 Harness 调用 Memhub context，然后完成几轮真实讨论。这样如果路由错误，证据量小，定位容易；如果一开始灌入大量内容，项目污染和 scope 错误会更难发现。

## 第六步：验证项目作用域

Memhub 的规则是：当前轮显式项目/workspace 证据优先于旧 conversation binding。如果新的请求明确来自项目 B，就不能因为上一个会话绑定过项目 A 而继续把业务记忆写入 A。相反，如果当前证据含糊，宁可退回 global-only，也不应该猜一个项目。

测试方法：在项目 A 中完成一段工作，然后切换到明确的项目 B，再回到 User Workspace 检查两个项目的 timeline 与 TODO。A 的业务事实不应该自动出现在 B；如果一个 Skill 被显式复用，它可以跨项目出现，但 Skill 不能携带 A 的业务内容。

## 第七步：验证 L1 与第一次连续性

L1 是原始对话证据层。完成一段真实工作后，打开 L1 检查是否存在对应 turn、时间戳、项目和来源。L1 的目标是可审计，不是让用户每天把所有原始对话重新阅读一遍。正常 recall 更偏向 L4 + 当前项目 L3/L2 + Skills；L1 主要用于证据追溯、bootstrap 和后续蒸馏。

如果 L1 已捕获而 L2 暂时没有更新，不要直接手工伪造 L2。先去 Processing 查看是否存在 pending、leased 或 failed job。自动蒸馏需要满足阈值或 idle 条件；不同环境的任务完成时间可能不同。Admin 可以配置自动蒸馏策略，普通 User 只需要看到处理状态。

## 第八步：换一个会话继续

这是最重要的验收。关闭当前对话，打开一个新的 ChatGPT/Codex 会话，或者在另一个已正确绑定同一账号的设备上开始工作。明确告诉 Harness 当前项目，然后检查它是否能够获取该项目最近 timeline、稳定规则与待办，而不是要求你把全部背景重新讲一遍。

User Overview 应优先显示“下一步”和“最近 continuity”。如果选择“全部项目”，先看到多个项目的概览；如果选择具体项目，再看到 Current Truth、TODO、L2/L3 状态和证据入口。能完成这一步，才说明 Memhub 的核心价值链真正成立。

## 成功验证清单

- Local：`memhub-core.service`、`memhub-local.service`、`memhub-bridge.service` 健康；Server：`memhub-core.service`、`memhub-server.service` 健康。
- MCP 客户端连接的是正确入口；不要把 18960 Memory Core 直接暴露给插件。
- User Workspace 的账号身份符合预期。
- “全部项目”能看到多个 project records，单项目选择后才展开详情。
- L1 能看到真实 turn 与项目来源。
- Processing 没有持续 failed；如果有 failed，先解决失败原因再判断蒸馏是否工作。
- 新会话能够恢复最近 continuity 或 TODO。
- 项目 B 不会自动带入项目 A 的业务记忆。

## 常见失败与恢复

如果 Workspace 返回 401，先判断这是正常的认证边界还是服务失败。Server 公网入口匿名 401 往往是预期行为；Local loopback 管理则使用独立 local-admin token。不要为了绕过 401 把整个 Gateway 改成匿名公网服务。

如果项目不对，先检查当前 Project Scope、Harness 提供的 workspace/project evidence 和 conversation binding。显式当前项目应该覆盖陈旧绑定。不要直接删除全部记忆；先修路由，再处理少量错误记录。

如果 L1 没有新记录，检查 capture/Bridge 链路；如果 L1 有但 L2/L3 没更新，检查 Processing；如果 Processing failed，查看 job 详情和 evidence refs。问题应该沿“入口 → 身份 → 项目路由 → L1 → job → Memory Core”逐层定位。

如果服务升级后异常，先做 `npm run core:check`、`npm run memory:audit`、`npm run state:audit`。涉及 schema 迁移时使用 `core:preflight`、`core:verify`、`core:preserved` 提供的备份与 durable fingerprint，不要只保存可重建索引。

## 平台差异

Linux Edition 使用 systemd user services，因此排错重点是 unit 状态、journal 和 loopback 监听。Windows Edition 使用对应 PowerShell installer 与本地启动方式，端口和产品边界与 Linux 一致。不要把“服务管理方式不同”误解成“记忆模型不同”。

Local 与 Server 的差异也不是 L1–L4 语义，而是入口与部署边界。Local 不需要公网认证；Server 必须把远程入口放到认证层后面。两者 Memory Core 都应保持私有。

## FAQ

### 我应该先导入历史聊天吗？
不建议把历史导入作为第一次验证。先用一个真实项目跑通 capture、scope、continuity，再考虑历史迁移。这样更容易判断问题来自旧数据还是当前运行链路。

### 一个账号可以有多少设备？
设备是账号的入口，不是独立用户。可以有多个设备，但每个设备凭据应可独立撤销，且远程 Bridge 的 Cloudflare Service Token 与 Memhub Device Token 不应该直接暴露给 AI 插件。

### 为什么不直接把所有历史放进 prompt？
因为这会失去项目边界、时间状态和证据层级。Memhub 的目标不是无限拼接历史，而是让模型拿到当前项目需要的长期上下文，并在需要时能够回到原始证据。

### Skill 为什么不属于 L5？
Skill 是可执行方法，不是从 L1 逐层蒸馏出来的业务记忆。它可以显式跨项目复用，因此与 L1–L4 是正交关系。

## 相关页面

继续阅读“安装与部署”了解 Local/Server × Linux/Windows 的完整部署步骤；阅读“日常工作流”了解 TODO、项目 scope、证据追溯与跨设备连续性；阅读“隐私与数据边界”明确哪些内容留在本机/服务器、Cloudflare 能看到什么、模型调用何时可能产生数据出站；遇到问题时进入“排错与恢复”。

## 第一次 30 分钟演练

为了避免“服务装好了但不知道记忆是否真的工作”，建议第一次使用固定做一个 30 分钟演练。前 5 分钟只做环境确认：Local 检查 17861/3001/18960 与三个 user service；Server 检查 core/server service、3001 origin 与外层认证。不要在这一阶段配置复杂项目，也不要导入旧历史。

接下来的 10 分钟创建或选择一个你确实在做的小项目，例如“memhub-docs-smoke”。项目描述写清目标和边界，然后在 Harness 中完成三到五轮真实工作。内容可以很简单，例如确认一个 README 修改、讨论一次接口行为、记录一个明确下一步。关键是这些 turn 必须带有清晰 project evidence，之后在 User Workspace 的 L1 能找到它们。

第 15–20 分钟检查 Processing 与项目 Overview。若 L2 尚未生成，记录当前 pending/leased 状态，而不是立刻认为失败；如果 job failed，则保留 job ID 与 evidence refs。若已经有 L2，检查 chronology 是否对应刚才发生的事实，没有把其他项目内容混进来。然后添加一个 TODO，例如“下一会话验证 Windows 安装说明”。

最后 10 分钟打开一个全新会话。只提供当前项目信息，不复制前面聊天。让 Harness 获取 Memhub context，并观察它是否能识别 TODO 与最近 continuity。再切回“全部项目”，确认 portfolio 中该项目的更新时间和 pending count 发生变化。完成这一演练，说明入口、scope、capture、processing、recall 和 UI 六个环节至少都走通了一次。

## 什么时候算“可以正式使用”

只有当你完成两次以上跨会话恢复、至少一次项目切换、一次 evidence trace，并且没有出现跨项目污染时，才建议把 Memhub 纳入日常依赖。第一次 smoke 通过只能证明基础链路可用，不能证明长期蒸馏质量已经稳定。

正式使用初期建议每周抽查一次：随机从 L3 选一条规则，沿 L2 回到 L1；随机检查一个项目 TODO 是否过期；检查 Processing 是否存在长期 failed/leased；检查“全部项目”是否能快速回答哪个项目需要继续。这个抽查比单纯统计记忆条数更能发现质量问题。

如果你计划迁移已有长期历史，先保留一个“纯新数据”项目作为对照。历史导入后如果系统表现异常，可以比较新项目与迁移项目，判断问题来自当前 capture 链路还是 legacy 数据，而不是把所有异常归因于模型。
