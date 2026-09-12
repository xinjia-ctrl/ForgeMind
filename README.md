# ForgeMind

ForgeMind 是一个面向本地 Git 仓库的 AI 编码 Agent。它把自然语言需求推进为一条可验证的工程闭环：

```text
PLAN → (ARCH) → CODE → TEST → REVIEW → COMMIT
                       ↑         │
                       └─ 返工 ──┘
```

项目刻意保持单仓库、单主流程：重点展示 Agent 编排、受控工具调用、自动验证和故障恢复，不承担代码托管平台、任务系统或长期知识库的职责。

## 核心能力

- 根据任务复杂度选择轻量或标准流程，架构阶段按需执行。
- CODE Agent 以小步动作读取、搜索、修改和快速检查代码。
- TEST 与 REVIEW 双门禁；失败证据会累计返回 CODE，最多返工 6 次。
- 每次运行创建独立 `forgemind/<run-id>` 分支，成功后生成 Git commit。
- 工具白名单、`allow / approve / deny` 策略和默认无网络容器沙箱。
- Token、调用次数、成本和运行时长预算。
- JSONL 事件日志、断点恢复、动作日志与离线 HTML 报告。
- OpenAI-compatible 模型接口；默认供应商为 DeepSeek，默认模型为 `deepseek-flash`（DeepSeek V4.1 Flash）。

## 快速开始

要求 Node.js 22+，默认沙箱还需要 Docker 或 Podman。

```bash
npm install
cp .env.example .env
npm run check
npm run web
```

浏览器访问命令输出的本地地址，选择仓库并填写需求即可。

CLI 示例：

```bash
npm run build
node --env-file-if-exists=.env dist/src/runtime/cli.js run \
  --repo /path/to/repository \
  --requirement "修复整数相加并补充测试" \
  --yes
```

断点恢复、回放与报告：

```bash
node dist/src/runtime/cli.js run --repo /path/to/repository --requirement "..." --run-id demo --resume
node dist/src/runtime/cli.js replay --repo /path/to/repository --run-id demo
node dist/src/runtime/cli.js report --repo /path/to/repository --run-id demo
```

## 模型配置

密钥只从后端环境变量读取，Web 请求不会接收或回传密钥。

| 供应商        | 环境变量            | 默认模型         |
| ------------- | ------------------- | ---------------- |
| DeepSeek      | `DEEPSEEK_API_KEY`  | `deepseek-flash` |
| OpenAI        | `OPENAI_API_KEY`    | `gpt-5.4-mini`   |
| 智谱 BigModel | `BIGMODEL_API_KEY`  | `glm-4.7-flash`  |
| 阿里云百炼    | `DASHSCOPE_API_KEY` | `qwen3.7-flash`  |
| Moonshot      | `MOONSHOT_API_KEY`  | `kimi-k2.6`      |

可用 `FORGEMIND_PROVIDER` 和 `FORGEMIND_MODEL` 修改默认选择。自定义 OpenAI-compatible 服务使用 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和显式模型名。

## 安全边界

- 目标仓库必须已有 commit 且工作区干净。
- 模型只能调用当前阶段显式允许的工具。
- 测试命令使用 argv 精确匹配，不经 shell 执行。
- 容器镜像必须固定到 SHA-256 digest，默认关闭网络并限制 CPU、内存和进程数。
- commit 默认需要批准；`--yes` 仅适合受信任的本地演示。
- 仓库内容、diff 和工具输出均按不可信上下文装配。

## 文档

- [产品边界](docs/PRD.md)
- [架构说明](docs/ARCHITECTURE.md)
- [使用手册](docs/PRODUCT_MANUAL.md)
- [评测方法](docs/EVALUATION.md)
- [已知限制](docs/LIMITATIONS.md)

## 验证

```bash
npm run check
npm run eval:contract
# 配置真实模型密钥后：
npm run eval:real
```

真实评测使用隔离的临时 Git 仓库、隐藏行为检查和故障注入，覆盖正确性、跨文件修改、自动返工、崩溃恢复、提示注入与改动范围。运行后同时生成 JSON 原始证据和适合阅读的 Markdown 成绩单；正式对外发布建议每个场景至少重复 3 次。详见[评测方法](docs/EVALUATION.md)。

### 最新真实模型快照

2026-09-12 使用 `deepseek-flash` 对 7 个场景各重复 3 次：

| 指标                        |                               结果 |
| --------------------------- | ---------------------------------: |
| 任务成功率 / 场景稳定通过率 |                100%（21/21）/ 100% |
| 验收证据 / 隐藏检查通过率   |                        100% / 100% |
| 故障恢复 / 安全场景通过率   |                        100% / 100% |
| 未授权工具调用率            |                                 0% |
| 平均模型调用 / Token        |                     3.9 次 / 4,859 |
| P50 / P95 时延              |                   5.4 秒 / 10.0 秒 |
| 估算成本上界                | $0.058（峰值、输入缓存未命中口径） |

完整口径、分场景数据和版本信息见[评测成绩单](evals/results/latest-real-agent.md)，逐次验收证据见[JSON 原始报告](evals/results/latest-real-agent.json)。该结果是带日期的模型快照，不是对未来模型版本的保证。

项目使用 TypeScript 严格模式，运行时零第三方依赖。
