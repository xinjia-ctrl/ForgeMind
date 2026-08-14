# ForgeMind 架构设计文档（ADR）— 企业平台（v2.0）

> 迭代：v2.0（第八轮，从研发工具到企业平台）
> 前置：v1.0 DAG 内核已实现（`src/dag/`，73/73 测试通过；Web 工作台 V3 进行中）
> 状态：I2 RBAC 内核与 I3 只读查询/导出已实现；I1 企业集成、I3 工作台面板规划中（对齐 `docs/PRD-v2.0-enterprise.md`）
> 技术栈：TypeScript / Node，零运行时第三方依赖（企业集成走标准 webhook + REST，OIDC 为 P1 接缝）

---

## 1. 范围与设计原则

本轮目标：让 ForgeMind 从"单团队内部工具"升级为"可被整个企业信任和治理的研发基础设施"——**接入企业系统（I1）、权限与治理（I2）、全量审计报表（I3）**。

追加本轮专属约束：

> **ADR-13（本轮核心）：v2.0 是"加外层"，不是"换内核"。**
> 企业能力（集成、RBAC、审计）全部作为**核心链路的外层适配**，不改动已由 73 测试验证的编排 / 安全 / 记忆内核（PRD §5 非目标）。核心只产出事件；集成与审计都是事件的消费方。

> **ADR-14：审计与集成都是"事件的只读投影"。**
> 延续 ADR-3/ADR-8 哲学：审计面板 = EventLog 的过滤聚合视图（只读索引，不引 DB）；企业集成 = 消费事件/产物的适配器。任何企业能力**不得**引入第二份事实源。

> **ADR-15：权限 deny-by-default，审批即 RBAC 的决策点。**
> RBAC 不另起一套权限系统，而是为 v0.4 审批网关（`ApprovalGateway`）注入**角色上下文**：风险等级 → 所需角色 → 当前 actor 是否具备。审计事件（`approval.*`）必须携带 `actor`/`role`，"谁批准了高风险动作"可追溯。

**兼容原则**：单任务/并发模式不回归；事件 Schema v1.4 仅新增可选字段与事件类型；既有 73 测试全部保持通过。

---

## 2. 架构总览（增量视角）

```
外部系统（GitHub / Jira / CI）
      ▲  │ webhook / REST
      │  ▼
src/integrations/（新增，I1）
  ├─ webhook.ts    # 事件接收（挂载到工作台 http server）
  ├─ jira.ts       # 拉取 issue 需求 / 回写评论
  ├─ github.ts     # 创建 PR / 评论（消费 v1.0 PRCandidate）
  └─ ci.ts         # 触发 CI（最小路径）

src/auth/（新增，I2）                    src/audit/（新增，I3）
  ├─ types.ts      角色/作用域              ├─ query.ts   按人/仓库/时间过滤
  ├─ rbac.ts       权限判定矩阵            └─ export.ts  CSV/JSON 导出
  └─ policy-source.ts 配置驱动
       │
       ▼
ApprovalGateway（v0.4 接口不变）→ request(action, { actor, role })
       │  风险等级 → 角色映射
       ▼
EventLog v1.4：+ actor/role 于 approval.*；+ integration.called
       ▼
Web 工作台（v1.0 V3，复用）→ 扩权限分层 + 审计面板
```

**核心不变**：Orchestrator / DAG 调度器 / ToolPolicy / 沙箱 / LayeredMemory / 报告管线（v0.2–v1.0 全部原样）。

---

## 3. 模块边界（新增）

```
src/
├── integrations/          # 新增：企业系统适配器（I1）
│   ├── types.ts           # Integration / WebhookPayload 接口
│   ├── webhook.ts         # webhook 接收与鉴权
│   ├── jira.ts            # Jira 适配器（读 issue / 回写评论）
│   ├── github.ts          # GitHub 适配器（创建 PR / 评论）
│   ├── ci.ts              # CI 触发（最小路径）
│   └── index.ts
├── auth/                  # 新增：RBAC（I2）
│   ├── types.ts           # Role(viewer/developer/approver/admin) / Scope(仓库/团队)
│   ├── rbac.ts            # 权限判定矩阵（纯函数）
│   └── policy-source.ts   # 配置驱动的用户→角色映射（文件）
├── audit/                 # 新增：审计报表（I3）
│   ├── query.ts           # 只读索引 + 时间窗口过滤
│   └── export.ts          # CSV/JSON 导出
└── workspace/             # v1.0 V3（进行中）：复用，扩权限分层 + 审计面板
```

---

## 4. I1 企业系统集成

### 4.1 形态（ADR-14 + PRD §4 方案 A：Webhook + REST）

- **被动集成**：外部平台推送事件 → `webhook.ts` 接收（鉴权：签名/HMAC，配置驱动）→ 校验后触发 Run 或更新状态。
- **主动调用**：`jira.ts` / `github.ts` 通过 REST 拉取需求、创建 PR、回写评论。
- 覆盖范围（PRD §8-1 最小路径）：**读 issue → Run → 创建 PR + 评论**；其余 API 能力（Jira 复杂查询、CI 状态回传深度）一律延后。

### 4.2 与核心的解耦

```ts
interface Integration {
  readonly name: string; // "github" | "jira" | "ci"
  consume(event: IntegrationSignal): Promise<void>; // 事件 → 外部动作
}
```

- 集成层**只消费**核心事件（`run.finished`、`task.completed`、`artifact.produced`），不修改核心。
- 每次外部调用落 `integration.called` 事件（镜像 `tool.called` 的审计模式，含脱敏参数 + 结果）。
- v1.0 的 `PRCandidate[]`（`src/dag/types.ts`）→ `github.ts` 自动创建 PR；失败回退为 PR 清单（不丢能力）。

---

## 5. I2 权限与治理（RBAC）

### 5.1 角色与作用域

```ts
type Role = "viewer" | "developer" | "approver" | "admin";
interface Actor {
  readonly id: string;
  readonly role: Role;
}
interface Scope {
  readonly repo?: string;
  readonly team?: string;
} // deny-by-default
```

权限矩阵（纯函数 `authorize(actor, scope, action)`）：

| 动作               | viewer | developer | approver | admin |
| ------------------ | ------ | --------- | -------- | ----- |
| 查看 Run/报告/审计 | ✅     | ✅        | ✅       | ✅    |
| 发起 Run           | ❌     | ✅        | ✅       | ✅    |
| 批准中风险动作     | ❌     | ✅        | ✅       | ✅    |
| 批准高风险动作     | ❌     | ❌        | ✅       | ✅    |
| 配置策略/权限      | ❌     | ❌        | ❌       | ✅    |

### 5.2 审批分级接入（ADR-15）

- v0.4 `ApprovalGateway.request()` 扩展调用上下文：`request(action, { actor, role })`——**接口签名扩展为可选参数，向后兼容**。
- 风险等级 → 所需角色：`低→自动（allow）`、`中→developer`、`高→approver`（映射表进配置 `policy-source.ts`）。
- 判定顺序：`PolicyResolver`（v0.4 三态）→ 若 `approve` 则 `authorize(actor, scope, riskLevel)` → 授权才执行，未授权即拒绝并落审计。

### 5.3 工作台分层

- v1.0 工作台按角色渲染：viewer 只读、developer 可发起/批准中风险、approver 增批高风险、admin 增配置页。
- P0 用户身份来自配置映射（`policy-source.ts`）；**OIDC/SSO 为 P1 接缝**（`Authenticator` 接口，后续换实现不动 RBAC）。

---

## 6. I3 全量审计报表

### 6.1 查询模型（ADR-14：事件只读投影）

- 数据源：既有 EventLog（`<git-dir>/forgemind/runs/*.jsonl`）+ v1.3 两级索引（`runId`/`taskId`）。
- 维度：人（`actor`）、仓库（`run.started.branch`/`task.started.repo`）、时间窗口、结果（`run.finished.status`）。
- 约束：**只读索引 + 时间窗口限制**（PRD §8-3），单次查询限定时间范围，不做全量实时检索；索引构建为离线增量扫描。

### 6.2 导出

- `audit/export.ts`：按查询结果生成 CSV / JSON，落盘 `.git/forgemind/audit/`，满足合规归档。
- 导出内容与审计面板同源（同一 query 函数），保证"看到的 = 导出的"。

---

## 7. 事件演进（v1.3 → v1.4，向后兼容）

| 变化                                                         | 说明                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| `approval.approved` / `approval.rejected` + `actor` / `role` | "谁批准/拒绝了什么"进审计                                |
| `run.started` + 可选 `actor`                                 | Run 发起人可追溯                                         |
| 新增 `integration.called`                                    | 外部系统调用审计（镜像 `tool.called` 模式，脱敏 + 结果） |

- golden 快照同步；`parseEvent` 兼容旧 v1.3 日志。
- `workflowTrace`/`workflowSignature` 语义不变（按 runId 过滤后仍成立）。

---

## 8. 记忆与多租户隔离（I5，P1）

- `LayeredMemory`（v0.5）的 `recall(query, scopes)` 已具备 scope 过滤；I5 增加 **workspace 维度**（团队/租户边界）。
- 记忆按 workspace 强制隔离：`remember`/`recall` 带 workspace 键，跨租户检索直接返回空（PRD §8-4 数据事故红线）。
- P0 不做：单租户（单 workspace）行为不变，I5 为接缝预留（接口签名含可选 `workspace`）。

---

## 9. 测试策略

| 里程碑      | 测试落点                                                                           | 形态                                   |
| ----------- | ---------------------------------------------------------------------------------- | -------------------------------------- |
| I1 集成     | issue 拉取 → Run → PR 创建 + 评论回写闭环、webhook 鉴权、`integration.called` 落盘 | e2e（GitHub/Jira 用 HTTP mock 服务器） |
| I2 RBAC     | 权限矩阵全分支（四角色 × 三风险）、deny-by-default、未授权拒绝入审计               | 单元测试（纯函数矩阵）                 |
| I3 审计     | 按人/仓库/时间过滤、导出 CSV/JSON 与面板同源、时间窗口限制                         | 单元 + 集成测试                        |
| I4/I5（P1） | 配额判定、workspace 隔离                                                           | 视预算                                 |

回归要求：`npm run check` + 既有 73 测试 + 本轮新增全部通过。

---

## 10. 风险与决策记录

| #   | 问题                                    | 严重度 | 处置                                                                  |
| --- | --------------------------------------- | ------ | --------------------------------------------------------------------- |
| 1   | 集成范围膨胀（Jira/GitHub/CI 各自深坑） | 高     | PRD §8-1 最小路径：读 issue / 写 PR + 评论，其余延后                  |
| 2   | RBAC 疏漏 = 安全漏洞                    | 高     | ADR-15 deny-by-default + 最小权限 + 全量审计；矩阵纯函数 + 全分支测试 |
| 3   | 审计数据规模（多租户后事件量大）        | 中     | 只读索引 + 时间窗口限制（PRD §8-3）                                   |
| 4   | 多租户记忆串味                          | 中     | workspace 强制隔离（P1，§8）                                          |
| 5   | P1 拖累 P0                              | 中     | 配额/多租户/OIDC 超预算即划 v2.1，不阻塞 I1-I3                        |

## 11. 里程碑映射（PRD §9）

| 里程碑      | 架构动作                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------- |
| I1          | `integrations/`（webhook + jira + github + ci）+ `integration.called` 事件                     |
| I2          | ✅ `auth/`（rbac 纯函数 + policy-source）+ ApprovalGateway 角色上下文 + 事件加 actor/role/risk |
| I3          | 🔄 `audit/`（有界 query + CSV/JSON export + CLI 已实现）；工作台审计面板待 V3                  |
| I4/I5（P1） | 配额治理 / 多租户 workspace 隔离 / OIDC                                                        |

## 12. 与既有架构的衔接

- **零改动内核**：Orchestrator、DAG 调度器、ToolPolicy、沙箱、LayeredMemory、报告管线全部原样复用（ADR-13）。
- **唯一侵入点**：`ApprovalGateway.request()` 增加可选 `actor/role` 上下文、事件加 `actor/role/integration.called` 字段——均为向后兼容演进。
- **演进**：v3.0 主动式能力（盯 issue/回 PR 评论）以本轮的 webhook + RBAC + 审计为地基；L4 语义记忆（Phase 4）正交。

### 当前实现说明

- `auth/rbac.ts` 实现四角色 × 五动作的 deny-by-default 纯函数矩阵；仓库/团队作用域必须显式命中，admin 才可跨作用域。
- `auth/policy-source.ts` 严格解析用户→角色/仓库/团队映射，拒绝未知字段、未知角色、重复用户与重复作用域。
- 策略规则支持 `risk: low|medium|high`；内建 `run_command` 为中风险、`git_commit` 为高风险。审批前先做 RBAC，越权不调用审批网关、不执行工具，并将 actor/role/risk 写入 `approval.*` 与离线报告。
- `runForgeMind` / `runDagForgeMind` 接受 actor 上下文，并在创建分支/工作树前校验发起权限；CLI 通过 `--actor-policy` + `--actor` 加载治理上下文，未启用时保持旧调用兼容。
- `audit/query.ts` 只扫描 EventLog JSONL，强制最长 31 天窗口和 10 万事件上限；支持按人/仓库/状态过滤。`audit/export.ts` 从同一投影生成 JSON/防公式注入 CSV，`audit export` CLI 要求查看权限。
