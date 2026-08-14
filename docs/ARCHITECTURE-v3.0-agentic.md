# ForgeMind 架构设计文档（ADR）— Agentic 研发操作系统（v3.0）

> 对齐：`docs/PRD-v3.0-agentic.md`（主线）与 `docs/PRD-v3.0-os.md`（安全约束补充）  
> 前置：v1.0 DAG、v2.0 RBAC 与审计投影  
> 状态：A1/A2 内核与 A4 运行时接缝已实现；外部 HTTP 集成与 A3 回写闭环待实现  
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
                 │ webhook 或 poller
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
AgenticRunDispatcher（A3 接缝）
                 │
                 ▼
runDagForgeMind / runForgeMind
                 │ agenticRunGovernance
                 ▼
既有 RBAC → ApprovalGateway → ToolPolicy → Sandbox → EventLog / Memory
```

模块边界：

| 文件                       | 职责                                                            |
| -------------------------- | --------------------------------------------------------------- |
| `src/agentic/types.ts`     | 标准事件、规则、配置、Run 请求与决策契约                        |
| `src/agentic/normalize.ts` | GitHub/Jira/CI/内部事件归一化；忽略无关事件，拒绝畸形事件       |
| `src/agentic/config.ts`    | 严格配置解析；拒绝未知字段、重复项和越界值                      |
| `src/agentic/trigger.ts`   | 确定性触发、去重、合并、冷却、限流、配额与延迟队列              |
| `src/agentic/watch.ts`     | webhook 共用入口、轮询守护循环、cursor、dispatch 重试与审计适配 |
| `src/agentic/guardrail.ts` | actor、风险升级和工具/命令白名单向 RunOptions 的投影            |

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

归一化层只保留触发所需的有界字段，不将完整评论正文、issue 描述或 webhook payload 写入审计。平台签名/HMAC 校验属于后续 HTTP adapter，必须在调用 normalizer 前完成。

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
- dispatch request id 由 rule id + event id 稳定组成，A3 dispatcher 必须用它实现幂等创建 Run。

---

## 7. 当前完成度与下一里程碑

| 能力                                    | 状态    | 备注                                         |
| --------------------------------------- | ------- | -------------------------------------------- |
| A1 标准事件与 webhook 共用入口          | ✅      | HTTP 签名接收器待 v2 I1/A3 adapter           |
| A1 轮询守护与 cursor 提交顺序           | ✅      | poller 的持久 cursor 存储由具体 adapter 实现 |
| A2 规则/去重/合并/冷却/限流/配额        | ✅      | 当前状态为进程内；跨重启持久化为下一步       |
| A4 actor/风险升级/工具命令白名单        | ✅ 接缝 | 主动 dispatcher 接入后形成端到端门禁         |
| A3 DAG dispatch、评论/PR 回写、记忆回灌 | ⏳      | 下一里程碑                                   |
| A5/A6                                   | 未开始  | 按 PRD 保持 P1                               |

下一步优先级：持久化 trigger/cursor checkpoint → 实现幂等 DAG dispatcher → GitHub/Jira/CI HTTP adapters → 评论/PR 回写与 LayeredMemory 回灌。
