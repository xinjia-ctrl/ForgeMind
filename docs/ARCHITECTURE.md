# ForgeMind 架构设计文档（ADR）

> 版本：v3.0 code line（对齐 `docs/PRD.md`）
> 状态：本地参考实现；能力边界见 `docs/LIMITATIONS.md`
> 技术栈：TypeScript / Node（>=22），单一进程、运行时零第三方依赖（无 DB / MQ / 框架）
> 演进总览：v0.2 闭环 → v0.3 可观测 → v0.4 安全 → v0.5 记忆/提示词 → v1.0 DAG/多仓库 → v2.0 企业集成/RBAC/审计 → v3.0 主动监测/有界协商/语义记忆/质量回馈

---

## 1. 设计原则

1. **简单** —— 采用"编排者 + 阶段化流水线 + 单条返工回路"，不引入通用 Agent 消息总线 / 事件引擎 / 队列；并发通过独立的 DAG 内核实现。
2. **可靠** —— 一切 Agent 交互通过不可变契约与结构化事件落地；失败分类明确，结果可回放。
3. **可扩展** —— Agent / Tool / LLM / Memory / Dispatcher 均为窄接口，为后续迭代预留接缝。
4. **可维护** —— 模块边界 = 目录边界；状态机、预算、路径安全、命令策略、触发判定均有独立测试。
5. **安全与可观测是底线** —— 纵深防御 + 全量审计，任一层缺失不会静默降级。

**关键架构决策（ADR-1）：仅 CODE 使用受限执行循环，门禁和提交保持确定性。**

PLAN、可选 ARCH 和 REVIEW 各做一次结构化模型判断。CODE 使用最多 10 轮的观察/小动作/新证据循环，每轮只能返回 1–3 个已定义动作；只有动作和工具观察连续相同且 workspace 未变化时才判定无进展，读取新内容、搜索新结果、todo 或行动方向变化都会继续。相同失败动作只有在没有成功动作介入且观察也相同时才触发重复失败；`fast-check` 可在修复后重新执行。`finish` 只结束 CODE，不能跳过独立 TEST/REVIEW。Test Gate 和 Commit Executor 不调用模型。

- 收益：CODE 能根据真实编辑和测试反馈改变策略，同时工具、轮次、Token、动作日志和最终验收仍可审计。
- 约束：模型不能注册新工具或命令；外部文本、仓库文件、diff、记忆和返工内容一律是不可信数据。

**ADR-16：主动性是外层控制面，不是第二套执行引擎。**
主动触发只生成 `AgenticRunRequest`；dispatcher 必须复用 `runForgeMind` / `runDagForgeMind`，主动与手动 Run 的门禁、沙箱和记忆行为保持一致。

**ADR-17：异构输入先归一化，边界校验失败即拒绝。**
GitHub、Jira、CI 与内部审批事件统一转换为 `DevelopmentEvent`。触发规则不得直接读取供应商原始 payload。

**ADR-18：触发判定确定性、有界、默认不执行。**
规则按配置顺序匹配第一条；仓库不在白名单、事件无规则、字段不合法时均不触发。去重、合并、冷却、限流和配额在 dispatch 前完成。

**ADR-19：消费游标只能在 dispatch 成功后推进。**
轮询事件先判定并 dispatch，再提交 poller cursor，避免"事件已消费、Run 未创建"的丢任务窗口。

**ADR-20：主动 Run 的权限只能收紧。**
主动 actor 固定为 `agentic/developer`；风险经 `低→中、中→高、高→高` 变换；工具和命令必须同时命中 agentic allowlist 与既有 stage policy。

**ADR-21：冲突默认一次裁决，多轮协商只显式启用。**
默认 `OneShotConflictResolver` 在一个 rubric 下读取双方证据，输出选择、理由、风险和带具体 verifier 的必须验证项；每一项都会转成新的 `AcceptanceCriterion`，无法绑定就停止运行。只有参与方确实拥有不同模型、工具、仓库上下文或权限时，调用方才显式启用最多三轮的 `NegotiationProtocol`。DAG 产物冲突键是 `repo:path`，不同仓库的同名文件不冲突；裁决验证必须注入共同的待运行下游任务，没有承接任务就禁止生成提交候选。

**ADR-22：semantic 是项目事实的检索索引，不是第四套事实层。**
`SemanticMemory` 只索引受治理的项目文档：默认提供零运行时依赖的确定性词法向量 + BM25，外部向量服务可经 `EmbeddingProvider` 接入。召回结果保留 entry id、来源、时间和置信度，并按 entry id/内容哈希跨来源去重后取 top-k。单次拒绝和尚未通过独立门禁的架构输出不会晋升为长期经验；`repositoryRoots` 是跨项目召回的显式授权边界。

**ADR-23：主动层以单一原子 checkpoint 保持跨重启一致性。**
`FileAgenticStateStore` 同步保存 poller cursor、事件 TTL 去重、对象冷却、pending、滑动窗口限流、每日配额与 dispatch retry。每个 dispatch 在外部调用前先落盘，成功后才清除；cursor 只在批次内事件都处理完成后提交。恢复语义为 at-least-once，稳定 `ruleId:eventId` 必须作为下游幂等键。损坏、超限或配置漂移状态 fail-closed。

**ADR-24：本地 Web 只是运行适配层，不是第二套编排器。**
`src/web/` 仅处理 loopback HTTP、目录选择、输入校验、单 Run 状态投影和报告访问；实际执行必须调用 `runForgeMind`，阶段进度只读投影同一 EventLog。服务默认只绑定 `127.0.0.1`，目录浏览限定用户主目录，同时只允许一个活动 Run。浏览器只提交供应商 ID、模型名和非敏感运行参数；API Key 只在服务端从 `.env` 解析，不进入页面、请求体、Job 或 EventLog。

**ADR-25：供应商兼容停留在 ChatProvider 边界，Agent 契约不分叉。**
`src/llm/provider-catalog.ts` 是 Web 常用供应商、官方端点、后端密钥变量和推荐模型的唯一目录；页面只消费服务端返回的安全投影，不复制端点或模型常量。`OpenAICompatibleChatProvider` 依据官方端点与模型做最小协议适配：`api.deepseek.com` 的 DeepSeek V4 以及 `open.bigmodel.cn` 的 GLM 4.5+ 请求固定 `thinking.type=disabled`，结构化请求使用供应商支持的 `json_object`；DashScope 的 Qwen 使用 `json_object`；OpenAI、Kimi 与其他兼容端点保持 `json_schema`。429、5xx、短暂网络错误与 `insufficient_system_resource` 在 Provider 边界最多额外重试两次；永久鉴权/参数错误不重试。DeepSeek 官方端点使用 11 分钟请求上限以覆盖其长排队连接。`finish_reason=length` 立即转换为明确的 `StageFailure`，不把截断 JSON 交给下游验证。结构化能力开关在 CLI/Web 组合根构造 Provider 时确定，Agent 只读取 Provider 能力位，因此供应商切换不会产生 Agent 分叉。

---

## 2. 架构总览

```
                事件源：GitHub / Jira / CI / 审批超时
                 │ webhook 共用入口 / poller
                 ▼
Active Layer ── src/agentic/（v3.0）
  normalize → trigger（去重/冷却/限流/配额）→ guardrail（actor/风险升级/白名单）
                 │ AgenticRunRequest
                 ▼
Dispatcher ── runDagForgeMind / runForgeMind（复用，非第二套引擎）
                 │
                 ▼
CLI / Local Web / API（src/runtime/cli.ts / src/web/ / src/runtime/run.ts）
  │ 校验 run/repo/测试配置 → 建分支 forgemind/<runId> → 建 EventLog
  ▼
DAG 内核（src/dag/）—— 跨仓库多任务（v1.0）
  DagPlanner → DagScheduler（并发 + 依赖 + repo:path 冲突裁决）→ ForgeMindTaskRunner（每任务一个 worktree）
  ▼（单任务或 DAG 子任务均进入）
Orchestrator（src/core/orchestrator.ts）—— 唯一决策中枢，持有 Run 级状态机
  │  确定性 profile → PLAN → optional ARCH → CODE loop → TEST → REVIEW → COMMIT
  │  ├─ 共享 RunBudget + RunManifest + phase checkpoint + CODE action journal
  │  └─ 默认 OneShotConflictResolver；多轮 NegotiationProtocol 仅显式启用
  ▼
Stage runners（src/agents/*）
  │       ├─ PLAN / optional ARCH / CODE loop / REVIEW —— ChatProvider
  │       ├─ deterministic Test Gate / Commit Executor —— 无 LLM 判断
  │       ├─ Memory —— episodic + governed project facts + semantic retrieval index
  │       └─ ScopedToolExecutor —— 白名单 → 策略 → 审批 → 工具 + 审计
  │                  └─ RunCommandTool → ProcessRunner → Docker/Podman 沙箱
  ▼
EventLog（src/core/event-log.ts）—— JSONL 持久化到 <git-dir>/forgemind/runs/
  ├→ replay（src/core/replay.ts）—— 纯函数重建 Timeline
  ├→ workflowSignature（src/core/reproducibility.ts）—— 规范化流程签名
  ├→ report（src/report/）—— events → view model → 单文件 HTML
  └→ audit export（src/audit/）—— 按窗口/角色/仓库投影导出
```

**事实流三条**：

1. **控制流**：只有 Orchestrator 调度 Agent；Agent 之间零直接调用。
2. **数据流**：Agent 间通过不可变 `TaskContext`（决策记录）+ 工作区产物（文件）传递，不传对话历史。
3. **可观测流**：所有阶段/LLM/工具/门禁/协商/审批事件追加到 EventLog，回放不依赖任何 Agent 实现。

**运行时隔离（ADR-2）**：每次 Run 要求目标仓库干净，在独立分支 `forgemind/<runId>` 上工作，**不自动合并、不合并回开发分支**；事件日志存放在 Git 元数据目录（`.git/forgemind/`），不污染产物 commit。失败 Run 保留分支与改动，供审计与恢复。

---

## 3. 模块边界

```
src/
├── core/       # 状态机、验收契约、RunBudget/Manifest/checkpoint/journal、事件、回放、复现签名
├── agents/     # PLAN / ARCH / CODE / REVIEW + 确定性 TEST gate / COMMIT executor
├── dag/        # DAG 计划、调度器、任务运行器（跨仓库并发）
├── agentic/    # 主动监测：归一化、触发、Watch 服务、护栏
├── negotiation/# 一次冲突裁决（默认）+ 显式多轮协议 + DecisionRecord
├── verification/# 注册命令、测试用例、文件断言与行为探针
├── tools/      # 9 个工具 + ToolPolicy + 路径安全 + 进程执行
├── llm/        # ChatProvider 接口 + OpenAI 兼容 + Fake + 能力探测
├── memory/     # LayeredMemory + EventLog 情景检索 + 项目记忆 + Noop
├── prompts/    # 五段式版本化 Prompt 资源、严格 JSON Schema 与加载器
├── context/    # 相关性排序与来源标记的 Context Assembler 纯函数
├── runtime/    # CLI、run 编排入口、Git 工作区/worktree、测试命令解析
├── report/     # 事件投影、HTML 纯渲染、报告 IO 装配
├── policy/     # 动作级三态解析 + 审批网关
├── auth/       # RBAC：角色 / 风险 / 作用域 / actor 策略
├── audit/      # 审计查询与导出（JSON / CSV）
├── sandbox/    # ProcessRunner + Docker/Podman/显式本机实现
├── web/        # loopback 本地工作台：目录浏览、Run API、进度与报告入口
└── config/     # Token 预算 + 安全策略配置加载
tests/
├── unit/       # 编排 / 安全 / 报告 / 记忆 / DAG / RBAC / 审计 / agentic / negotiation
├── golden/     # 事件 Schema 快照
└── e2e/        # 真实 node --test + 真实 Git commit 全链路
evals/          # 提示词评测集（4 场景 A/B 指标）
```

---

## 4. 核心数据契约

### 4.1 TaskContext（不可变）

`src/core/types.ts` 定义。`createTaskContext` 后经 `Object.freeze` 深冻结（`src/core/context.ts`），只允许 Orchestrator 通过 `with*` 系列函数产生新实例追加字段：

- `plan` / `architecture`：PLAN、ARCH 阶段的**结构化决策**（含 `summary` 摘要；ARCH 可含 `alternatives[]` 供协商检测）。
- `artifacts`：各阶段产物引用（`{path, kind, summary, stage}`）。
- `requiredAcceptanceCriteria`：调用方提供的不可改写结构化验收标准。
- `upstreamHandoffs`：DAG 前驱的仓库、分支、commit、产物版本、验收证据和未完成项。
- `gates`：TEST/REVIEW 门禁记录，含逐条 `VerificationEvidence` 与 `artifactFingerprint`。
- `meta.attempt`：当前阶段 + 返工轮次；`meta.tokenBudget`：每阶段预算。
- **不加对话历史**：TaskContext 只承载"结果"，不承载"过程"，是控制 Token 增长的核心手段。

### 4.2 StageOutput（可辨识联合）

```
plan | architecture | code(actions 已验证) | gate(TEST/REVIEW) | commit
```

Orchestrator 对 `kind` 做穷举校验（`outputArtifacts`），返回错误类型即 `FatalFailure` → `BLOCKED`，契约漂移立即可见。

### 4.3 事件 Schema（v:1）

EventLog 以 JSONL 落盘，事件形如 `{v:1, seq, ts, type, data}`，`EventDataMap`（`src/core/events.ts`）为唯一类型源，golden 测试锁定快照：

| type                                                 | 关键 data                                                 | 用途               |
| ---------------------------------------------------- | --------------------------------------------------------- | ------------------ |
| `run.started` / `run.finished`                       | runId, requirement, branch, repo, actor, profile / status | 运行边界           |
| `task.started` / `task.completed` / `task.failed`    | taskId, childRunId, repo, branch / status                 | DAG 子任务生命周期 |
| `stage.started` / `stage.completed` / `stage.failed` | stage, attempt / status / kind, error                     | 阶段生命周期       |
| `llm.called`                                         | model, tokens, promptFingerprint, promptVersion           | 决策点 + 成本      |
| `memory.recalled` / `memory.stored`                  | entryId, scope, source, timestamp, confidence, score      | 记忆审计           |
| `context.assembled`                                  | sections(source/references/tokens), tokenEstimate         | 上下文审计         |
| `tool.called`                                        | tool, args, result, policy                                | 审计（含脱敏）     |
| `approval.requested/approved/rejected`               | action, policy, mode, actor, role, risk, source           | 安全决策审计       |
| `artifact.produced`                                  | path, kind, summary                                       | 产物追溯           |
| `gate.rejected` / `gate.passed`                      | diff 指纹 + criterion/verifier/source 绑定证据            | 门禁证据           |
| `development.received` / `trigger.decided`           | eventId, source, repo, decision, ruleId, requestId        | 主动监测审计       |
| `negotiation.started/round/resolved/escalated`       | negotiationId, trigger, round, decision, approved         | 协商审计           |

`EventLog.append` 对写入做串行队列化，保证并发阶段下 seq 单调递增；`taskId` / `parentRunId` 由 index 自动注入。

---

## 5. 编排与 Agent 生命周期

### 5.1 Run 级状态机（Orchestrator 持有）

```
NEW → deterministic profile → PLAN → optional ARCH → CODE loop → TEST → REVIEW → COMMIT
                                              ▲          │失败      │驳回
                                              └──────────┴──────────┘
   任一阶段：BUDGET_EXHAUSTED / TIMEOUT / NO_PROGRESS / MAX_STEPS /
             MAX_TOOL_FAILURES / MAX_REWORK 均保留明确停止原因
   契约、恢复清单或动作核对不确定：FatalFailure → BLOCKED
```

- 返工回路：TEST 先暴露编译/类型/测试问题；只有 TEST 通过才消耗 REVIEW 模型调用。任何门禁失败都回 CODE，之后必须重新跑 TEST，再跑 REVIEW。
- **验收闭环**：每个 `AcceptanceCriterion` 声明 `requiredEvidence` 与唯一 verifier。Test Gate 逐条执行 TEST verifier；Review Agent 只判断 REVIEW verifier。`assertAcceptanceSatisfied` 和 Commit Executor 核对 id、类型、来源、通过状态及 TEST/REVIEW/当前 diff 指纹。
- **运行档位**：仓库数量、预计文件、公共 API、依赖、数据库、显式架构变化和可并行子目标先经纯函数选择 `light / standard / dag`；单仓普通任务不默认消耗 ARCH。
- **取消与恢复**：AbortSignal 贯穿所有外部调用。`RunCheckpoint` 同时保存累计 `RunBudgetSnapshot` 与 `RunManifest`；恢复必须匹配 requirement/acceptance/HEAD/provider/model/prompts/policy/test/budget/upstream commits。CODE journal 以 `PLANNED → EXECUTED → VERIFIED` 处理动作级崩溃窗口，无法核对即 BLOCKED。
- **产物隔离**：PLAN/ARCH 文档、checkpoint 和 journal 位于 `<git-dir>/forgemind/runs/<runId>/artifacts/`，不进入目标 worktree。
- **冲突裁决**：ARCH 冲突、重复 REVIEW 驳回及同仓产物语义冲突默认进入一次 rubric 裁决；多轮协议由 `negotiationMode:"multi-round"` 显式开启。

### 5.2 Agent 生命周期（BaseAgent）

```
CREATED → RUNNING → SUCCEEDED | FAILED
```

- 单实例单次运行：`run()` 检测已运行即抛 `StageFailure`，实例不可复用。
- `run()` 统一把状态迁移、`stage.started/completed/failed` 事件、Token 预算挂接封装好，子类只实现 `execute()`。
- `completeJson()`：加载版本化 Prompt、装配来源标记上下文，调用前由阶段预算和共享 RunBudget 预检，调用后按实际 usage 累计结算并记录 prompt 版本。
- PLAN/ARCH/CODE/REVIEW 使用统一信任标签；requirement 可标为 trusted/untrusted，workspace、diff、检索、记忆、外部标题和返工默认 untrusted，不能修改工具、权限或验收契约。
- PLAN 为模型生成条件选择可证明的 verifier；调用方给定条件时完整原样继承。
- CODE 使用 `actions[]` 小步循环并接收完整验收/上游 handoff；动作签名进入恢复 journal。
- REVIEW 只为明确分配到 REVIEW 的 criterion 生成一条绑定 rubric 和 diff 指纹的证据。

### 5.3 阶段契约与工具白名单

| 阶段   | 运行器              | 允许工具                                                            | 写权限                           | 产物                              |
| ------ | ------------------- | ------------------------------------------------------------------- | -------------------------------- | --------------------------------- |
| PLAN   | `PlanAgent`         | 无工作区工具                                                        | **只读**                         | Git metadata 中的 plan.md         |
| ARCH   | `ArchitectureAgent` | 无工作区工具                                                        | **只读**                         | Git metadata 中的 architecture.md |
| CODE   | `CodeAgent`         | glob, grep, read/write/edit, git status/diff, registered fast-check | 源码区（禁止 `docs/.forgemind`） | 已验证动作与变更文件              |
| TEST   | `TestGate`          | 注册命令、git_diff、文件/行为 verifier                              | **只读**                         | 确定性 criterion evidence         |
| REVIEW | `ReviewAgent`       | git_status, git_diff                                                | **只读**                         | 语义 rubric evidence              |
| COMMIT | `CommitExecutor`    | git_status, git_diff, git_commit                                    | 仅 COMMIT 策略                   | commit                            |

---

## 6. DAG 跨仓库并发编排（v1.0）

`src/dag/` 在单任务闭环之上提供多仓库任务编排，**不修改既有 `runForgeMind` 内核**：

- **DagPlanner**（`src/dag/plan.ts`）：单次 LLM 调用产出 `DagPlan{summary, tasks[]}`，每个 task 绑定 `{taskId, deps[], repo, requirement, structured acceptanceCriteria[]}`。需求与仓库列表以 untrusted 数据块输入，逐条 verifier 严格校验。
- **DagScheduler**（`src/dag/scheduler.ts`）：有界并发（默认 4）推进；依赖满足才执行；任一依赖失败则下游传播为 `BLOCKED`；产出 `DagResult{SUCCEEDED|FAILED|PARTIAL}` 与 PR 候选列表（仅全部成功时）。
- **ForgeMindTaskRunner**（`src/dag/task-runner.ts`）：每个成功任务输出 `UpstreamHandoff{commit, artifacts@version, acceptanceEvidence, incompleteItems}`。每个任务仍在独立 linked worktree 运行；同仓后继从首个前驱 commit 创建，并显式 merge 其他同仓前驱 commit（冲突即失败），跨仓只传递证据 handoff。PR 列表按拓扑生成 stacked base 与 upstreamBranches；绝不执行自动 merge，且 `test` 只能作为目标、不能作为来源。
- **Conflict handoff**：同仓上游产物以 `repo:path` 为冲突键，默认经一次 rubric 裁决；不同仓库的同名路径不会误触发。裁决及完整上游 evidence 都进入下游 handoff，而不只是“等待完成”。
- **父日志**：DAG 本身有父 EventLog（`<git-dir>/forgemind/dag-runs/`），记录 `task.started/completed/failed` 与 PR 列表产物；子任务日志在各自 worktree 的 Git 元数据下。
- **授权前置**：运行前对所有目标仓库执行 `authorize(actor, {repo, team}, "run")`，任一失败即拒绝启动。

---

## 7. 主动监测层（v3.0，`src/agentic/`）

```
GitHub / Jira / CI / Approval timeout
        │ signed webhook：原始字节 HMAC → normalizeDevelopmentEvent
        │ poller：GitHubWorkflow / JiraIssue / CI（带 cursor）
        ▼
AgenticWatchService（watch.ts）
  │  development.received / trigger.decided → EventLog
  │  FileAgenticStateStore → atomic checkpoint / restart recovery
  ▼
AgenticTriggerEngine（trigger.ts）
  ├─ event TTL 去重（delivery id）
  ├─ repository allowlist
  ├─ 第一条命中规则匹配 + 模板渲染（仅字段替换）
  ├─ 同对象 pending 合并 / 冷却窗口合并
  ├─ 每日任务配额 / 全局滑动窗口限流 → DEFER 入 pending queue
  │     AgenticRunRequest（幂等 id = ruleId:eventId）
  ▼
ForgeMindAgenticRunDispatcher
  │ FileAgenticDispatchStore：RUNNING / FAILED / COMPLETED
  ├─ 单仓 → runForgeMind
  └─ 多仓 → runDagForgeMind
  ▼
agenticRunGovernance（guardrail.ts）：actor=agentic/developer、风险升级、工具/命令白名单交集
  ▼
既有 RBAC → ApprovalGateway → ToolPolicy → Sandbox → EventLog / Memory
  ▼
AgenticFeedbackCoordinator → push branch → GitHub PR → GitHub/Jira/CI comment
```

- **消费游标与恢复**（ADR-19/23）：`watch.ts` 中 cursor 仅在 poller 返回新 cursor 且批次事件处理成功后更新；`state.ts` 原子保存 cursor、dedupe、cooldown、pending、rate/quota 与 dispatch retry。dispatch 失败保留稳定 request id 并在重启后优先重试（`pendingDispatchCount` 可观测）。
- **入口鉴权**：`webhook.ts` 对未解析的原始字节计算 SHA-256 HMAC，常量时间比较后才解析；GitHub、Jira 与可配置 CI header 分别适配，Node handler 同时限制请求体大小。
- **幂等执行**：`dispatcher.ts` 以 request 指纹和文件级独占 claim 持久化状态；明确失败以新 attempt 重试，已完成但回写失败只重试回写，歧义 RUNNING fail-closed。
- **平台闭环**：`github.ts` / `jira.ts` / `ci.ts` 提供 Poller 与 REST 客户端；`feedback.ts` 推送独立分支、创建或复用 PR，并以隐藏 marker / idempotency key 防重复评论。禁止从 `test` 创建 PR，且没有自动 merge 路径。
- **配置**（`src/agentic/config.ts`）：严格解析，拒绝未知字段、重复 rule id、rule 指向白名单外仓库、越界配额。
- **护栏**（ADR-20）：`agenticRunGovernance()` 生成可直接展开进 `RunOptions` 的 actor、风险变换与白名单；`ScopedToolExecutor` 在 RBAC/ApprovalGateway 前应用风险升级，升级后的风险进入 `approval.*` 审计。
- **不越权**：主动 Run 与手动 Run 走同一条执行链，审批、沙箱、记忆行为完全一致。

---

## 8. 冲突裁决层（v3.0，`src/negotiation/`）

```
触发检测（triggers.ts，纯函数）：
  detectArchitectureConflict      —— ARCH 存在 >1 个显著不同的 alternatives
  detectRepeatedReviewRejection   —— REVIEW 连续 N 次驳回
  detectArtifactMismatch          —— 同仓 `repo:path` artifact 语义不同
        │ NegotiationEvidence{trigger, topic, proposal, counter}
        ▼
OneShotConflictResolver（默认）
  │  一次结构化模型裁决：selection / decision / rationale / risks / requiredVerification
  │  明确 rubric；调用计入共享 RunBudget；全量事件审计
  │
  └─ NegotiationProtocol（仅 negotiationMode="multi-round"）
       不同模型/工具/权限/仓库上下文时使用；≤3 轮，超时或无共识升级审批
  ▼
createDecisionRecord（record.ts）→ persistDecisionRecord → L3 decisions.json
```

- **默认路径**：一次裁决避免同一模型扮演双方后再用关键词重叠判断“收敛”。输出明确指出风险和带具体 verifier 的必须验证项；运行时把它们追加成不可绕过的验收条件。
- **显式多轮**：保留原协议用于真正异构参与方；无共识或超时复用高风险 `ApprovalGateway`，审批拒绝则裁决不生效。
- **集成**：Orchestrator 在 ARCH 冲突与 REVIEW 连续驳回时调用并更新当前验收契约；DagScheduler 仅检测同仓同路径语义冲突，并将新增条件绑定到共同下游任务。没有可绑定 verifier 或没有待运行承接任务时立即停止，`DecisionRecord` 不能越过 TEST/REVIEW 直接进入提交。裁决记录同时进入 DAG 结果和受治理项目记忆。

---

## 9. 上下文工程与 Token 预算

### 9.1 预算表（`src/config/budgets.ts`，input/output tokens）

| 阶段   | input | output |
| ------ | ----- | ------ |
| PLAN   | 8K    | 2K     |
| ARCH   | 12K   | 3K     |
| CODE   | 32K   | 8K     |
| REVIEW | 24K   | 3K     |
| TEST   | 2K    | 500    |
| COMMIT | 2K    | 500    |

阶段级 `TokenBudgetTracker` 防止单次上下文失控；更外层的共享 `RunBudgetTracker` 累计所有阶段、CODE 轮次、返工和冲突裁决的 LLM 次数、input/output、估算成本、持续时间和工具调用。快照写入 checkpoint，恢复不会重置预算。`estimateTokens = utf8字节/4`，实际消耗以厂商 `usage` 结算。

### 9.2 四条铁律（强制层：AgentFactory 注入 + BaseAgent 统一执行）

1. **代码检索优先于投喂**：Agent 只能经工具触达代码；CODE 阶段按"ARCH 预期文件 → grep 命中 → 文件名关键词"排序，最多 8 个文本文件、每文件前 400 行、总量 ≤80K UTF-8 字节。
2. **契约与证据不丢失**：摘要用于叙事，上下游仍传完整验收条件、verifier、产物版本、未完成项和逐条 evidence。
3. **工具结果分片**：`read_file` 按行范围 + 字节上限，grep 最多 200 条命中，glob 最多 500 文件，diff 按字节截断并置 `truncated`。
4. **REVIEW 超限即驳回**：diff 超出审查预算时，ReviewAgent 直接 `rejected`（reason=上下文超限），引导拆小改动。

---

## 10. Tool 系统

### 10.1 工具集（`src/tools/index.ts`）

`read_file`、`write_file`（原子写：临时文件+rename）、`edit_file`（精确串匹配 + `expectedOccurrences` 计数校验）、`grep`、`glob`、`run_command`、`git_status`、`git_diff`（含未跟踪文件）、`git_commit`。

工具不 throw（`errorMessage` 兜底转结构化 `ToolResult`），所有调用由 `ScopedToolExecutor` 统一记录 `tool.called` 并通过共享 `auditValue` 做**审计脱敏**（prompt/token/密钥、文件内容、diff、编辑片段和命令输出等键值 → `<redacted>`）。

### 10.2 ToolPolicy（deny-by-default）

每阶段独立策略，AgentFactory 在 `policyFor()` 中装配：

- 工具白名单 + 阶段可写开关（PLAN/ARCH/REVIEW/TEST 只读业务工作区）。
- PLAN/ARCH 通过 `RunArtifactStore` 写 Git metadata；CODE 禁止写 `docs/.forgemind`。
- 命令白名单：TEST verifier 和 CODE `fast-check` 仅接受预注册的精确 argv；agentic 模式下再与主动 allowlist 取交集。
- Git hooks 默认执行；仅显式 `--skip-git-hooks` 时由 COMMIT 策略加入 `--no-verify`。
- 输出字节上限（CODE 128K / REVIEW 72K / 其余 32K）+ 进程超时（TEST 300s / 其余 120s）。

### 10.3 路径安全（`src/tools/path-safety.ts`）

- 拒绝空字节；`realpath` 归一化工作区根；`path.resolve` 后强制前缀包含校验（防目录穿越）。
- 读写路径真实解析后仍须位于工作区内（防 symlink 逃逸）。
- 禁止直接访问 Git 元数据（`.git`）。
- 进程执行（`src/tools/process.ts`）：`spawn` 无 shell、输出按字节截断、超时 SIGTERM→SIGKILL。

### 10.4 测试命令策略（`src/runtime/test-command.ts`）

- 可执行白名单：`npm / node / pnpm / yarn / bun`；参数仅安全字符正则。
- 仅允许测试调用形态（`node --test`、`npm test`、`npm run test`）。
- 自动探测 `package.json.scripts.test`，可显式指定。

### 10.5 安全执行链

`ScopedToolExecutor` 在阶段白名单之后叠加 `PolicyResolver`（`src/policy/resolver.ts`）：规则支持 `allow / approve / deny`，命中优先级为 command 精确规则 > stage+tool > tool > `defaultMode`，同具体度后加载层优先。配置层从低到高为内置默认、全局文件、环境 JSON、`--config`、仓库 `forgemind.config.json`；未知字段或非法值直接 `HardFailure`。

`approve` 由统一 `ApprovalGateway` 处理：TTY 交互、`--yes` 自动批准或 `--no-approve`/无 TTY 拒绝。请求、批准、拒绝分别落 `approval.*`，动作先经 `auditValue`。

`RunCommandTool` 依赖注入的 `ProcessRunner`。隔离执行模式默认使用 Docker/Podman：

- 镜像必须使用 sha256 digest 固定；无可用运行时默认 fail-fast。
- `/source` 是唯一宿主只读挂载；固定入口脚本复制到 `/workspace` tmpfs 后执行 argv，测试副产物不回传。
- 默认 `--network=none`、`--read-only`、`--cap-drop ALL`、`no-new-privileges`，并限制 CPU、内存、PID、超时和输出。
- `sandbox.mode=local` 仅是显式受信任降级，强制 `defaultMode=deny`，事件证据标记为 `local/host`。

---

## 11. RBAC 与审计（v2.0）

### 11.1 RBAC（`src/auth/`）

- 角色：`viewer < developer < approver < admin`；动作：`view / run / approve:medium / approve:high / configure`。
- `authorize(actor, scope, action)`：deny-by-default；角色不低于动作所需角色，且作用域命中 actor 的 `repos[]` / `teams[]`（admin 免作用域检查）。
- 风险 → 审批动作：`low → 无`，`medium → approve:medium`（需 developer），`high → approve:high`（需 approver）。
- actor 策略来自 `--actor-policy` 文件（严格解析，拒绝未知字段）；`run`/`dag run` 在创建分支/worktree 前检查 Run 权限；`audit export` 需 `view` 权限。
- 主动 actor 固定为 `agentic/developer`，repos 限定为授权仓库（ADR-20）。

### 11.2 审计导出（`src/audit/`）

- `queryAuditEvents`：扫描 `forgemind/runs` 与 `forgemind/dag-runs` 下 JSONL，投影为有界 `AuditRecord`（runId/seq/ts/type/stage/taskId/actor/role/risk/repo/status/operation/outcome）。
- 窗口约束：最多 31 天，支持 `--filter-actor / --filter-repo / --status`；超过 100,000 事件扫描即拒绝。
- `exportAuditResult`：JSON 与公式注入安全 CSV（同一投影源）。

---

## 12. 静态可观测性报告

`report --repo <path> --run-id <id>` 从 JSONL 事件生成 `<git-dir>/forgemind/reports/<runId>.html`。报告是日志的只读投影，不参与运行状态决策：

```
EventLog.load() → buildReportViewModel(events) → renderReportHtml(model) → atomic write
       IO                    纯函数                     纯函数                 IO
```

- `src/report/view-model.ts`：复用 `workflowTrace`，按实际事件顺序和 stage/attempt 分组；聚合 token、工具次数、阶段耗时、门禁返工、产物、主动监测与协商事件和失败定位。
- `src/report/render-html.ts`：内嵌 CSS/JavaScript 的单文件报告，提供时间线播放；所有动态文本统一 HTML 转义；离线 CSP。
- 最多渲染 2,000 条事件；超限时抽样普通事件，优先保留失败、门禁和失败工具调用。
- 工具 `args/result` 在报告投影时再次调用共享 `auditValue`。
- 安全事件面板投影 `approval.*`、策略化 `tool.called`、`development.*`、`trigger.*` 与 `negotiation.*`。

### 12.1 本地页面工作台

`web` CLI 启动 `src/web/server.ts`，以零第三方依赖的 Node HTTP server 提供本地操作页面：

- 只绑定 `127.0.0.1`，默认端口 3210；页面资源内嵌且配置严格 CSP。
- 文件夹浏览以当前用户主目录为根，真实路径归一化后做包含检查；目标仓库仍复用 `inspectGitWorkspace` 与 clean gate。
- 目标仓库必须有至少一个 commit；unborn 仓库在创建 ForgeMind 分支前拒绝并返回可操作的中文提示。
- 没有项目时可由用户显式点击创建独立的 `ForgeMindDemo` Git 仓库；已存在目录绝不覆盖。
- 页面从服务端供应商目录生成供应商下拉框和可输入筛选的模型列表；预置 OpenAI、DeepSeek、智谱 BigModel、阿里百炼、Kimi 和自定义 OpenAI-compatible 服务。
- API Key 仅来自本地 `.env`：`OPENAI_API_KEY`、`DEEPSEEK_API_KEY`、`BIGMODEL_API_KEY` / `ZHIPU_API_KEY`、`DASHSCOPE_API_KEY`、`MOONSHOT_API_KEY`。页面只显示所选变量是否已配置，不接收、不返回密钥。
- 旧版 `OPENAI_API_KEY + OPENAI_BASE_URL` 仍作为当前默认供应商的兼容配置；存在供应商专用变量时优先使用专用变量，避免切换平台时误用其他平台密钥。
- 页面切换供应商时使用目录中的官方端点、推荐模型、结构化输出和温度 0；只有“自定义”允许编辑 API 地址。DeepSeek / GLM 在 Provider 适配层关闭思考并转为 `json_object`，DashScope Qwen 转为 `json_object`。
- Run 请求复用 `runForgeMind`，同一时间只允许一个活动任务；页面从共享 EventLog 只读投影当前阶段，完成后复用 `generateReport`。
- 页面不提供 merge、任意命令或 Git 分支操作入口，因此不扩大既有 ToolPolicy 与审批边界。

---

## 13. Memory 与语义检索索引（默认关闭）

| 类别             | 载体                                         | 当前行为                                                        |
| ---------------- | -------------------------------------------- | --------------------------------------------------------------- |
| working          | 不可变 `TaskContext` + 阶段产物              | 单 Run 决策、完整验收契约与 handoff                             |
| episodic         | `<git-dir>/forgemind/runs/*.jsonl`           | 按需求关键词与运行结果检索历史轨迹                              |
| governed project | `.forgemind/memory/{decisions,lessons}.json` | 只保存治理决策及独立门禁验证后的成功经验                        |
| semantic index   | 上述项目文档的只读索引                       | 默认词法向量 + BM25，`EmbeddingProvider` 可插拔；不是独立事实层 |

- `MemoryProvider` 统一窄接口；每个 recall item 保留 entry id、source、timestamp、confidence、score 和 reason。`LayeredMemory` 聚合后按 entry id 或 content hash 去重，再应用 top-k。
- 默认注入 `NoopMemoryProvider`；只有 CLI `--memory` 或 API 显式传入 Provider 才启用。
- PLAN/ARCH 在 `BaseAgent` 生命周期内只读注入召回结果；项目记忆写入需 `--memory` 确认，运行入口将 `.forgemind/memory/` 加入 Git 本地 exclude。
- `DecisionRecord` 经显式治理路径写入项目 decisions；普通 ARCH 输出要等 commit 已产生且 TEST/REVIEW 证据完整、通过、指纹一致后才能晋升。
- 项目文档版本为 2；条目含 created/updated、repository scope、confidence、permissions、expiresAt、validatedByRunIds、supersedes 和 active/superseded/tombstone。v1 读取时迁移，检索排除过期与非 active 条目；`supersede`/`tombstone` 提供更正和删除。单次 gate rejection 只留在 episodic。
- `run.quality` 不再生成万能总分/等级，而是记录 outcome、evidenceCompleteness、verificationStrength、coveragePercent|null、reworkRounds、policyViolations 和 confidence。只有成功、证据 100%、非 weak、无策略违规的结果进入 lessons。
- 代码覆盖率只接受 `FORGEMIND_COVERAGE=<0-100>` 显式测试输出；否则为 `unavailable`，报告不猜测覆盖率。
- `SemanticMemory` 只读索引项目文档：词条经 NFKC、大小写与英文复数归并，得分 = `BM25(0.6) + cosine(0.4)`；默认 `LexicalEmbeddingProvider` 为确定性词法向量，也可注入 `OpenAICompatibleEmbeddingProvider`。外部向量维度/有限值严格校验；`repositoryRoots` 是跨项目授权边界。
- 记忆内容不参与控制流决策，也不修改用户代码。

---

## 14. 安全边界（纵深防御）

1. deny-by-default 阶段策略（含只读 REVIEW/TEST）。
2. 命令/工具精确白名单，无 shell。
3. 路径包含 + symlink 逃逸防护 + `.git` 禁访。
4. 输出字节截断 + 审计脱敏 + 全量事件落盘。
5. `git_commit` 默认执行仓库 hooks；hooks 失败时 Run 失败并保留分支。
6. 测试进程默认容器沙箱；宿主仅用于显式受信任降级。
7. RBAC 前置检查（run / approve / view）+ actor 作用域约束。
8. 主动层三层约束：授权仓库白名单 + 每日配额/速率限制 + 风险升级审批（ADR-20）。
9. 协商升级复用 `approve:high` 审批链，decision-record 全量入审计。
10. 所有批准、拒绝和沙箱证据进入事件日志并由报告展示。

---

## 15. 工程质量

### 15.1 错误分类（`src/core/errors.ts`）

| 类型           | kind  | 含义                                   | Run 结果 |
| -------------- | ----- | -------------------------------------- | -------- |
| `StageFailure` | STAGE | Agent 可修复（返回结构错误、工具失败） | FAILED   |
| `HardFailure`  | HARD  | 预算超限 / 权限 / 仓库不干净           | FAILED   |
| `FatalFailure` | FATAL | 框架级（契约漂移、事件日志损坏）       | BLOCKED  |

### 15.2 测试策略（`npm test` = build + `node --test`）

- **单元**：结构化 acceptance/verifier、CODE loop/journal、RunBudget/Manifest/profile、TEST→REVIEW 编排、DAG handoff/repo:path 冲突、记忆治理与 recall@k，以及既有安全/报告/Provider/agentic 回归。
- **Golden**：`tests/golden/event-schema.snapshot.json` 锁定事件契约，防 Schema 漂移。
- **E2E**：真实测试/commit/可复现性、审批拒绝与报告、双 Run 记忆召回、DAG 全链路、签名 Webhook 到幂等 Run/PR/评论的主动闭环。
- **Smoke**：真实文件 checkpoint + dispatch 失败重启恢复始终执行；真实容器、外部 Chat 和外部 Embedding 在配置环境执行，发布门禁缺配置即失败。
- **Eval**：`npm run prompt:contract` 用 FakeProvider 做快速 Prompt/Schema 合约回归（`eval:contract` 保留为兼容别名）；`npm run eval:real` 必须连接真实模型，在临时 Git 仓库执行完整 Run、真实编辑/测试/提交与隐藏语义断言。当前场景规模和结论边界见 `docs/EVALUATION.md`。
- **质量门禁**：`npm run check` 串行执行 TypeScript 严格检查、类型感知 ESLint、Prettier 检查与测试；`.github/workflows/ci.yml` 在 push / pull request 中运行同一门禁。

---

## 16. 已知问题与决策记录

| #   | 问题                                                                             | 位置                                               | 严重度 | 处置                                                                      |
| --- | -------------------------------------------------------------------------------- | -------------------------------------------------- | ------ | ------------------------------------------------------------------------- |
| 1   | REVIEW input 预算 24K，但 diff 上限 72K 字节（≈18K token）+ 上下文开销，余量偏紧 | `src/core/agent-factory.ts` policyFor / budgets.ts | 低     | 超限已有安全兜底（diff 截断即驳回）；调参时优先提升预算或收紧 diff 上限。 |
| 2   | 路径检查存在 TOCTOU（realpath 校验与 readFile 之间可换链）                       | `src/tools/path-safety.ts`                         | 低     | 本地可信场景可接受；沙箱用严格句柄化（O_NOFOLLOW / 沙箱 FS）消除。        |
| 3   | 文件幂等账本遇到进程崩溃留下 RUNNING 时无法自动判断外部 Run 是否已产生副作用     | `src/agentic/dispatcher.ts`                        | 中     | 保持 fail-closed，由运维依据 run id 对账；不盲目重跑。                    |
| 4   | 协商收敛判定基于关键词重叠，极端场景可能误判                                     | `src/negotiation/protocol.ts`                      | 低     | 有界（≤3 轮）+ 超时升级兜底；判定仅作为"是否收敛"信号，最终人类可仲裁。   |
| 5   | L4 默认词法向量对同义词/语义近义召回有限，跨语言召回弱                           | `src/memory/semantic-memory.ts`                    | 低     | 默认零依赖可接受；接续精度提升走 `EmbeddingProvider` 注入外部向量服务。   |

**历轮已解决决策**：Git hooks 默认执行且可显式跳过；CODE 上下文 UTF-8 字节截断；报告纯函数管线；策略/审批/沙箱统一执行链；Prompt 版本与原生结构化输出；DAG worktree 隔离和证据 handoff；主动监测与外部回写审计；结构化 verifier 验收；受限 CODE loop；共享 RunBudget/Manifest/checkpoint/journal；一次冲突裁决；受治理项目记忆与语义检索索引。

---

## 17. 演进路线（对齐 PRD §7）

| 阶段             | 架构动作                                           | 状态           |
| ---------------- | -------------------------------------------------- | -------------- |
| Phase 1（MVP）   | 单条需求走通全链路                                 | ✅ 已实现      |
| Phase 2 可观测   | 静态离线报告 + 回放 + 复现签名                     | ✅ 已实现      |
| Phase 3 治理隔离 | 沙箱/审批、DAG 并发、RBAC、审计                    | ✅ 已实现      |
| Phase 4 长期记忆 | 情景/项目记忆 + 语义检索索引 + 主动监测 + 裁决沉淀 | ✅ 已实现      |
| 本地易用性       | loopback Web 工作台 + 项目选择 + Run/报告入口      | ✅ 已实现      |
| 扩展项           | 远程多用户实时视图与 RUNNING 对账工具              | — 非 v3.0 范围 |

**明确不做（防过度设计）**：不引入 MQ、DB、图/事件引擎、Agent 自由对话拓扑。单进程、顺序执行、JSONL 落盘支撑演示闭环，且迁移路径清晰。

---

## 18. 与当前产品范围的对应关系

- DoD 全流程、审查真实输出、测试真实通过、有效 commit：e2e 验证 ✅。
- 可复现：`workflowSignature` 双 Run 一致性 ✅。
- 报告时间线 / 门禁 / 失败 / 统计 / 离线：纯函数投影 + CLI e2e ✅。
- 安全策略 / 审批 / 沙箱 / 资源限制 / 安全报告：回归保持 ✅。
- 情景/项目记忆与语义索引、Prompt 版本、结构化输出、相关性上下文、contract + real-agent Eval：已实现 ✅。
- DAG 并发与 evidence handoff、RBAC、审计导出、主动监测、一次冲突裁决与可选多轮协议、语义检索索引：已实现 ✅。
- 本地页面工作台：loopback HTTP、目录选择、统一 Run 启动、EventLog 进度和报告入口已实现；远程多用户实时视图仍为非目标。
- 非目标（远程实时视图 / 自由协商）：明确不做；Agentic 公网 HTTP、凭据托管与仓库部署映射仍由宿主服务配置。
