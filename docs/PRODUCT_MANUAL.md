# ForgeMind 产品使用手册

> 版本：v3.0（对应 npm `3.0.0`，覆盖 v0.2 → v3.0 全部已实现能力）
> 验证：以当前 `npm run check` 输出为准；评估范围见 `docs/EVALUATION.md`
> 说明：本手册面向使用者，描述**当前代码实际具备**的产品能力，不含规划中未实现的功能。

---

## 1. 产品是什么

ForgeMind 是一个受限 Agent 与确定性门禁协作的软件研发编排器。输入一条自然语言需求，系统先确定运行档位，再执行 **规划 → 可选架构 → 受限编码循环 → 确定性测试门禁 → 独立语义审查 → 策略化提交**，最终产出逐条满足验收契约的 commit。支持**单任务顺序流水线**、**跨仓库 DAG 并发编排**、**主动事件监测**三种执行模式。

**一句话**：你给需求，ForgeMind 给"已提交的代码"；你给事件，ForgeMind 自己发现要干什么。

## 2. 执行模式与产品边界

| 模式         | 命令                            | 适用场景                      | 状态 |
| ------------ | ------------------------------- | ----------------------------- | ---- |
| 单任务流水线 | `run`                           | 单个仓库、单条需求、固定顺序  | ✅   |
| DAG 并发编排 | `dag run`                       | 跨仓库、多任务、并行执行      | ✅   |
| 主动监测     | `AgenticWatchService`（库 API） | 监听 issue/CI/PR 事件自动触发 | ✅   |
| 审计导出     | `audit export`                  | 企业审计 / 合规归档           | ✅   |
| 本地页面     | `npm run web`                   | 选择项目并可视化启动单任务    | ✅   |

| 项       | 现状                                                         |
| -------- | ------------------------------------------------------------ |
| 输入     | 自然语言需求（≤ 100,000 字符）+ 可选策略配置                 |
| 输出     | Git commit + 事件日志（JSONL）+ 可视化报告（HTML）+ 审计导出 |
| 模型     | 任意 OpenAI 兼容 Chat Completions 接口；原生结构化输出可开关 |
| 测试执行 | 沙箱内运行（Docker 或本地降级），真实测试命令                |
| 记忆     | 工作/情景/项目记忆 + 语义检索索引，`--memory` 启用           |
| 审批     | 策略网关：允许/需审批/拒绝，交互或自动                       |
| 安全     | 沙箱 + RBAC 角色 + 全量审计                                  |

## 3. 使用前置条件

1. Node.js ≥ 22，Git 已安装；DAG 模式需 git worktree 支持
2. 目标仓库：**干净的工作区** + **已有至少一个 commit** + **已配置 Git 作者**
3. 环境变量：至少配置一个模型供应商的服务端 API Key
4. 可选：`FORGEMIND_GLOBAL_CONFIG`（全局策略）、`FORGEMIND_STRUCTURED_OUTPUT`（结构化输出开关）

## 4. 本地页面工作台（推荐新手使用）

在 ForgeMind 项目目录运行：

```bash
npm run web
```

终端显示 `ForgeMind Web is ready: http://127.0.0.1:3210` 后，用浏览器打开该地址。页面支持：

1. 点击“选择”浏览当前用户目录下的项目文件夹；系统会检查它是否为干净的 Git 仓库。
2. 没有项目时点击“创建安全演示项目”，自动准备一个可测试的 `ForgeMindDemo`。
3. 填写自然语言需求；在“模型与运行设置”中下拉选择供应商，再在模型框输入名称筛选或手动填写其他模型名。
4. 点击“启动 Multi-Agent 研发任务”，右侧查看 PLAN → 可选 ARCH → CODE → TEST → REVIEW → COMMIT 阶段进度。
5. 完成后打开离线审计报告。代码只提交到 `forgemind/<run-id>` 独立分支，不自动合并。

API Key 不在页面填写，只放在 ForgeMind 根目录的 `.env`（该文件已被 Git 忽略）。可以一次配置多个供应商，之后直接在页面切换：

```dotenv
OPENAI_API_KEY=你的OpenAI密钥
DEEPSEEK_API_KEY=你的DeepSeek密钥
BIGMODEL_API_KEY=你的智谱密钥
DASHSCOPE_API_KEY=你的阿里百炼密钥
MOONSHOT_API_KEY=你的Kimi密钥

# 可选：页面首次打开时默认选中哪个供应商和模型
FORGEMIND_PROVIDER=deepseek
FORGEMIND_MODEL=deepseek-v4-flash
FORGEMIND_STRUCTURED_OUTPUT=1
FORGEMIND_TEMPERATURE=0
FORGEMIND_MAX_REWORK=6
```

只使用一个供应商时，只填写对应的一行 Key 即可。修改 `.env` 后需要停止并重新运行 `npm run web`，页面切换供应商和模型则不需要再次修改文件。

页面内置以下常用选项：

- OpenAI：GPT-5.4、GPT-5.4 mini、GPT-4.1 mini
- DeepSeek：DeepSeek V4 Flash / Pro
- 智谱 BigModel：GLM-5.2、GLM-5.1、GLM-5 Turbo、GLM-4.7 系列
- 阿里云百炼：Qwen3.8 Max、Qwen3.7 Plus / Flash
- Kimi：Kimi K2.6、K2.5、K2、K2 Thinking
- 自定义 OpenAI-compatible：可编辑 API 地址并手动填写模型名

DeepSeek V4 与智谱 GLM 会在统一 Provider 边界关闭思考模式并使用 `json_object`；DashScope Qwen 使用 `json_object`；OpenAI 与 Kimi 使用 `json_schema`。429、5xx、临时资源不足和短暂网络错误会自动进行有上限的重试；鉴权或参数错误立即返回。返工意见会累积传递，默认最多返工 6 次，也可以在页面调整。若一批编辑中的前序修改导致后续 `edit_file` 搜索文本过期，系统会保留成功修改、重新读取最新文件并自动生成剩余编辑，而不是立即结束任务。这些差异不会产生新的 Agent 实现。

旧的单供应商配置 `OPENAI_API_KEY + OPENAI_BASE_URL` 仍可用，后端会把它归属给当前默认供应商；新配置优先使用供应商专用 Key。自定义服务继续使用 `OPENAI_API_KEY`。安全策略仍保留在 `forgemind-local.config.json`，不要把 API Key 写进该文件。

页面服务只监听 `127.0.0.1`，目录浏览不超出当前用户主目录；API Key 不会进入浏览器请求、运行状态、事件日志或配置响应。同一时间只允许一个页面任务，避免分支切换冲突。

## 5. 单任务流水线（run）

```bash
npm install
npm run build

export OPENAI_API_KEY="sk-..."

node dist/src/runtime/cli.js run \
  --repo /abs/path/to/target-repo \
  --requirement "添加一个健康检查接口，并附上测试"
```

| 选项                     | 说明                                              | 默认                                |
| ------------------------ | ------------------------------------------------- | ----------------------------------- |
| `--repo`                 | 目标仓库绝对路径                                  | 必填                                |
| `--requirement`          | 自然语言需求                                      | 必填                                |
| `--model`                | 模型名                                            | `FORGEMIND_MODEL` 或 `gpt-4.1-mini` |
| `--base-url`             | OpenAI 兼容服务地址                               | `OPENAI_BASE_URL` 或官方地址        |
| `--run-id`               | 自定义运行 ID                                     | 自动生成                            |
| `--resume`               | 从该 run id 阶段检查点恢复；需同时提供 `--run-id` | false                               |
| `--test-command`         | 显式测试命令                                      | 自动探测                            |
| `--max-rework`           | 返工上限                                          | 6                                   |
| `--skip-git-hooks`       | 跳过 Git commit hooks                             | false                               |
| `--memory`               | 启用治理记忆与语义检索索引                        | false                               |
| `--config`               | 策略配置文件                                      | 无                                  |
| `--yes` / `--no-approve` | 自动批准 / 禁止批准                               | 交互                                |
| `--actor-policy --actor` | RBAC 角色策略                                     | 无                                  |

## 6. DAG 并发编排（dag run）

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
- 前驱成功后传递 commit、产物版本、逐条验收证据和未完成项；同仓后继以其 commit 为基线并集成其他同仓前驱，跨仓后继接收完整证据 handoff；
- 产物冲突键为 `repo:path`，不同仓库的同名文件不会误判；默认只做一次基于 rubric 的裁决并产出 `DecisionRecord`。裁决要求的每项验证都必须带具体 verifier、追加成下游 `AcceptanceCriterion` 并通过门禁；无法绑定或没有待运行下游承接时停止，不生成提交候选。多轮协商仅由 API 显式开启；
- 跨仓库全部成功后才产出结果，不自动 merge。

## 7. 主动监测（Agentic）

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

`AgenticFeedbackCoordinator` 在成功后推送 ForgeMind 分支、创建或复用 GitHub PR，再回写来源 Issue/PR、Jira Issue 或 CI。所有外部动作必须通过 `ExternalActionGovernor`；内置 `ApprovalExternalActionGovernor` 复用风险/RBAC 审批并将请求、批准/拒绝、执行和验证结果写入 EventLog。push、PR、GitHub/Jira 评论执行后必须读回验证。评论内置稳定 marker，PR 按 head/base 查询复用，因此回写重试不会重复执行 Run。系统不会自动 merge，也拒绝把 `test` 用作 PR 源分支。

## 8. 审批与权限（RBAC）

- **审批网关**：`--yes`（自动批准）/ `--no-approve`（禁止批准）/ 交互式询问三种模式；
- **策略配置**：`--config` / `FORGEMIND_GLOBAL_CONFIG` / `FORGEMIND_POLICY_JSON` 三级来源，deny-by-default；
- **RBAC 角色**：`--actor-policy <path> --actor <id>` 指定操作者与角色，高风险动作需匹配角色权限。

## 9. 记忆与语义检索索引

`--memory` 启用后：

| 层       | 记什么              | 载体                      |
| -------- | ------------------- | ------------------------- |
| 工作记忆 | 当前 Run 决策       | `TaskContext`             |
| 情景记忆 | 历史 Run 事件轨迹   | `EventLog`                |
| 项目记忆 | 项目约定/决策/教训  | 仓库 `.forgemind/memory/` |
| 语义索引 | 跨任务决策/教训召回 | 项目记忆的只读检索索引    |

新 Run 会检索相关记忆注入 PLAN/ARCH 上下文；`memory.recalled / memory.stored` 事件可见可审计。

项目记忆文档使用 v2 治理字段：entry id、创建/更新时间、仓库范围、置信度、读写权限、过期时间、验证 Run、替代关系，以及 `active / superseded / tombstone` 状态。v1 文档读取时迁移；过期、被替代和 tombstone 条目不会召回。召回先按 entry id 或内容哈希去重，再应用 top-k。单次 gate rejection 和尚未通过独立门禁的架构输出只保留在本次轨迹中；架构经验仅在成功提交且 TEST/REVIEW 证据完整、指纹一致后晋升，长期质量 lesson 也只从已验证成功 Run 生成。API 可用 `ProjectMemory.supersede` 和 `tombstone` 完成更正与删除。

## 9.1 验收闭环与恢复

PLAN 为每条标准分配稳定 `AC-*` id、所需证据和验证器。外部传入的标准不允许模型改写。验证器可以是注册测试套件、指定测试用例、文件断言、行为探针或审查 rubric。确定性 Test Gate 先运行主测试命令，再逐条执行所有 TEST 条件；Review Agent 只判断分配给 REVIEW 的语义条件。证据必须同时绑定 criterion id、验证器类型、来源和 diff SHA-256。即使主测试退出码为 0，只要任一专属验证器失败，Commit Executor 也会拒绝；当前代码、最新 TEST、最新 REVIEW 的指纹不一致同样拒绝。

单仓任务按确定性信号选择 `light` 或 `standard`；多仓任务使用 `dag`。CODE 每轮最多执行 1–3 个小动作、最多 10 轮；新读取/搜索结果、todo 变化、行动方向变化或 workspace 变化都算进展，只有相同动作产生相同观察且未形成代码变化时才停止。相同失败动作在成功修复介入后可以重新执行。`fast-check` 只能调用预注册且通过策略的命令，`finish` 不能跳过后续 TEST/REVIEW。

整次 Run 共用累计预算。CLI 收到 `Ctrl-C` 或 `SIGTERM` 后会把取消传到模型调用、裁决和子进程，并原子保存下一安全阶段。使用原 `--run-id <id> --resume` 继续；`RunManifest` 会核对需求、验收契约、初始 HEAD、Provider/Model、Prompt 版本、Policy、测试命令、预算和上游提交。CODE 动作日志使用 `PLANNED → EXECUTED → VERIFIED`；PLANNED 同时原子保存 `beforeHash` 与 `expectedAfterHash`。恢复时当前文件等于后态即确认已执行，等于前态才重放，两者都不等则进入 BLOCKED 并禁止覆盖。PLAN/ARCH 文档和动作日志位于 `<git-dir>/forgemind/runs/<run-id>/artifacts/`，不会被 `git add --all` 带进业务 commit。

默认语义检索索引使用零运行时依赖的词法向量 + BM25，并归一化大小写、标点与英文复数。API 调用方可通过 `EmbeddingProvider` 注入外部向量服务；跨项目检索必须在 `SemanticMemory.repositoryRoots` 中显式列出授权仓库，CLI 的 `--memory` 仅使用当前仓库。

内置 `OpenAICompatibleEmbeddingProvider` 可直连 OpenAI-compatible `/embeddings`，必须显式配置模型和维度；HTTP 错误、非 JSON、维度不符或非有限数值都会使当前阶段失败，不能静默降级为伪向量。

## 10. 回放与报告

```bash
forge-mind replay --repo <path> --run-id <run-id>   # 事件时间线 + workflowSignature
forge-mind report --repo <path> --run-id <run-id>   # 单文件 HTML 报告（离线可打开）
```

报告包含：阶段时间线 + 播放控制、门禁判定与返工标记、失败定位（Stage/Hard/Fatal）、每阶段 token/工具/耗时，以及 `outcome / evidenceCompleteness / verificationStrength / coveragePercent|null / reworkRounds / policyViolations / confidence`。系统不再把测试通过率伪装成覆盖率，也不再硬凑一个万能等级或总分。

每个 Run 结束时都会写入 `run.quality`。如测试命令能提供代码覆盖率，请在输出中加入 `FORGEMIND_COVERAGE=<0-100>`；未提供时保持 `null/unavailable`。只有带专属行为/文件/用例验证、独立审查且指纹一致的成功结果才可能达到 `strong` 并进入长期 lesson。

快速合约评测使用 `npm run prompt:contract`（`eval:contract` 是兼容别名），只验证 Prompt、Schema 与工具合约，不作为效果基准。真实效果门禁使用 `npm run eval:real`：它复用 `FORGEMIND_PROVIDER`（或 `FORGEMIND_EVAL_PROVIDER`）及对应凭据，在临时 Git 仓库运行五类受控任务：单文件缺陷、跨文件功能、测试失败后返工、写入后崩溃恢复和冲突裁决。结果连同模型调用、token、返工和最终逐条证据写入 `evals/results/latest-real-agent.json`；缺凭据会在场景开始前失败，不会记为通过。`npm run eval` 串行执行两者。当前证据边界见 `docs/EVALUATION.md`。

## 11. 审计导出

```bash
forge-mind audit export \
  --repo <path> --from 2026-08-01T00:00:00Z --to 2026-08-31T00:00:00Z \
  --actor-policy <path> --actor <admin-id> \
  --format json|csv
```

按时间窗口导出全部 Run、审批决策、命令执行与 token 消耗，用于合规归档。

## 12. 安全边界

- **沙箱执行**：测试命令在 Docker 沙箱运行（不可用时降级本地，均有检测与降级证据入审计）；
- **命令白名单**：仅测试类命令，无 shell，禁路径穿越；
- **路径安全**：目录穿越、symlink 逃逸、Git 元数据访问均被拒绝；
- **审批门禁**：高风险动作必须审批，决策全量入审计；
- **RBAC**：权限 deny-by-default，最小权限；
- **审计脱敏**：事件日志对密钥/内容脱敏、超长截断；报告二次脱敏 + HTML 转义 + CSP 零外链；
- **Git hooks**：默认执行，仅显式 `--skip-git-hooks` 跳过并记入策略。

> ⚠️ 主动监测与沙箱仅对**受信任的仓库与配置**运行。三层护栏是失控的最后防线。

## 13. 发布 smoke

`npm run test:smoke` 总会执行真实文件 checkpoint/dispatch 失败恢复；未配置的外部依赖会标记 skip。发布环境使用 `npm run test:smoke:release`，缺任一真实依赖即失败：

| 能力       | 必需配置                                                                  |
| ---------- | ------------------------------------------------------------------------- |
| 容器       | `FORGEMIND_SMOKE_CONTAINER_IMAGE`（digest pinned）、可选 runtime          |
| 外部模型   | `OPENAI_API_KEY`、`FORGEMIND_SMOKE_MODEL`、可选 `OPENAI_BASE_URL`         |
| 外部向量   | API key、`FORGEMIND_SMOKE_EMBEDDING_MODEL`、`..._EMBEDDING_DIMENSION`     |
| 失败后恢复 | 无外部配置；验证失败 dispatch 跨实例恢复、稳定 request id、成功后不再重放 |

## 14. 已知限制与失败场景

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

## 15. 常见问题

**Q：测试命令怎么确定？** 自动读 `package.json` 的 test 脚本，非 Node 仓库用 `--test-command` 显式指定。

**Q：DAG 模式为什么需要 worktree？** 每任务独立工作区，`--worktrees-root` 指定根目录。

**Q：主动监测怎么接入？** Webhook 场景用三类 receiver + `handleNodeWebhook`；无 Webhook 时注入 GitHub/Jira/CI Poller。两者都进入同一个 `AgenticWatchService`，再接 `ForgeMindAgenticRunDispatcher` 与可选回写协调器。

**Q：主动监测重启会丢 cursor 或配额吗？** 注入 `FileAgenticStateStore` 后不会；未注入时保留原有纯内存模式，适合测试与短生命周期进程。

**Q：记忆会不会污染代码？** 记忆只读注入，落盘需确认（`.forgemind/memory/`），可查看可删除。
