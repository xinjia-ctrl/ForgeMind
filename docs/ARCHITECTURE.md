# ForgeMind 架构设计文档（ADR）

> 版本：v0.5（对齐 PRD v0.5，记忆、上下文与提示词工程已实现，完整测试套件通过）
> 状态：已实现
> 技术栈：TypeScript / Node（>=22），单一进程、运行时零第三方依赖（无 DB / MQ / 框架）

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
CLI (src/runtime/cli.ts: forge-mind run / forge-mind replay / forge-mind report)
  │
  ▼
runForgeMind (src/runtime/run.ts)
  │  校验 run/repo/测试配置 → 建分支 forgemind/<runId> → 建 EventLog
  ▼
Orchestrator (src/core/orchestrator.ts)  —— 唯一决策中枢，持有 Run 级状态机
  │  顺序推进阶段 + 门禁返工回路（≤ maxRework=3）
  │  每阶段：AgentFactory.create(stage) → 注入 ScopedToolExecutor + ToolPolicy + TokenBudget
  ▼
StageAgent (src/agents/*)  —— 单次 LLM 调用，返回结构化 StageOutput
  │       │
  │       ├─ ChatProvider (src/llm/)  —— OpenAI 兼容 / Fake
  │       └─ ScopedToolExecutor  —— 白名单 → 动作策略 → 审批 → 工具 + 审计
  │                  └─ RunCommandTool → ProcessRunner → Docker/Podman 沙箱
  ▼
EventLog (src/core/event-log.ts)  —— JSONL 持久化到 <git-dir>/forgemind/runs/<runId>.jsonl
  └→ replay (src/core/replay.ts)  —— 纯函数重建 Timeline
  └→ workflowSignature (src/core/reproducibility.ts) —— 规范化流程签名
  └→ report (src/report/) —— events → view model → 单文件 HTML
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
├── memory/     # LayeredMemory + EventLog 情景检索 + 项目记忆 + Noop
├── prompts/    # 五段式版本化 Prompt 资源、严格 JSON Schema 与加载器
├── context/    # 相关性排序与来源标记的 Context Assembler 纯函数
├── runtime/    # CLI、run 编排入口、Git 工作区、测试命令解析
├── report/     # 事件投影、HTML 纯渲染、报告 IO 装配
├── policy/     # 动作级三态解析 + 审批网关
├── sandbox/    # ProcessRunner + Docker/Podman/显式本机实现
└── config/     # Token 预算 + 安全策略配置加载
tests/
├── unit/       # orchestration / security / report view model + renderer / cli
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

| type                                                 | 关键 data                                                         | 用途           |
| ---------------------------------------------------- | ----------------------------------------------------------------- | -------------- |
| `run.started` / `run.finished`                       | runId, requirement, branch / status, summary                      | 运行边界       |
| `stage.started` / `stage.completed` / `stage.failed` | stage, attempt / status / kind, error, stack                      | 阶段生命周期   |
| `llm.called`                                         | model, tokens, promptFingerprint, promptVersion, structuredOutput | 决策点 + 成本  |
| `memory.recalled` / `memory.stored`                  | scope, source/路径, score, reason, used                           | 记忆审计       |
| `context.assembled`                                  | sections(source/references/tokens), tokenEstimate                 | 上下文审计     |
| `tool.called`                                        | tool, args, result, policy                                        | 审计（含脱敏） |
| `approval.requested/approved/rejected`               | action, policy, mode, source/reason                               | 安全决策审计   |
| `artifact.produced`                                  | path, kind, summary                                               | 产物追溯       |
| `gate.rejected` / `gate.passed`                      | reason, feedback / evidence                                       | 门禁证据       |

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

## 6. 上下文工程与 Token 预算

### 6.1 预算表（`src/config/budgets.ts`，input/output tokens）

| 阶段   | input | output |
| ------ | ----- | ------ |
| PLAN   | 8K    | 2K     |
| ARCH   | 12K   | 3K     |
| CODE   | 32K   | 8K     |
| REVIEW | 24K   | 3K     |
| TEST   | 2K    | 500    |
| COMMIT | 2K    | 500    |

`TokenBudgetTracker`（`src/core/token-budget.ts`）：input/output 独立计数，`ensureInputFits/ensureOutputFits` 在**消耗前**校验，超限抛 `HardFailure`（Fail-Fast），绝不静默截断 LLM 调用。`estimateTokens = utf8字节/4`（保守估算），实际消耗以厂商 `usage` 结算。

### 6.2 四条铁律（强制层：AgentFactory 注入 + BaseAgent 统一执行）

1. **代码检索优先于投喂**：Agent 只能经工具触达代码；CODE 阶段按“ARCH 预期文件 → grep 命中 → 文件名关键词”排序，最多 8 个文本文件、每文件前 400 行、总量 ≤80K UTF-8 字节。`truncateUtf8` 保证不切断多字节字符。
2. **跨阶段只传摘要**：下一阶段 prompt 只带 `summary`，不带完整产物。
3. **工具结果分片**：`read_file` 按行范围 + 字节上限，grep 最多 200 条命中，glob 最多 500 文件，diff 按字节截断并置 `truncated`。
4. **REVIEW 超限即驳回**：diff 超出审查预算时，ReviewAgent 直接 `rejected`（reason=上下文超限），引导拆小改动——预算失效转成产品级反馈，而非静默放行。

---

## 7. Tool 系统

### 7.1 工具集（`src/tools/index.ts`）

`read_file`、`write_file`（原子写：临时文件+rename）、`edit_file`（精确串匹配 + `expectedOccurrences` 计数校验）、`grep`、`glob`、`run_command`、`git_status`、`git_diff`（含未跟踪文件）、`git_commit`。

工具不 throw（`errorMessage` 兜底转结构化 `ToolResult`），所有调用由 `ScopedToolExecutor` 统一记录 `tool.called` 并通过共享 `auditValue` 做**审计脱敏**（prompt/token/密钥、文件内容、diff、编辑片段和命令输出等键值 → `<redacted>`）。

### 7.2 ToolPolicy（deny-by-default，`src/tools/types.ts`）

每阶段独立策略，AgentFactory 在 `policyFor()` 中装配：

- 工具白名单（`allowedTools`）+ 阶段可写开关（REVIEW/TEST 只读）。
- 写前缀约束：PLAN/ARCH 仅 `docs/.forgemind/<runId>`；CODE 禁止写该目录。
- 命令白名单：仅 `allowedCommands` 精确 argv 匹配。
- Git hooks 默认执行；仅显式 `--skip-git-hooks` 时由 COMMIT 策略加入 `--no-verify`。
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

### 7.5 Phase 3 安全执行链（ADR-6）

`ScopedToolExecutor` 在既有阶段白名单之后叠加 `PolicyResolver`：规则支持 `allow / approve / deny`，命中优先级为 command 精确规则 > stage+tool > tool > `defaultMode`，同具体度后加载层优先。配置层从低到高为内置默认、全局文件、环境 JSON、`--config`、仓库 `forgemind.config.json`；未知字段或非法值直接 `HardFailure`。

`approve` 由统一 `ApprovalGateway` 处理：TTY 交互、`--yes` 自动批准或 `--no-approve`/无 TTY 拒绝。请求、批准、拒绝分别落 `approval.*`，动作先经 `auditValue`。

`RunCommandTool` 不再直接依赖宿主进程函数，而依赖注入的 `ProcessRunner`。生产默认 Docker/Podman：

- 镜像必须使用 sha256 digest 固定；无可用运行时默认 fail-fast。
- `/source` 是唯一宿主只读挂载；固定入口脚本复制到 `/workspace` tmpfs 后执行 argv，测试副产物不回传。
- 默认 `--network=none`、`--read-only`、`--cap-drop ALL`、`no-new-privileges`，并限制 CPU、内存、PID、超时和输出。
- `sandbox.mode=local` 仅是显式受信任降级，强制 `defaultMode=deny`，事件证据标记为 `local/host`。

---

## 8. 静态可观测性报告（Phase 2 P0）

`forge-mind report --repo <path> --run-id <id>` 从 JSONL 事件生成 `<git-dir>/forgemind/reports/<runId>.html`。报告是日志的只读投影，不参与运行状态决策：

```
EventLog.load() → buildReportViewModel(events) → renderReportHtml(model) → atomic write
       IO                    纯函数                     纯函数                 IO
```

- `src/report/view-model.ts`：复用 `workflowTrace`，按实际事件顺序和 stage/attempt 分组；聚合 token、工具次数、阶段耗时、门禁返工、产物和失败定位。
- `src/report/render-html.ts`：生成内嵌 CSS/JavaScript 的单文件报告，提供时间线播放；所有动态文本统一 HTML 转义。
- `src/report/report.ts`：唯一报告 IO 边界，负责加载日志并原子写入报告。
- 阶段失败或缺少 `stage.completed` 时，耗时为 `null`；不基于相邻事件猜测。旧日志缺少 `stage.failed.kind` 时展示 `UNKNOWN`，不根据错误字符串推断。
- 最多渲染 2,000 条事件；超限时抽样普通事件，并优先保留失败、门禁和失败工具调用。
- 工具 `args/result` 在报告投影时再次调用共享 `auditValue`；CSP 禁止外部资源，报告可完全离线打开。
- 安全事件面板投影 `approval.*` 与策略化 `tool.called`，展示 ALLOWED/REQUESTED/APPROVED/DENIED、决策来源、时间和脱敏详情。

---

## 9. Memory 设计（项目级 L2/L3，默认关闭）

| 层          | 载体                                         | 当前行为                                   |
| ----------- | -------------------------------------------- | ------------------------------------------ |
| L1 working  | 不可变 `TaskContext` + 阶段产物              | 所有阶段已有，生命周期为单 Run             |
| L2 episodic | `<git-dir>/forgemind/runs/*.jsonl`           | 按需求关键词与运行结果检索历史轨迹         |
| L3 project  | `.forgemind/memory/{decisions,lessons}.json` | ARCH/门禁事实确定性投影，按 tag/关键词召回 |
| L4 semantic | `null`                                       | 接口占位，容器跳过且不报错                 |

`MemoryProvider` 保持统一 `remember / rememberGate? / recall(query, options)` 接口。默认注入 `NoopMemoryProvider`；只有 CLI `--memory` 或 API 显式传入 Provider 才启用。PLAN/ARCH 在 `BaseAgent` 生命周期内只读注入召回结果；项目记忆写入需 `--memory` 确认，运行入口将目录加入 Git 本地 exclude。记忆内容不参与控制流决策，也不修改用户代码。

---

## 10. 安全边界（Phase 3）

安全采用三层纵深：阶段级最小权限、动作级策略/审批、容器运行隔离。任一层缺失不会静默降级：

1. deny-by-default 阶段策略（含只读 REVIEW/TEST）。
2. 命令/工具精确白名单，无 shell。
3. 路径包含 + symlink 逃逸防护 + `.git` 禁访。
4. 输出字节截断 + 审计脱敏 + 全量事件落盘。
5. `git_commit` 默认执行仓库 hooks；hooks 失败时 Run 失败并保留分支。仅用户显式传入 `--skip-git-hooks` 才使用 `--no-verify`，且策略写入审计事件。
6. 测试进程默认容器沙箱；宿主仅用于显式受信任降级。
7. 所有批准、拒绝和沙箱证据进入事件日志并由报告展示。

---

## 11. 工程质量

### 11.1 错误分类（`src/core/errors.ts`）

| 类型           | kind  | 含义                                   | Run 结果 |
| -------------- | ----- | -------------------------------------- | -------- |
| `StageFailure` | STAGE | Agent 可修复（返回结构错误、工具失败） | FAILED   |
| `HardFailure`  | HARD  | 预算超限 / 权限 / 仓库不干净           | FAILED   |
| `FatalFailure` | FATAL | 框架级（契约漂移、事件日志损坏）       | BLOCKED  |

`BaseAgent` 在 `stage.failed` 写入分类；该字段保持可选以兼容 v0.2 日志。未分类的运行时异常按框架级 `FATAL` 处理，避免未知错误静默降级。

### 11.2 测试策略（完整套件通过，`npm test` = build + `node --test`）

- **单元**：覆盖编排、安全、报告、分层记忆、损坏记忆 fail-fast、Prompt 资源/Schema、结构化能力降级、上下文排序、工作区检索与事件并发写入。
- **Golden**：`tests/golden/event-schema.snapshot.json` 锁定新增 memory/context/prompt 事件契约，防 Schema 漂移。
- **E2E**：保留真实测试/commit/可复现性、审批拒绝与报告；新增双 Run 记忆召回及记忆不进入 commit 的验证。
- **Eval**：`npm run eval` 用 4 条代表性需求与 FakeProvider 输出 A/B 通过率、返工、越权调用与 token 成本。
- **质量门禁**：`npm run check` 串行执行 TypeScript 严格检查、类型感知 ESLint、Prettier 检查与测试；`.github/workflows/ci.yml` 在 push / pull request 中运行同一门禁。

---

## 12. 已知问题与决策记录（评审发现）

| #   | 问题                                                                             | 位置                                               | 严重度 | 处置                                                                              |
| --- | -------------------------------------------------------------------------------- | -------------------------------------------------- | ------ | --------------------------------------------------------------------------------- |
| 1   | REVIEW input 预算 24K，但 diff 上限 72K 字节（≈18K token）+ 上下文开销，余量偏紧 | `src/core/agent-factory.ts` policyFor / budgets.ts | 低     | 超限已有安全兜底（diff 截断即驳回，§6.2-4）；调参时优先提升预算或收紧 diff 上限。 |
| 2   | 路径检查存在 TOCTOU（realpath 校验与 readFile 之间可换链）                       | `src/tools/path-safety.ts`                         | 低     | 本地可信场景可接受；Phase 3 沙箱用严格句柄化（O_NOFOLLOW / 沙箱 FS）消除。        |

**v0.2 已解决决策**：Git hooks 改为默认执行且可显式跳过；CODE 上下文改为 UTF-8 字节截断；新增 ESLint、Prettier 与 CI；新增规范化工作流签名关闭可复现性 DoD。

**v0.3 已解决决策**：`stage.failed.kind` 向后兼容落盘；审计函数提升为 executor/report 共享模块；新增纯函数报告管线、离线单文件渲染和 2,000 条时间线边界。

**v0.4 已解决决策**：三态策略与审批网关进入统一 Tool 执行链；测试命令容器化且资源受限；本机降级显式且可审计；报告新增安全面板。

**v0.5 已解决决策**：L2/L3 项目记忆确定性投影且显式启用；Prompt 资源化并记录版本；原生结构化输出带能力降级且不重试；上下文按相关性装配并在报告审计；评测集提供 A/B 护栏。

## 13. 演进路线（对齐 PRD §7）

| 阶段             | 架构动作                                | 接缝                                                 |
| ---------------- | --------------------------------------- | ---------------------------------------------------- |
| Phase 2 可观测   | ✅ 静态离线报告；实时事件订阅待后续     | 纯投影已就绪；实时能力可复用 EventLog                |
| Phase 3 生产级   | ✅ 沙箱与审批；并发任务待后续           | `ProcessRunner`/`ApprovalGateway` 可继续扩展远程实现 |
| Phase 4 长期记忆 | ✅ 项目 L2/L3；跨项目向量语义检索待后续 | `LayeredMemory` 的 semantic 接缝可独立替换           |

**明确不做（防过度设计）**：不引入 MQ、DB、图/事件引擎、Agent 自由对话拓扑。单进程、顺序执行、JSONL 落盘支撑演示闭环，且迁移路径清晰。

---

## 14. 与 PRD v0.5 的对应关系

- DoD 前四项（全流程 / 审查真实输出 / 测试真实通过 / 有效 commit）：已由 e2e 验证 ✅。
- DoD 第五项（可复现）：`workflowSignature` 双 Run 一致性 + 相同门禁判定已由 e2e 验证 ✅；`temperature=0 + seed=42` 尽力稳定模型输出，非比特级承诺。
- Phase 2 P0（时间线 / 门禁 / 失败 / 统计 / 离线报告）：纯函数投影 + CLI 成功/失败 e2e 已验证 ✅。
- Phase 3 P0/P1（策略 / 审批 / 沙箱 / 资源限制 / 安全报告 / CLI 交互）：回归保持 ✅。
- v0.5 P0（L2/L3 记忆 / Prompt 版本 / 结构化输出）与 P1（相关性上下文 / 报告审计 / Eval）：完整测试套件与 4 场景评测验证 ✅。
- 非目标（L4 跨项目语义记忆 / 并发 / 云托管）：架构接缝已留，本轮不实现。
