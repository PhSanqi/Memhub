# 安装与部署

**第一次使用请选全新安装。** Local 适合单机，Server 适合多设备共享你自己的账号。官网/GitHub Pages 是静态介绍，不提供登录或托管记忆服务；请勿用别人的站点工作区作为安装入口。只有确实运行过早期版本并保留旧状态的用户才需要迁移流程，不需要为了验证迁移主动安装旧版本。

本页覆盖 Memhub 的 Local / Server × Linux / Windows 四种组合，并把“安装成功”的定义从“脚本退出码为 0”提升到“服务、入口、身份、项目和恢复路径都经过验证”。如果你只是第一次试用，优先 Local；如果明确需要多设备、长期在线或远程 MCP，再选择 Server。

## 安装前先理解三个边界

第一，Memory Core 是私有数据层，默认绑定 loopback，不要把 18960 直接发布到公网。第二，Memhub MCP runtime 默认监听 loopback 3001：Local 客户端直接连接它，Server 则通过 Cloudflare Access/Tunnel 等认证反向代理把公网 `/mcp` 转到同一个 runtime。Local 与 Remote 只有传输/认证路径不同，不维护第二套 MCP 实现。

安装脚本会创建账号、token、状态目录和运行配置。请把 `MEMHUB_HOME` 或默认状态目录视为需要备份的数据，而不是临时缓存。Capture 原始证据、项目注册、会话绑定与 Memory Core 数据库承担不同职责，不能只备份其中一个 SQLite 文件就认为系统可恢复。

## Local Edition：Linux

从仓库根目录执行：

```bash
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
bash editions/local/linux/install.sh
```

安装器默认使用 `MEMHUB_HOME=$HOME/.memhub`。它为 Memory Core 准备配置和本地 SQLite，Memory Core 监听 `127.0.0.1:18960`；Memhub MCP runtime 使用 3001。systemd user units 包括 `memhub-core.service`、`memhub.service` 与 `memhub-stack.target`。

安装完成后依次检查：

```bash
systemctl --user status memhub-core.service
systemctl --user status memhub.service
ss -ltn | grep -E '3001|18960'
```

成功状态不是“所有端口都对公网监听”，恰恰相反，默认应看到 loopback。MCP 客户端使用：

```text
http://127.0.0.1:3001/mcp
```

3001 与 18960 都只在本机可见是期望结构。不要为了让客户端连接方便而把 18960 改到 `0.0.0.0`；AI 客户端只连接 3001 的 `/mcp`。

## Local Edition：Windows

首次在 Windows 安装 Memhub，直接执行新装流程即可；**不需要先安装旧版、制造旧定时任务或执行历史迁移**。仅当这台机器原本确实运行过早期 split-task 版本时，旧实例升级才是需要单独审计的场景；不能把隔离测试当作实际旧实例迁移证明。

PowerShell：

```powershell
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
powershell -ExecutionPolicy Bypass -File .\editions\local\windows\install.ps1
```

Windows 安装器同样生成本地账号和 Memory token，并准备 Memory Core 与 MCP runtime。客户端地址是：

```text
http://127.0.0.1:3001/mcp
```

如果系统有全局代理，不要修改用户的网络全局设置。loopback 请求应继续走本机，代理规则由系统和用户自己控制。排错时先直接验证 3001 本机可达，再判断是否是宿主、浏览器或代理软件拦截。

## Server Edition：Linux

Linux Server：

```bash
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
MEMHUB_PUBLIC_HOST=memory.example.com bash editions/server/linux/install.sh
```

安装器创建与 Local 相同的 `memhub-core.service`、`memhub.service` 与 `memhub-stack.target`。Memory Core 仍在 `127.0.0.1:18960`；MCP origin 在：

```text
http://127.0.0.1:3001/mcp
```

先在服务器上验证 origin。只有 origin 健康以后，再配置 Cloudflare Tunnel / Access。推荐排错顺序：本机进程 → loopback HTTP → Host/public-host 校验 → Tunnel → Access policy → 远程客户端 OAuth/MCP。这样任何一步失败都能明确归属。

`MEMHUB_PUBLIC_HOST` 用于 Gateway 的 public host 约束，不意味着 Gateway 应直接监听公网地址。公网 DNS 指向 Tunnel 或认证反向代理，而不是把 Node 进程暴露在 Internet。

## Server Edition：Windows

首次部署 Server 与旧实例迁移是两条不同的流程。新装按以下步骤进行；如果机器上已有 Memhub 状态或定时任务，应先核对来源、备份和所有权，不要用新装命令直接覆盖已有实例。

PowerShell：

```powershell
git clone https://github.com/PhSanqi/Memhub.git
cd Memhub
powershell -ExecutionPolicy Bypass -File .\editions\server\windows\install.ps1 -PublicHost memory.example.com
```

Windows Server 的产品边界与 Linux Server 一致：Memory Core 私有、Gateway loopback、外层认证代理负责公网入口。脚本会把 `PublicHost` 传给 Gateway。安装完成以后先在本机测试 3001，再做远程认证。

## Cloudflare Access 与远程身份

Server Edition 推荐 Cloudflare Access 作为人类身份边界。Memhub 验证 Access JWT，再把外部身份映射到稳定 `account_id`。账号角色保存在 Memhub 内部，不信任浏览器随意传入的 role header。

机器客户端与人类浏览器可以使用不同的认证交互，但最终都必须映射到稳定 `account_id`。远程 MCP 客户端在 Cloudflare/OAuth 边界完成认证；认证凭据不应该进入 AI prompt，也不应该写入项目记忆。

匿名访问 `/user` 或 `/admin` 在受保护 Server 上返回 401 可能完全正常。判断服务是否故障，需要同时检查 origin、本地认证和 Cloudflare 边缘状态。

## 安装后健康检查

仓库提供多层检查：

```bash
npm run core:check
npm run memory:audit
npm run state:audit
```

`core:check` 用于 Memory Core 运行与 schema 基线；`memory:audit` 检查长期内容卫生；`state:audit` 检查本地状态结构。它们解决不同问题，不应该用一个命令的“成功”代替其他层的验证。

浏览器侧还要验证 User Workspace 与 Admin。User 应看到正确账号与项目范围；Admin 需要明确 account/project scope、Processing 状态和项目边界。安装完成但账号映射错误，同样不能算部署成功。

## MCP 与 Harness 连接

Local MCP 客户端直接连接 runtime：

```text
http://127.0.0.1:3001/mcp
```

Server 远程客户端使用经过认证保护的外部 MCP URL。不要把 origin `127.0.0.1:3001` 填到另一台机器上；它只对服务器本机有意义。

客户端直接使用 MCP endpoint。Agent 每轮使用 Memhub 时应先调用 `memmy_context`，携带当前请求和显式 `project/workspace_project` 证据，再调用 `memmy_turn action=open`；最终回答前调用 `memmy_turn action=commit`。conversation/session id 仅为可选 provenance，不作为项目、Branch 或蒸馏批次的路由键。

## 升级前备份与 preflight

涉及 Memory Core schema 或长期状态升级时，先使用迁移 preflight：

```bash
npm run core:preflight
```

preflight 会进行 vendored-runtime 完整性检查、在线 rollback snapshot 和 durable fingerprint。完成变更后使用：

```bash
npm run core:verify -- --manifest <manifest>
npm run core:preserved -- --manifest <manifest>
```

`verify` 用于冻结副本的精确比较；`preserved` 检查 schema 变更后 durable 表与基线行身份是否保留。只复制 `capture-index.sqlite` 之类可重建索引不是可靠备份。

## 卸载与恢复

Local Linux 提供 `editions/local/linux/uninstall.sh`，Windows 有对应 `uninstall.ps1`；Server 也有各自卸载脚本。执行卸载前先确认脚本会处理哪些服务和配置，并单独保留你希望恢复的状态目录。不要把“停止服务”“删除程序代码”“删除长期记忆”当成同一个动作。

如果升级后服务无法启动，优先恢复服务配置或 rollback snapshot，再做内容级修复。若数据库 integrity 正常但索引异常，可重建索引；若 durable 数据本身出现问题，应使用 migration manifest 与审计工具判断，而不是直接重建整个状态根目录。

## 常见失败：服务没有 active

Linux 使用：

```bash
systemctl --user status memhub-core.service
journalctl --user -u memhub-core.service -n 100 --no-pager
```

Local 与 Server 都检查 `memhub.service`。如果 core 失败，MCP runtime 往往只是连带失败，不要先改外层 Cloudflare。

如果 Node 路径、仓库路径或权限发生变化，systemd unit 仍可能引用旧位置。检查 unit 的 `ExecStart` 和环境文件，修复引用以后 `systemctl --user daemon-reload` 再重启。

## 常见失败：远程 404 / 401 / Host 拒绝

404 首先检查路径。Server Origin MCP 是 `/mcp`，网页入口仍是 `/memhub` 及其子路由；不要把浏览器页面路径与 MCP transport 路径混在一起。

401 要区分匿名被拒绝和已认证仍被拒绝。匿名访问 Admin 被拒绝是正确安全行为；已登录账号没有 Admin role 时同样应该被拒绝。Host validation 失败则检查 `MEMHUB_PUBLIC_HOST` 与反向代理 Host header。

## 平台差异

Linux 的优势是 systemd user service 与 journal 诊断明确；Windows 更依赖 PowerShell installer 和本地启动脚本。两者端口与数据语义相同。Server 与 Local 的差异主要是部署和认证，而不是 Memory Core 内部模型。

如果你在 Windows 工作站上需要长期服务器记忆，也可以把 Server 放在 Linux VPS，然后让 Windows 只作为远程 MCP 客户端；没有必要为了 Windows 客户端而运行 Windows Server Edition。

## 安全检查

- Memory Core 18960 不应直接公网可达。
- Gateway 公网入口必须经过认证层。
- OAuth/Access token 等认证凭据不应进入 AI prompt 或项目记忆。
- Admin 高影响操作前确认当前 account/project scope。
- 删除项目是逻辑删除，改变后续路由；不要把它当作“清空所有历史”。
- Merge 会改变 canonical project 与 alias 关系，执行前检查 source/target ID。

## FAQ

### 可以把 Gateway 直接绑定 0.0.0.0 吗？
技术上网络层可以这样做，但这不是推荐 Server 边界。推荐保留 loopback origin，使用经过认证的代理发布。这样身份与公网暴露面更清晰。

### Cloudflare 会存我的 Memory Core 吗？
不会。Cloudflare 在目标结构中承担身份与传输边界，不是 Memory Core 存储后端。具体网络流量仍取决于你的代理与模型配置，因此隐私页会进一步区分 authentication traffic 与 memory-content egress。

### Local 能以后迁移到 Server 吗？
可以规划迁移，但应把 durable 状态、账号、项目注册与 Memory Core 一起视为迁移对象，并在迁移前后使用 preflight/fingerprint 验证。不要只复制一个数据库文件后假设全部状态已迁移。

### 为什么还要区分 Memory Core 和 MCP runtime？
Memory Core 是私有持久化/检索数据层；MCP runtime 承担账号、项目、上下文、工具协议与远程身份边界。AI 客户端只连接 MCP runtime，Memory Core token 不暴露给客户端。

## 相关页面

第一次部署完成后阅读“日常工作流”，用一个真实项目验证 continuity；部署到远程前阅读“隐私与数据边界”；遇到端口、认证、项目或蒸馏异常时按“排错与恢复”的分层路径定位。

## 安装后的发布验证清单

部署完成后不要马上把地址交给所有客户端。先做一次“从内到外”的发布验证。Local 从 Memory Core 开始，确认 18960 仅 loopback，再确认 3001 `/mcp`。Server 从 18960 Core 到 3001 `/mcp` origin，再到 Tunnel/Access 和公网 `/mcp`。每经过一层都记录协议结果，这样公网失败时能知道是哪一层开始不同。

Server 的浏览器验证至少包括：首页或 Docs 公共页面返回 200；匿名 User/Admin 返回认证挑战或 401；合法 User 身份能进入 User；Admin role 才能进入 Admin；公网 MCP endpoint 能完成协议握手。不要用浏览器首页 200 代替 MCP 验证，也不要用 MCP 可用代替 Admin 权限验证。

部署后再检查 Host/Origin validation。`MEMHUB_PUBLIC_HOST` 应与真实公开 host 一致；如果反向代理改写 Host，需要保证 Gateway 接收到允许值。错误做法是为了通过验证关闭 Host/Origin 检查，因为那会把一个配置问题变成安全边界缺失。

## 配置与状态目录应该怎么备份

备份最少要覆盖 Memory Core durable 数据、L1 原始证据、账号、Project Registry、distillation state 和迁移所需 manifest。可以重建的索引与可以重新下载的 release 文件优先级较低。每次大版本升级前先做完整 preflight，再执行文件级备份；如果只复制数据库而遗漏 Project Registry，恢复后可能出现“记忆还在但项目路由丢了”的半恢复状态。

备份文件本身同样包含敏感数据。Server 用户不要把备份直接放到公开对象存储；Local 用户也不要因为是“个人电脑”就忽略磁盘加密与备份权限。恢复测试应在隔离目录完成，不要拿唯一生产备份直接做实验。

## 升级演练

升级前记录当前版本、服务 PID、端口、项目数量、Memory Core durable fingerprint 和一条可验证的项目 continuity。执行 `core:preflight` 后再更新代码/包。升级完成后依次跑 build/test、core verify/preserved，再重启实际服务。最后用之前记录的项目做 continuity smoke：如果代码测试通过但运行进程仍是旧 build，这个 smoke 会立刻暴露问题。

升级失败时优先回到最近一个已验证的 snapshot，而不是在生产库上连续尝试多个 schema 修复。每次恢复后都要重新验证账号与 project scope，因为迁移后的 routing 状态与 durable memory 同样重要。

## Windows 与 Linux 的服务生命周期差异

Linux systemd user service 默认与用户 session/linger 配置相关。如果机器重启后服务没有自动起来，检查 user service enable 状态与 linger，而不是把脚本重复安装一遍。Windows 需要确认启动脚本或任务运行在正确用户上下文，Node 路径和状态目录没有因为管理员/普通用户切换而改变。

路径中包含空格时，Windows 启动脚本必须正确引用；Linux 仓库移动后 unit 中旧的绝对路径也会失效。两个平台都应把“程序路径”“状态路径”“凭据路径”分开理解，不要把代码仓库删除等同于删除长期数据。

## 生产环境变更纪律

修改公网 host、Access policy、账号 role/允许列表、项目 merge/delete、Memory Core schema 都属于不同风险等级。一次只改一类边界并完成验证，再继续下一类。不要在同一次维护窗口同时重配 Cloudflare、迁移数据库、升级 Node 和重建项目注册，否则失败后几乎无法定位根因。

对外发布新网页也应遵循同样原则：先 build + E2E + responsive review，再重启 Gateway，最后从公网检查页面标记。网页静态改动虽然不触碰 Memory Core，但 Gateway 重启仍会短暂影响 MCP，因此应该被视为运行切换而不是“只是改 CSS”。

## 防火墙、代理与 DNS 验证

Local Edition 正常情况下不需要为 3001/18960 打开入站防火墙，因为客户端与服务都在本机 loopback。若安全软件阻止本机进程通信，应针对具体进程或 loopback 规则诊断，而不是把端口开放到局域网。Server Edition 同样不需要把 18960/3001 直接开放给公网；外部只需要到达认证反向代理/Tunnel。

配置域名后，先确认 DNS 指向预期 Tunnel/代理，再确认 TLS 证书与 Access policy。公网域名能解析但 origin Host 不匹配时，Gateway 可能拒绝请求，这是安全校验正常工作。使用 `curl` 分别测试 origin 与 public URL，记录状态码差异。企业代理环境中如需 `HTTP_PROXY/HTTPS_PROXY/NO_PROXY`，应由部署环境明确设置；不要让安装脚本擅自重写用户全局代理。

## 部署完成后的交付记录

建议把以下信息写入运维记录，但不要记录明文 token：Edition、OS、安装版本、仓库或 release 来源、状态根目录、公开 host、服务 unit/启动方式、MCP 对外地址、最近一次 preflight manifest、备份位置、Admin 账号绑定方式。这样几个月后升级或迁移时，不需要从机器现状反向猜部署结构。

交付记录还应包含一次验证证据：一个项目名、一个 pending TODO、一次跨会话 continuity，以及验证时的服务启动时间。它们能证明“服务正在运行”和“长期记忆链路实际工作”是同一版本的事实，而不是两个不同时间点的假设。
