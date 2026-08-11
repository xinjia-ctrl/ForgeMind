# ForgeMind 架构设计文档（ADR）— Phase 2 可观测性报告（v0.3）

> 迭代：v0.3（第三轮，Phase 2 可观测性可视化）
> 前置：v0.2 MVP 闭环已实现（23/23 测试通过）
> 状态：已实现（31/31 测试通过，对齐 `docs/PRD-v0.3-observability.md`）
> 技术栈：TypeScript / Node，沿用"零运行时第三方依赖"

---

## 1. 范围与设计原则

本轮只做一件事：把不可见的多 Agent 协作过程变成**可播放、可解释、可定位**的视觉叙事——单文件 HTML 报告。

沿用 v0.2 四条原则，并追加一条本轮专属原则：

> **ADR-3（本轮核心）：报告是日志的投影，不是第二份事实源。**
> 报告的数据源只有 `EventLog`（JSONL）；所有统计必须可追溯到具体事件行。禁止在报告层引入独立状态、独立指标、或 LLM 参与生成内容。

由此得到强制约束：**报告生成管线必须纯函数化**（`events → view model → HTML`），与 v0.2 的 `replay` 同为"日志的只读派生"，天然可测试、可复现、无副作用。

---

## 2. 产品形态决策（ADR-4）

采纳 PRD 方案 **A：静态单文件 HTML 报告**。

- 生成：`forge-mind report --repo <path> --run-id <id>`。
- 产物：`<git-dir>/forgemind/reports/<runId>.html`（与事件日志同栖于 Git 元数据目录，不污染产物 commit）。
- 约束：**零外链**（CSS/JS 内嵌）、离线可打开、单文件。
- 明确不做：不引入 Web 服务、不引入前端框架、不引入端口管理。实时视图（PRD P1-6）划入 Phase 2 后半段，作为可选增强，不在本轮架构内。

---

## 3. 模块边界（新增 `src/report/`）

```
src/
├── report/
│   ├── view-model.ts      # events → ReportViewModel（纯函数，O1）
│   ├── render-html.ts     # ReportViewModel → HTML 字符串（纯函数，O2）
│   └── report.ts          # 装配：load → view-model → render → write（O3）
```

- `view-model` 与 `render-html` **禁止触碰文件系统 / 网络 / 时间**（纯函数，输入输出显式）。
- 唯一的 IO 集中在 `report.ts`（读 JSONL、写 HTML）。
- CLI 在 `src/runtime/cli.ts` 增加 `report` 子命令，复用现有 `EventLog.open` + 参数解析。

---

## 4. 数据契约：ReportViewModel

`view-model` 的输出类型，也是渲染层的唯一输入（渲染层不得直接读事件）：

```ts
interface ReportViewModel {
  runId: string;
  status: RunStatus | "RUNNING";
  requirement: string;
  failure?: {
    stage: StageId | null; // stage.failed 定位；null = 框架级（BLOCKED）
    kind: "STAGE" | "HARD" | "FATAL" | "UNKNOWN"; // UNKNOWN 仅兼容历史日志
    message: string;
  };
  timeline: TimelineGroup[]; // 按实际顺序和 stage/attempt 分组的归一化事件序列
  gates: GateResult[]; // REVIEW/TEST 门禁判定 + 返工回路标记
  stats: {
    total: {
      inputTokens: number;
      outputTokens: number;
      toolCalls: number;
      durationMs: number | null;
    };
    perStage: Array<{
      stage: StageId;
      llmCalls: number;
      inputTokens: number;
      outputTokens: number;
      toolCalls: number;
      durationMs: number | null;
    }>;
  };
  artifacts: ArtifactRef[]; // 产物清单
}
```

**数据来源与追溯**（每个字段都能指向事件类型）：

| 字段     | 来源事件                                                                                | 说明                                     |
| -------- | --------------------------------------------------------------------------------------- | ---------------------------------------- |
| timeline | `workflowTrace` 归一化 + `stage`/`attempt` 分组                                         | 复用 v0.2 归一化逻辑，禁止二次发明       |
| gates    | `gate.rejected` / `gate.passed`                                                         | 含 reason/feedback/attempt，高亮返工回路 |
| 阶段统计 | `llm.called`（token）、`tool.called`（次数）、`stage.started`↔`stage.completed`（耗时） | 聚合必须可对账回事件行                   |
| 失败定位 | `stage.failed` / `run.finished`（status）                                               | kind 字段依赖 §6 事件演进                |

---

## 5. 关键设计决策

### 5.1 渲染安全（ADR-5：纵深脱敏 + HTML 转义）

PRD §8-1 明确"禁止把原始 prompt/token 泄露进报告"。双层防线：

1. **脱敏**：报告渲染前，对 `tool.called` 的 `args/result` **再次**执行共享的 `src/tools/audit.ts#auditValue`（executor 与 report 共用）。
2. **HTML 转义**：所有事件文本插入 HTML 前必须 `escapeHtml`，防 XSS 与格式破坏。

> 说明：事件落盘时已脱敏（executor 写入的是 `auditValue` 后的值），但报告层仍显式二次脱敏——纵深防御 + 未来事件源扩展（如实时流）时不依赖落盘假设。

### 5.2 体积控制（PRD §8-2）

长 Run 事件多，HTML 按"归一化视图 + 抽样展开"渲染：

- 时间线默认只渲染 `workflowTrace` 粒度（type/stage/attempt/operation/outcome）。
- 工具调用的详细 `args/result` 折叠展开，单 Run 渲染条目设上限（建议 2_000 条），超出仅保留失败工具调用与门禁事件。

### 5.3 不编造指标（PRD §8-3）

产品纪律写入架构：`view-model` 只做**聚合与投影**，不派生任何事件中不存在的数值。耗时以 `stage.started`/`stage.completed` 的 `ts` 差值计；若缺 `stage.completed`（阶段失败），该阶段 `durationMs` 置 `null`，不推算。

---

## 6. 失败事件演进（已实现）

PRD v0.3 要求报告展示**失败类型（Stage / Hard / Fatal）**。v0.2 的 `stage.failed` 只含 `{ runId, stage, error, stack? }`，无法区分运行时已有的 `ForgeMindError.kind`，因此 v0.3 扩展事件契约。

**方案（事件 Schema v1 → v1.1，向后兼容）**：

- `stage.failed` 新增可选字段 `kind: "STAGE" | "HARD" | "FATAL"`（`BaseAgent` 统一 catch 处通过 `classifyFailure` 写入）。
- `run.finished` 维持现状（status 已能表达 FAILED/BLOCKED）。
- `golden` 快照（`tests/golden/event-schema.snapshot.json`）已同步更新；`parseEvent` 对缺省 `kind` 的事件按旧解析，报告明确展示 `UNKNOWN`（兼容历史日志且不猜测）。

**为何不在报告层推断 kind**：错误字符串做启发式分类不可靠且违反"不编造指标"。必须在**事件写入点**补全数据。

---

## 7. 复用与改动清单

| 项目                                  | 现状           | 本轮动作                              |
| ------------------------------------- | -------------- | ------------------------------------- |
| `EventLog` / `events.ts`              | v1 可用        | ✅ `stage.failed` 加可选 `kind`（§6） |
| `replay.ts`                           | 可用           | ✅ 不动（报告复用 `workflowTrace`）   |
| `reproducibility.ts`（workflowTrace） | 可用           | ✅ 作为 timeline 基础，扩展分组视图   |
| `auditValue`（executor.ts 私有）      | 未导出         | ✅ 提升为 `src/tools/audit.ts` 共享   |
| 错误分类（Stage/Hard/Fatal）          | 运行时         | ✅ `BaseAgent` 落盘 kind（§6）        |
| CLI                                   | `run`/`replay` | ✅ 新增 `report` 子命令               |

---

## 8. 测试策略

| 里程碑      | 测试落点                                                                                         | 形态                                               |
| ----------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| O1 视图模型 | 聚合正确性（token/次数/耗时）、失败定位、门禁回路标记、空事件边界                                | 单元测试，纯函数直调                               |
| O2 报告渲染 | 脱敏二次生效、`escapeHtml`（注入 `<script>` 用例）、无外链（正则断言无 http 资源）、离线条目上限 | 单元测试                                           |
| O3 CLI 集成 | `forge-mind report` 对成功/失败 run-id 各出一份有效 HTML                                         | e2e（复用 v0.2 fixture 仓库 + `FakeChatProvider`） |

全部新增文件已通过 `npm run check`（typecheck + eslint + prettier + 31 项测试）与现有 CI 同构门禁。

---

## 9. 风险与决策记录

| #   | 问题                                         | 严重度 | 处置                                     |
| --- | -------------------------------------------- | ------ | ---------------------------------------- |
| 1   | `stage.failed` 无失败分类，报告无法展示 kind | 高     | ✅ §6 事件演进，写入口补全               |
| 2   | 报告泄密风险（tool args / 内容片段）         | 高     | ✅ 二次脱敏 + escapeHtml + CSP，单测覆盖 |
| 3   | 长 Run 报告体积                              | 中     | ✅ 归一化 + 抽样展开 + 2,000 条上限      |
| 4   | `format:check` 被未格式化的 v0.3 文档阻断    | 低     | ✅ Prettier 统一格式化                   |

## 10. 里程碑映射（PRD §9）

| 里程碑     | 架构动作                                             |
| ---------- | ---------------------------------------------------- |
| O1         | ✅ `view-model.ts` + 事件演进（§6）+ `audit.ts` 提取 |
| O2         | ✅ `render-html.ts`（脱敏 + 转义 + 无外链）          |
| O3         | ✅ `report.ts` 装配 + CLI 子命令                     |
| O4（可选） | 实时事件流视图、可复现性对照页（Phase 2 后半段）     |

## 11. 与既有架构的衔接

- v0.2 的"单一事实源 + 只读派生"模型是本轮的全部前提：报告不新增状态，不改变 Orchestrator 控制流或统一 Agent/Tool 接口。
- 唯一侵入点是 §6 的 `stage.failed.kind` 字段（事件 Schema 演进），属"让事实更完整"，不改变事实语义。
- 演进路线：Phase 3（沙箱/审批/并发）与 Phase 4（长期记忆）不受本轮影响。
