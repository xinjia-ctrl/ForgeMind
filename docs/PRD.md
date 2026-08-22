# ForgeMind 产品需求文档（PRD）

> 版本：v3.0（npm 发布版本 `3.0.0`；主动监测、有界协商、L4 语义记忆与质量回馈已实现）
> 状态：v3.0 全部验收项已实现；`npm run check` 通过（151 项：148 通过，3 项真实依赖 smoke 条件跳过）
> 演进总览：v0.2 闭环 → v0.3 可观测 → v0.4 安全 → v0.5 记忆/提示词 → v1.0 DAG/多仓库 → v2.0 企业集成/RBAC/审计 → v3.0 主动监测/有界协商/语义记忆

## 1. 产品定位

ForgeMind 是一个生产级 Multi-Agent Coding Agent 系统，通过多个 AI Agent 协作实现软件研发全流程闭环：需求分析 → 产品设计 → 架构设计 → 代码开发 → 代码审查 → 测试验证 → Git 提交。

产品定位是打造类似 Devin、Claude Code 的 AI 软件研发平台。当前已具备：单任务闭环、可观测报告、沙箱与审批、四层记忆、DAG 并发编排、企业审计与主动事件监测，架构上持续向"研发操作系统"演进（对齐 `docs/VISION.md`）。

## 2. 目标用户与场景

| 场景         | 用户     | 核心诉求                                                                                       |
| ------------ | -------- | ---------------------------------------------------------------------------------------------- |
| 面试展示     | 候选人   | 一条自然语言需求，演示多 Agent 协作产出可运行代码、测试通过并完成 Git 提交；过程可审计、可回放 |
| 个人研发提效 | 开发者   | 将"需求 → 提交"的重复劳动交给系统，人只做关键决策与最终验收                                    |
| 团队协作     | 研发团队 | 需求标准化、过程可追溯、质量有保障（代码审查 + 测试验证作为强制环节）                          |
| 跨仓库研发   | 研发团队 | 一个需求拆解为多任务并行，跨仓库协作（`dag run`）                                              |
| 无人值守研发 | 团队     | 监听 issue/CI 失败自动触发研发闭环（Agentic）                                                  |
| 企业治理     | 管理员   | RBAC 权限 + 全量审计导出 + 配额管控                                                            |

## 3. MVP 范围与核心能力

MVP 只做一件事并做通：**一个自然语言需求，经多 Agent 协作，产出通过测试的代码并完成 Git 提交**。

核心能力：

1. **需求解析**：将自然语言需求拆解为可执行的任务计划。
2. **多 Agent 协作**：计划 / 架构 / 编码 / 审查 / 测试 / 提交 各环节由专职 Agent 承担，角色之间有明确的输入输出契约。
3. **代码审查强制门禁**：Reviewer 发现缺陷时驳回，由系统决策返工，而非静默通过。
4. **测试验证强制门禁**：测试未通过不允许进入提交环节。
5. **Git 提交**：全链路通过后自动生成提交信息并执行提交。
6. **过程可观测**：每个环节的输入输出可审计、可回放，用于面试演示与问题定位。
7. **离线可视化**：任意历史 Run 可生成单文件 HTML，展示时间线、返工、失败定位、阶段统计和产物。
8. **生产安全**：动作级三态策略、审批网关和容器沙箱构成纵深防御，全部决策可审计。
9. **可选四层记忆**：用户显式启用后检索历史 Run、项目决策与教训，并通过 L4 语义检索补充关键词召回；写入仍为确定性投影。
10. **提示词与上下文治理**：版本化五段式提示词、原生结构化输出、相关性检索和上下文审计。
11. **DAG 并发编排**：一个需求拆解为多任务 DAG，跨仓库并行执行（`dag run`）。
12. **RBAC 权限治理**：角色化权限 + 策略分级，deny-by-default。
13. **企业审计导出**：按时间/角色/仓库检索并导出全部 Run 与审批决策。
14. **主动事件监测**：监听 issue/CI/PR 事件，按规则自动触发研发闭环，三层护栏防失控。
15. **有界多 Agent 协商**：架构冲突或重复驳回时执行最多三轮 Proposal → Counter → Decision，未收敛则升级审批。

## 4. 非目标（MVP 明确不做）

- 不做未经授权的全局记忆；CLI 只检索当前仓库，跨项目语义检索必须由 API 调用方显式配置授权仓库根目录。
- 不做需要常驻服务的实时 Web 仪表盘（静态离线报告已实现，实时视图延后）。
- 不做模型能力横向比拼，只保证链路可用。
- 不做多 Agent 自由协商；只支持三轮有界、可审计且可升级的结构化协议。

## 5. MVP 演示验收标准（DoD）

给定一个固定样例需求，一条命令执行后必须同时满足：

- [x] 自动完成 需求 → 架构 → 编码 → 审查 → 测试 → 提交 全流程；
- [x] 审查环节有真实输出（非空壳）；
- [x] 测试环节真实运行并通过（非 mock）；
- [x] 生成有效的 Git commit；
- [x] 全流程事件可逐步回放，且结果可复现（同输入同结果）。
- [x] 一条命令为成功或失败 Run 生成离线单文件 HTML 报告；
- [x] 报告可播放阶段/attempt 时间线，高亮门禁返工和失败类型；
- [x] 报告展示可追溯的 token、工具次数、阶段耗时与产物。
- [x] 测试命令在资源受限、默认断网的 Docker/Podman 沙箱执行；
- [x] 高风险动作支持 allow/approve/deny，审批请求、批准和拒绝完整审计；
- [x] 报告展示策略、审批和沙箱安全证据。
- [x] 双 Run 时，第二次 PLAN/ARCH 能召回第一次的情景与项目记忆，读写均有审计事件；
- [x] 提示词资源可版本化，`llm.called` 记录版本并优先使用原生 JSON Schema；
- [x] CODE 上下文按架构文件、grep 命中和关键词相关性装配，报告展示来源与 token；
- [x] `npm run eval` 对 4 条代表性需求输出确定性 A/B 指标。
- [x] 跨仓库需求拆解为 DAG 任务并行执行，依赖按序等待，各自过门禁；
- [x] RBAC 角色生效，未授权动作拒绝且入审计；
- [x] `audit export` 按窗口导出审计数据（JSON/CSV）；
- [x] 主动监测：事件经去重/配额/冷却判定后触发，`development.received` / `trigger.decided` 全量落盘。
- [x] 主动层 cursor、去重、限流、每日配额、pending 与 dispatch 重试通过原子 checkpoint 跨重启恢复。
- [x] GitHub/Jira/CI Webhook 在解析前校验原始字节 HMAC；GitHub Workflow、Jira Issue 与通用 CI Poller 支持持久 cursor。
- [x] 幂等 dispatcher 将单仓请求路由到 `runForgeMind`、多仓请求路由到 `runDagForgeMind`，并持久化 RUNNING/FAILED/COMPLETED 状态。
- [x] 成功 Run 可推送独立分支、创建/复用 GitHub PR，并幂等回写 GitHub Issue/PR、Jira Issue 或 CI；不自动合并。
- [x] 协商触发后最多三轮收敛或升级，结构化 `DecisionRecord` 确定性写入 L3。
- [x] 后续 Run 可通过 L4 召回历史决策/教训，`memory.recalled` 记录 `semantic` 命中依据。

> **实现状态说明（v3.0）**：原有闭环、安全与门禁语义保持不变。记忆默认关闭，只有 `--memory` 或 API 注入 Provider 时启用；L4 默认使用零依赖词法向量 + BM25，也提供 `OpenAICompatibleEmbeddingProvider` 外部向量实现。项目记忆通过 Git 本地 exclude 不进入生成的 commit。主动监测为库 API（`AgenticWatchService`），已经具备签名 Webhook、cursor Poller、持久幂等 dispatcher 和 PR/评论回写；部署方只需注入凭据、HTTP 路由与仓库路径解析。真实容器、外部模型和向量 Provider 由 `test:smoke:release` 在具备凭据与运行时的发布环境强制验证。

## 6. 核心能力与实现对照（v3.0）

| PRD 能力               | 实现落点                                                         | 状态 |
| ---------------------- | ---------------------------------------------------------------- | ---- |
| 需求解析               | `PlanAgent`（`src/agents/plan-agent.ts`）→ `plan.md`             | ✅   |
| 多 Agent 协作          | 6 个 `StageAgent`，仅 Orchestrator 调度，零直接调用              | ✅   |
| 代码审查强制门禁       | `ReviewAgent` 只读审查 + diff 指纹锚定 + 返工回路                | ✅   |
| 测试验证强制门禁       | `TestAgent` 真实运行白名单测试命令                               | ✅   |
| Git 提交               | `CommitAgent` + `GitCommitTool`，独立分支，不自动合并            | ✅   |
| 过程可观测             | `EventLog` JSONL + `replay` 回放器                               | ✅   |
| 离线可视化报告         | `events → ReportViewModel → HTML` + `report` CLI                 | ✅   |
| 流程可复现             | `workflowTrace/workflowSignature` + 双 Run e2e 验证              | ✅   |
| 上下文预算控制         | `TokenBudgetTracker` + 每阶段独立预算（`config/budgets.ts`）     | ✅   |
| 安全边界               | `ToolPolicy` 白名单 + 路径/symlink 防护 + 审计脱敏               | ✅   |
| 动作级策略与审批       | `PolicyResolver` + `ApprovalGateway` + `approval.*`              | ✅   |
| 容器沙箱与资源上限     | Docker/Podman `ProcessRunner` + 默认拒绝本机降级                 | ✅   |
| 安全审计视图           | 报告 security 投影与离线面板                                     | ✅   |
| 四层记忆与语义检索     | L2/L3 + L4 默认词法及 OpenAI-compatible 外部向量 Provider        | ✅   |
| 提示词版本与结构化输出 | `prompts/*.v1.md` + JSON Schema + 能力降级                       | ✅   |
| 相关性上下文与审计     | `Context Assembler` + `context.assembled` + 报告面板             | ✅   |
| 提示词评测             | 4 场景 FakeProvider A/B 指标（`npm run eval`）                   | ✅   |
| DAG 并发编排           | `src/dag/`（plan/scheduler/task-runner）+ `dag run` CLI          | ✅   |
| RBAC 权限治理          | `src/auth/`（rbac/policy-source）+ `--actor-policy`              | ✅   |
| 企业审计导出           | `src/audit/`（query/export）+ `audit export` CLI                 | ✅   |
| 主动事件监测           | trigger/watch/guardrail + 原子 checkpoint 跨重启恢复             | ✅   |
| 外部事件与回写闭环     | 签名 Webhook/cursor Poller + 幂等 dispatcher + PR/评论回写       | ✅   |
| 有界多 Agent 协商      | `src/negotiation/` + DAG Artifact mismatch + `DecisionRecord` L3 | ✅   |
| 自我评估与质量回馈     | `src/quality/` + `run.quality` + L3 教训 + 报告质量面板          | ✅   |
| 实时视图 / 自由协商    | 本轮明确非目标                                                   | —    |

## 7. 演进路线

| 阶段           | 内容          | 目标                                    |
| -------------- | ------------- | --------------------------------------- |
| Phase 1（MVP） | 完整闭环 Demo | ✅ 单条需求走通全链路，可演示、可复现   |
| Phase 2        | 可观测增强    | ✅ 静态离线报告；实时协作视图待后续     |
| Phase 3        | 生产级能力    | ✅ 权限审批与沙箱、DAG 并发、RBAC、审计 |
| Phase 4        | 长期记忆      | ✅ 项目 L2/L3 + L4 语义检索             |

## 8. 关键约束

- 技术栈：TypeScript / Node。
- 上下文必须有预算控制，禁止全量塞入。
- 全链路必须设置最大迭代轮次，防止死循环。
- 系统面向"真实生产使用"演进，安全与可审计性是长期底线。

## 9. 使用文档入口

- 产品使用手册（使用者视角）：`docs/PRODUCT_MANUAL.md`
- 架构与 ADR：`docs/ARCHITECTURE.md`
