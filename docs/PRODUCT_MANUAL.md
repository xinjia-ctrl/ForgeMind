# ForgeMind 产品使用手册

> 版本：v3.0（对应 npm `3.0.0`，覆盖 v0.2 → v3.0 全部已实现能力）
> 验证：`npm run check` 通过（151 项：148 通过，3 项真实依赖 smoke 条件跳过）
> 说明：本手册面向使用者，描述**当前代码实际具备**的产品能力，不含规划中未实现的功能。

---

## 1. 产品是什么

ForgeMind 是一个多 Agent 协作的软件研发编排器。输入一条自然语言需求，系统通过 6 个专职 Agent 依次完成 **规划 → 架构 → 编码 → 审查 → 测试 → 提交**，最终产出通过审查与测试的 commit。支持**单任务顺序流水线**、**跨仓库 DAG 并发编排**、**主动事件监测**三种执行模式。

**一句话**：你给需求，ForgeMind 给"已提交的代码"；你给事件，ForgeMind 自己发现要干什么。

## 2. 执行模式与产品边界

| 模式         | 命令                            | 适用场景                      | 状态 |
| ------------ | ------------------------------- | ----------------------------- | ---- |
| 单任务流水线 | `run`                           | 单个仓库、单条需求、固定顺序  | ✅   |
| DAG 并发编排 | `dag run`                       | 跨仓库、多任务、并行执行      | ✅   |
| 主动监测     | `AgenticWatchService`（库 API） | 监听 issue/CI/PR 事件自动触发 | ✅   |
| 审计导出     | `audit export`                  | 企业审计 / 合规归档           | ✅   |

| 项       | 现状                                                         |
| -------- | ------------------------------------------------------------ |
| 输入     | 自然语言需求（≤ 100,000 字符）+ 可选策略配置                 |
| 输出     | Git commit + 事件日志（JSONL）+ 可视化报告（HTML）+ 审计导出 |
| 模型     | 任意 OpenAI 兼容 Chat Completions 接口；原生结构化输出可开关 |
| 测试执行 | 沙箱内运行（Docker 或本地降级），真实测试命令                |
| 记忆     | 四层记忆：工作/情景/项目/语义，`--memory` 启用               |
| 审批     | 策略网关：允许/需审批/拒绝，交互或自动                       |
| 安全     | 沙箱 + RBAC 角色 + 全量审计                                  |

## 3. 使用前置条件

1. Node.js ≥ 22，Git 已安装；DAG 模式需 git worktree 支持
2. 目标仓库：**干净的工作区** + **已有至少一个 commit** + **已配置 Git 作者**
3. 环境变量：`OPENAI_API_KEY`（可自定义 `OPENAI_BASE_URL`）
4. 可选：`FORGEMIND_GLOBAL_CONFIG`（全局策略）、`FORGEMIND_STRUCTURED_OUTPUT`（结构化输出开关）

## 4. 单任务流水线（run）

```bash
npm install
npm run build

export OPENAI_API_KEY="sk-..."

node dist/src/runtime/cli.js run \
  --repo /abs/path/to/target-repo \
  --requirement "添加一个健康检查接口，并附上测试"
```

| 选项                     | 说明                  | 默认                                |
| ------------------------ | --------------------- | ----------------------------------- |
| `--repo`                 | 目标仓库绝对路径      | 必填                                |
| `--requirement`          | 自然语言需求          | 必填                                |
| `--model`                | 模型名                | `FORGEMIND_MODEL` 或 `gpt-4.1-mini` |
| `--base-url`             | OpenAI 兼容服务地址   | `OPENAI_BASE_URL` 或官方地址        |
| `--run-id`               | 自定义运行 ID         | 自动生成                            |
| `--test-command`         | 显式测试命令          | 自动探测                            |
| `--max-rework`           | 返工上限              | 3                                   |
| `--skip-git-hooks`       | 跳过 Git commit hooks | false                               |
| `--memory`               | 启用四层记忆          | false                               |
| `--config`               | 策略配置文件          | 无                                  |
| `--yes` / `--no-approve` | 自动批准 / 禁止批准   | 交互                                |
| `--actor-policy --actor` | RBAC 角色策略         | 无                                  |

## 5. DAG 并发编排（dag run）

跨仓库、多任务并行执行：

```bash
node dist/src/runtime/cli.js dag run \
  --repos /abs/a,/abs/b \
  --requirement "前后端联调支付模块" \
  --max-concurrency 2
```

| 选项                | 说明                | 默认     |
| ------------------- | ------------------- | -------- |
| `--repos`           | 逗号分隔的仓库列表  | 必填     |
| `--requirement`     | 需求                | 必填     |
| `--max-concurrency` | 并行度上限          | 1        |
| `--worktrees-root`  | git worktree 根目录 | 临时目录 |

- 需求拆解为 DAG 任务，无依赖任务并行、有依赖等待前驱；
- 每任务独立分支 + 独立沙箱 + 独立测试，各自过门禁；
- 后继任务启动前检测跨任务同路径产物的语义冲突，触发有界协商并产出 `DecisionRecord`；
- 跨仓库全部成功后才产出结果，不自动 merge。

## 6. 主动监测（Agentic）

监听开发事件自动触发研发闭环。事件类型：`issue.updated / issue.assigned / ci.failed / pr.mentioned / approval.timed_out`；来源：`github / jira / ci / forgemind`。

通过配置文件声明触发规则与护栏：

```jsonc
{
  "repositories": ["owner/repo-a"],
  "dailyTaskQuota": 20,
  "rateLimit": { "maxRuns": 5, "windowMs": 60000 },
  "guardrails": {
    "allowedTools": ["read_file", "grep", "write_file"],
    "allowedCommands": [["npm", "test"]],
  },
  "rules": [
    {
      "id": "fix-ci",
      "match": { "type": "ci.failed", "source": "ci", "repo": "owner/repo-a" },
      "run": { "requirement": "分析并修复 CI 失败，{{event.id}}", "priority": "high" },
      "cooldownMs": 300000,
    },
  ],
}
```

三层护栏防止失控：

1. **授权白名单**：只有 `repositories` 列表内的仓库才会触发；
2. **配额与限流**：`dailyTaskQuota` 每日上限 + `rateLimit` 窗口限流；
3. **事件去重与冷却**：重复事件忽略、同一对象冷却期内合并、`cooldownMs` 防抖。

决策类型：`TRIGGER`（触发 Run）/ `IGNORE`（忽略）/ `MERGE`（合并进进行中任务）/ `DEFER`（限流延后）。所有决策写入事件日志。

生产部署应给 `AgenticWatchService` 注入 `FileAgenticStateStore`，文件放在服务数据目录或 `<git-dir>/forgemind/agentic/`，不要进入受管工作树。它以单一原子 checkpoint 保存 poller cursor、事件 TTL 去重、对象冷却、pending 队列、滑动窗口限流、每日配额和失败 dispatch；重启后在第一次 `accept/pollOnce` 前自动恢复。若需要在首次轮询前读取 cursor，先调用 `await watch.restore()`。checkpoint 损坏、超限或引用已删除 rule 时 fail-closed。

生产输入可直接使用 `GitHubWebhookReceiver`、`JiraWebhookReceiver`、`CiWebhookReceiver`，或以 `GitHubWorkflowRunPoller`、`JiraIssuePoller`、`CiEventPoller` 轮询兜底。Webhook 必须把未解析的原始请求体交给 receiver：GitHub 使用 `X-Hub-Signature-256`，Jira 使用 `X-Hub-Signature`，CI header 可配置；签名失败、正文超限或 JSON 畸形均不会进入 Watch。`handleNodeWebhook` 可挂到 Node HTTP server。

执行端使用 `ForgeMindAgenticRunDispatcher` + `FileAgenticDispatchStore`：单仓目标走 `runForgeMind`，多仓目标走 `runDagForgeMind`，主动 actor、风险升级、工具/命令白名单会继续传入子 Run。账本在执行前写入 `RUNNING`，明确失败记为 `FAILED` 并以新 attempt 重试，成功记为 `COMPLETED`；若进程崩溃留下歧义 `RUNNING`，系统拒绝盲目重跑并要求按 run id 对账。

`AgenticFeedbackCoordinator` 在成功后推送 ForgeMind 分支、创建或复用 GitHub PR，再回写来源 Issue/PR、Jira Issue 或 CI。评论内置稳定 marker，PR 按 head/base 查询复用，因此回写重试不会重复执行 Run。系统不会自动 merge，也拒绝把 `test` 用作 PR 源分支。

## 7. 审批与权限（RBAC）

- **审批网关**：`--yes`（自动批准）/ `--no-approve`（禁止批准）/ 交互式询问三种模式；
- **策略配置**：`--config` / `FORGEMIND_GLOBAL_CONFIG` / `FORGEMIND_POLICY_JSON` 三级来源，deny-by-default；
- **RBAC 角色**：`--actor-policy <path> --actor <id>` 指定操作者与角色，高风险动作需匹配角色权限。

## 8. 记忆（四层）

`--memory` 启用后：

| 层       | 记什么              | 载体                      |
| -------- | ------------------- | ------------------------- |
| 工作记忆 | 当前 Run 决策       | `TaskContext`             |
| 情景记忆 | 历史 Run 事件轨迹   | `EventLog`                |
| 项目记忆 | 项目约定/决策/教训  | 仓库 `.forgemind/memory/` |
| 语义记忆 | 跨任务决策/教训召回 | L3 文档只读语义索引       |

新 Run 会检索相关记忆注入 PLAN/ARCH 上下文；`memory.recalled / memory.stored` 事件可见可审计。

默认 L4 使用零运行时依赖的词法向量 + BM25，并归一化大小写、标点与英文复数。API 调用方可通过 `EmbeddingProvider` 注入外部向量服务；跨项目检索必须在 `SemanticMemory.repositoryRoots` 中显式列出授权仓库，CLI 的 `--memory` 仅使用当前仓库。

内置 `OpenAICompatibleEmbeddingProvider` 可直连 OpenAI-compatible `/embeddings`，必须显式配置模型和维度；HTTP 错误、非 JSON、维度不符或非有限数值都会使当前阶段失败，不能静默降级为伪向量。

## 9. 回放与报告

```bash
forge-mind replay --repo <path> --run-id <run-id>   # 事件时间线 + workflowSignature
forge-mind report --repo <path> --run-id <run-id>   # 单文件 HTML 报告（离线可打开）
```

报告包含：阶段时间线 + 播放控制、门禁判定与返工标记、失败定位（Stage/Hard/Fatal）、每阶段 token/工具/耗时、确定性质量评分（门禁/返工/测试/覆盖率证据）与建议、审计后的工具详情、流程签名。

每个 Run 结束时都会写入 `run.quality`。如测试命令能提供代码覆盖率，请在输出中加入 `FORGEMIND_COVERAGE=<0-100>`；未提供时报告明确显示 unavailable。启用 `--memory` 后，质量评估和建议写入 `lessons.json`，后续相关需求会在 PLAN/ARCH 中只读召回。

## 10. 审计导出

```bash
forge-mind audit export \
  --repo <path> --from 2026-08-01T00:00:00Z --to 2026-08-31T00:00:00Z \
  --actor-policy <path> --actor <admin-id> \
  --format json|csv
```

按时间窗口导出全部 Run、审批决策、命令执行与 token 消耗，用于合规归档。

## 11. 安全边界

- **沙箱执行**：测试命令在 Docker 沙箱运行（不可用时降级本地，均有检测与降级证据入审计）；
- **命令白名单**：仅测试类命令，无 shell，禁路径穿越；
- **路径安全**：目录穿越、symlink 逃逸、Git 元数据访问均被拒绝；
- **审批门禁**：高风险动作必须审批，决策全量入审计；
- **RBAC**：权限 deny-by-default，最小权限；
- **审计脱敏**：事件日志对密钥/内容脱敏、超长截断；报告二次脱敏 + HTML 转义 + CSP 零外链；
- **Git hooks**：默认执行，仅显式 `--skip-git-hooks` 跳过并记入策略。

> ⚠️ 主动监测与沙箱仅对**受信任的仓库与配置**运行。三层护栏是失控的最后防线。

## 12. 发布 smoke

`npm run test:smoke` 总会执行真实文件 checkpoint/dispatch 失败恢复；未配置的外部依赖会标记 skip。发布环境使用 `npm run test:smoke:release`，缺任一真实依赖即失败：

| 能力       | 必需配置                                                                  |
| ---------- | ------------------------------------------------------------------------- |
| 容器       | `FORGEMIND_SMOKE_CONTAINER_IMAGE`（digest pinned）、可选 runtime          |
| 外部模型   | `OPENAI_API_KEY`、`FORGEMIND_SMOKE_MODEL`、可选 `OPENAI_BASE_URL`         |
| 外部向量   | API key、`FORGEMIND_SMOKE_EMBEDDING_MODEL`、`..._EMBEDDING_DIMENSION`     |
| 失败后恢复 | 无外部配置；验证失败 dispatch 跨实例恢复、稳定 request id、成功后不再重放 |

## 13. 已知限制与失败场景

| 场景                     | 行为                    |
| ------------------------ | ----------------------- |
| 目标仓库有未提交变更     | 拒绝执行（HardFailure） |
| 无 LLM API Key           | 拒绝执行                |
| LLM 返回非 JSON / 缺字段 | 阶段失败，Run 失败      |
| REVIEW diff 超限截断     | 直接驳回并提示缩小变更  |
| TEST 超时/输出超限       | 视为测试失败            |
| 返工超限                 | FAILED，保留现场        |
| DAG 任务依赖成环         | 拆解阶段报错            |
| 主动事件未授权仓库       | IGNORE，入审计          |
| 配额/限流命中            | DEFER，延后重试         |
| 主动 checkpoint 损坏     | FatalFailure，拒绝恢复  |
| 外部向量维度不符         | StageFailure，不降级    |

## 14. 常见问题

**Q：测试命令怎么确定？** 自动读 `package.json` 的 test 脚本，非 Node 仓库用 `--test-command` 显式指定。

**Q：DAG 模式为什么需要 worktree？** 每任务独立工作区，`--worktrees-root` 指定根目录。

**Q：主动监测怎么接入？** Webhook 场景用三类 receiver + `handleNodeWebhook`；无 Webhook 时注入 GitHub/Jira/CI Poller。两者都进入同一个 `AgenticWatchService`，再接 `ForgeMindAgenticRunDispatcher` 与可选回写协调器。

**Q：主动监测重启会丢 cursor 或配额吗？** 注入 `FileAgenticStateStore` 后不会；未注入时保留原有纯内存模式，适合测试与短生命周期进程。

**Q：记忆会不会污染代码？** 记忆只读注入，落盘需确认（`.forgemind/memory/`），可查看可删除。
