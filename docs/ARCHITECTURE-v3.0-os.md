# ForgeMind 架构设计文档（ADR）— 研发操作系统（v3.0 完整版）

> 迭代：v3.0（第九轮，终极形态）
> 对齐：`docs/PRD-v3.0-os.md`（终极形态主线）
> 前置：v3.0 主动层（`src/agentic/`）已实现；A2 协商与 A3 L4 记忆为本轮新增设计
> 状态：A1、A2 核心与 A3 L4 记忆已实现；A2 跨任务 Artifact 运行时接入与 A4 质量回馈待实现
> 技术栈：TypeScript / Node，**严守零运行时第三方依赖**

> 说明：`ARCHITECTURE-v3.0-agentic.md` 已细化主动触发层（A1 + guardrail），本文档为对齐 `PRD-v3.0-os.md` 的**完整架构**，在主动层之上新增 A2 协商与 A3 L4 记忆设计。

---

## 1. 范围与设计原则

v3.0 的目标：从"企业平台"跨过最后一道坎，成为"系统里主动工作的研发成员"——**主动触发（A1）+ 多 Agent 协商（A2）+ 自进化记忆（A3）+ 质量回馈（A4）**。

沿用已确立的架构主线（编排者决策、事件事实源、加外层不改内核），追加三条本轮专属约束：

> **ADR-21：协商是有界结构化协议，不是自由对话。**
> 协商 = `Proposal → Counter → Decision` 三轮有界协议，产出结构化 `DecisionRecord`；无共识/超时 → 升级人类审批。自由对话违背"编排者决策"与可审计性（PRD §8-2 风险红线），明确不做。

> **ADR-22：L4 语义记忆延续零依赖底线——EmbeddingProvider 可插拔接缝 + 默认自研词法检索。**
> v0.5 预留的 semantic scope 本轮实装为 `SemanticMemory`，检索实现通过 `EmbeddingProvider` 接口注入：默认提供自研轻量检索（TF-IDF/BM25 + 符号归一化），向量实现（外部服务/库）作为可选 provider 接入，**不引入运行时第三方依赖**。语义检索的写仍走确定性投影（ADR-7）。

> **ADR-23：自进化 = 知识沉淀，不调模型权重。**
> A4 质量回馈只做"评估 → 沉淀 decision-record / 教训 → 反馈到提示词与策略"，不做在线学习/模型微调（PRD §5 非目标），保证可控可解释，演进可审计。

---

## 2. 架构总览（增量视角）

```
GitHub / Jira / CI / 审批超时
        │ webhook / poller
        ▼
Active Layer（已实现）── src/agentic/
  watch → normalize → trigger（去重/冷却/限流/配额）→ guardrail（actor/风险升级/白名单）
        │ AgenticRunRequest
        ▼
Dispatch（A3 接缝）
        ▼
DAG / Orchestrator（v1.0/v0.2 内核，复用）
  │  ├─ 协商触发点：ARCH 方案冲突 / REVIEW 连续驳回 / 跨任务产物不一致
  │  └─ Negotiation Layer（新增）── src/negotiation/
  │        Proposal → Counter → Decision（三轮有界）→ DecisionRecord → 写 L3
  ▼
Memory Layer（v0.5 + 新增 L4）── src/memory/
  L1 TaskContext · L2 EventLog · L3 project-memory（+ decisions.json）
  L4 semantic-memory（新：EmbeddingProvider 接缝 + 默认词法实现）
  ▼
EventLog v1.5：+ negotiation.* / development.* / trigger.*
  ▼
report / audit（复用投影管线）
```

---

## 3. A1 主动式 Agent（已实现，引用）

`src/agentic/` 已实现并配套测试（A1/A2 内核 + A4 运行时接缝），详见 `ARCHITECTURE-v3.0-agentic.md`。要点：

- **异构归一化**（`normalize.ts`）：GitHub/Jira/CI/内部事件 → `DevelopmentEvent`（有界字段），畸形事件拒绝，不写原始 payload 进审计（ADR-17）。
- **确定性触发**（`trigger.ts`）：规则顺序匹配、仓库白名单、TTL 去重、同对象合并、冷却、滑动窗口限流、每日配额；决策四态 `TRIGGER/IGNORE/MERGE/DEFER`（ADR-18）。
- **消费游标**（`watch.ts`）：cursor 仅在 dispatch 成功后推进，失败保留稳定 request id 重试，防丢任务（ADR-19）。
- **权限只收紧**（`guardrail.ts`）：actor 固定 `agentic/developer`；`escalateAgenticRisk`（低→中、中/高→高）；工具/命令与既有 stage policy 取交集（ADR-20）。

---

## 4. A2 多 Agent 协商（新增设计）

### 4.1 触发点（与既有编排衔接）

| 触发点           | 检测位置                                                                     | 说明                                                     |
| ---------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------- |
| ARCH 方案冲突    | `ArchitectureAgent` 契约扩展：输出可选 `alternatives[{position, tradeoffs}]` | 存在 >1 个可行方案且权衡显著时，框架触发协商而非单向拍板 |
| REVIEW 连续驳回  | Orchestrator 的 REVIEW gate：连续 N 次（默认 2）驳回                         | 不再直接返工，先把各轮 feedback 作为立场输入进入协商     |
| 跨任务产物不一致 | DAG scheduler：任务间 artifact 引用冲突检测                                  | 引用语义不匹配时触发协商                                 |

### 4.2 协商协议（ADR-21）

```ts
type NegotiationTrigger = "arch-conflict" | "review-repeated-rejection" | "artifact-mismatch";

interface NegotiationRound {
  readonly round: 1 | 2 | 3;
  readonly proposal: string; // 发起方立场 + 权衡（LLM 单次调用生成）
  readonly counter: string; // 反方立场 + 权衡（LLM 单次调用生成）
}

interface Negotiation {
  readonly id: string;
  readonly runId: string;
  readonly trigger: NegotiationTrigger;
  readonly topic: string;
  readonly rounds: readonly NegotiationRound[]; // ≤3 轮，有界
  readonly status: "RESOLVED" | "ESCALATED" | "TIMED_OUT";
  readonly decisionRecord: DecisionRecord | null;
}
```

- **有界**：最多 3 轮；每轮 `proposal/counter` 为一次 LLM 调用（延续 ADR-1 单次调用确定性，Token 预算按既有机制收紧）。
- **裁决**：框架做**结构化仲裁**——立场是否收敛（关键词/字段比对 + 明确接受标记）；无共识或超时 → `ESCALATED` → 升级人类审批（复用 v0.4 `ApprovalGateway`，`approval.*` 事件链完整）。
- **产物**：`DecisionRecord` 写 L3 记忆（`decisions.json`），可审计可回放可检索。

```ts
interface DecisionRecord {
  readonly id: string;
  readonly runId: string;
  readonly topic: string;
  readonly trigger: NegotiationTrigger;
  readonly positions: ReadonlyArray<{
    readonly side: "proposal" | "counter";
    readonly position: string;
  }>;
  readonly decision: string;
  readonly escalated: boolean;
  readonly createdAt: string;
}
```

### 4.3 模块边界

```
src/negotiation/
├── types.ts        # Negotiation / NegotiationRound / DecisionRecord 契约
├── triggers.ts     # 三触发点的检测（纯函数，输入 ctx/gates/artifacts）
├── protocol.ts     # 三轮有界状态机（框架仲裁 + 升级兜底）
└── record.ts       # DecisionRecord 生成 + 写 L3（确定性投影）
```

### 4.4 审计与事件

| 事件                    | data                  | 说明               |
| ----------------------- | --------------------- | ------------------ |
| `negotiation.started`   | runId, trigger, topic | 协商开始           |
| `negotiation.round`     | runId, round, status  | 每轮立场与收敛判定 |
| `negotiation.resolved`  | runId, decision       | 有界内达成共识     |
| `negotiation.escalated` | runId, reason         | 升级人类审批       |

---

## 5. A3 自进化记忆（L4 实装）

### 5.1 L4 语义记忆（ADR-22）

- 接缝（v0.5 已留）：`LayeredMemory` 的 `recall(query, scopes)` 中 `semantic` scope。
- 实装 `src/memory/semantic-memory.ts`：

```ts
interface EmbeddingProvider {
  embed(text: string): Promise<readonly number[]>; // 向量实现接缝
  readonly dimension: number;
}
```

- **默认实现**（零依赖）：`LexicalEmbeddingProvider`——确定性哈希 TF 向量 + corpus BM25/IDF + 符号归一化（大小写/标点/复数），与关键词层互补而非替代。
- **向量实现**：外部库/服务作为 `EmbeddingProvider` 的可选实现接入，不改变 `recall` 接口，不引入运行时依赖。
- **写路径不变**：语义层只做检索增强，`remember` 仍走确定性投影（ADR-7），LLM 不参与记忆生成。

### 5.2 decision-record 与教训沉淀

- 协商的 `DecisionRecord` → L3 `decisions.json`（tags: topic/trigger/时间）。
- Run 失败教训（`gate.rejected.feedback`）→ L3 `lessons.json`（v0.5 已有）。
- 检索：后续 Run 的 `recall(query, scopes: ["project","semantic"])` 可命中协商决策——"这个需求上次因为方案 X 争议升级过"，直接注入装配上下文。

---

## 6. A4 自进化质量回馈（P1）

- Run 完成后计算质量指标：门禁通过率、返工轮次、测试覆盖率（来源事件聚合，纯函数）。
- 反馈路径（ADR-23）：质量指标 → 沉淀为教训/评估记录 → 影响提示词模板选择与策略建议——**只读证据驱动**，不做黑盒调参。
- 可见性：报告"质量评估"面板 + 审计（`run.quality` 事件，v1.5）。

---

## 7. 事件演进（v1.4 → v1.5，向后兼容）

| 变化                                                     | 说明                   |
| -------------------------------------------------------- | ---------------------- |
| 新增 `development.received` / `trigger.decided`          | 已实现（agentic 层）   |
| 新增 `negotiation.*`（started/round/resolved/escalated） | 协商审计               |
| 新增 `run.quality`                                       | A4 质量评估（P1）      |
| `approval.*` 复用                                        | 协商升级走的既有审批链 |

golden 快照同步；`parseEvent` 兼容旧日志；`workflowSignature` 按 runId 过滤后语义不变。

---

## 8. 安全与审计

- 主动层：actor `agentic/developer` + 风险升级 + 白名单交集（已实现，ADR-20）。
- 协商层：`decision-record` 全量入审计；升级路径复用 RBAC `approve:medium/high`（`src/auth/types.ts`）判定谁可批准。
- L4：记忆检索结果 `memory.recalled` 事件含命中层与依据，语义层同样可审计。

---

## 9. 测试策略

| 里程碑       | 测试落点                                                                              | 形态                                               |
| ------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------- |
| A1（已实现） | agentic-normalize/trigger/watch/guardrail 测试（现有 103 测试内）                     | ✅ 已覆盖                                          |
| A2 协商      | 三触发点检测、三轮有界（第 3 轮强制收敛）、无共识升级、超时、DecisionRecord 落盘      | 单元测试（FakeChatProvider + FakeApprovalGateway） |
| A3 L4        | 词法检索相关性、EmbeddingProvider 接缝（注入 fake 向量）、decision-record 跨 Run 检索 | 单元 + e2e                                         |
| A4（P1）     | 质量指标聚合、反馈可见性                                                              | 单元                                               |

回归要求：`npm run check` + 既有测试 + 本轮新增全部通过。A3 完成后共 120 个测试。

## 10. 风险与决策记录

| #   | 问题                    | 严重度 | 处置                                                       |
| --- | ----------------------- | ------ | ---------------------------------------------------------- |
| 1   | 主动失控                | 高     | 三层约束已实现：白名单 + 配额 + 审批（ADR-20）             |
| 2   | 协商退化为聊天          | 高     | ADR-21 三轮有界协议 + 超时升级，自由对话明确不做           |
| 3   | L4 引依赖破坏零依赖底线 | 中     | ADR-22 EmbeddingProvider 接缝 + 默认自研词法，向量可选接入 |
| 4   | 自进化黑盒              | 中     | ADR-23 只做知识沉淀，回馈可见可审计                        |
| 5   | 系统复杂度达峰          | 中     | 严守"加外层不改内核"；A2/A3 均为既有接缝的扩展             |

## 11. 里程碑映射（PRD §9）

| 里程碑   | 架构动作                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| A1       | 已实现（`src/agentic/`）                                                                                           |
| A2       | ✅ 核心：`src/negotiation/` + `negotiation.*` 事件 + ArchitectureAgent 契约扩展；Artifact 运行时接入待显式引用契约 |
| A3       | ✅ `src/memory/semantic-memory.ts` + `EmbeddingProvider` 接缝 + decisions.json/lessons.json 检索                   |
| A4（P1） | `run.quality` 事件 + 报告质量面板                                                                                  |

## 12. 完成度对照

| 能力                                             | 状态    | 位置                                               |
| ------------------------------------------------ | ------- | -------------------------------------------------- |
| A1 主动触发（watch/normalize/trigger/guardrail） | ✅      | `src/agentic/`                                     |
| 主动层审计事件（development._/trigger._）        | ✅      | `src/core/events.ts`                               |
| RBAC/风险等级（v2.0 基座）                       | ✅      | `src/auth/types.ts`                                |
| A2 协商协议                                      | ✅ 核心 | ARCH/REVIEW 已接入；Artifact mismatch 为纯检测接缝 |
| A3 L4 语义记忆                                   | ✅      | `src/memory/semantic-memory.ts`（本文档 §5）       |
| A4 质量回馈                                      | ⏳ P1   | 本文档 §6                                          |
