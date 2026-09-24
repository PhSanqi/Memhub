# 隐私与数据边界

Memhub 处理的是高敏感数据：原始对话、长期用户记忆、项目决策、项目架构、从私有内容生成的 embedding，以及账号/项目标识。理解隐私不能只问“数据是否在本地”，还要区分存储、网络、模型、身份、项目和设备六类边界。本页把每一层的默认行为、可变配置和验证方式拆开说明。

## 默认原则：Memory Core local-only

Memory Core 是长期数据平面，默认只允许 loopback。仅仅配置一个远程 URL 不等于授权私有内容出站。vendored Memory Core 的 network policy 对模型/embedding HTTP、远程 storage backend 和 raw Memory REST client 都执行默认拒绝：loopback HTTP/HTTPS 可以使用，非 loopback 目标需要调用方显式做 code-level `allowRemote: true` 决策，这个 escape hatch 不作为普通终端用户配置暴露。

这条原则意味着：如果你希望使用远程模型做语义蒸馏，必须明确知道是哪个 Harness/模型在处理哪些证据；不能因为 Gateway 是远程的就推断 Memory Core 也远程，也不能因为摘要已经“脱敏”就把它当低敏数据。

## 数据分类

原始 conversation turns 属于高敏感数据，默认本地。L2 项目时间线、L3 项目规则和 L4 用户画像同样高敏感，因为它们可能比单条聊天更集中地表达项目与个人信息。项目架构 Markdown、决策记录和 embedding 也属于私有数据。Derived data 并不会因为“只是摘要/向量”就自动降低敏感级别。

账号 ID、项目 ID、设备 ID 虽然通常不包含正文，但属于私有控制信息，用于身份、路由和 provenance。安装器下载 release metadata 属于低敏网络流量，应该与记忆内容出站分开审计。

## Local Edition 的边界

Local Edition 把 Memory Core、Gateway 和 Bridge 放在同一机器，默认 loopback。插件连接 `127.0.0.1:17861/mcp`，Bridge 再访问本地 Gateway。这个结构的好处是：插件不需要直接接触 Memory Core token，公网也没有必要参与。

如果本机安装了全局代理，Memhub 不应该修改用户代理设置。loopback 是否被代理软件特殊处理由用户环境决定；排错时确认本机端口与 Host/Origin，而不是关闭全局代理来“验证”。

Local 并不意味着所有数据永远不会离开机器。如果你连接的 AI Harness 使用云模型，Harness 可能把它召回的上下文发送给模型提供商。Memhub 能控制 recall scope 和 evidence boundary，但不能替你改变外部 Harness 的模型隐私政策。因此本地存储边界与模型处理边界必须分别理解。

## Server Edition 的边界

Server Edition 把 Memory Core 与 Gateway 放在服务器 loopback。建议的拓扑是：Internet AI host → authenticated HTTPS/MCP → Cloudflare Access/Tunnel → Memhub Gateway → loopback Memory Core。Gateway 是唯一预期公网 ingress；Memory Core 不直接发布。

Cloudflare 接收认证和传输流量，但不是 Memory Core 的存储后端，也不是语义蒸馏模型。你仍需要根据自己的 Cloudflare 配置、日志策略和所在地区评估元数据处理；产品边界只说明 Memhub 不把 Cloudflare 当长期记忆数据库。

Server 多设备共享记忆依赖稳定 account_id。人类登录身份由 Access JWT 映射到账号；机器 Bridge 使用独立设备凭据。设备 token 可以撤销，不应该成为永久用户 ID。

## 人类身份与机器身份

公开浏览器或 Hosted MCP 请求属于人类身份路径。Cloudflare Access 验证用户后，Memhub 验证 JWT issuer/audience/signature/sub/verified email，再解析到稳定账号。内部 role 存储在 Memhub，不信任客户端伪造 role。

机器 Bridge 不是一个“人”。它可以使用 Cloudflare Service Token 通过边缘层，再用 Memhub Device Token 在 origin 选择账号与设备。两个 token 作用域不同，应分别轮换与撤销。

不要把 Device Token、Service Token、local-admin token 放进项目描述、TODO、L1 对话或 prompt。凭据属于控制平面，不属于长期记忆内容。

## 项目边界

项目隔离是隐私边界的一部分。一个账号可以有多个项目，但项目 A 的业务事实不应因为同一用户而自动进入项目 B。Context Router 正常解析一个 primary project；当前轮显式 workspace/project evidence 优先于旧 binding；证据含糊时可以 global-only。

L3 是项目级长期规则。只有多个项目反复支持的稳定特征才进入 L4。这个设计避免一次敏感项目事件被错误泛化成账号全局画像。

Skill 是独立 capability channel。Skill 可以跨项目复用方法，但不得携带项目业务事实。审核 Skill 时要问“这是可复用过程，还是项目知识被包装成了 Skill”。

## 模型处理边界

语义蒸馏由连接的 ChatGPT/Codex/Claude/其他 Harness 模型执行。Memhub 负责 evidence bounds、target layer/scope validation、canonical artifact identity、provenance、job lease/completion/retry 和 durable commit。模型负责理解、抽象和综合。

这意味着“是否调用云模型”不是由 Memory Core 自动决定，而取决于你连接的 Harness 和模型配置。想要严格本地处理，就必须同时选择本地存储和本地/可信模型执行路径。

当 job 进入模型处理前，应该只包含目标层需要的 bounded evidence。不要为了“模型可能需要更多上下文”把账号所有项目原始历史一起发送。

## Embedding 与派生数据

Embedding 来自私有内容，仍属于私有数据。默认 Memory Core network policy 对远程 embedding HTTP 同样控制。不要因为 embedding “不可读”就认为可以无条件发送到第三方。

如果未来启用远程 embedding 或 remote storage，应把它当显式架构变化审计：目标地址、传输加密、provider 日志、数据保留、删除机制、失败回退都需要记录。

## Capture 与索引边界

L1 的 authoritative source 是 Memhub state root 下的 per-turn capture JSON；`capture-index.sqlite` 主要存可重建元数据，用于项目/会话过滤、计数、阈值调度和 idle scheduling。dirty ledger 在 raw/index 状态转换前写入，异常中断时可以根据原始 capture 重建受影响索引。

因此备份策略不能只复制索引。原始 capture、Memory Core durable DB、项目注册和账号/设备控制状态都要考虑。索引坏了可以重建；原始证据丢了则无法从索引恢复。

## 浏览器 Control Plane

User/Admin 页面会展示账号、项目、待办、记忆层与 Processing。公开 Server 上它们必须位于认证边界之后。匿名 401 是正常保护，不应该为了方便审计而关闭认证。

Admin 可以进行项目 merge/delete、账号 role、distillation policy 等高影响操作，因此不仅需要“登录”，还需要稳定 Admin role。高影响操作应明确当前 account/project scope，并在 UI 中展示影响说明。

## 日志与诊断

排错日志可能包含 project ID、job ID、错误消息和路径。把日志发给第三方前先检查是否包含 raw turn、token、email、内部 host 或项目正文。故障诊断不应成为新的数据泄漏路径。

Server 的 Cloudflare/Tunnel 日志与 Memhub 自己的运行日志属于不同系统。确认谁能访问、保留多久、是否包含 URL/query 等元数据。

## 备份与迁移

升级前运行 migration preflight，保留 rollback snapshot 与 durable fingerprint。备份应该存放在与你风险模型一致的位置；如果把本地私有记忆复制到公开云盘，相当于改变了存储边界。

恢复后使用 `core:verify` / `core:preserved` 确认 durable identities 与 schema 保留，而不是只看服务启动。恢复完成后再验证 account/project scope，避免旧绑定导致数据被写入错误项目。

## 数据删除与逻辑删除

项目 Delete 当前是逻辑删除：项目退出 active routing，但已有记忆保留。这是为了可审计和避免破坏历史 provenance。它不等于“彻底擦除所有与项目有关的个人数据”。如果你的需求是法律或安全意义的完全删除，需要单独定义 durable data purge 流程，不能用项目逻辑删除冒充。

Merge 同样不会物理重写历史，它改变 canonical project 与 alias 关系。操作前应理解目标项目会成为后续路由中心。

## 如何验证隐私边界

Local：检查 17861/3001/18960 都只在预期 loopback；确认插件连 17861。Server：检查 18960/3001 origin 只在服务器本机；公网只能通过认证域名进入。使用网络工具验证，而不是仅相信配置文件。

检查 User/Admin 是否在匿名请求下被拒绝；检查正常账号和 Admin role 是否区分。撤销一个 Device Token，确认该设备失效但其他设备与账号记忆仍然存在。

检查一个项目的 L3 是否不会出现在另一个项目 context；检查 Skill 可以复用但不带业务事实。最后检查模型配置，确认你知道召回内容最终由哪个模型处理。

## 常见误解

“用了 Cloudflare，所以内容都存 Cloudflare”是错误的；Cloudflare 在目标架构中是身份/传输边界。

“用了 Local，所以 AI 内容绝不会离开电脑”也不一定；如果 Harness 使用云模型，prompt/context 仍可能发送给 provider。

“摘要比原文安全，所以 L3/L4 可以随便外发”也是错误的；摘要往往集中包含更有价值的长期信息。

“同一账号的项目天然可以互相读取”不符合 Memhub 边界。账号统一身份，但业务记忆仍按项目隔离。

## 平台差异

Linux/Windows 的数据分类与隐私语义相同。差别主要是服务管理、文件路径与 token 保存方式。Server/Local 的核心差异是公网入口和认证，不是是否使用 L1–L4。

在企业或受监管环境中，还需要叠加你自己的磁盘加密、服务器访问控制、备份合规、模型 provider 协议和数据驻留要求；Memhub 的默认边界不能替代组织安全政策。

## FAQ

### Memhub 会把记忆卖给广告商吗？
Memhub 自托管架构的长期记忆存储由你控制。真正需要审计的是你部署的服务器、反向代理和连接的模型提供商，而不是假设所有组件共享同一隐私政策。

### 我能把 Memory Core 放到另一台机器吗？
默认产品路径不建议。远程 storage/model 是显式架构变化，需要经过 network policy 与风险审计。Server Edition 的推荐方式是把 Gateway 与 Memory Core 放在同一服务器私有边界。

### Cloudflare Service Token 能否替代 Memhub Device Token？
不能。前者通过边缘访问控制，后者在 Memhub origin 选择并约束设备/账号；两者职责不同。

### 项目逻辑删除会清掉所有历史吗？
不会。它主要改变 active routing。需要彻底数据删除时应采用专门 purge 方案，并评估 provenance、备份和合规影响。

### 为什么 L4 要求多个项目证据？
因为账号级结论影响范围更大。跨项目重复证据可以降低把单次事件错误泛化为长期用户特征的风险。

## 相关页面

部署公网入口前先阅读“安装与部署”；日常如何保持项目隔离与证据追溯见“日常工作流”；出现身份、scope、capture、job、数据库或升级问题时使用“排错与恢复”的分层诊断路径。

## 建立自己的威胁模型

在正式部署前列出至少四类主体：本机普通用户、拥有服务器 shell 的管理员、能够通过 Cloudflare/IdP 登录的人、连接的 AI 模型/服务提供商。对每类主体分别回答“能看到哪些内容、能执行哪些操作、凭据如何撤销、日志保留在哪里”。只有这样，“私有”才是具体边界而不是宣传词。

Local 的主要风险往往来自本机账号、磁盘、恶意插件和云模型；Server 还增加公网认证、反向代理、服务器管理员与远程设备。不要因为 Server 使用 HTTPS 就忽略 origin 与备份权限，也不要因为 Local 没公网就忽略插件和模型出站。

## 最小权限建议

普通 User 只需要读取自己的记忆、项目、TODO 与 Processing 状态，不需要修改账号角色或蒸馏策略。Admin 才能管理账号、项目 merge/delete 和 policy。设备凭据只允许代表绑定账号的机器入口，不应该自动获得 Admin Web 权限。

凭据轮换时一次只撤销一个边界：Cloudflare Service Token 影响边缘机器认证；Memhub Device Token 影响 origin 设备身份；local-admin token 影响 loopback 管理。分开轮换可以确认失效范围符合预期。

## 数据最小化与召回最小化

长期存储最小化和每次召回最小化是两件事。即使 L1 为审计保留较长历史，正常 context recall 也不应把所有 L1 发送给模型。优先 L4 + 当前项目 L3/L2 + Skill，只有证据核对时再下钻 L1。

在敏感项目中，可以进一步减少 Project Description、TODO 与 summary 中不必要的个人识别信息。项目路由只需要足够消歧，不需要复制客户名单、密钥或完整合同正文。

## 隐私审计清单

每次发布或改变模型/网络配置后至少检查：Memory Core 是否仍只在 loopback；Gateway 是否仍位于认证边界；匿名 Admin 是否被拒绝；一个设备 token 撤销后是否仅影响该设备；跨项目 recall 是否保持隔离；远程模型配置是否有明确批准；备份是否在受控位置；日志是否意外记录 token/raw prompt。

把这份清单和 deterministic deployment evidence 一起保存，比单纯保存一张架构图更有价值，因为它说明边界在实际运行中确实成立。

## 前置条件、命令与 UI 示例

进行隐私审计前，应知道自己运行的是 Local 还是 Server、Memory Core/Gateway/Bridge 分别在哪台机器、公开 host 是什么、Harness 使用本地还是云模型、备份存在哪里。缺少这些事实时不要先下“数据都在本地”或“Cloudflare 看不到内容”之类结论。

Local/Server 都可以先检查监听边界：

```bash
ss -ltn | grep -E '17861|3001|18960'
```

Server 再分别检查 origin 与公网入口。UI 示例：匿名打开 `/admin` 应被认证层拒绝；合法 User 打开 `/user` 应只能看到自己的账号范围；只有 Admin role 才能进入管理页面。设备撤销后，该设备应失效，但同一账号其他设备和长期记忆仍可用。

## 失败诊断与恢复方法

如果发现 18960/3001 意外直接公网监听，先停止公网暴露并恢复 loopback/认证代理，再检查访问日志和凭据是否需要轮换。若 Device Token、Service Token 或 local-admin token 疑似泄露，按各自作用域单独撤销/轮换，不要把一个 token 的泄露误当成必须删除全部记忆。

如果跨项目出现隐私污染，先停止相关自动 job，修复 Context Router/项目绑定，再沿 L4→L3→L2→L1 provenance 确认影响范围。只有受影响 artifact 需要治理时，不要通过清空整个账号来掩盖边界问题。恢复后重新执行项目隔离测试与匿名/角色权限测试。
