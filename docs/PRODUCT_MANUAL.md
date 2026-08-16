# ForgeMind 产品使用手册

> 版本：v1.0（对齐已实现代码，覆盖 v0.2 → v3.0 全部能力，103/103 测试通过）
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

## 7. 审批与权限（RBAC）

- **审批网关**：`--yes`（自动批准）/ `--no-approve`（禁止批准）/ 交互式询问三种模式；
- **策略配置**：`--config` / `FORGEMIND_GLOBAL_CONFIG` / `FORGEMIND_POLICY_JSON` 三级来源，deny-by-default；
- **RBAC 角色**：`--actor-policy <path> --actor <id>` 指定操作者与角色，高风险动作需匹配角色权限。

## 8. 记忆（四层）

`--memory` 启用后：

| 层       | 记什么             | 载体                      |
| -------- | ------------------ | ------------------------- |
| 工作记忆 | 当前 Run 决策      | `TaskContext`             |
| 情景记忆 | 历史 Run 事件轨迹  | `EventLog`                |
| 项目记忆 | 项目约定/决策/教训 | 仓库 `.forgemind/memory/` |
| 语义记忆 | 跨任务知识         | 接缝预留                  |

新 Run 会检索相关记忆注入 PLAN/ARCH 上下文；`memory.recalled / memory.stored` 事件可见可审计。

## 9. 回放与报告

```bash
forge-mind replay --repo <path> --run-id <run-id>   # 事件时间线 + workflowSignature
forge-mind report --repo <path> --run-id <run-id>   # 单文件 HTML 报告（离线可打开）
```

报告包含：阶段时间线 + 播放控制、门禁判定与返工标记、失败定位（Stage/Hard/Fatal）、每阶段 token/工具/耗时、审计后的工具详情、流程签名。

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

## 12. 已知限制与失败场景

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

## 13. 常见问题

**Q：测试命令怎么确定？** 自动读 `package.json` 的 test 脚本，非 Node 仓库用 `--test-command` 显式指定。

**Q：DAG 模式为什么需要 worktree？** 每任务独立工作区，`--worktrees-root` 指定根目录。

**Q：主动监测怎么接入？** 通过库 API 注入 `DevelopmentEventPoller` 与 `AgenticRunDispatcher`，或直接 `accept(event)` 喂事件。

**Q：记忆会不会污染代码？** 记忆只读注入，落盘需确认（`.forgemind/memory/`），可查看可删除。
