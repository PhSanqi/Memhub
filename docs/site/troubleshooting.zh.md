# 排错与恢复

排错的核心原则是先确定故障层，再修改最小范围。Memhub 有入口、身份、账号、项目路由、L1 capture、Processing job、Memory Core、Control Plane、反向代理等多个边界；“记忆没工作”只是现象，不是根因。不要一看到异常就清空状态目录、重装所有服务或删除项目。

## 诊断顺序

推荐固定顺序：进程/端口 → HTTP 入口 → 身份 → account scope → project scope → L1 → Processing → L2/L3/L4 → UI。这个顺序从确定性最强的层开始，能避免把模型语义问题误判成网络问题，也避免用重装掩盖 scope 错误。

记录每一步的事实：命令、状态码、当前账号、当前项目、job ID、evidence refs。不要只写“看起来好了”。修复完成以后用同样步骤复验。

## 症状：页面打不开或服务端口不存在

Linux 先检查：

```bash
systemctl --user status memhub-core.service
systemctl --user status memhub-local.service
systemctl --user status memhub-bridge.service
systemctl --user status memhub-server.service
```

Local 不会同时需要 server service；Server 也不需要 local/bridge 作为服务器核心。根据 Edition 选择对应 unit。再看端口：

```bash
ss -ltn | grep -E '17861|3001|18960'
```

如果 Core 不健康，先修 Core；Gateway/Bridge 依赖 Core，后面的失败可能只是连带现象。查看 journal：

```bash
journalctl --user -u memhub-core.service -n 100 --no-pager
```

然后检查对应 Gateway unit。常见原因包括 Node 路径变化、仓库移动、环境文件丢失、端口占用或状态目录权限错误。

## 症状：Local MCP 连接失败

Local 插件默认连 `http://127.0.0.1:17861/mcp`。先从本机验证 Bridge 是否监听，再确认 Bridge 配置指向本地 Gateway。不要把插件直接改成 18960 Memory Core。

如果本机浏览器能访问但插件不能，检查宿主 MCP 配置、代理/no_proxy 行为、插件版本和协议路径。保留用户全局代理设置，不要通过关闭代理来“修复”产品。

如果 17861 不存在但 3001 正常，问题在 Bridge；如果 3001 也不存在，继续向 Gateway/Core 上游定位。

## 症状：Server 公网 401

先判断 401 是否预期。匿名访问受 Cloudflare Access 保护的 `/user`、`/admin` 应被拒绝。已登录用户访问 Admin 但不是 Admin role，也应该被拒绝。

在服务器本机测试 origin 3001；如果 origin 正常而公网 401，检查 Cloudflare Access policy、JWT audience/issuer、Host header 与账号绑定。如果公网完全绕过认证反而能访问 Admin，这才是严重安全问题。

Local loopback 管理使用独立 local-admin token。Cloudflare 请求不能伪装成本地管理路径。

## 症状：404 或路径不一致

Memhub 支持 base path rewrite。某些部署内部路径是 `/memhub/*`，公开 root base 可能映射为 `/`、`/user`、`/admin`、`/docs`。不要根据一个环境的 URL 猜另一个环境。

Server Origin MCP 路径是 `/memhub/mcp`，capture 是 `/memhub/capture`。网页和 MCP 是不同入口。确认反向代理没有把 `/mcp` 错误转到 Web UI 或反过来。

## 症状：账号不对

先确认当前页面显示的账号和认证身份。稳定 account_id 才是产品用户边界；email/sub 是外部身份解析证据。不要通过改前端 query 参数绕过账号权限。

如果同一人被意外创建成两个账号，先检查 IdP subject/email linking 历史，再决定绑定/迁移策略。不要直接合并数据库行，因为项目、设备和 provenance 都依赖 account scope。

## 症状：项目上下文错误

查看 Project Scope selector、当前 workspace/project evidence、Project Registry 的 slug/aliases/description，以及 conversation binding。当前轮显式项目证据应该覆盖陈旧 binding。

如果两个项目名称相近，补充描述与 alias 进行消歧。证据不足时接受 global-only，不要为了“体验顺滑”默认最近项目。

修复 scope 后检查后续新 capture 是否进入正确项目。已经污染的旧记忆要按层级审计，不要因为一条错误就清空所有项目。

## 症状：“全部项目”只看到一个项目

确认 selector 真的是空 project filter；检查 Projects API 是否返回多个 active project；检查前端请求 URL 是否意外保留 `project=` 参数；再检查项目状态是否被逻辑删除。

正常“全部项目”是 portfolio overview：每个项目一条 compact record，按 pending/recency 排序。只有选中具体项目才展开 Current Truth 与 TODO。如果 UI 展开了单项目，很可能是前端 scope 状态没有正确清空，而不是后端只有一个项目。

## 症状：L1 没有新证据

沿 capture 路径检查：Harness 是否真的提交 turn、Bridge/capture endpoint 是否可达、Device Token 是否有效、事件是否已经 ingest。L1 authoritative source 是 per-turn capture JSON；索引只是可重建元数据。

如果索引异常但原始 capture 在，系统可以重建索引。不要反过来把 index 当唯一事实来源。

## 症状：L1 有数据但 L2/L3 没更新

打开 Processing。pending 表示等待执行，leased 表示任务已被 worker/模型处理，failed 才是明确异常。自动 L1→L2 受完成轮数和 idle 条件影响，不一定每一轮立即生成新 timeline。

Admin 可以检查自动蒸馏 policy。不要为了让 UI “立刻有 L2”把阈值设成 1 并永久保留；过低阈值可能产生碎片化时间线。

如果 job failed，记录 target、project、reason、evidence refs 与错误信息。判断是模型失败、证据范围验证失败、Memory Core 写入失败还是上游 artifact 不存在。

## 症状：L3/L4 内容不可信

L3 应来自项目 L2 的稳定模式；L4 应有至少两个项目 L3 支持。如果 L4 只有单项目证据，检查 L4 gate 和历史迁移数据是否混入。Legacy Policy/World Model 或旧 user_memories 不应该被当作当前 L2/L3/L4 语义直接展示。

如果内容语义错误，先追 provenance。修正上游 L2/L3 后再重新蒸馏，比直接编辑最终文字更可靠。

## 症状：Processing 长时间 leased

确认任务租约是否过期、worker 是否仍存在、网络/模型调用是否卡住。不要同时启动多个不具备隔离的 worker 去抢同一 job。Memhub job lease/completion/retry 负责幂等和重试边界。

如果 worker 已崩溃，按运行时设计让 lease/retry 恢复，而不是直接把数据库状态手工改成 completed。

## 症状：Admin Merge/Delete 不符合预期

Merge 将 source 项目转为历史 alias，后续 canonical routing 指向 target；历史记忆不会物理重写。确认 source/target ID，不只看显示名。

Delete 是逻辑删除，项目退出 active registry，但 durable memory 保留。它不是“彻底清除项目数据”。如果操作后项目仍在历史 artifact 中出现，这是正常 provenance，不代表删除失败。

高影响操作执行前确认当前 account scope。多账号 Admin 场景尤其不要在错误账号上操作。

## 症状：升级后数据库或 schema 异常

升级前应执行：

```bash
npm run core:preflight
```

如果已有 manifest，升级后：

```bash
npm run core:verify -- --manifest <manifest>
npm run core:preserved -- --manifest <manifest>
```

`verify` 检查冻结副本；`preserved` 检查 durable row identities 与 schema 保留。数据库 integrity 失败时不要继续写入；优先恢复 rollback snapshot。

如果只有可重建索引失败，重建索引比回滚所有 durable 数据更合适。

## 症状：长期记忆污染或旧 scope 数据混入

先运行：

```bash
npm run memory:audit
npm run state:audit
```

审计优先，不要直接 repair。确认问题范围和可恢复性以后再运行对应 apply/tidy 流程。旧 legacy 导入不能自动成为账号级用户画像。

## 症状：浏览器页面布局或交互异常

先区分数据问题与 UI 问题。Network/API 数据正确但界面错，检查 URL state、project selector、viewport、theme/lang 和 console errors。User/Admin 都应在 390/768/1024/1440 真实 CSS viewport 下无 root horizontal overflow。

Drawer 必须有 focus trap、Escape close、focus restore；背景自动刷新不能在 drawer 打开期间替换触发节点。若焦点恢复失败，检查是否存在 silent refresh race，而不是只在测试里强制 focus。

## 症状：远程请求偶发超时

先确认 Gateway 本地响应时间；再看反向代理、Tunnel、DNS 和客户端。公网 curl 超时但本地 3001 正常，不能直接归因于 Memory Core。反过来，本地 API 也慢时再分析 Core/search/job。

不要通过无限增加客户端 timeout 掩盖长期不响应。记录哪一层开始变慢。

## 症状：模型调用或 embedding 被阻止

Memory Core 对非 loopback 网络默认拒绝。检查是否有人把 remote model/storage 配置成普通终端用户路径。需要远程模型语义处理时，推荐通过 Harness 明确承担模型调用，而不是偷偷改变 Core network policy。

如果产品设计确实需要远程存储或 embedding，应作为显式架构变更审核 `allowRemote`、目标 host、数据类别与恢复策略。

## 恢复策略

恢复前先停止产生新写入的路径，明确备份/manifest。能修配置就不要回滚数据；能重建索引就不要覆盖 durable DB；只有 durable 数据或 schema 确认损坏时才使用 rollback snapshot。

恢复后依次验证 Core integrity、Gateway、身份、项目、L1、Processing、L2/L3。不要只因为网页恢复 200 就宣布数据恢复完成。

## 最小诊断清单

```bash
npm run core:check
npm run memory:audit
npm run state:audit
npm test
```

生产部署还应检查实际 systemd/Windows process、监听地址、认证状态和页面/API 标记。代码测试通过不等于运行进程已经加载新 build。

## 平台差异

Linux 使用 systemd/journal，服务依赖关系更直观。Windows 重点检查 PowerShell installer 生成的启动路径、Node 路径、端口和用户权限。产品层诊断顺序保持一致。

Local 多一层 Bridge 17861；Server 多一层远程认证代理。定位故障时把这些额外层分别加入链路，不要改变核心顺序。

## FAQ

### 重装能解决大部分问题吗？
不建议把重装作为第一选择。它可能暂时消除配置症状，却同时丢失定位 evidence，甚至覆盖状态。先判断故障层。

### 为什么匿名 /admin 返回 401？
如果部署使用认证边界，这是正常结果。真正的问题是合法 Admin 身份仍无法访问，或匿名反而可以访问。

### 可以直接删除 failed job 吗？
先看失败原因和 evidence refs。删除记录会丢失诊断线索，并可能让上游问题继续产生新失败任务。

### 项目错了是不是删除项目最快？
不是。先修 Context Router evidence/binding。逻辑删除会改变未来 routing，但不会自动修正历史 artifact。

### 怎么判断修复真的成功？
用原始失败场景重新执行，并记录状态码、账号、项目、L1/job/artifact 结果。不要用“页面看起来正常”替代链路验证。

## 相关页面

如果根因是部署、服务、端口或 Cloudflare，回到“安装与部署”；如果是账号/项目/记忆使用方式，阅读“日常工作流”；涉及远程模型、Cloudflare、token、备份位置和数据出站时阅读“隐私与数据边界”。

## 建议的故障记录模板

每次较复杂故障建议记录：发生时间、Edition/OS、版本或 commit、用户看到的症状、第一条可重复命令、最后一个确定正常的层、当前账号、当前项目、相关 job/event ID、是否涉及远程代理、执行过哪些变更、恢复点在哪里。这样下一次同类问题不会从“重新猜一次”开始。

例如“User 页面空白”不是足够记录；应该写成“2026-09-22 Server/Linux，公网 /user 登录后 200，但 API kind=projects 返回 500；本地 3001 同样 500；memhub-core active；错误只影响 account X；回滚前 snapshot Y”。这种记录可以直接缩小到 Gateway/Control Plane 数据路径。

## 恢复演练

不要等真正事故才第一次测试恢复。可以在隔离状态根目录做一次演练：运行 preflight 得到 snapshot/manifest，复制环境，模拟索引损坏或停止服务，然后按文档恢复；完成后对比 durable fingerprint、项目数量、一个 L2 artifact 和一个 TODO。演练过程中不要使用唯一生产备份。

恢复演练还应包括“程序代码没坏，但项目 scope 错了”的逻辑事故。准备两个测试项目，故意给会话错误 binding，再用当前轮显式 evidence 修正，确认新 capture 回到正确项目。这样可以验证不是所有事故都需要数据库回滚。

## 什么时候应该停止自动修复

如果出现数据库 integrity 失败、无法确认备份状态、多个项目大范围 scope 污染、凭据疑似泄露，应该先停止新写入和自动 job，再做审计。继续让模型自动蒸馏会扩大影响范围。

同样，如果你不确定一个删除/merge 是否可逆，不要因为 UI 有按钮就继续操作。先确认 source/target、durable history 和恢复方案。高影响操作的最佳“自动化”不是更快执行，而是更快确认影响边界。

## 修复完成后的复验

每次修复至少验证原始失败场景、相邻一层和最终用户目标。例如修复 Cloudflare 401 后，不只看 200，还要验证 User account 正确；修复 project routing 后，不只看 selector，还要产生一条新 L1 并确认进入正确项目；修复 Processing 后，不只看 job completed，还要确认目标 L2/L3 artifact 更新且 provenance 正确。

最后记录服务 PID/启动时间与 build 标记，避免“磁盘代码已修、运行进程仍是旧版本”。对网页修复还要用真实 CSS viewport 的 review pack 验证，而不是只看浏览器缩放截图。

## 升级、回滚还是内容修复：如何选择

如果故障发生在新版本启动后、旧版本数据 fingerprint 仍然可验证，并且错误涉及 schema/启动配置，优先考虑版本回滚或配置修复。如果服务运行正常但少量 L2/L3 语义错误，优先做内容审计和重新蒸馏，不需要回滚整个程序。若错误来自 project routing，则修复路由与后续 capture，数据库回滚往往不能解决根因。

一个实用判断是：先问“错误是否影响 durable 数据结构”“是否仍在持续产生错误写入”“能否用确定性工具验证”。影响 durable schema 且仍在写入时应尽快停止写入；仅 UI/展示错误可在服务保持运行时修前端并做 review；模型语义错误则保留 evidence，针对目标 artifact 修复。把故障类型和恢复动作对应起来，能避免最常见的过度回滚。

## 什么时候需要寻求人工复核

当系统无法确定项目归属、L4 证据跨项目冲突、高影响 merge/delete 已执行但影响范围不清楚，或备份 manifest 与当前 durable state 不一致时，应停止自动决策并人工复核。此时“继续自动跑直到成功”会降低可恢复性。保留日志、snapshot、job/evidence ID，再由人明确目标状态，是更安全的恢复路径。

## 前置条件

开始排错前先保留现场：不要删除状态目录、不要重装、不要手工改数据库 job 状态。记录 Edition、操作系统、当前版本、服务启动时间、账号、项目、出现问题的 URL/命令与最近一次确定正常的时间点。如果涉及升级或迁移，先确认 rollback snapshot / manifest 是否存在；如果涉及凭据泄露，先停止相关入口的新请求再继续诊断。

排错机器上还应具备最基本的本机检查能力：能查看进程/服务状态、loopback 端口、HTTP 状态码与日志。Server 场景需要同时能区分 origin 和公网入口，否则很容易把 Cloudflare/DNS 问题误判为 Memory Core 问题。
