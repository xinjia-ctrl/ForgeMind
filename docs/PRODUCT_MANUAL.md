# ForgeMind 产品使用手册

> 版本：v0.3（对齐已实现代码）
> 说明：本手册面向使用者，描述**当前代码实际具备**的产品能力，不含规划中未实现的功能。

---

## 1. 产品是什么

ForgeMind 是一个多 Agent 协作的软件研发编排器：输入一条自然语言需求，系统通过 6 个专职 Agent 依次完成 **规划 → 架构 → 编码 → 审查 → 测试 → 提交**，最终在你的 Git 仓库中产出一个通过审查与测试的 commit。

**一句话**：你给需求，ForgeMind 给"已提交的代码"。

## 2. 产品边界（当前版本）

| 项       | 现状                                                                      |
| -------- | ------------------------------------------------------------------------- |
| 输入     | 一条自然语言需求（≤ 100,000 字符）                                        |
| 输出     | 一个 Git commit + 全流程事件日志（JSONL）+ 可选单文件 HTML 报告           |
| 运行环境 | 本地机器，目标仓库必须干净（无未提交变更）                                |
| 模型     | 任意 OpenAI 兼容 Chat Completions 接口（`gpt-4.1-mini` 默认）             |
| 测试执行 | 真实运行测试命令（自动探测 package test，回退 `node --test`，可显式指定） |
| 长期记忆 | 无（一次 Run 即独立上下文）                                               |
| 可视化   | 任意历史 Run 可生成离线单文件 HTML 报告                                   |

## 3. 使用前置条件

1. Node.js ≥ 22，Git 已安装
2. 目标仓库：**干净的工作区** + **已有至少一个 commit** + **已配置 Git 作者**
3. 环境变量：`OPENAI_API_KEY`（可自定义 `OPENAI_BASE_URL` 指向兼容服务）

## 4. 快速开始

```bash
npm install
npm run build

export OPENAI_API_KEY="sk-..."
export FORGEMIND_MODEL="gpt-4.1-mini"

# 在一个干净的仓库目录中：
node dist/src/runtime/cli.js run \
  --repo /abs/path/to/target-repo \
  --requirement "添加一个健康检查接口，并附上测试"
```

成功后终端输出：

```json
{
  "status": "SUCCEEDED",
  "summary": "Created commit <sha>",
  "branch": "forgemind/<run-id>",
  "eventLog": "/abs/path/.git/forgemind/runs/<run-id>.jsonl"
}
```

## 5. 完整执行流程（使用者视角）

```
PLAN  → 生成任务计划 docs/.forgemind/<run-id>/plan.md
ARCH  → 生成架构决策 docs/.forgemind/<run-id>/architecture.md
CODE  → 生成代码 + 测试（最多 30 个文件操作）
REVIEW→ 只读审查 diff；发现缺陷 → 驳回 → 带着反馈回到 CODE
TEST  → 真实运行测试；失败 → 带着输出回到 CODE
COMMIT→ 通过全部门禁后创建 commit（不自动合并分支）
```

- 每次 Run 在**独立分支 `forgemind/<run-id>`** 上进行，不触碰主分支。
- 失败/成功均保留分支与变更，供审计和恢复。
- REVIEW 驳回或 TEST 失败后最多返工 `max-rework` 轮（默认 3），超限即 FAILED。

## 6. 命令行

### 运行

```bash
forge-mind run --repo <path> --requirement <text> [选项]
```

| 选项               | 说明                                  | 默认                                 |
| ------------------ | ------------------------------------- | ------------------------------------ |
| `--repo`           | 目标仓库绝对路径                      | 必填                                 |
| `--requirement`    | 自然语言需求                          | 必填                                 |
| `--model`          | 模型名                                | `FORGEMIND_MODEL` 或 `gpt-4.1-mini`  |
| `--base-url`       | OpenAI 兼容服务地址                   | `OPENAI_BASE_URL` 或官方地址         |
| `--run-id`         | 自定义运行 ID（字母数字 `._-`，≤128） | 自动生成                             |
| `--test-command`   | 显式测试命令                          | 自动探测 `package.json` 的 test 脚本 |
| `--max-rework`     | 返工上限                              | 3                                    |
| `--skip-git-hooks` | 显式跳过 Git commit hooks             | false（默认执行 hooks）              |

### 回放

```bash
forge-mind replay --repo <path> --run-id <run-id>
```

输出按序排列的完整事件时间线（每一步的 LLM 调用、工具调用、门禁判定）及 `workflowSignature`，用于演示、审计与流程一致性比较。

### 生成可视化报告

```bash
forge-mind report --repo <path> --run-id <run-id>
```

报告写入 `<git-dir>/forgemind/reports/<run-id>.html`，直接用浏览器离线打开，无需启动服务或联网。报告包含：

- 按实际顺序排列的阶段/attempt 时间线与播放控制；
- REVIEW/TEST 门禁判定及返工标记；
- 失败阶段、Stage/Hard/Fatal 类型和错误信息；
- 各阶段 LLM token、工具调用数和可对账耗时；
- 产物列表、审计后的工具详情与流程签名。

## 7. 产物与可观测性

- **工作区产物**：`docs/.forgemind/<run-id>/plan.md`、`architecture.md`
- **事件日志**：`.git/forgemind/runs/<run-id>.jsonl`（不进入 commit，不污染产出）
- **可视化报告**：`.git/forgemind/reports/<run-id>.html`（日志的只读投影，不是第二份事实源）
- **事件类型**：`run.started / stage.started / llm.called / tool.called / artifact.produced / gate.rejected / gate.passed / stage.completed / stage.failed / run.finished`
- **门禁判定**：REVIEW 以 diff 指纹（sha256）锚定，防止"审查后工作区又变了"；COMMIT 前强制复核 diff 指纹一致。
- **流程签名**：`workflowSignature` 忽略时间戳、runId、commit sha 等非确定数据，对事件顺序、阶段、工具结果和门禁结果生成稳定 sha256。

## 8. 安全边界（当前版本，使用者须知）

当前版本 `run_command` **直接在本机执行**，属明确的安全让步。防护措施：

- 命令白名单：只能运行 `npm/pnpm/yarn/bun/node` 的测试类命令，无 shell，禁路径穿越
- 工具按阶段白名单：REVIEW/TEST 只读，CODE 可写但禁写 `docs/.forgemind` 与 `.git`
- 路径安全：目录穿越、symlink 逃逸、Git 元数据访问均被拒绝
- 审计脱敏：事件日志对密钥/内容类字段脱敏、超长截断
- 报告安全：工具参数/结果二次脱敏，所有动态内容 HTML 转义，CSP 禁止外部资源与联网
- Git hooks 默认执行；仅显式 `--skip-git-hooks` 时跳过，并在 ToolPolicy 审计描述中记录

> ⚠️ **仅对受信任的仓库运行**。生产级沙箱与审批网关规划在 Phase 3。

## 9. 已知限制与失败场景

| 场景                              | 行为                    |
| --------------------------------- | ----------------------- |
| 目标仓库有未提交变更              | 拒绝执行（HardFailure） |
| 无 LLM API Key                    | 拒绝执行                |
| LLM 返回非 JSON / 缺字段          | 阶段失败，Run 失败      |
| REVIEW diff 超限截断              | 直接驳回并提示缩小变更  |
| TEST 超时（默认 5 分钟）/输出超限 | 视为测试失败            |
| 返工超限                          | FAILED，保留现场        |
| 无效 run-id / 重复 run-id         | 拒绝（FatalFailure）    |
| Git commit hook 失败              | FAILED，保留分支供处理  |

## 10. 常见问题

**Q：测试命令怎么被确定的？**
自动读取仓库 `package.json` 的 `scripts.test`；非 Node 仓库可用 `--test-command "node --test"` 显式指定。

**Q：为什么我的仓库必须有已提交内容？**
`prepareGitWorkspace` 要求工作区干净，且不支持 detached HEAD。

**Q：产物为什么不进 commit？**
运行事件写入 `.git/forgemind/runs/`（Git 元数据目录），从设计上避免污染提交产物。

**Q：报告为什么不需要服务？**
报告是内嵌 CSS/JavaScript 的单个 HTML 文件，所有数据都来自对应 Run 的 JSONL 事件日志；它不加载任何外链资源。
