# ForgeMind 架构设计文档（ADR）

> 版本：v3.0（对应 npm `3.0.0`，对齐 `docs/PRD.md`，全能力已实现，151 个测试用例登记）
> 状态：已实现
> 技术栈：TypeScript / Node（>=22），单一进程、运行时零第三方依赖（无 DB / MQ / 框架）
> 演进总览：v0.2 闭环 → v0.3 可观测 → v0.4 安全 → v0.5 记忆/提示词 → v1.0 DAG/多仓库 → v2.0 企业集成/RBAC/审计 → v3.0 主动监测/有界协商/语义记忆/质量回馈

---

## 1. 设计原则

1. **简单** —— 采用"编排者 + 阶段化流水线 + 单条返工回路"，不引入通用 Agent 消息总线 / 事件引擎 / 队列；并发通过独立的 DAG 内核实现。
2. **可靠** —— 一切 Agent 交互通过不可变契约与结构化事件落地；失败分类明确，结果可回放。
3. **可扩展** —— Agent / Tool / LLM / Memory / Dispatcher 均为窄接口，为后续迭代预留接缝。
4. **可维护** —— 模块边界 = 目录边界；状态机、预算、路径安全、命令策略、触发判定均有独立测试。
5. **安全与可观测是生死线** —— 纵深防御 + 全量审计，任一层缺失不会静默降级。

**关键架构决策（ADR-1）：Agent 内单次 LLM 调用（single-shot），Agent 无自循环。**

各阶段 Agent 一次 `complete()` 产出结构化 JSON（如 CODE 返回 `operations[]` 批量操作，由框架顺序执行）；"迭代/返工"只发生在 Orchestrator 层的门禁回路（REVIEW/TEST → CODE），Agent 内部不存在 agentic 工具循环。

- 收益：确定性高（配合 `temperature=0, seed=42`）、Token 预算易收紧、审计简单（一次 `llm.called` = 一次决策）。
- 代价：单阶段内无法自主多轮探索；大型任务靠"分阶段 + 返工"而非 Agent 自规划。

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

**ADR-21：协商是有界结构化协议，不是自由对话。**
协商 = `Proposal → Counter → Decision` 三轮有界协议，产出结构化 `DecisionRecord`；无共识/超时 → 升级人类审批。自由对话违背"编排者决策"与可审计性，明确不做。

**ADR-22：L4 语义记忆延续零依赖底线——EmbeddingProvider 可插拔接缝 + 默认自研词法检索。**
`semantic` scope 实装为 `SemanticMemory`（`src/memory/semantic-memory.ts`）：检索通过 `EmbeddingProvider` 接口注入，默认提供零运行时依赖的确定性词法向量 + BM25（NFKC 归一化、英文复数/大小写归并、`stableHash` 有符号 hash），外部向量服务可作为可选 provider 接入。语义检索的写仍走确定性投影（ADR-7），LLM 不参与记忆生成；`repositoryRoots` 是跨项目召回的显式授权边界，CLI `--memory` 仅授权当前仓库。

**ADR-23：主动层以单一原子 checkpoint 保持跨重启一致性。**
`FileAgenticStateStore` 同步保存 poller cursor、事件 TTL 去重、对象冷却、pending、滑动窗口限流、每日配额与 dispatch retry。每个 dispatch 在外部调用前先落盘，成功后才清除；cursor 只在批次内事件都处理完成后提交。恢复语义为 at-least-once，稳定 `ruleId:eventId` 必须作为下游幂等键。损坏、超限或配置漂移状态 fail-closed。

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
CLI / API（src/runtime/cli.ts / src/runtime/run.ts）
  │ 校验 run/repo/测试配置 → 建分支 forgemind/<runId> → 建 EventLog
  ▼
DAG 内核（src/dag/）—— 跨仓库多任务（v1.0）
  DagPlanner → DagScheduler（并发 + 依赖 + Artifact mismatch 协商）→ ForgeMindTaskRunner（每任务一个 worktree）
  ▼（单任务或 DAG 子任务均进入）
Orchestrator（src/core/orchestrator.ts）—— 唯一决策中枢，持有 Run 级状态机
  │  顺序推进阶段 + 门禁返工回路（≤ maxRework=3）
  │  ├─ 协商触发点：ARCH 方案冲突 / REVIEW 连续驳回（src/negotiation/）
  │  └─ NegotiationLayer：Proposal → Counter → Decision（三轮有界）→ DecisionRecord → L3
  ▼
StageAgent（src/agents/*）—— 单次 LLM 调用，返回结构化 StageOutput
  │       ├─ ChatProvider（src/llm/）—— OpenAI 兼容 / Fake
  │       ├─ Memory（src/memory/）—— L2 episodic + L3 project
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
├── core/       # 状态机、TaskContext、事件 Schema、EventLog、Token 预算、错误、AgentFactory、回放、复现签名
├── agents/     # PLAN / ARCH / CODE / REVIEW / TEST / COMMIT 六个 StageAgent
├── dag/        # DAG 计划、调度器、任务运行器（跨仓库并发）
├── agentic/    # 主动监测：归一化、触发、Watch 服务、护栏
├── negotiation/# 有界协商：触发检测、协议状态机、DecisionRecord
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
- `gates`：REVIEW/TEST 门禁记录（`{stage, attempt, passed, reason, feedback, evidence}`）。
- `meta.attempt`：当前阶段 + 返工轮次；`meta.tokenBudget`：每阶段预算。
- **不加对话历史**：TaskContext 只承载"结果"，不承载"过程"，是控制 Token 增长的核心手段。

### 4.2 StageOutput（可辨识联合）

```
plan | architecture | code(operations 已执行) | gate(REVIEW/TEST) | commit
```

Orchestrator 对 `kind` 做穷举校验（`outputArtifacts`），返回错误类型即 `FatalFailure` → `BLOCKED`，契约漂移立即可见。

### 4.3 事件 Schema（v:1）

EventLog 以 JSONL 落盘，事件形如 `{v:1, seq, ts, type, data}`，`EventDataMap`（`src/core/events.ts`）为唯一类型源，golden 测试锁定快照：

| type                                                 | 关键 data                                          | 用途               |
| ---------------------------------------------------- | -------------------------------------------------- | ------------------ |
| `run.started` / `run.finished`                       | runId, requirement, branch, repo, actor / status   | 运行边界           |
| `task.started` / `task.completed` / `task.failed`    | taskId, childRunId, repo, branch / status          | DAG 子任务生命周期 |
| `stage.started` / `stage.completed` / `stage.failed` | stage, attempt / status / kind, error              | 阶段生命周期       |
| `llm.called`                                         | model, tokens, promptFingerprint, promptVersion    | 决策点 + 成本      |
| `memory.recalled` / `memory.stored`                  | scope, source/路径, score, reason, used            | 记忆审计           |
| `context.assembled`                                  | sections(source/references/tokens), tokenEstimate  | 上下文审计         |
| `tool.called`                                        | tool, args, result, policy                         | 审计（含脱敏）     |
| `approval.requested/approved/rejected`               | action, policy, mode, actor, role, risk, source    | 安全决策审计       |
| `artifact.produced`                                  | path, kind, summary                                | 产物追溯           |
| `gate.rejected` / `gate.passed`                      | reason, feedback / evidence                        | 门禁证据           |
| `development.received` / `trigger.decided`           | eventId, source, repo, decision, ruleId, requestId | 主动监测审计       |
| `negotiation.started/round/resolved/escalated`       | negotiationId, trigger, round, decision, approved  | 协商审计           |

`EventLog.append` 对写入做串行队列化，保证并发阶段下 seq 单调递增；`taskId` / `parentRunId` 由 index 自动注入。

---

## 5. 编排与 Agent 生命周期

### 5.1 Run 级状态机（Orchestrator 持有）

```
NEW → PLAN → ARCH ──冲突──▶ 协商（NegotiationLayer）──▶ 应用决策
                          │
CODE ⇄ REVIEW ──驳回──▶ 协商（连续 N 次驳回时）──▶ 注入协商决策返工
  │          ▲
  ▼ 通过      │
TEST ──失败───┘
  │ 通过
  ▼
COMMIT → SUCCEEDED
   任一阶段：预算超限/工具权限 → HardFailure → FAILED；框架级错误 → FatalFailure → BLOCKED
   REVIEW/TEST 连续驳回超过 maxRework(3) → FAILED
```

- 返工回路：`attempt` 对 CODE/REVIEW/TEST 共用同一轮次；REVIEW 驳回用 review feedback，TEST 驳回用 test feedback。
- **协商接入点**：ARCH 阶段若 `architecture.alternatives` 存在 >1 个显著不同的可行方案（`detectArchitectureConflict`），且注入了 `NegotiationCoordinator`，则先协商再定稿；REVIEW 连续驳回达到阈值（默认 2）时，把历轮 feedback 作为立场进入协商，结果注入返工反馈。
- 死循环双保险：`maxRework` 数值上限 + 每阶段 Token 预算（Fail-Fast）。

### 5.2 Agent 生命周期（BaseAgent）

```
CREATED → RUNNING → SUCCEEDED | FAILED
```

- 单实例单次运行：`run()` 检测已运行即抛 `StageFailure`，实例不可复用。
- `run()` 统一把状态迁移、`stage.started/completed/failed` 事件、Token 预算挂接封装好，子类只实现 `execute()`。
- `completeJson()`：加载 `prompts/*.v1.md`，装配来源标记上下文和 PLAN/ARCH 只读记忆；单次 LLM 调用（`temperature=0, seed=42`）优先请求原生 JSON Schema，能力不可用时走既有 JSON 解析，不做 LLM 重试。调用后按 `usage` 结算预算并记录 prompt 版本。

### 5.3 阶段契约与工具白名单

| 阶段   | 类                  | 允许工具                                                 | 写权限                           | 产物                           |
| ------ | ------------------- | -------------------------------------------------------- | -------------------------------- | ------------------------------ |
| PLAN   | `PlanAgent`         | write_file                                               | 仅 `docs/.forgemind/<runId>/`    | plan.md + TaskPlan             |
| ARCH   | `ArchitectureAgent` | write_file                                               | 仅 `docs/.forgemind/<runId>/`    | architecture.md + ArchDecision |
| CODE   | `CodeAgent`         | glob, grep, read_file, write_file, edit_file, git_status | 源码区（禁止 `docs/.forgemind`） | 变更文件                       |
| REVIEW | `ReviewAgent`       | git_status, git_diff                                     | **只读**                         | gate 判定                      |
| TEST   | `TestAgent`         | run_command（仅白名单测试命令）                          | **只读**                         | gate 判定                      |
| COMMIT | `CommitAgent`       | git_status, git_diff, git_commit                         | 仅 COMMIT 策略                   | commit                         |

---

## 6. DAG 跨仓库并发编排（v1.0）

`src/dag/` 在单任务闭环之上提供多仓库任务编排，**不修改既有 `runForgeMind` 内核**：

- **DagPlanner**（`src/dag/plan.ts`）：单次 LLM 调用产出 `DagPlan{summary, tasks[]}`，每个 task 绑定 `{taskId, deps[], repo, requirement}`。严格校验：taskId 合法、无重复/自环/未知依赖、repo 在 allowlist、依赖无环（拓扑排序验证）、1–50 个任务。
- **DagScheduler**（`src/dag/scheduler.ts`）：有界并发（默认 4）推进；依赖满足才执行；任一依赖失败则下游传播为 `BLOCKED`；产出 `DagResult{SUCCEEDED|FAILED|PARTIAL}` 与 PR 候选列表（仅全部成功时）。
- **ForgeMindTaskRunner**（`src/dag/task-runner.ts`）：每个任务在**独立 Git linked worktree**（`prepareTaskWorktree`，默认 `os.tmpdir()` 下，可用 `--worktrees-root` 固化）上以 `runId = childRunId(parent, taskId)` 调用 `runForgeMind`，因此每个任务拥有独立分支、沙箱、门禁与 EventLog。
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

## 8. 有界协商层（v3.0，`src/negotiation/`）

```
触发检测（triggers.ts，纯函数）：
  detectArchitectureConflict      —— ARCH 存在 >1 个显著不同的 alternatives
  detectRepeatedReviewRejection   —— REVIEW 连续 N 次驳回
  detectArtifactMismatch          —— 跨任务 artifact 路径同义不同（DAG 接缝）
        │ NegotiationEvidence{trigger, topic, proposal, counter}
        ▼
NegotiationProtocol（protocol.ts，ADR-21）
  │  negotiation.started
  │  每轮：proposal.respond() + counter.respond()（各一次 LLM 调用，temperature=0）
  │  convergedDecision：关键词收敛判定（接受标记 + 立场重叠）
  │  negotiation.round（≤3 轮，有界）
  │  negotiation.resolved —— 共识达成 → DecisionRecord（确定性生成）
  │  无共识 / 超时 → escalate()：升级人类审批（approval.requested→approved/rejected，risk=high）
  │  negotiation.escalated
  ▼
createDecisionRecord（record.ts）→ persistDecisionRecord → L3 decisions.json
```

- **Token 预算**：每场协商 12K input / 3K output，每轮输出上限 1K tokens，超时默认 120s。
- **升级兜底**：无共识或超时 → `ESCALATED`/`TIMED_OUT`，复用 v0.4 `ApprovalGateway`，审批通过才产出 `DecisionRecord`；审批被拒则协商不生效，Run 按既有逻辑处理（ARCH 阶段失败 / 返工）。
- **集成**：Orchestrator 在 ARCH 冲突与 REVIEW 连续驳回时调用；DagScheduler 收集成功子任务的最终 CODE 产物，在后继任务启动前检测同路径语义冲突并调用。成功协商的 `DecisionRecord` 会进入 DAG 结果，并在启用记忆时写入各任务 worktree 的 L3 项目记忆，供后续 Run 检索引用。

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

`TokenBudgetTracker`：input/output 独立计数，`ensureInputFits/ensureOutputFits` 在**消耗前**校验，超限抛 `HardFailure`（Fail-Fast），绝不静默截断 LLM 调用。`estimateTokens = utf8字节/4`（保守估算），实际消耗以厂商 `usage` 结算。

### 9.2 四条铁律（强制层：AgentFactory 注入 + BaseAgent 统一执行）

1. **代码检索优先于投喂**：Agent 只能经工具触达代码；CODE 阶段按"ARCH 预期文件 → grep 命中 → 文件名关键词"排序，最多 8 个文本文件、每文件前 400 行、总量 ≤80K UTF-8 字节。
2. **跨阶段只传摘要**：下一阶段 prompt 只带 `summary`，不带完整产物。
3. **工具结果分片**：`read_file` 按行范围 + 字节上限，grep 最多 200 条命中，glob 最多 500 文件，diff 按字节截断并置 `truncated`。
4. **REVIEW 超限即驳回**：diff 超出审查预算时，ReviewAgent 直接 `rejected`（reason=上下文超限），引导拆小改动。

---

## 10. Tool 系统

### 10.1 工具集（`src/tools/index.ts`）

`read_file`、`write_file`（原子写：临时文件+rename）、`edit_file`（精确串匹配 + `expectedOccurrences` 计数校验）、`grep`、`glob`、`run_command`、`git_status`、`git_diff`（含未跟踪文件）、`git_commit`。

工具不 throw（`errorMessage` 兜底转结构化 `ToolResult`），所有调用由 `ScopedToolExecutor` 统一记录 `tool.called` 并通过共享 `auditValue` 做**审计脱敏**（prompt/token/密钥、文件内容、diff、编辑片段和命令输出等键值 → `<redacted>`）。

### 10.2 ToolPolicy（deny-by-default）

每阶段独立策略，AgentFactory 在 `policyFor()` 中装配：

- 工具白名单 + 阶段可写开关（REVIEW/TEST 只读）。
- 写前缀约束：PLAN/ARCH 仅 `docs/.forgemind/<runId>`；CODE 禁止写该目录。
- 命令白名单：仅 `allowedCommands` 精确 argv 匹配；agentic 模式下与主动 allowlist 取交集。
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

`RunCommandTool` 依赖注入的 `ProcessRunner`。生产默认 Docker/Podman：

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

---

## 13. Memory 设计（默认关闭）

| 层          | 载体                                         | 当前行为                                                          |
| ----------- | -------------------------------------------- | ----------------------------------------------------------------- |
| L1 working  | 不可变 `TaskContext` + 阶段产物              | 所有阶段已有，生命周期为单 Run                                    |
| L2 episodic | `<git-dir>/forgemind/runs/*.jsonl`           | 按需求关键词与运行结果检索历史轨迹                                |
| L3 project  | `.forgemind/memory/{decisions,lessons}.json` | ARCH/门禁/协商/质量评估确定性投影，按 tag/关键词召回              |
| L4 semantic | `.forgemind/memory/` 只读语料（L3 文档）     | `SemanticMemory`：默认词法向量 + BM25，`EmbeddingProvider` 可插拔 |

- `MemoryProvider` 统一 `remember / rememberGate? / rememberDecisionRecord? / rememberQuality? / recall(query, options)` 接口；`LayeredMemory` 按 scope 聚合、限流排序。
- 默认注入 `NoopMemoryProvider`；只有 CLI `--memory` 或 API 显式传入 Provider 才启用。
- PLAN/ARCH 在 `BaseAgent` 生命周期内只读注入召回结果；项目记忆写入需 `--memory` 确认，运行入口将 `.forgemind/memory/` 加入 Git 本地 exclude。
- 协商 `DecisionRecord` 经 `rememberDecisionRecord` 写入 L3 `decisions.json`（tag: negotiation/trigger/topic）。
- A4 在 `run.finished` 后从事件事实源确定性生成 `run.quality`（门禁通过率、返工轮次、TEST 通过率、显式覆盖率、评分/等级/建议）；启用记忆时经 `rememberQuality` 写入 L3 `lessons.json`。质量条目包含原需求，后续相关 Run 可召回并只读注入 PLAN/ARCH。
- 代码覆盖率只接受 `FORGEMIND_COVERAGE=<0-100>` 显式测试输出；否则为 `unavailable`，报告不猜测覆盖率。
- L4 `SemanticMemory` 只读检索 L3 文档（`decisions.json` / `lessons.json`）：词条经 NFKC 归一化、大小写与英文复数归并，得分 = `BM25(0.6) + cosine(0.4)`；默认 `LexicalEmbeddingProvider` 为确定性 `stableHash` 词法向量（维度 512，可配置），也可注入内置 `OpenAICompatibleEmbeddingProvider` 直连外部 `/embeddings`。外部向量必须匹配显式维度且全部为有限值，否则 `StageFailure`。默认维度 512、并发嵌入 8、单文档索引上限 100K 字符、语料上限 10,000 条（超限 `HardFailure`）。`repositoryRoots` 为跨项目召回授权边界；`memory.recalled` 事件记录 `semantic` 命中层与 `reason`（BM25/cosine/terms 依据）。
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

### 15.2 测试策略（`npm test` = build + `node --test`，151 个测试）

- **单元**：编排、安全、报告、分层记忆、损坏记忆 fail-fast、Prompt 资源/Schema、结构化能力降级、上下文排序、工作区检索、事件并发写入、DAG（plan/scheduler/task-runner）、RBAC/actor 策略、审计查询、agentic（normalize/trigger/watch/guardrail/webhook/poller/dispatcher/feedback）、协商（protocol/triggers）、语义记忆（词法/向量/跨仓库/失败关闭）。
- **Golden**：`tests/golden/event-schema.snapshot.json` 锁定事件契约，防 Schema 漂移。
- **E2E**：真实测试/commit/可复现性、审批拒绝与报告、双 Run 记忆召回、DAG 全链路、签名 Webhook 到幂等 Run/PR/评论的主动闭环。
- **Smoke**：真实文件 checkpoint + dispatch 失败重启恢复始终执行；真实容器、外部 Chat 和外部 Embedding 在配置环境执行，发布门禁缺配置即失败。
- **Eval**：`npm run eval` 用 4 条代表性需求与 FakeProvider 输出 A/B 通过率、返工、越权调用与 token 成本。
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

**历轮已解决决策**：Git hooks 默认执行且可显式跳过；CODE 上下文 UTF-8 字节截断；`stage.failed.kind` 向后兼容；报告纯函数管线 + 2,000 条时间线边界；三态策略与审批网关统一执行链；容器沙箱与资源限制；本机降级显式可审计；L2/L3 记忆确定性投影 + 显式启用；Prompt 资源化与版本记录；原生结构化输出带能力降级；DAG 并发与 worktree 隔离；RBAC 与审计导出；主动监测三层护栏与原子 checkpoint；签名 Webhook/cursor Poller/幂等 dispatcher/PR 与评论回写；有界协商与升级兜底；L4 语义记忆实装（`SemanticMemory` + 外部向量 Provider）。

---

## 17. 演进路线（对齐 PRD §7）

| 阶段             | 架构动作                                       | 状态           |
| ---------------- | ---------------------------------------------- | -------------- |
| Phase 1（MVP）   | 单条需求走通全链路                             | ✅ 已实现      |
| Phase 2 可观测   | 静态离线报告 + 回放 + 复现签名                 | ✅ 已实现      |
| Phase 3 生产级   | 沙箱/审批、DAG 并发、RBAC、审计                | ✅ 已实现      |
| Phase 4 长期记忆 | 项目 L2/L3 + L4 语义检索 + 主动监测 + 协商沉淀 | ✅ 已实现      |
| 扩展项           | 实时视图与 RUNNING 对账工具                    | — 非 v3.0 范围 |

**明确不做（防过度设计）**：不引入 MQ、DB、图/事件引擎、Agent 自由对话拓扑。单进程、顺序执行、JSONL 落盘支撑演示闭环，且迁移路径清晰。

---

## 18. 与 PRD v3.0 的对应关系

- DoD 全流程、审查真实输出、测试真实通过、有效 commit：e2e 验证 ✅。
- 可复现：`workflowSignature` 双 Run 一致性 ✅。
- 报告时间线 / 门禁 / 失败 / 统计 / 离线：纯函数投影 + CLI e2e ✅。
- 安全策略 / 审批 / 沙箱 / 资源限制 / 安全报告：回归保持 ✅。
- L2/L3/L4 记忆、Prompt 版本、结构化输出、相关性上下文、Eval：完整套件 + 4 场景评测 ✅。
- DAG 并发、RBAC、审计导出、主动监测（签名入口 + Poller + 持久 checkpoint + 幂等 dispatcher + 回写）、协商（`negotiation.*` + DecisionRecord）、L4 语义记忆（默认词法 + 外部向量 Provider）：已实现 ✅。
- 非目标（实时视图 / 自由协商）：明确不做；HTTP server 进程、凭据托管与仓库部署映射由宿主服务配置。
