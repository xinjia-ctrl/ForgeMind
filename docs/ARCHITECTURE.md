# ForgeMind 架构

## 1. 总览

```text
CLI / Local Web
       │
       ▼
runForgeMind
  ├─ 检查 Git 工作区并创建运行分支
  ├─ 装配策略、沙箱、预算、事件日志和检查点
  └─ Orchestrator
       PLAN → (ARCH) → CODE → TEST → REVIEW → COMMIT
                            ↑         │
                            └─ rework ┘
```

系统采用一个显式状态机，不使用消息总线或动态 Agent 网络。每个阶段创建一次性 Agent 实例；阶段间只通过不可变 `TaskContext`、结构化产物和门禁证据通信。

## 2. 运行流程

1. `runForgeMind` 校验输入和 Git 状态。
2. `selectRunProfile` 选择 `light` 或 `standard`；复杂任务增加 ARCH。
3. PLAN 生成步骤和结构化验收条件。
4. CODE 在最多 10 个小步循环内执行读取、搜索、修改和快速检查。
5. TEST 运行已注册 verifier；REVIEW 检查 diff 和验收条件。
6. 任一门禁拒绝时，累计反馈返回下一轮 CODE；超过上限即失败。
7. 双门禁证据完整且指纹一致后，COMMIT 才能执行。

## 3. 关键数据

- `TaskContext`：需求、仓库、计划、可选架构、产物、门禁和当前尝试次数。
- `AcceptanceCriterion`：描述、所需证据类型和具体 verifier。
- `EventLog`：只追加 JSONL，是回放、质量指标和报告的事实源。
- `RunCheckpoint`：安全阶段、上下文、返工历史、预算快照和运行清单。
- `RunManifest`：需求、初始 HEAD、模型、提示词、策略、测试与预算指纹，防止错误恢复。
- `ActionJournal`：CODE 文件动作的 PLANNED / EXECUTED / VERIFIED 状态，处理崩溃重入。

## 4. 工具与安全

所有工具都经过同一个 `ScopedToolExecutor`：

```text
Agent 请求
  → 阶段工具白名单
  → RulePolicyResolver
  → allow / approve / deny
  → ToolPolicy 路径与命令检查
  → 本地或容器执行
  → 脱敏事件
```

默认允许只读文件工具和受控编辑；TEST/CODE 只可执行预注册测试命令；COMMIT 需要批准。容器默认关闭网络并限制资源，镜像必须固定 digest。

## 5. 模型与提示词

`OpenAICompatibleChatProvider` 统一各供应商调用。供应商差异集中在目录与请求兼容层，业务阶段只依赖 `ChatProvider`。

提示词按文件版本化，输出使用 JSON Schema 或 JSON Object。每次 `llm.called` 记录模型、token、提示词版本和输入指纹，但不记录密钥。

## 6. 恢复与可观测性

- 每个阶段转换后原子保存检查点。
- 收到取消信号时保留当前安全状态。
- 恢复前比对仓库分支和 `RunManifest`，配置漂移时拒绝继续。
- 报告是事件日志的纯投影，展示时间线、门禁、产物、预算、审批、提示词和上下文来源。

## 7. 目录

```text
src/
├── agents/        阶段 Agent
├── config/        预算与策略配置
├── context/       上下文装配和文件排序
├── core/          编排内核
├── llm/           模型接口与供应商目录
├── policy/        策略和批准网关
├── quality/       运行质量指标
├── report/        离线 HTML 报告
├── runtime/       CLI、Git 和运行入口
├── sandbox/       Docker/Podman/本地执行器
├── tools/         工具实现
├── verification/  验收 verifier
└── web/           本地 Web 工作台
```

## 8. 设计取舍

- 单仓库换取边界清晰和可解释性。
- 显式阶段换取可测试控制流。
- 验收契约与真实执行证据优先于模型自评。
- 事件投影复用同一事实源，不引入独立数据库。
- 模型可以提出动作，但不能扩大工具、命令、预算或权限。
