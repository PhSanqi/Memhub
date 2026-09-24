# 日常工作流

Memhub 的日常价值不是让用户频繁浏览“记忆数据库”，而是让每次工作恢复更短：先知道当前账号和项目，马上看到下一步与最近 continuity，需要追溯时再进入时间线和原始证据。本页围绕真正的使用动作，而不是围绕内部表结构组织。

## 先确认 Scope，再开始工作

每次重要工作都应该先回答两个问题：当前是谁，当前在哪个项目。账号是人的稳定边界；ChatGPT、Codex、电脑、服务器和 Bridge 都只是来源。项目是业务长期记忆的主要边界。当前轮显式 workspace/project 证据优先于旧 conversation binding；如果当前项目证据含糊，系统宁可 global-only，也不应该猜项目。

User Workspace 顶部 Project Scope 是最直接的检查点。选择“全部项目”时，你应该看到 portfolio overview：多个项目按 pending TODO 与最近更新时间排序。选择具体项目后，才展开 Current Truth、TODO、最近 continuity、L2/L3 状态和 provenance。不要在“全部项目”模式里把一个项目误当成全局事实。

## 工作流一：继续一个已有项目

进入 User Overview，先选择具体项目。第一屏先看 NEXT 与 Recent continuity/Current Truth。NEXT 来自项目 pending TODO；Recent continuity 通常来自 L2 项目时间线中最近稳定的状态。如果这两块已经足够回答“上次做到哪里、下一步是什么”，不需要立刻打开完整 L1/L2。

开始新会话时，可以让 Harness 召回当前项目上下文。正常 recall 优先使用账号 L4 + 当前项目 L3/L2 + 可复用 Skill；只有 bootstrap 或迁移后项目没有 L2/L3 时，才可能临时使用相关 L1。这个策略的目的，是让日常 prompt 不被大量原始历史淹没，同时保留需要时回到证据的能力。

工作结束前，把真正需要下一次继续的动作写入项目 TODO。TODO 不是通用 GTD 系统，也不应该保存长期知识；它表达“下一次 AI 工作应该继续什么”。完成后标记 done，避免 Overview 永远堆积已经完成的动作。

## 工作流二：创建或确认项目

项目注册表包含 canonical slug、显示名、aliases、描述、状态与 TODO。新项目的描述应该帮助路由消歧：写清这个项目是什么、与相似项目有什么区别，而不是写一段营销介绍。Slug 应稳定，后续如果名称变化可通过 aliases 兼容，而不是频繁创建新项目。

当 Harness 当前 workspace 与已注册项目明确匹配时，Context Router 应解析到一个 primary project。如果存在多个相似候选且证据不足，应该先补充描述/alias 或显式指定当前项目。不要通过“默认使用最近项目”来掩盖歧义。

Admin 的 Merge 是高影响操作：source 会转成历史 alias，记忆不会物理重写，但后续 canonical routing 会变化。执行前确认 source/target ID，而不只看显示名。Delete 是逻辑删除，已有记忆保留，但项目退出 active routing。两者都不应该用作日常整理手段。

## 工作流三：管理 TODO

在 Projects 或单项目 Overview 中查看 pending TODO。每条 TODO 应尽量是可执行动作，例如“重新跑 Windows installer smoke 并记录结果”，而不是“继续优化”。如果一个动作已经变成稳定规则或长期经验，它应该进入 L2/L3 的语义蒸馏，而不是永久留在 TODO。

TODO 与项目绑定。切换到“全部项目”时，portfolio 只需要显示 pending count 和最近两条，帮助判断哪个项目需要继续；选中项目后再看完整列表。这样 Overview 保持行动导向，而不是变成一个展开所有项目细节的巨大页面。

如果 TODO 与 Current Truth 冲突，优先核对时间：TODO 可能是旧任务，L2 可能记录了后续决策。完成或取消旧 TODO，比让模型猜哪条更可靠。

## 工作流四：理解 L1 → L2 → L3 → L4

L1 是原始对话证据，追加为主。它回答“这条事实最初来自哪次会话、什么时候、哪个项目、哪个 Harness”。L1 不是用户画像，也不应该把某次临时情绪或第三方说法直接当成长期特征。

L2 是一个项目的 canonical chronology。它把决策、状态变化、替代历史按时间组织，回答“项目发生过什么、现在发展到哪里”。如果某个结论后来被推翻，L2 应保留前后时间关系，而不是只保留最后一句话。

L3 是项目内稳定规则、偏好、经验和工作方式。它来自 L2，不应该直接从孤立 L1 跳过时间判断。L3 回答“在这个项目里长期应该怎么做”。项目 A 的 L3 不能自动进入项目 B。

L4 是账号级画像，只从多个项目重复出现的 L3 证据中形成。一次项目事件不能直接升级成人格结论。L4 回答“跨项目反复成立的稳定工作特征是什么”。

Skill 与四层正交。它描述可复用的执行方法，例如一套前端视觉审计流程。Skill 可以显式跨项目复用，但不能把源项目的业务事实一并带到目标项目。

## 工作流五：从结论追到证据

当 L3/L4 中出现重要结论时，不要只看 summary。先看 artifact 的 project、updated time 和 provenance，再沿 L2 找到形成它的 chronology。如果仍需要核对原话，再进入 L1。这个路径应是“结论 → 时间线 → 原始证据”，而不是每天从数千条 L1 开始搜索。

User 的 L2 页面适合看项目发展；L3/L4 适合看稳定结论；L1 用于审计。Admin 还可以查看 Processing job 的 evidence refs，确认某次蒸馏使用了哪些上游证据。

如果发现错误结论，先判断错误层级。L1 原始证据错误通常意味着 capture/导入问题；L2 时间线错误是归纳或项目 scope 问题；L3/L4 错误可能是上游证据不足、跨项目污染或稳定性判断错误。不同层的修复方式不一样。

## 工作流六：跨对话继续

在会话 A 中明确项目并完成工作，确保 capture 进入 L1。结束前记录必要 TODO。打开会话 B，显式提供当前项目/workspace 证据，让 Harness 调用 Memhub context。检查它是否先拿到 Current Truth、L3/L2 与 TODO，而不是要求你复制整个聊天历史。

如果会话 B 得到错误项目，先检查当前轮 evidence 与 conversation binding。当前轮显式项目应该覆盖旧绑定。如果没有任何明确项目线索，global-only 比猜错项目更安全。

验证成功后再逐渐依赖自动 recall。初期保持项目切换明确，可以更快发现路由问题。

## 工作流七：跨设备继续

Server Edition 下，多台设备连接同一个稳定账号。设备 token 表示机器入口，不创建新的用户人格。设备 A 产生的项目记忆，在设备 B 明确选择同一项目后可以继续使用；但不同设备上的不同项目仍保持项目隔离。

Bridge 的设备凭据可独立撤销。撤销设备不应删除账号长期记忆。反过来，删除一个项目也不应该撤销设备。把身份、设备、项目分成不同控制对象，可以避免安全操作误伤数据。

## 工作流八：使用 Processing

Processing 展示 L2/L3/L4/Skill 蒸馏任务。普通 User 主要看结果状态；Admin 可以配置自动 L1→L2 触发策略。状态优先级通常是 failed > pending/leased > completed。failed 是需要行动的异常，completed 应降噪。

当 L1 有证据但 L2 没变化时，先看是否存在 pending/leased。任务可能在等待阈值或 lease；不要立刻手写长期记忆。当 job failed 时，查看 target、project、reason、evidence refs 与错误信息，再定位模型、证据、验证或存储问题。

## 工作流九：使用 Skills

Skill 是可执行方法，不是业务记忆。好的 Skill 应描述可以重复执行的流程、输入、约束、验收方式，而不是“项目 A 当前使用 PostgreSQL”这种事实。前者可以跨项目，后者属于项目 L2/L3。

调用 Skill 时仍然需要当前项目 scope。Skill 提供“怎么做”，项目记忆提供“在这个项目里做什么、为什么这样做”。两者组合但不合并。

## 工作流十：全部项目 Portfolio

“全部项目”用于回答组合层的问题：哪些项目最近更新，哪些有 pending TODO，哪个项目 Processing 异常，哪些已经形成 L2/L3。它不是把所有项目的完整 Current Truth 拼在一起。

Portfolio 应按行动优先级排序：有 pending TODO 的项目优先，其次按最近更新时间。每条记录只保留项目身份、最近 continuity 摘要、TODO 摘要和层级状态。点击项目后才进入单项目详情。

这种设计也减少跨项目污染风险：用户不会在一个“全球大摘要”里把不同项目事实混在一起。

## 成功验证

- 新会话能在不重复全部背景的情况下继续具体项目。
- “全部项目”显示多个项目，而不是默认展开某一个。
- 选中项目后 Current Truth、TODO、L2/L3 与 provenance 一致。
- TODO 完成后不再作为下一步长期占据 Overview。
- L3 只影响当前项目；L4 有跨项目证据；Skill 不携带业务事实。
- Processing failed 能从 Overview/Admin 快速发现。

## 常见失败与恢复

项目切换后仍看到旧项目内容：检查 URL/project selector、Harness evidence 和 stale binding。先修 scope，再考虑内容修复。

Portfolio 只有一个项目：确认 Project Registry 是否实际存在多个 active projects，检查当前 selector 是否真的是“全部项目”，并确认 API 请求没有携带 project filter。

Recent continuity 为空但 L1 有数据：检查 L2 job 是否 pending/failed，确认是否达到自动触发阈值。必要时由 Admin 检查 distillation policy。

L3 内容太像一次聊天摘要：说明稳定性门槛不足。回到 L2 看是否真的存在多次、长期支持；不要用“写得更像规则”掩盖证据不足。

跨设备无法继续：先确认两个设备映射到同一 account_id，再确认项目相同；不要把设备 token 差异误认为账号不同。

## 平台差异

Local 与 Server 的工作流语义相同。Local 的 scope 错误通常来自本机 Harness/Bridge；Server 还可能多一层 Cloudflare/远程身份。Windows/Linux 差异主要在服务管理与路径，不改变项目、TODO、L1–L4 规则。

## FAQ

### 每次工作都必须手动选项目吗？
不一定。明确 workspace/project evidence 可以自动路由；但当候选模糊时，显式选择比猜测更安全。重要跨项目切换建议确认 scope。

### Current Truth 是单独的第五层吗？
不是。它是面向工作的视图，通常来自最新 L2 chronology 与项目注册信息，用来快速恢复项目状态。

### 为什么全部项目不显示完整 L3？
因为 portfolio 的任务是比较项目与决定下一步，不是跨项目拼接所有业务记忆。完整 L3 应在选中具体项目后查看。

### TODO 会被蒸馏成长期记忆吗？
TODO 本身是行动状态。真正稳定的决策、经验或规则应该通过证据和时间线进入 L2/L3，而不是因为 TODO 存在就自动成为长期事实。

### 我可以直接编辑 L4 吗？
L4 的可靠性来自跨项目证据。治理工具可以处理错误或迁移，但正常产品路径应该让它由多个项目 L3 支持，而不是把它当个人简介表单。

## 相关页面

部署与入口问题看“安装与部署”；数据出站、Cloudflare 与模型边界看“隐私与数据边界”；如果出现 401、错误项目、记忆不更新、failed job 或升级异常，进入“排错与恢复”。

## 多项目同时推进时的工作习惯

当一天内频繁切换多个项目，最容易出错的是把“最近会话”误当成“当前项目”。建议每次跨项目切换都让 Harness 带上 workspace/project evidence，并在 User 顶部确认 scope。对非常相似的两个项目，使用稳定 slug 和清晰 description，不要只靠自然语言标题。

Portfolio 的作用就是在这种场景下帮助决策：先看哪些项目有 pending TODO、哪个最近更新、哪个 Processing 出现异常，然后只展开你准备继续的那个项目。它不应该成为跨项目全文搜索页，也不应该把所有 Current Truth 拼成一个大摘要。

## 项目结束、暂停和恢复

一个项目暂时不做时，优先清理 TODO：完成的标记 done，不再做的取消或重写；保留最后一次 L2 chronology 和稳定 L3。项目状态可以反映 active/retired 等生命周期，但不要为了“列表干净”逻辑删除仍可能恢复的项目。

几个月后恢复项目时，先读 Recent continuity 和最后几段 L2，再看 L3 规则是否仍适用。不要直接假设旧 L3 永久正确；如果外部环境、依赖或目标已经改变，新会话应产生新的时间线证据并更新稳定规则。

## 如何写高质量 Current Truth

Current Truth 不是一段无限增长的项目介绍，而是从最新 chronology 提炼出的“现在成立什么”。好的 Current Truth 应包含当前目标、关键约束、已经确定的决策和下一阶段阻塞；已经被替代的历史留在 L2，不需要全部复制进当前视图。

如果 Current Truth 超过几屏，说明它可能混入了历史。回到 L2 把旧状态保留在时间线上，再让 Overview 只承担恢复工作所需的最小事实。

## 如何判断一个信息应该进哪一层

问三个问题：这是原始事实还是总结？是否需要时间顺序才能理解？是否已经稳定到可以长期影响未来工作？原始对话进入 L1；需要前后状态的项目事实进入 L2；跨多个时间点稳定的项目规则进入 L3；只有多个项目都支持的用户特征才进入 L4。若信息本质是“执行步骤”，考虑 Skill 而不是业务记忆。

这个判断能显著减少“所有东西都塞进长期记忆”的倾向。Memhub 的价值来自边界清晰，而不是层级数量越多越好。

## 前置条件与 UI 示例

开始日常工作流前，至少应存在一个稳定账号、一个已注册项目，并且 Harness 能访问 Memhub context。推荐先用 User Workspace 验证当前 scope，再开始高价值工作。一个典型 UI 路径是：`全部项目 → 选择 memhub → Overview → NEXT / Current Truth → L2 → L1 evidence`。如果只是想判断下一步，停在 Overview；只有需要追溯时间变化时才进入 L2，只有需要核对原始来源时再进入 L1。

另一个典型跨项目路径是：`全部项目 → project A → 完成 TODO → 全部项目 → project B`。切换后顶部 scope、URL project state 和 Current Truth 都应同步改变。若 project B 页面仍显示 A 的业务事实，先停止继续工作并修复 scope；不要让后续 turn 扩大污染。

## 恢复方法

如果一次会话被错误路由，先修当前 project evidence 或 registry alias，让后续 capture 回到正确项目；再依据 provenance 判断已经产生的 L2/L3 是否需要重新蒸馏。若只是 TODO 过期，直接完成/取消 TODO 即可，不需要重建项目。若 Current Truth 过长或混入历史，把旧状态留在 L2 chronology，再让 Overview 收敛为当前状态。
