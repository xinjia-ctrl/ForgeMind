# ForgeMind 架构设计文档（ADR）— Agentic 研发操作系统（v3.0）

> 对齐：`docs/PRD-v3.0-agentic.md`（主线）与 `docs/PRD-v3.0-os.md`（安全约束补充）  
> 前置：v1.0 DAG、v2.0 RBAC 与审计投影  
> 状态：A1-A6 全部实现；宿主服务仅负责 HTTP 监听、凭据托管与仓库路径配置
> 验证：`npm run check` 通过（151 项：148 通过，3 项真实依赖 smoke 条件跳过）
> 技术栈：TypeScript / Node，零运行时第三方依赖

---

## 1. 范围与决策

v3.0 在现有 Run/DAG 外增加 `Watch → Trigger → Dispatch` 主动层，不重写编排、安全、记忆或报告内核。

> **ADR-16：主动性是外层控制面，不是第二套执行引擎。**
> Trigger 只生成 `AgenticRunRequest`；A3 dispatcher 必须复用 `runForgeMind` / `runDagForgeMind`，主动与手动 Run 的门禁、沙箱和记忆行为保持一致。

> **ADR-17：异构输入先归一化，边界校验失败即拒绝。**
> GitHub、Jira、CI 与内部审批事件统一转换为 `DevelopmentEvent`。触发规则不得直接读取供应商原始 payload，避免平台字段渗透进编排层。

> **ADR-18：触发判定确定性、有界、默认不执行。**
> 规则按配置顺序匹配第一条；仓库不在白名单、事件无规则、字段不合法时均不触发。去重、同对象合并、冷却、滑动窗口限流和每日配额在 dispatch 前完成。

> **ADR-19：消费游标只能在 dispatch 成功后推进。**
> 轮询事件先判定并 dispatch，再提交 poller cursor。dispatch 失败会保留同一稳定 request id 并优先重试，避免“事件已消费、Run 未创建”的丢任务窗口。

> **ADR-20：主动 Run 的权限只能收紧。**
> 主动 actor 固定为 `agentic/developer`；风险经 `低→中、中→高、高→高` 变换；工具和命令必须同时命中 agentic allowlist 与既有 stage policy。主动配置不能扩大核心策略已经拒绝的权限。

---

## 2. 增量架构

```text
GitHub / Jira / CI / Approval timeout
                 │ signed webhook 或 cursor poller
                 ▼
normalizeDevelopmentEvent
                 │ DevelopmentEvent
                 ▼
AgenticWatchService ───────────────► EventLog
                 │                  development.received
                 ▼                  trigger.decided
AgenticTriggerEngine
  ├─ repository allowlist
  ├─ rule matching / template rendering
  ├─ event TTL dedupe
  ├─ same-object merge / cooldown
  └─ rate limit / daily quota / pending queue
                 │ AgenticRunRequest
                 ▼
ForgeMindAgenticRunDispatcher
  │ FileAgenticDispatchStore
  ├─ 单仓 runForgeMind
  └─ 多仓 runDagForgeMind
                 ▼
AgenticFeedbackCoordinator：push → PR → source comment
                 │ agenticRunGovernance / no merge
                 ▼
既有 RBAC → ApprovalGateway → ToolPolicy → Sandbox → EventLog / Memory
```

模块边界：

| 文件                        | 职责                                                         |
| --------------------------- | ------------------------------------------------------------ |
| `src/agentic/types.ts`      | 标准事件、规则、配置、Run 请求与决策契约                     |
| `src/agentic/normalize.ts`  | GitHub/Jira/CI/内部事件归一化；忽略无关事件，拒绝畸形事件    |
| `src/agentic/config.ts`     | 严格配置解析；拒绝未知字段、重复项和越界值                   |
| `src/agentic/trigger.ts`    | 确定性触发、去重、合并、冷却、限流、配额与延迟队列           |
| `src/agentic/watch.ts`      | 统一事件消费、轮询守护循环、cursor、dispatch 重试与审计适配  |
| `src/agentic/guardrail.ts`  | actor、风险升级和工具/命令白名单向 RunOptions 的投影         |
| `src/agentic/webhook.ts`    | GitHub/Jira/CI 原始字节 HMAC、请求体边界与 Node HTTP handler |
| `src/agentic/github.ts`     | Workflow Poller、PR 创建/复用、Issue/PR 幂等评论             |
| `src/agentic/jira.ts`       | JQL cursor Poller 与 ADF Issue 评论                          |
| `src/agentic/ci.ts`         | 通用 CI PollSource 与幂等状态回传                            |
| `src/agentic/dispatcher.ts` | 持久 claim、单仓/DAG 路由、失败恢复与回写断点                |
| `src/agentic/feedback.ts`   | 分支发布、PR 与来源评论编排；禁止 test 源分支和自动 merge    |

---

## 3. 标准事件契约

```ts
interface DevelopmentEvent {
  id: string; // 来源 + 平台 delivery id，必须稳定
  source: "github" | "jira" | "ci" | "forgemind";
  type: "issue.updated" | "issue.assigned" | "ci.failed" | "pr.mentioned" | "approval.timed_out";
  repo: string; // 与 allowlist 使用相同的规范标识
  object: { kind: string; id: string; title?: string; url?: string };
  occurredAt: string; // 规范化 ISO 时间
  actor?: string;
  labels: readonly string[];
  context: Readonly<Record<string, JSONScalar | readonly string[]>>;
}
```

归一化层只保留触发与回写定位所需的有界字段，不将完整评论正文、issue 描述或 webhook payload 写入审计。平台签名/HMAC 已由 `webhook.ts` 在调用 normalizer 前按原始字节验证；解析后再进入标准事件契约。

---

## 4. 触发状态机

单个事件的判定顺序固定：

1. delivery id TTL 去重；
2. repository allowlist；
3. 第一条启用且匹配的规则；
4. 已排队的同对象事件合并；
5. 已触发对象的冷却窗口合并；
6. 每日任务配额；
7. 全局滑动窗口速率限制；
8. 生成稳定 `AgenticRunRequest`。

决策只有四类：

| 决策      | 含义                                       | 是否 dispatch |
| --------- | ------------------------------------------ | ------------- |
| `TRIGGER` | 规则命中且所有治理检查通过                 | 是            |
| `IGNORE`  | 重复、越权仓库或无规则                     | 否            |
| `MERGE`   | 同一对象已有活跃/待处理触发                | 否            |
| `DEFER`   | 命中配额或速率限制，进入内部 pending queue | 到期重评估    |

`DEFER` 不等同丢弃；`drainReady()` 在后续轮询周期重评估。待处理对象收到新事件时保留最新上下文，但仍只生成一个 Run。

---

## 5. 配置契约

```json
{
  "repositories": ["acme/api"],
  "dailyTaskQuota": 20,
  "rateLimit": { "maxRuns": 5, "windowMs": 60000 },
  "dedupeTtlMs": 86400000,
  "guardrails": {
    "allowedTools": ["glob", "grep", "read_file", "write_file", "edit_file", "run_command"],
    "allowedCommands": [["npm", "test"]]
  },
  "rules": [
    {
      "id": "diagnose-ci",
      "match": {
        "type": "ci.failed",
        "labelsAll": ["forgemind:fix"]
      },
      "run": {
        "requirement": "Diagnose {{object.id}} on {{repo}} ({{context.branch}})",
        "priority": "high"
      },
      "cooldownMs": 300000
    }
  ]
}
```

模板只支持字段替换，不执行表达式或代码。不存在的字段替换为空字符串。配置由严格解析器读取：未知字段、重复 rule id、rule 指向白名单外仓库、重复命令或越界配额都会使启动失败。

---

## 6. 安全与审计

- `agenticRunGovernance()` 生成可直接展开进 `RunOptions` 的 actor、风险变换和白名单；
- stage 固有工具集合与 agentic allowlist 取交集；测试命令必须同时匹配既有测试命令和 agentic command allowlist；
- `ScopedToolExecutor` 在 RBAC/ApprovalGateway 前应用风险升级，因此升级后的风险会进入 `approval.*` 审计；
- Watch 层记录 `development.received` 与 `trigger.decided`，不记录原始敏感 payload；
- dispatch request id 由 rule id + event id 稳定组成；dispatcher 对规范请求计算指纹，并用文件级独占 claim 实现跨重启幂等。
- `FileAgenticStateStore` 以 0600 临时文件 + 原子 rename 提交 checkpoint；损坏、超限、未知 rule 或 pending key 不一致均 fail-closed。
- checkpoint 同时覆盖 cursor、seen events、cooldown、pending、recent runs、daily counts 与 dispatch retries；dispatch 前写入 retry，成功后清除。
- `FileAgenticDispatchStore` 分离执行状态与回写状态：COMPLETED 后回写失败只重试回写；明确异常进入 FAILED 并生成新 attempt；歧义 RUNNING 必须人工对账。
- GitHub/Jira 评论使用稳定 marker，CI 使用 idempotency key；PR 先查 open head/base 再创建。所有路径只推送/建 PR，不执行 merge，且拒绝 `test` 作为 head。

---

## 7. 完成度与运维边界

| 能力                             | 状态 | 备注                                                   |
| -------------------------------- | ---- | ------------------------------------------------------ |
| A1 标准事件与签名 Webhook/Poller | ✅   | GitHub/Jira/CI HMAC、bounded Node handler、持久 cursor |
| A2 规则/去重/合并/冷却/限流/配额 | ✅   | Watch checkpoint 跨重启恢复                            |
| A3 幂等 dispatch、PR 与评论回写  | ✅   | 执行/回写断点分离；明确失败恢复、歧义失败关闭          |
| A4 actor/风险升级/工具命令白名单 | ✅   | 单仓和 DAG 子 Run 端到端生效                           |
| A5 三轮有界协商与 DecisionRecord | ✅   | ARCH/REVIEW/Artifact mismatch；无共识或超时升级审批    |
| A6 CI 自动修复闭环               | ✅   | CI 事件 → Run/DAG → REVIEW/TEST → PR → CI/Issue 回写   |

v3.0 功能里程碑已收口。后续运维增强是 RUNNING 对账命令与实时视图；HTTP server、secret manager 和部署映射保持宿主层职责，不影响 v3.0 完成状态。
