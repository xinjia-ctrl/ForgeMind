# ForgeMind

ForgeMind 是一个面向 TypeScript/Node.js 项目的本地代码研发工作流，通过阶段化模型角色与确定性的测试、审查、策略和提交门禁，将自然语言需求推进为经过证据验证的代码提交。

> 项目状态：面向生产问题设计的本地参考实现。它不是托管式 IDE、多用户服务，也不会自主合并代码。

```text
档位选择 → PLAN → 可选 ARCH → 有界 CODE 循环
                                ↑          ↓
                                └── 返工 ← TEST → REVIEW → COMMIT
```

Orchestrator 统一控制流程。Agent 之间不会互相调用，也不能自行创建工具；各阶段只传递不可变任务上下文、结构化验收条件、受限产物和绑定 verifier 的证据。

## 为什么做这个项目

许多 Coding Agent Demo 会在模型声称“任务完成”时停止。ForgeMind 把完成判断交给外部证据：

- 每条验收条件必须绑定已注册的测试套件、测试用例、文件断言、行为探针或审查 rubric。
- TEST 与 REVIEW 的证据必须绑定同一个工作区指纹；两个门禁之间代码发生变化时，COMMIT 会被阻止。
- 只有 CODE 使用自主循环，并对步骤、动作、重试、工具、Token 消耗和停止条件设置上限。
- 被中断的写操作通过 `PLANNED → EXECUTED → VERIFIED` 日志恢复；文件状态无法安全对账时默认停止。
- 工具策略、审批、路径约束、沙箱证据和运行事件均会落盘，可用于回放和离线报告。

## 已实现范围

| 领域     | 当前实现                                                              |
| -------- | --------------------------------------------------------------------- |
| 工作流   | 确定性档位选择；PLAN、可选 ARCH、CODE、TEST、REVIEW、COMMIT           |
| 验收验证 | 结构化验收契约、注册式 verifier、累积返工证据、产物指纹               |
| 恢复机制 | 共享运行预算、取消、阶段 checkpoint、运行清单、动作日志               |
| 代码隔离 | 每次运行使用独立 Git 分支；每个 DAG 任务使用独立 worktree；不自动合并 |
| 权限治理 | 阶段工具白名单、allow/approve/deny 策略、可选 RBAC、审计导出          |
| 命令执行 | 默认使用 digest 固定的 Docker/Podman 沙箱；可显式启用受信任本机模式   |
| 可观测性 | 版本化 JSONL 事件、回放签名、自包含离线 HTML 报告                     |
| 可选扩展 | 项目记忆、语义检索索引、多仓库 DAG、GitHub/Jira/CI 适配器             |

## 验证快照

最近一次本地验证时间为 2026-09-08：

- `npm run check`：登记 204 项测试，201 项通过，3 项依赖外部环境的 smoke 测试跳过。
- 真实 Agent 评测：使用 `deepseek-v4-flash` 的 5 个受控场景全部通过，其中包含一次自动返工、一次崩溃恢复和一次冲突裁决。
- 发布包预检：构建和包内容检查成功。

这五个真实 Agent 场景使用的是受控小型仓库，不代表通用 Coding Agent 基准。准确的评测范围和限制见[评估说明](docs/EVALUATION.md)。

## 快速开始

环境要求：Node.js 22+、Git，以及一个兼容 OpenAI Chat Completions 协议的模型服务。

```bash
npm ci
cp .env.example .env
# 在 .env 中填写准备使用的模型供应商密钥。

npm run web -- --config ./forgemind-local.config.json
```

浏览器打开 `http://127.0.0.1:3210`。仓库附带的本地配置会在宿主机执行已批准的测试命令，仅适合受信任的演示仓库。

如果需要隔离执行，请提供包含 digest 固定容器镜像的策略文件：

```bash
npm run build

node dist/src/runtime/cli.js run \
  --repo /absolute/path/to/target-repo \
  --requirement "增加健康检查接口并补充测试" \
  --config /absolute/path/to/forgemind.config.json
```

目标必须是包含至少一个提交且没有未提交修改的 Git 仓库。ForgeMind 会创建 `forgemind/<run-id>` 分支，失败时保留分支和证据供排查，并且不会自动合并生成的修改。

对于跨多个仓库的需求：

```bash
node dist/src/runtime/cli.js dag run \
  --repos /absolute/path/to/service,/absolute/path/to/web \
  --requirement "为服务端和 Web 客户端增加同一个功能" \
  --max-concurrency 4 \
  --yes
```

每个 DAG 任务在独立 linked worktree 中执行，并产出包含 commit、产物、验收证据和未完成项的版本化 handoff。成功的 DAG 只生成 PR candidate；除非另行配置外部反馈适配器，否则不会推送或合并代码。

## 报告与回放

```bash
node dist/src/runtime/cli.js replay \
  --repo /absolute/path/to/target-repo \
  --run-id <run-id>

node dist/src/runtime/cli.js report \
  --repo /absolute/path/to/target-repo \
  --run-id <run-id>
```

运行产物保存在目标仓库的 Git metadata 中，不会进入生成的 commit。离线报告展示阶段时间线、返工回路、验收证据、失败信息、预算、审计动作、记忆使用情况和工作流签名。

## 质量检查

```bash
npm run check             # 类型检查、Lint、格式和完整测试
npm run prompt:contract   # Prompt 与 Schema 合约回归
npm run eval:real         # 真实模型、编辑、测试和提交；需要模型密钥
npm run test:smoke        # 外部依赖 smoke 检查
```

`prompt:contract` 是结构回归测试，不是模型效果基准。`eval:real` 会将最近一次结果写入 `evals/results/latest-real-agent.json`。

## 文档

- [文档索引](docs/README.md)
- [当前产品范围](docs/PRD.md)
- [架构与设计决策](docs/ARCHITECTURE.md)
- [产品使用手册](docs/PRODUCT_MANUAL.md)
- [评估方法与结果](docs/EVALUATION.md)
- [已知限制与非目标](docs/LIMITATIONS.md)
- [历史 PRD 与 ADR](docs/history/README.md)

## 安全边界

ForgeMind 通过精确命令白名单、路径与符号链接检查、输出限制、审计脱敏、审批门禁和可选的断网容器沙箱降低风险。这些控制本身不能保证任意仓库都是安全的。在受信任本地环境之外使用前，请先阅读[已知限制](docs/LIMITATIONS.md)中的信任边界和未解决风险。
