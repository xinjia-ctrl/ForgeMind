# ForgeMind 架构设计文档（ADR）— 记忆与提示词工程（v0.5）

> 迭代：v0.5（第五轮，记忆增强 + 上下文/提示词工程）
> 前置：v0.4 已实现（生产级安全与沙箱，45/45 测试通过）
> 状态：已实现（对齐 `docs/PRD-v0.5-memory-and-prompt.md`，61/61 测试通过）
> 技术栈：TypeScript / Node，**严守零运行时第三方依赖**（模板插值/记忆检索/评测均自研）

---

## 1. 范围与设计原则

本轮目标：把"能跑闭环"升级为"越用越懂项目"——记忆、上下文、提示词三块从"能用"打磨到"可解释、可复用、可评测"。

追加三条本轮专属约束：

> **ADR-7：记忆生成不用 LLM，只做确定性规则投影。**
> `remember` 从 ARCH 的 `decisions[]/files[]`、`gate.rejected.feedback` 等**已落盘事实**中按确定性规则提取条目；`recall` 用 tags 精确命中 + 关键词重叠打分。LLM 不参与记忆的写与取——记忆可复现、可审计，延续"报告是日志投影"的哲学。

> **ADR-8：记忆是增强，不是第二事实源。**
> 记忆只读注入上下文，绝不动用户代码。每次注入落 `memory.recalled` 事件（含命中层 / 依据 / score），可追溯、可关闭。L3 项目记忆落盘需用户确认（红线，PRD §8-1）。

> **ADR-9：结构化输出 = 能力探测 + 优雅降级，不做 LLM 重试。**
> 用 `response_format` 原生结构化输出替换正则解析；能力探测失败或请求被拒时，**降级到既有 `parseJsonObject` 正则路径**（不重试 LLM，保持单次调用确定性）。契约不变：Agent 层仍拿到 `content` 字符串，`validation.ts` 校验层不动。

**兼容原则**：本轮不改 Orchestrator 控制流与门禁语义；`MemoryProvider` 接口向后兼容演进（recall 增加可选 scopes）；事件 Schema v1 → v1.2 仅**新增类型与可选字段**。v0.4 的 45 个测试必须全部保持通过。

---

## 2. 架构总览（增量视角）

```
                      ┌──────────────────────────────────────────────┐
                      │  MemoryProvider（LayeredMemory 容器，新增）    │
                      │  L1 working = TaskContext（已有）              │
                      │  L2 episodic = EventLog 检索（新增）           │
                      │  L3 project = .forgemind/memory/（新增）       │
                      │  L4 semantic = null 占位（接缝）               │
                      └──────────────────────────────────────────────┘
                                     │ recall(query, scopes)   注入点
                                     ▼
Orchestrator（PLAN/ARCH 阶段装配时注入，改动最小）
  │
  ▼
BaseAgent.completeJson（改造）
  ├─ 加载 prompt 资源（prompts/*.v1.md，五小节模板 + 版本）
  ├─ 结构化输出优先（ChatOptions.structuredOutput → response_format）
  └─ 失败降级 parseJsonObject（保留）
  │
  ▼
EventLog v1.2：+ memory.recalled / memory.stored；llm.called + promptVersion
  ▼
report：+ 记忆使用面板 / 提示词版本 / 上下文审计面板（P1）
```

---

## 3. 模块边界（新增/改动）

```
src/
├── memory/
│   ├── memory-provider.ts        # 接口演进：recall(query, options?: {scopes})
│   ├── layered-memory.ts         # 新增：LayeredMemory 容器（L1-L4 路由 + scope 过滤）
│   ├── project-memory.ts         # 新增：L3 落盘 .forgemind/memory/ + 确定性投影提取
│   ├── episodic-memory.ts        # 新增：L2 复用 EventLog 关键词+结果检索
│   └── noop-memory-provider.ts   # 既有（L4 占位 + 默认关闭）
├── prompts/                      # 新增：提示词资源（带版本号 .md）
│   └── index.ts                  # 版本常量 + 加载器（零依赖插值）
├── context/
│   └── assembler.ts              # 新增（P1）：Context Assembler 纯函数（L0-L3 分层）
├── llm/
│   ├── chat-provider.ts          # 改动：ChatOptions 增加 structuredOutput
│   ├── capabilities.ts           # 新增：能力探测（结构化输出支持判定）
│   └── openai-compatible-provider.ts  # 改动：response_format 支持
├── agents/base-agent.ts          # 改动：prompt 资源加载 + 结构化优先 + 降级
├── core/
│   ├── events.ts                 # 改动：新增 memory.* 事件；llm.called 加 promptVersion
│   └── orchestrator.ts           # 改动：PLAN/ARCH 装配时 recall 注入
└── report/
    ├── view-model.ts             # 改动：记忆面板 + 上下文审计面板
    └── render-html.ts
```

---

## 4. F1 分层记忆（P0）

### 4.1 接口演进（向后兼容）

```ts
type MemoryScope = "working" | "episodic" | "project" | "semantic";

interface MemoryProvider {
  remember(ctx: TaskContext, artifact: ArtifactRef): Promise<void>; // 不变，内部路由到各层
  recall(
    query: string,
    options?: { scopes?: readonly MemoryScope[] },
  ): Promise<readonly Retrieval[]>;
}
```

- 既有 `NoopMemoryProvider` 保持可用（默认不启用记忆）。
- `semantic` 层未实现时（当前为 null）在容器内**跳过且不报错**（PRD F1 要求）。
- `Retrieval` 增加 `scope` 字段标识来源层（报告可展示"用了哪层记忆"）。

### 4.2 L3 项目记忆（确定性投影）

载体：仓库内 `.forgemind/memory/`（随 Git 演进，可查看、可删除、不影响提交产物）。

```
.forgemind/memory/
├── decisions.json    # ARCH decisions[]/files[] → 决策条目（tags: 阶段/文件/关键词）
└── lessons.json      # gate.rejected.feedback → 教训条目（tags: 门禁/阶段/关键词）
```

- **写**：`remember` 按确定性规则投影（无 LLM）；L3 落盘需用户确认（CLI `--memory` 或交互确认，默认不写，尊重仓库洁癖）。
- **读**：`recall` 按 tags 精确命中 + 关键词重叠打分，`scope=project` 过滤。
- **审计**：每次读写落 `memory.stored` / `memory.recalled` 事件。

### 4.3 L2 情景记忆（复用 EventLog，零新增基建）

- 检索源：既有 `<git-dir>/forgemind/runs/*.jsonl`（`EventLog`）。
- 策略：需求关键词匹配 + `run.finished.status` 结果过滤（成功/失败模式），取最近 N 条。
- 用途：PLAN/ARCH 注入"同类需求上次在哪个门禁失败、原因是什么"。
- 复用 `workflowTrace` 归一化结果作为"情景摘要"，不重复解析。

### 4.4 注入与红线

- BaseAgent 仅在 PLAN/ARCH 的统一生命周期装配时调用 `recall`（不引入新的 Agent 实现方式，不触碰门禁回路）。
- 记忆只读注入：注入文本进入 prompt，不修改任何文件；每条注入落 `memory.recalled` 事件（含 `used: boolean`，报告展示命中与未命中）。
- 关闭手段：`NoopMemoryProvider` 默认注入（当前行为）；L3 未确认不落盘。

---

## 5. F2 提示词版本化（P0）

### 5.1 资源化与模板

- 每个 Agent 的 system prompt 从 `base-agent.ts` / 各 Agent 内嵌字符串抽离为 `prompts/<stage>.v1.md` 资源，`prompts/index.ts` 用**版本常量**（`PROMPT_VERSIONS = { PLAN: "plan.v1", ... }`）引用。
- 五小节统一模板（PRD F2）：
  ```
  [角色与职责] [输入契约摘要] [约束与边界] [输出 JSON Schema] [成功判据]
  ```
- 插值用 `{{placeholder}}` 简单字符串替换（自研，零依赖，不引模板引擎）。

### 5.2 可观测

- `llm.called` 事件新增 `promptVersion: string`（可选字段，向后兼容），报告展示"每个 Agent 用了哪个版本的提示词"。
- 回归护栏：prompt 改动必须过 F5 评测集，禁止无评估的静默替换。

> 注：`prompts/*.md` 为运行时资源，加载方式（fs 读取 + 路径约定，保持零依赖）在 M4 实现时确认；`src/prompts/index.ts` 是唯一加载入口，Agent 不直接触达文件系统。

---

## 6. F3 原生结构化输出（P0）

### 6.1 契约演进

```ts
interface ChatOptions {
  // ...既有
  structuredOutput?: { jsonSchema: Record<string, unknown> }; // response_format json_schema
}
```

- `openai-compatible-provider.ts`：`structuredOutput` 存在时请求体加 `response_format: { type: "json_schema", json_schema }`。
- `Capabilities`（`llm/capabilities.ts`）：探测当前 provider 是否支持结构化输出（配置开关 `FORGEMIND_STRUCTURED_OUTPUT=0` 关闭 / 首次 400 响应记录能力位）。

### 6.2 降级路径（不重试 LLM）

```
completeJson（结构化优先）
  ├─ capabilities 支持 && 请求成功 → 解析 JSON 校验（validation.ts，契约不变）
  ├─ capabilities 不支持 → 直接走既有 parseJsonObject（正则兜底，输出常含围栏）
  └─ 请求被拒（400 结构类错误）→ 降级 parseJsonObject 解析本次 content，不重试
```

- **不重试**：保持"单次 LLM 调用 = 一次决策"的确定性（ADR-1），避免双调用破坏预算与可复现性。
- 解析失败仍抛 `StageFailure`（既有行为），但预期概率显著下降。

---

## 7. F4 上下文相关性装配（P1）

### 7.1 来源分层（L0-L3）

| 层            | 内容                                              | 预算参与         | 状态                  |
| ------------- | ------------------------------------------------- | ---------------- | --------------------- |
| L0 核心契约   | requirement + plan.summary + architecture.summary | 必给，不参与争抢 | 已有                  |
| L1 检索上下文 | CODE：按相关性选择的文件/片段                     | 参与             | 改造                  |
| L2 记忆上下文 | PLAN/ARCH：recall 命中的约定/教训                 | 参与             | F1 提供               |
| L3 返工上下文 | 返工时：gate.feedback + 上次失败证据 + diff 摘要  | 参与             | 已有 feedback，补证据 |

### 7.2 Context Assembler（纯函数）

从 `code-agent.ts` 的 `collectWorkspaceContext` 抽离为 `src/context/assembler.ts`：

```ts
interface AssemblerInput {
  ctx: TaskContext;
  retrieval: readonly Retrieval[]; // recall 结果（可选）
  workspaceIndex?: readonly string[]; // glob 索引（可选）
}
interface PromptInput {
  sections: ReadonlyArray<{ name: string; content: string; source: string }>;
  tokenEstimate: number;
}
```

- **选择策略**（弃用 `glob("**/*") + slice(0,8)` 粗暴投喂）：ARCH 预期文件优先 → grep 命中文件 → 文件名关键词相关性（整文件兜底）。
- **审计**：`PromptInput.sections` 含 `source` 标记（哪来的：契约/检索/记忆/返工），报告渲染"每阶段实际注入内容"面板。

### 7.3 约束

- 预算不变：`TokenBudgetTracker` 仍是底线，只换"选什么"，不换"给多少"（PRD F4 红线）。

---

## 8. F5 提示词评测集（P1）

- 固定评测集：3-5 条代表性需求 × 断言（门禁通过、结构输出合法、无越权工具调用）。
- 确定性回归用 `FakeChatProvider`（防提示词改动静默回退）；真实模型抽样冒烟。
- 新增 `npm run eval`（不进 `npm run check` 主链，作为可选门禁）。
- 输出 A/B 对比（版本 A vs B：通过率 / 返工轮次 / token 成本），支撑"提示词工程"演示叙事。

---

## 9. 事件演进（v1 → v1.2，向后兼容）

| 变化                                | 说明                                                    |
| ----------------------------------- | ------------------------------------------------------- |
| 新增 `memory.recalled`              | runId, stage, scope, source, score, content(脱敏), used |
| 新增 `memory.stored`                | runId, stage, scope, kind, path                         |
| `llm.called` + 可选 `promptVersion` | 报告展示提示词版本                                      |

golden 快照同步；`parseEvent` 对旧 v1 日志兼容（缺省字段不报错）。

---

## 10. 测试策略

| 里程碑        | 测试落点                                                          | 形态                                  |
| ------------- | ----------------------------------------------------------------- | ------------------------------------- |
| M1 记忆内核   | 分层 remember/recall/覆盖/scope 过滤、L3 落盘与确认语义、投影规则 | 单元测试（纯函数 + FakeMemory）       |
| M2 情景记忆   | 关键词命中历史 Run、结果状态过滤                                  | 单元测试（构造 EventLog fixture）     |
| M3 记忆注入   | 双 Run 第二次 PLAN/ARCH 含记忆注入、`memory.recalled` 落盘        | e2e（FakeChatProvider + FakeMemory）  |
| M4 提示词工程 | promptVersion 落盘、结构化输出成功/降级两条路径、31+45 全过       | 单元 + 集成（fake provider 模拟 400） |
| M5（P1）      | Assembler 纯函数、上下文面板、`npm run eval` A/B                  | 单元 + e2e                            |

回归要求：`npm run check` + 既有 45 测试 + 本轮新增全部通过。当前结果为 61/61。

---

## 11. 风险与决策记录

| #   | 问题                   | 严重度 | 处置                                                              |
| --- | ---------------------- | ------ | ----------------------------------------------------------------- |
| 1   | 记忆污染（注入坏信息） | 高     | ADR-7 确定性投影 + ADR-8 只读/可审计/可关闭 + L3 落盘确认         |
| 2   | 结构化输出厂商协议差异 | 高     | ADR-9 能力探测 + 降级不重试，契约不变                             |
| 3   | 提示词改动静默回归     | 中     | F5 评测集护栏 + `promptVersion` 审计                              |
| 4   | 相关性排序误伤关键文件 | 中     | P1 先做"ARCH 预期文件优先"，关键词排序实测后收敛（PRD §8-4）      |
| 5   | 记忆文件污染用户仓库   | 中     | `.forgemind/memory/` 与运行产物同栖（gitignore 策略），落盘需确认 |

## 12. 里程碑映射（PRD §7）

| 里程碑   | 架构动作                                                             |
| -------- | -------------------------------------------------------------------- |
| M1       | `layered-memory.ts` + `project-memory.ts` + `memory.*` 事件          |
| M2       | `episodic-memory.ts`（EventLog 检索）                                |
| M3       | Orchestrator PLAN/ARCH recall 注入 + 报告记忆面板                    |
| M4       | `prompts/` 资源化 + `promptVersion` + `capabilities.ts` + 结构化输出 |
| M5（P1） | `context/assembler.ts` + 上下文审计面板 + `npm run eval`             |

## 13. 与既有架构的衔接

- **不触碰**：Orchestrator 控制流与门禁、Agent 契约、ToolPolicy/审批/沙箱（v0.4）、reproducibility。
- **演进**：L4 语义记忆（Phase 4）为 `LayeredMemory` 的新一层实现，接口 `recall(query, scopes)` 已对齐业界范式，未来可换向量库只动该层。
- **正交性**：记忆与提示词均为"装配期增强"，运行期执行链（工具/沙箱/门禁）零改动。
