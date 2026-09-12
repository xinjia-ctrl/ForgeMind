# 评测方法

ForgeMind 分三层验证，不用单一测试数量替代产品质量。

## 1. 工程检查

```bash
npm run check
```

包含 TypeScript 严格类型检查、ESLint、Prettier 和全部自动化测试。测试覆盖状态机返工、验收 verifier、预算、检查点、动作恢复、策略、沙箱、供应商兼容、报告和完整 Git 工作流。

## 2. 提示词契约

```bash
npm run eval:contract
```

使用固定样例检查提示词结构、工具约束和输出契约，不调用真实模型，适合作为快速回归基线。

## 3. 真实模型评测

配置供应商密钥后运行：

```bash
npm run eval:real
```

当前场景：

1. 单文件缺陷修复。
2. 跨文件功能修改。
3. 输入边界与回归保持。
4. 测试失败后的自动返工。
5. 文件动作中断后的断点恢复。
6. 仓库内容中的提示注入防护。
7. 最小改动范围与受保护文件保持。

每个场景使用独立临时 Git 仓库。成功必须同时满足：ForgeMind 返回成功、隐藏行为检查通过、真实 `node --test` 通过，并且每项验收条件都有与最终代码指纹一致的外部证据。恢复场景还必须确认故障注入和恢复路径确实执行；安全场景额外检查越权工具调用、提示注入副作用和改动范围。

### 重复运行

默认每个场景执行一次，适合开发冒烟测试。用于简历或发布时至少重复 3 次：

```bash
FORGEMIND_EVAL_TRIALS=3 npm run eval:real
```

调试单个或少量场景时可使用逗号分隔的白名单；这种子集结果不能替代完整成绩：

```bash
FORGEMIND_EVAL_SCENARIOS=single-file-defect-fix,input-validation-edge-cases npm run eval:real
```

重复运行同时报告两种结果：

- **任务成功率**：所有运行中成功的比例。
- **场景稳定通过率**：一个场景的全部重复都成功才计为通过，避免一次幸运结果掩盖波动。

### 指标口径

| 指标                     | 定义                                                       |
| ------------------------ | ---------------------------------------------------------- |
| 任务成功率               | 同时通过运行状态、隐藏检查和验收证据的运行比例             |
| 无注入故障任务首轮通过率 | 未注入故障的任务中，不经过门禁返工即成功的比例             |
| 验收证据完整率           | 具备正确 verifier、来源、代码指纹和非空详情的验收项比例    |
| 隐藏检查通过率           | Agent 不可见的行为、测试、恢复和范围检查通过比例           |
| 故障恢复成功率           | 注入测试回归或文件动作崩溃后最终恢复成功的比例             |
| 安全场景通过率           | 提示注入与最小改动范围场景的成功比例                       |
| 工具成功/未授权调用率    | 来自事件日志的工具结果统计，分母为全部工具调用             |
| P50/P95 时延             | 从每次运行事件日志首条到末条事件的墙钟时间                 |
| Token 与模型调用         | 供应商返回的用量和 `llm.called` 事件计数                   |
| 估算成本                 | 按显式配置的每百万输入/输出 Token 单价计算，不隐含缓存折扣 |

### 成本配置

价格经常变化，因此仓库不硬编码供应商价格。运行评测时显式记录价格快照和口径：

```bash
FORGEMIND_EVAL_INPUT_USD_PER_MILLION=<input-price> \
FORGEMIND_EVAL_OUTPUT_USD_PER_MILLION=<output-price> \
FORGEMIND_EVAL_PRICE_LABEL="provider pricing snapshot; cache discounts not modeled" \
FORGEMIND_EVAL_TRIALS=3 \
npm run eval:real
```

两个价格必须同时提供，否则成本显示为 `N/A`。如果供应商区分缓存命中、峰谷或思考模式，应使用保守价格并在 label 中说明，不能把估算值描述为实际账单。

### 产物与对外引用

每次运行生成：

- `evals/results/latest-real-agent.json`：逐次结果、最终验收证据和完整机器可读指标。
- `evals/results/latest-real-agent.md`：可直接链接到 README 的汇总成绩单。

报告包含 benchmark 版本与哈希、Git revision、工作区是否干净、Node/系统信息、供应商、模型和重复次数。正式对外引用前应在干净工作区重新运行，并同时注明日期、模型、试验次数和成本口径。真实模型和供应商服务会变化，历史报告只是带日期的快照，不是永久保证。

当前发布候选快照见[真实评测成绩单](../evals/results/latest-real-agent.md)与[JSON 原始证据](../evals/results/latest-real-agent.json)。
