# ForgeMind 架构设计文档（ADR）

> 版本：v0.2（对齐 PRD v0.2，MVP 已实现，16/16 测试通过）
> 状态：评审中
> 技术栈：TypeScript / Node（>=22），单一进程、无外部依赖（无 DB / MQ / 框架）

---

## 1. 设计原则

1. **简单** —— MVP 采用"编排者 + 阶段化线性流水线 + 单条返工回路"，不引入通用 Agent 消息总线 / DAG 引擎 / 队列。
2. **可靠** —— 一切 Agent 交互通过不可变契约与结构化事件落地；失败分类明确，结果可回放。
3. **可扩展** —— Agent / Tool / LLM / Memory 均为窄接口，为 Phase 2–4 预留接缝，MVP 不提前实现。
4. **可维护** —— 模块边界 = 目录边界；状态机、预算、路径安全、命令策略均有独立测试。

**关键架构决策（ADR-1）：Agent 内单次 LLM 调用（single-shot），Agent 无自循环。**

各阶段 Agent 一次 `complete()` 产出结构化 JSON（如 CODE 返回 `operations[]` 批量操作，由框架顺序执行）；"迭代/返工"只发生在 Orchestrator 层的门禁回路（REVIEW/TEST → CODE），Agent 内部不存在 agentic 工具循环。

- 收益：确定性高（配合 `temperature=0, seed=42`）、Token 预算易收紧、审计简单（一次 `llm.called` = 一次决策）。
- 代价：单阶段内无法自主多轮探索；大型任务靠"分阶段 + 返工"而非 Agent 自规划，MVP 场景足够。

---

## 2. 架构总览

```
CLI (src/runtime/cli.ts: forge-mind run / forge-mind replay)
  │
  ▼
runForgeMind (src/runtime/run.ts)
  │  校验 repo 干净 → 建分支 forgemind/<runId> → 解析测试命令 → 建 EventLog
  ▼
Orchestrator (src/core/orchestrator.ts)  —— 唯一决策中枢，持有 Run 级状态机
  │  顺序推进阶段 + 门禁返工回路（≤ maxRework=3）
  │  每阶段：AgentFactory.create(stage) → 注入 ScopedToolExecutor + ToolPolicy + TokenBudget
  ▼
StageAgent (src/agents/*)  —— 单次 LLM 调用，返回结构化 StageOutput
  │       │
  │       ├─ ChatProvider (src/llm/)  —— OpenAI 兼容 / Fake
  │       └─ ScopedToolExecutor (src/tools/executor.ts)  —— 白名单 + 审计
  ▼
EventLog (src/core/event-log.ts)  —— JSONL 持久化到 <git-dir>/forgemind/runs/<runId>.jsonl
  └→ replay (src/core/replay.ts)  —— 纯函数重建 Timeline
```

**事实流三条**：

1. **控制流**：只有 Orchestrator 调度 Agent；Agent 之间零直接调用。
2. **数据流**：Agent 间通过不可变 `TaskContext`（决策记录）+ 工作区产物（文件）传递，不传对话历史。
3. **可观测流**：所有阶段/LLM/工具/门禁事件追加到 EventLog，回放不依赖任何 Agent 实现。

**运行时隔离（ADR-2）**：每次 Run 要求目标仓库干净，在独立分支 `forgemind/<runId>` 上工作，**不自动合并、不合并回开发分支**；事件日志存放在 Git 元数据目录（`.git/forgemind/runs/`），不污染产物 commit。失败 Run 保留分支与改动，供审计与恢复。

---

## 3. 模块边界

```
src/
├── core/       # 状态机、TaskContext、事件、EventLog、Token 预算、错误、AgentFactory
├── agents/     # PLAN / ARCH / CODE / REVIEW / TEST / COMMIT 六个 StageAgent
├── tools/      # 9 个工具 + ToolPolicy + 路径安全 + 进程执行
├── llm/        # ChatProvider 接口 + OpenAI 兼容 + Fake
├── memory/     # MemoryProvider 接口 + Noop
├── runtime/    # CLI、run 编排入口、Git 工作区、测试命令解析
└── config/     # budgets.ts（每阶段 Token 预算）
tests/
├── unit/       # orchestrator / token-budget / path-safety / test-command / cli
├── golden/     # 事件 Schema 快照
└── e2e/        # 真实 node --test + 真实 Git commit 全链路
```

---

## 4. 核心数据契约

### 4.1 TaskContext（不可变）

`src/core/types.ts` 定义。`createTaskContext` 后经 `Object.freeze` 深冻结（`src/core/context.ts`），只允许 Orchestrator 通过 `with*` 系列函数产生新实例追加字段：

- `plan` / `architecture`：PLAN、ARCH 阶段的**结构化决策**（含 `summary` 摘要）。
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

| type | 关键 data | 用途 |
|---|---|---|
| `run.started` / `run.finished` | runId, requirement, branch / status, summary | 运行边界 |
| `stage.started` / `stage.completed` / `stage.failed` | stage, attempt / status / error, stack | 阶段生命周期 |
| `llm.called` | model, inputTokens, outputTokens, promptFingerprint(sha256) | 决策点 + 成本 |
| `tool.called` | tool, args, result, policy | 审计（含脱敏） |
| `artifact.produced` | path, kind, summary | 产物追溯 |
| `gate.rejected` / `gate.passed` | reason, feedback / evidence | 门禁证据 |

---

## 5. 编排与 Agent 生命周期

### 5.1 Run 级状态机（Orchestrator 持有）

```
NEW → PLAN → ARCH → CODE → REVIEW ──驳回──▶ CODE(attempt+1, 注入 feedback)
                          │                     ▲
                          ▼ 通过                  │
                        TEST ──失败──────────────┘
                          │ 通过
                          ▼
                        COMMIT → SUCCEEDED
   任一阶段：预算超限/工具权限 → HardFailure → FAILED；框架级错误 → FatalFailure → BLOCKED
   REVIEW/TEST 连续驳回超过 maxRework(3) → FAILED
```

- 返工回路：`attempt` 对 CODE/REVIEW/TEST 共用同一轮次；REVIEW 驳回用 review feedback，TEST 驳回用 test feedback（`src/core/orchestrator.ts`）。
- 死循环双保险：`maxRework` 数值上限 + 每阶段 Token 预算（Fail-Fast，见 §6）。

### 5.2 Agent 生命周期（BaseAgent，`src/agents/base-agent.ts`）

```
CREATED → RUNNING → SUCCEEDED | FAILED
```

- 单实例单次运行：`run()` 检测已运行即抛 `StageFailure`，实例不可复用（配合 AgentFactory 每阶段新建）。
- `run()` 统一把状态迁移、`stage.started/completed/failed` 事件、Token 预算挂接封装好，子类只实现 `execute()`。
- `completeJson()`：单次 LLM 调用（`temperature=0, seed=42`），前置估算 + 调用后按 `usage` 结算预算，落 `llm.called`，解析并校验 JSON。

### 5.3 阶段契约与工具白名单

| 阶段 | 类 | 允许工具 | 写权限 | 产物 |
|---|---|---|---|---|
| PLAN | `PlanAgent` | write_file | 仅 `docs/.forgemind/<runId>/` | plan.md + TaskPlan |
| ARCH | `ArchitectureAgent` | write_file | 仅 `docs/.forgemind/<runId>/` | architecture.md + ArchDecision |
| CODE | `CodeAgent` | glob, grep, read_file, write_file, edit_file, git_status | 源码区（禁止 `docs/.forgemind`） | 变更文件 |
| REVIEW | `ReviewAgent` | git_status, git_diff | **只读** | gate 判定 |
| TEST | `TestAgent` | run_command（仅白名单测试命令） | **只读** | gate 判定 |
| COMMIT | `CommitAgent` | git_status, git_diff, git_commit | 仅 COMMIT 策略 | commit |

---

## 6. 上下文工程与 Token 预算

### 6.1 预算表（`src/config/budgets.ts`，input/output tokens）

| 阶段 | input | output |
|---|---|---|
| PLAN | 8K | 2K |
| ARCH | 12K | 3K |
| CODE | 32K | 8K |
| REVIEW | 24K | 3K |
| TEST | 2K | 500 |
| COMMIT | 2K | 500 |

`TokenBudgetTracker`（`src/core/token-budget.ts`）：input/output 独立计数，`ensureInputFits/ensureOutputFits` 在**消耗前**校验，超限抛 `HardFailure`（Fail-Fast），绝不静默截断 LLM 调用。`estimateTokens = utf8字节/4`（保守估算），实际消耗以厂商 `usage` 结算。

### 6.2 四条铁律（强制层：AgentFactory 注入 + BaseAgent 统一执行）

1. **代码检索优先于投喂**：Agent 只能经工具触达代码；CODE 阶段上下文仅取架构预期文件 + glob 结果前 8 个文本文件、每文件前 400 行、总量 ≤80K 字符（`collectWorkspaceContext`）。
2. **跨阶段只传摘要**：下一阶段 prompt 只带 `summary`，不带完整产物。
3. **工具结果分片**：`read_file` 按行范围 + 字节上限，grep 最多 200 条命中，glob 最多 500 文件，diff 按字节截断并置 `truncated`。
4. **REVIEW 超限即驳回**：diff 超出审查预算时，ReviewAgent 直接 `rejected`（reason=上下文超限），引导拆小改动——预算失效转成产品级反馈，而非静默放行。

---

## 7. Tool 系统

### 7.1 工具集（`src/tools/index.ts`）

`read_file`、`write_file`（原子写：临时文件+rename）、`edit_file`（精确串匹配 + `expectedOccurrences` 计数校验）、`grep`、`glob`、`run_command`、`git_status`、`git_diff`（含未跟踪文件）、`git_commit`。

工具不 throw（`errorMessage` 兜底转结构化 `ToolResult`），所有调用由 `ScopedToolExecutor` 统一记录 `tool.called` 并做**审计脱敏**（content/secret/password/api key 键值 → `<redacted>`）。

### 7.2 ToolPolicy（deny-by-default，`src/tools/types.ts`）

每阶段独立策略，AgentFactory 在 `policyFor()` 中装配：

- 工具白名单（`allowedTools`）+ 阶段可写开关（REVIEW/TEST 只读）。
- 写前缀约束：PLAN/ARCH 仅 `docs/.forgemind/<runId>`；CODE 禁止写该目录。
- 命令白名单：仅 `allowedCommands` 精确 argv 匹配。
- 输出字节上限（CODE 128K / REVIEW 72K / 其余 32K）+ 进程超时（TEST 300s / 其余 120s）。

### 7.3 路径安全（`src/tools/path-safety.ts`）

- 拒绝空字节；`realpath` 归一化工作区根；`path.resolve` 后强制前缀包含校验（防目录穿越）。
- 读写路径真实解析后仍须位于工作区内（防 symlink 逃逸，写路径含祖先 realpath 校验）。
- 禁止直接访问 Git 元数据（`.git`）。
- 进程执行（`src/tools/process.ts`）：`spawn` 无 shell、输出按字节截断、超时 SIGTERM→SIGKILL。

### 7.4 测试命令策略（`src/runtime/test-command.ts`）

- 可执行白名单：`npm / node / pnpm / yarn / bun`；参数仅安全字符正则。
- 仅允许测试调用形态（`node --test`、`npm test`、`npm run test`）。
- 自动探测 `package.json.scripts.test`，可显式指定。

---

## 8. Memory 设计（对齐 PRD：MVP 不做跨项目长期记忆）

| 类型 | MVP | 说明 |
|---|---|---|
| 短期（单次 Run） | TaskContext + 工作区产物 | 生命周期 = 一次 Run，天然有界 |
| 项目内知识 | 仓库 `docs/` + git 历史 | 复用 git 载体 |
| 跨项目 / 向量库 | Noop（Phase 4） | 仅留接口 |

`MemoryProvider`（`src/memory/memory-provider.ts`）：`remember / recall`。Orchestrator 已在阶段完成时调用 `remember`（当前 Noop），Phase 4 换向量实现不动其他代码。

---

## 9. 安全边界（MVP 本地执行）

PRD §7 将"安全与可审计"列为长期底线，但沙箱/审批属 Phase 3。MVP 的本地执行边界是**明确让步**，通过以下措施收窄：

1. deny-by-default 阶段策略（含只读 REVIEW/TEST）。
2. 命令/工具精确白名单，无 shell。
3. 路径包含 + symlink 逃逸防护 + `.git` 禁访。
4. 输出字节截断 + 审计脱敏 + 全量事件落盘。
5. `git_commit` 使用 `--no-verify`（规避仓库钩子干扰自动化提交，属**已知风险**，见 §11）。
6. 部署约束：仅在可信仓库上运行。

---

## 10. 工程质量

### 10.1 错误分类（`src/core/errors.ts`）

| 类型 | kind | 含义 | Run 结果 |
|---|---|---|---|
| `StageFailure` | STAGE | Agent 可修复（返回结构错误、工具失败） | FAILED |
| `HardFailure` | HARD | 预算超限 / 权限 / 仓库不干净 | FAILED |
| `FatalFailure` | FATAL | 框架级（契约漂移、事件日志损坏） | BLOCKED |

### 10.2 测试策略（16/16 通过，`npm test` = build + `node --test`）

- **单元**：Orchestrator 状态机（返工/超限/只读上下文不可变）、TokenBudgetTracker、路径与 symlink 安全、测试命令策略、CLI 校验 —— 全部注入 `FakeChatProvider` 保证确定性。
- **Golden**：`tests/golden/event-schema.snapshot.json` 锁定事件契约，防 Schema 漂移。
- **E2E**：`tests/e2e/full-workflow.test.ts` 真实执行 `node --test` 并创建真实 Git commit。
- 校验命令：`npm run typecheck`（`tsc --noEmit`）。当前无独立 lint 脚本（见 §11）。

---

## 11. 已知问题与决策记录（评审发现）

| # | 问题 | 位置 | 严重度 | 处置 |
|---|---|---|---|---|
| 1 | `git_commit --no-verify` 绕过仓库钩子 | `src/tools/git-tools.ts:100` | 中 | 有意的产品决策（钩子可能拦截自动化提交）；生产化时应改为可配置（默认执行 hooks，失败转人工审批）。 |
| 2 | `collectWorkspaceContext` 用**字符** `slice(0,80_000)`，非字节 | `src/agents/code-agent.ts:110` | 中 | 含大量多字节文本（如中文注释）时，80K 字符换算 token 可能 >32K input 预算，触发 `HardFailure` 而非正常截断。短期改为按 utf8 字节截断；长期由 TokenBudgetTracker 前移预算感知。 |
| 3 | REVIEW input 预算 24K，但 diff 上限 72K 字节（≈18K token）+ 上下文开销，余量偏紧 | `src/core/agent-factory.ts` policyFor / budgets.ts | 低 | 超限已有安全兜底（diff 截断即驳回，§6.2-4），可接受；调参时优先提升 REVIEW input 预算或收紧 diff 上限。 |
| 4 | 路径检查存在 TOCTOU（realpath 校验与 readFile 之间可换链） | `src/tools/path-safety.ts` | 低 | 本地可信场景可接受；Phase 3 沙箱用严格句柄化（O_NOFOLLOW / 沙箱 FS）消除。 |
| 5 | 无独立 lint / format 脚本 | `package.json` | 低 | 建议补 `eslint` + `prettier`，纳入 CI。 |

## 12. 演进路线（对齐 PRD §6）

| 阶段 | 架构动作 | 接缝 |
|---|---|---|
| Phase 2 可观测 | 回放 UI / 实时事件订阅 | EventLog 已就绪，补 WS 订阅层 |
| Phase 3 生产级 | 沙箱执行、审批网关、并发任务、真实仓库接入 | `ToolPolicy`→沙箱；阶段表→可配置流水线；`EventLog` 单文件→可寻址存储 |
| Phase 4 长期记忆 | 向量库 + 语义检索 | `MemoryProvider` 替换 Noop |

**明确不做（防过度设计）**：不引入 MQ、DB、图/事件引擎、Agent 自由对话拓扑。单进程、顺序执行、JSONL 落盘支撑演示闭环，且迁移路径清晰。

---

## 13. 与 PRD v0.2 的对应关系

- DoD 前四项（全流程 / 审查真实输出 / 测试真实通过 / 有效 commit）：已由 e2e 验证 ✅。
- DoD 第五项（可复现）：按 v0.2 澄清口径 —— "同输入 → 同流程、同事件序列、门禁判定可复现"（`temperature=0 + seed=42` 尽力而为，非比特级）。
- 非目标（长期记忆 / 可视化 / 并发）：架构接缝已留，均不实现。
