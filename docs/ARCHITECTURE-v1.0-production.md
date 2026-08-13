# ForgeMind 架构设计文档（ADR）— 生产可用（v1.0）

> 迭代：v1.0（第七轮，从演示到生产可用）
> 前置：v0.5 已实现（记忆/提示词工程 + 兼容性与并发增强，64/64 测试通过）
> 状态：V1 DAG 内核已实现；V2 多仓库全链路与 V3 Web 工作台规划中（对齐 `docs/PRD-v1.0-production.md`）
> 技术栈：TypeScript / Node，零运行时第三方依赖（Web 工作台用 Node 原生 http + SSE，不引框架）

---

## 1. 范围与设计原则

本轮目标：从"单任务 CLI 工具"升级为"可并行、可接入真实研发流程的研发平台"——**DAG 并发编排 + 多仓库 + Web 工作台**。

追加本轮专属约束：

> **ADR-10（本轮核心）：DAG 只换拓扑，不换执行器。**
> 现有 `Orchestrator`（`src/core/orchestrator.ts`）已是成熟、经过 64 测试验证的单任务状态机 + 门禁回路。v1.0 把它**原样复用为 DAG 节点执行器**，新增的只是"调度拓扑"（依赖表、并行、失败传播）。不重写执行语义，杜绝"并发改造"引入的回归。

> **ADR-11：并发隔离 = 每任务独立沙箱与工作区快照，交叉产物走显式 Artifact 引用。**
> 多任务并发最大风险是共享可变目录踩踏（PRD §8-1）。约束：每个任务独立工作区快照（v0.4 沙箱）、独立分支、独立 EventLog；任务间数据传递只允许经显式 Artifact 引用（父 Run 产物索引），禁止共享可变目录。

> **ADR-12：工作台是只读投影 + 审批 UI，不是第二系统。**
> 工作台复用事件流与报告纯函数管线：看板 = EventLog 的实时投影（SSE），结果页 = v0.3 `generateReport` 的复用，审批 = v0.4 `ApprovalGateway` 的 UI 化（接口不变）。P0 不包含编辑/配置界面（范围陷阱防护，PRD §8-3）。

**兼容原则**：单任务模式行为不回归（DoD 硬性要求）；事件 Schema v1.3 仅新增可选字段；v0.5 的 64 个测试全部保持通过。

---

## 2. 架构总览（增量视角）

```
CLI
 ├─ forge-mind dag run --repos a,b,c --requirement "..."   [新增：多任务编排]
 └─ forge-mind serve --repos a,b,c                          [新增：Web 工作台]
       │
       ▼
DagOrchestrator（src/dag/scheduler.ts，新增）
  │  1. PM Agent 拆解需求 → DagTask[] + 依赖表
  │  2. 环检测（拓扑排序，无环才可执行）
  │  3. 调度循环：就绪任务并行执行
  │  4. 失败传播：任务失败 → 下游标记 blocked
  │  5. 聚合：PR 清单（不自动 merge）
  │
  ├─▶ TaskRunner × N（复用现有单任务执行，见 ADR-10）
  │      每任务独立：runId(子 Run)、工作区快照/沙箱、分支、EventLog
  │      内部仍走 PLAN→ARCH→CODE⇄REVIEW⇄TEST→COMMIT + 审批网关
  │
  └─▶ EventLog v1.3（runId + parentRunId + taskId 两级索引）
         │
         ▼
Web 工作台（src/workspace/，新增）
  ├─ 看板：SSE 订阅事件 → DAG 实时状态
  ├─ 审批面板：HTTP API → ApprovalGateway（Workbench 实现，接口不变）
  └─ 结果页：复用 v0.3 报告渲染
```

**两级事件索引（PRD §8-4）**：父 Run 事件带 `parentRunId`/`taskId`，子 Run 带独立 `runId`；报告/回放按任务过滤。事件量并发放大后仍可定位、可审计。

---

## 3. 模块边界（新增/改动）

```
src/
├── dag/                      # 新增：DAG 编排
│   ├── types.ts              # DagTask / DagResult / TaskDependency
│   ├── plan.ts               # 任务拆解（PM Agent → DagTask[]，复用 PLAN 产物契约）
│   ├── scheduler.ts          # 调度器（拓扑/并行/失败传播）
│   └── task-runner.ts        # 节点执行器（封装复用 runForgeMind 单任务能力）
├── workspace/                # 新增：Web 工作台
│   ├── server.ts             # Node http 服务器（零依赖）
│   ├── sse.ts                # SSE 事件广播（订阅 EventLog/运行中事件流）
│   ├── api.ts                # HTTP API（审批决策回传）
│   └── approval-gateway.ts   # WorkbenchApprovalGateway（实现 ApprovalGateway 接口）
├── core/
│   ├── orchestrator.ts       # 既有，语义不动（作为 TaskRunner 的底层执行器）
│   ├── events.ts             # 改动：+ parentRunId / taskId 可选字段（v1.3）
│   └── run.ts                # 改动：runForgeMind 拆分为可复用"单任务执行器"工厂
└── runtime/cli.ts            # 改动：新增 dag / serve 子命令
```

---

## 4. C1 DAG 并发编排

### 4.1 数据契约

```ts
interface DagTask {
  readonly taskId: string;
  readonly deps: readonly string[]; // 依赖的任务 id（无环约束）
  readonly repo: string; // C2 多仓库：作用仓库
  readonly requirement: string; // 子需求（PM Agent 拆解产物）
}

interface DagResult {
  readonly status: "SUCCEEDED" | "FAILED" | "PARTIAL";
  readonly tasks: ReadonlyArray<{ taskId: string; status: TaskStatus; runId: string }>;
  readonly prList: readonly PRCandidate[]; // 跨仓库 PR 清单，不自动 merge
}
```

### 4.2 调度器语义

| 规则     | 实现                                                                    |
| -------- | ----------------------------------------------------------------------- |
| 无环约束 | 任务拆解后立即拓扑排序；检测到环 → 拆解阶段即 `HardFailure`（PRD §8-2） |
| 并行执行 | 就绪任务（所有 deps 成功）并发启动；每任务独立 `runId`（子 Run）        |
| 依赖等待 | 后继任务等待前驱 `SUCCEEDED`；前驱失败 → 后继不启动，标记 `BLOCKED`     |
| 失败传播 | 任务失败不拖垮并行任务；汇总为 `PARTIAL`/`FAILED`，产出失败清单         |
| 收敛     | 全部成功 → `PRCandidate[]`（repo/branch/需求摘要），**不自动 merge**    |

### 4.3 与现有 Orchestrator 的关系（ADR-10）

- `scheduler.ts` 只做拓扑决策；节点执行委托 `task-runner.ts`。
- `task-runner.ts` 复用 `runForgeMind`（`src/runtime/run.ts`）的单任务能力，改造点仅是**工厂化**：从 `run.ts` 抽取"创建 TaskExecutor（workspace/EventLog/AgentFactory/policy/memory）→ 注入 scheduler 调度"。
- 每个任务的门禁语义完全不变：REVIEW/TEST 强制、审批网关生效、Token 预算生效。

---

## 5. C2 多仓库支持

- 声明：`--repos a,b,c`；PM Agent 拆解时把任务绑定到具体仓库。
- 隔离：每仓库独立分支（`forgemind/<runId>`）、独立沙箱（`src/sandbox/` 现成）、独立测试命令（`test-command.ts` 现成）、独立 EventLog（各仓库 `.git/forgemind/runs/`）。
- 共享：`LayeredMemory`（`src/memory/layered-memory.ts`）按项目 scope 检索，父子 Run 共享决策；产物索引经显式 Artifact 引用。
- 合并策略：**产出 PR 清单，交人类决策**（PRD C2）；清单作为 `artifact.produced` 落盘，可在工作台/报告中查看。

---

## 6. C3 Web 工作台（P0：只读看板 + 审批 + 结果页）

### 6.1 形态（ADR-12 + PRD §4 方案 A）

自研静态页 + Node 原生 http + SSE，零前端/后端框架。

```
src/workspace/
├── server.ts          # http 服务：静态资源 + /events(SSE) + /approve(API)
├── sse.ts             # 从运行中事件流订阅 → 广播（复用 EventLog 事件结构）
├── api.ts             # POST /approve → 决策回传审批网关
└── approval-gateway.ts# WorkbenchApprovalGateway：request() 挂起 → 前端点击 → resolve
```

### 6.2 审批 UI 化（接口不变，v0.4 承诺兑现）

- 现有 `ApprovalGateway.request()` 是 Promise；CLI 交互网关用 stdin 读 `y/n`。
- `WorkbenchApprovalGateway`：`request()` 把待审批项推入内存队列并返回 pending Promise；前端看板展示 → 用户点击批准/拒绝 → `POST /approve` 触发 Promise resolve/reject。
- **接口、事件（`approval.*`）、审计链完全复用 v0.4**，零侵入。

### 6.3 看板与结果页

- 看板：SSE 推送 `stage.started/completed`、`gate.*`、`approval.*` → 前端渲染 DAG 节点状态（运行中/成功/失败/等待审批）。
- 结果页：复用 `generateReport`（`src/report/report.ts`）静态 HTML，任务完成后内嵌。

---

## 7. 事件演进（v1.2 → v1.3，向后兼容）

| 变化                                                   | 说明                                            |
| ------------------------------------------------------ | ----------------------------------------------- |
| `run.started` + 可选 `parentRunId`                     | 子 Run 标记父 Run                               |
| 全事件 + 可选 `taskId`                                 | 两级索引（runId + taskId），报告/回放按任务过滤 |
| 新增 `task.started` / `task.completed` / `task.failed` | 任务级生命周期（DAG 调度层事件）                |

- golden 快照同步；`parseEvent` 兼容旧 v1.2 日志（缺省字段不报错）。
- `workflowTrace`/`workflowSignature` 语义不变（按 runId 过滤后仍成立，可复现性不受并发影响）。

---

## 8. 测试策略

| 里程碑      | 测试落点                                                                                                 | 形态                                               |
| ----------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| V1 DAG 内核 | 并行执行（时间戳重叠）、依赖等待（前驱成功后继才启动）、失败传播（下游 blocked）、环检测、多任务事件索引 | 单元测试（注入 FakeTaskRunner + FakeChatProvider） |
| V2 多仓库   | 2 仓库 3 任务全链路、每任务独立分支/沙箱/测试、PR 清单产出                                               | e2e（真实 git 仓库，复用 full-workflow 模式）      |
| V3 工作台   | SSE 推送、审批回调闭环（approval.requested → 前端 → approved）、结果页内嵌                               | 集成测试（Node http 启动 + 请求断言）              |
| V4（P1）    | 配置化团队策略解析、webhook 鉴权                                                                         | 视预算                                             |

回归要求：`npm run check` + 既有 64 测试（单任务模式不回归）+ 本轮新增全部通过。

---

## 9. 风险与决策记录

| #   | 问题                      | 严重度 | 处置                                                        |
| --- | ------------------------- | ------ | ----------------------------------------------------------- |
| 1   | 并发写共享目录竞态        | 高     | ADR-11 独立沙箱/快照 + 显式 Artifact 引用；禁止共享可变目录 |
| 2   | DAG 死锁/循环依赖         | 高     | 拆解后拓扑排序，环即报错（PRD §8-2）；MVP 仅支持 DAG        |
| 3   | 工作台范围膨胀            | 中     | ADR-12 P0 只做只读看板+审批+结果页；编辑/配置界面划入后续   |
| 4   | 并发后事件量暴增          | 中     | v1.3 两级索引（runId+taskId），报告/回放按任务过滤          |
| 5   | CI 集成（C5）依赖外部平台 | 低     | 需要 webhook 鉴权与仓库权限设计；超预算则明确划入 v1.1      |
| 6   | 并发任务共享 LLM/预算     | 低     | 每任务独立 TokenBudget（既有），任务级并发不共享预算额度    |

## 10. 里程碑映射（PRD §9）

| 里程碑   | 架构动作                                                                 |
| -------- | ------------------------------------------------------------------------ |
| V1       | ✅ `dag/plan.ts` + `dag/scheduler.ts` + 单任务执行适配器 + `task.*` 事件 |
| V2       | 多仓库执行器（复用 sandbox/test-command/EventLog）+ PR 清单              |
| V3       | `workspace/`（server + sse + api + WorkbenchApprovalGateway）            |
| V4（P1） | 团队策略配置 + CI webhook                                                |

## 11. 与既有架构的衔接

- **复用不重写**：Orchestrator 状态机、门禁回路、ToolPolicy/审批/沙箱（v0.4）、LayeredMemory（v0.5）、报告纯函数（v0.3）全部原样复用。
- **改动面**：`run.ts` 工厂化（抽取可复用执行器）、`events.ts` 加索引字段、CLI 加 `dag`/`serve` 子命令。
- **演进**：Phase 4（L4 语义记忆）、C5 CI 集成（v1.1）、多租户/云端（非目标）与 v1.0 正交。

### V1 实现说明

- `DagPlanner` 对模型拆解结果执行仓库白名单、任务数、字段、依赖、重复 ID 与环检测；支持原生结构化输出。
- `DagScheduler` 只负责拓扑：就绪任务受控并发、依赖等待、失败隔离、递归 `BLOCKED` 传播；仅全成功时生成 PR 候选清单，不执行 merge。
- `ForgeMindTaskRunner` 复用 `runForgeMind`，注入 `parentRunId/taskId`，并拒绝任何不同任务复用同一真实工作区。V2 将提供 worktree/快照工厂与 2 仓库 3 任务 e2e。
- EventLog 支持父子 Run/任务索引，`task.started/completed/failed` 已进入回放、签名、报告投影和 golden 契约。
