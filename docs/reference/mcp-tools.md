# Memhub MCP Tools Reference / Memhub MCP 工具参考

Bilingual reference for Memhub Model Context Protocol (MCP) tools, governance contracts, and progressive disclosure architecture.
Memhub 模型上下文协议（MCP）工具、治理契约与渐进式呈现架构双语参考手册。

---

## Architecture & Governance / 架构与治理原则

1. **One context call per turn / 任务启动单次读取**
   - Call `memmy_context` once at turn start with explicit `project` or `workspace_project` evidence.
   - 任务开始时调用一次 `memmy_context` 并附带显式 `project` 或 `workspace_project` 证据。

2. **Project / Workspace resolution / 项目与工作区解析**
   - Projects resolve strictly from current explicit evidence or exact aliases.
   - `conversation_id` and `continuity_id` are optional transport provenance and **never** select projects or branches.
   - Disagreements between explicit `project` and `workspace_project` fail closed. Never guess.
   - 项目仅由当前轮显式证据或精确别名确定；`conversation_id` 仅用于溯源，不参与项目路由；二者冲突时严格拒绝。禁止猜测。

3. **Plan-Approval-Execute Governance / 计划-授权-执行治理**
   - High-impact mutations (`memmy_project_manage`, `memhub_memory` L3/L4, `memmy_project` Architecture, `memhub_skill` revision/retirement) require a two-phase handshake:
     `action=plan` -> show user full proposed content -> user explicit approval -> `action=execute` with `authorization_id`.
   - 高影响变更一律采用两阶段闭环：`plan` 返回单次授权标识与影响说明 -> 全文展示给用户并获明确授权 -> `execute` 凭 `authorization_id` 执行。

4. **Progressive Disclosure / 渐进式呈现模型**
   - `memmy_context` returns brief bounded envelopes with extractive outlines and query-relevant passages.
   - Full content is hydrated on demand using exact `evidenceRef` via `memhub_memory action=load` or `memmy_project action=architecture`.
   - `memmy_context` 返回瘦身摘要与高相关段落；正文仅在需要时凭 exact `evidenceRef` 按需水合。

5. **Small Ack for Turn Telemetry / Turn 日志精简确认**
   - `memmy_turn` actions (`open`, `checkpoint`, `commit`, `failed`, `truncated`) return a compact acknowledgement without echoing submitted texts. `resume` retains its read payload.
   - `memmy_turn` 除 `resume` 外仅返回精简元数据，绝不回显用户或模型正文。

---

## Tool Catalog / 工具目录

### 1. `memmy_context`
- **Description / 描述**:
  - EN: Reads long-term memory at the start of a task. Bounded extractive brief with query-matched passages. Returns `turnKnowledgePlan` for role assignments. Downstream tools must pass through exact `evidenceRef`.
  - 中文：任务开始时调用一次读取长期记忆。采用抽取式大纲与高相关段落预算控制。返回 `turnKnowledgePlan` 指引知识角色。下游工具必须原样回传 exact `evidenceRef`。
- **Parameters / 参数**:
  - `query`: Current user request or prompt / 当前用户请求或需要补充上下文的问题。
  - `detail`: `"brief"` (default, diet mode) or `"full"` (retains unabridged payload) / 输出模式：brief（默认）或 full。
  - `max_content_bytes`: Total byte budget clamp [2,000, 512,000] / 总内容字节预算上限。
  - `conversation_id`: Transport provenance; does not route project / 可选 transport provenance；不参与项目选择。
  - `continuity_id`: Continuity provenance; does not route project / 可选 continuity provenance；不参与项目选择。
  - `project`: Explicit project canonical slug or alias / 明确项目 slug。
  - `workspace_project`: Workspace-detected project slug; rejects if conflicts / 工作区解析项目；冲突时拒绝。
  - `branch`: Optional project branch scope / 可选项目内 Branch id/name。
  - `semantic_projects`: Candidate project list for semantic fallback / 语义项目候选列表。
  - `capability_projects`: Candidate project list for reusable skill discovery / 可复用 Skill 检索候选项目列表。
  - `cross_project_skills`: Whether to recall cross-project skills (default true) / 是否启用跨项目可复用 Skill 召回。
  - `limit`: Maximum recall count per memory layer / 每类记忆最大召回条数。

### 2. `memmy_turn`
- **Description / 描述**:
  - EN: L1 raw turn lifecycle ledger. Call `open` at task start, `checkpoint` for audit milestones, and `commit` before final response. Returns small ack without echoing full texts.
  - 中文：L1 原始 turn 日志。任务开始 action=open，审计节点 action=checkpoint，完成前 action=commit。返回精简 ack，不回显正文。
- **Parameters / 参数**:
  - `action`: `open | checkpoint | commit | failed | truncated | resume`.
  - `event_id`: Stable L1 event id from `open` / open 返回的稳定 L1 event id。
  - `turn_id`: Harness native turn id / Harness 原生 turn id。
  - `conversation_id`: Transport provenance; not used for routing / 可选 transport provenance。
  - `continuity_id`: Resume continuity key / 可选显式 resume key。
  - `previous_event_id`: Prior event reference / 显式前序 L1 event id。
  - `project`: Explicit project slug / 明确 canonical project。
  - `workspace_project`: Workspace project slug / 工作区项目 slug。
  - `user_text`: Raw user input text / 用户原始输入文本。
  - `assistant_text`: Final assistant text / 助手最终回答文本。
  - `reasoning_summary`: Public audit summary (no hidden chain-of-thought) / 可公开审计的决策摘要。
  - `tool_summary`: Key tool actions summary / 关键工具动作与结果摘要。
  - `limit`: Resume maximum turns (default 12) / resume 最大返回轮数。

### 3. `memhub_memory`
- **Description / 描述**:
  - EN: Progressive-disclosure memory hydration and explicit user-authorized L3/L4 governance. `load` hydrates an exact `evidenceRef`. `why` reviews revision causality. `plan` prepares full canonical replacement; `execute` applies after user approval.
  - 中文：Progressive-disclosure 记忆读取与 L3/L4 治理。action=load 水合单条记忆；action=why 查看证据链；action=plan 准备替换；action=execute 凭 authorization_id 与 confirmation_evidence_ref 执行。
- **Parameters / 参数**:
  - `action`: `load | why | plan | execute`.
  - `evidence_ref`: Exact evidence reference from context / exact evidenceRef。
  - `query`: Concrete query for WHY review / 待审查因果或背景的问题。
  - `max_sources`: Max evidence items per section (default 4) / 每节最大证据数。
  - `kind`: `l3` (project durable) or `l4` (account profile) / 记忆层级。
  - `content`: Complete final canonical content / 完整正文全文。
  - `base_evidence_ref`: Base revision evidence reference / 当前层级 exact evidenceRef。
  - `project`: Project slug for L3 / 明确项目 slug。
  - `workspace_project`: Workspace project for L3 / 工作区项目。
  - `note`: Short reason for mutation / 变更原因简述。
  - `authorization_id`: One-time approval id / 单次授权标识。
  - `confirmation_evidence_ref`: Confirmation turn L1 reference / 用户确认轮 l1:<event-id>。

### 4. `memhub_branch`
- **Description / 描述**:
  - EN: Task and workstream scope within a project. Does not bind to host conversation. Manages task branches for scoped retrieval.
  - 中文：项目内 Branch Context。Branch 是显式 task/workstream scope，不绑定 host conversation。
- **Parameters / 参数**:
  - `action`: `list | create | close | reopen`.
  - `project`: Project slug / 项目 slug。
  - `workspace_project`: Workspace project / 工作区项目。
  - `branch`: Branch identifier / Branch id/name。
  - `name`: Branch name / Branch 名称。
  - `goal`: Workstream goal / workstream 目标。
  - `include_closed`: Include closed branches / 是否包含已关闭 Branch。

### 5. `memhub_skill`
- **Description / 描述**:
  - EN: Skill router and execution lifecycle. `load` gets skill content; `record` logs execution telemetry; `status` views history. Mutations require `plan` and user approval before `execute`.
  - 中文：Skill Router 与执行生命周期。action=load 加载 Skill；action=record 记录遥测；status 查看遥测。修订或退役必须 action=plan 并获授权后 action=execute。
- **Parameters / 参数**:
  - `action`: `load | record | status | plan | execute`.
  - `skill_id`: Skill memory identifier / Skill memory id。
  - `execution_id`: Execution handle / 执行标识。
  - `stage`: `invoked | success | failure | user_correction`.
  - `executor`: Harness executor name / 执行 Harness。
  - `note`: Short summary / 执行结果或纠正摘要。
  - `operation`: `revise | retire`.
  - `content`: Full new skill text / 完整新版 Skill 过程。
  - `title`: Skill title / Skill 标题。
  - `version`: Strictly monotonic semver / 递增版本号。
  - `tags`: Retrieval tags / 业务检索标签。
  - `authorization_id`: One-time approval token / 单次授权标识。

### 6. `memhub_distill`
- **Description / 描述**:
  - EN: Unified L2/L3/L4/Skill distillation entrypoint. Harness performs semantic summarization; Memhub enforces evidence boundaries, scope, leases, and version ledger.
  - 中文：统一的 L2/L3/L4/Skill 蒸馏入口。语义整理由当前 Harness 完成，Memhub 负责证据边界、scope、版本与提交。
- **Parameters / 参数**:
  - `action`: `audit | discover | consolidate | recover_ingest | reconcile_derived | reconcile_l4 | next | renew | submit | skip`.
  - `event_id`: Target event id for recover / 完整稳定 Capture event_id。
  - `kind`: `l2 | l3 | l4 | skill`.
  - `content`: Distilled canonical text / 完整目标层内容。
  - `scope`: `account | project`.
  - `project`: Project slug / 明确项目 slug。
  - `workspace_project`: Workspace project / 工作区项目。
  - `title`: Title / 标题。
  - `tags`: Tags / 业务检索标签。
  - `source_harness`: Harness identifier / 产生沉淀的 Harness。
  - `artifact_id`: Stable canonical artifact id / 稳定的 canonical artifact id。
  - `version`: Version string / 产物版本。
  - `project_description`: Optional 1-3 sentence summary for L2 / L2 附带项目描述。
  - `evidence_refs`: Array of exact evidence references / 精确证据引用。
  - `source_conversations`: Source conversation ids / 产物来源对话 ID。
  - `confidence`: Confidence score [0, 1] / 置信度。
  - `job_id`: Leased job id / leased job id。
  - `lease_seconds`: Lease duration [30, 900] / 租约秒数。
  - `lease_token_supported`: Enable lease tokens / 启用 lease token 协议。
  - `lease_token`: Opaque lease token / opaque lease token。
  - `evidence_offset`: Evidence pagination offset / 大 evidence 分片偏移。
  - `evidence_chunk_chars`: Chunk size / 分片字符数。
  - `inspect_contract`: Contract inspection / 只返回蒸馏规则。
  - `dry_run`: Dry run validation / 校验候选但不写入。

### 7. `memmy_project_list`
- **Description / 描述**:
  - EN: Read-only project registry catalog. Returns summaries by default (`detail=true` for full details). Use query similarity and description to verify existing projects before creating new ones.
  - 中文：只读列出当前账号项目注册表。默认返回摘要（description 最多 280 字符及 pendingTodoCount）；detail=true 返回完整详情。禁止盲目新建。
- **Parameters / 参数**:
  - `detail`: Return full project details (default false) / 是否返回完整详情。
  - `query`: Similarity search term / 可选项目名称/slug/关键词。
  - `include_archived`: Include archived projects / 是否包含 archived 项目。
  - `include_inactive`: Include archived/merged/deleted / 是否包含历史状态。
  - `limit`: Candidate suggestion limit / 相似候选最大数量。

### 8. `memhub_todo`
- **Description / 描述**:
  - EN: First-class project todo management. Uses Project Registry as single source of truth. Do not put todos in architecture docs or L2/L3 memory.
  - 中文：项目待办的一等 MCP 工具。使用 Project Registry 作为唯一事实源，支持 list/add/complete/reopen；禁止把待办写进 Project Architecture、项目 description 或 L2/L3。
- **Parameters / 参数**:
  - `action`: `list | add | complete | reopen`.
  - `project`: Explicit project slug / 明确项目 slug。
  - `workspace_project`: Workspace project / 工作区项目。
  - `text`: Todo text for add / 待办内容。
  - `todo_id`: Todo id for complete/reopen / 待办 id。
  - `status`: Filter status: `pending | done | all` / list 过滤。

### 9. `memmy_project_manage`
- **Description / 描述**:
  - EN: Governed project registry lifecycle management. Mutations require `action=plan` followed by explicit user authorization before `action=execute`.
  - 中文：受控项目管理工具。支持 create/update/archive/unarchive/delete/merge。所有修改必须先 action=plan，并在收到针对该计划的明确授权后才能 action=execute。
- **Parameters / 参数**:
  - `action`: `plan | execute`.
  - `operation`: `create | update | archive | unarchive | delete | merge`.
  - `project`: Canonical slug or current project / 项目 slug。
  - `target`: Target project for merge / merge 目标项目。
  - `name`: Display name / 显示名。
  - `description`: Project description for disambiguation / 项目描述。
  - `aliases`: Explicit alias set / 显式别名集合。
  - `authorization_id`: Plan approval token / 一次性授权 ID。

### 10. `memmy_project`
- **Description / 描述**:
  - EN: Project context and Project Architecture. Architecture replacements require `architecture_plan` and user approval before `architecture_execute`.
  - 中文：项目上下文与 Project Architecture。Project 只由显式证据解析，不保存 host conversation binding。架构替换须经过受控两阶段计划与执行。
- **Parameters / 参数**:
  - `detail`: Summary vs full for list / list 是否返回完整详情。
  - `action`: `list | current | architecture | architecture_plan | architecture_execute | architecture_history`.
  - `project`: Project slug / 明确项目 slug。
  - `workspace_project`: Workspace project / 工作区项目。
  - `query`: Architecture module search query / architecture 模块选择 query。
  - `content`: Canonical architecture markdown / 完整 Architecture 正文全文。
  - `authorization_id`: Plan approval token / 一次性授权 ID。
  - `limit`: Revision history limit / 历史条数。

### 11. `memhub_result`
- **Description / 描述**:
  - EN: Chunked transport continuation for large MCP JSON results. When a result exceeds transport buffer, read subsequent chunks by `result_id` and `next_offset`.
  - 中文：续取被 Memhub 分片的 MCP JSON 结果。当返回 result_transport.mode=chunked 时，按 result_id 和 next_offset 继续读取，按 offset 拼接后解析。
- **Parameters / 参数**:
  - `result_id`: Large result transmission id / 大结果传输标识。
  - `offset`: Starting character offset / 续取起始字符偏移量。
  - `chunk_chars`: Chunk size in characters (default 100,000) / 每次续取字符数。
