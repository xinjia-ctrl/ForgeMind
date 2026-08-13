# ForgeMind 产品使用手册

> 版本：v0.5（对齐已实现代码）
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
| 运行环境 | 目标仓库必须干净；测试命令默认在 Docker/Podman 容器沙箱执行               |
| 模型     | 任意 OpenAI 兼容 Chat Completions 接口（`gpt-4.1-mini` 默认）             |
| 测试执行 | 真实运行测试命令（自动探测 package test，回退 `node --test`，可显式指定） |
| 长期记忆 | 默认关闭；`--memory` 显式启用项目内 L2 情景记忆与 L3 项目记忆             |
| 可视化   | 任意历史 Run 可生成离线单文件 HTML 报告                                   |

## 3. 使用前置条件

1. Node.js ≥ 22，Git 已安装；默认安全模式需 Docker 或 Podman
2. 目标仓库：**干净的工作区** + **已有至少一个 commit** + **已配置 Git 作者**
3. 环境变量：`OPENAI_API_KEY`（可自定义 `OPENAI_BASE_URL` 指向兼容服务）
4. 策略配置包含使用 sha256 digest 固定的测试镜像

## 4. 快速开始

```bash
npm install
npm run build

export OPENAI_API_KEY="sk-..."
export FORGEMIND_MODEL="gpt-4.1-mini"

# 在一个干净的仓库目录中：
node dist/src/runtime/cli.js run \
  --repo /abs/path/to/target-repo \
  --requirement "添加一个健康检查接口，并附上测试" \
  --config /abs/path/to/forgemind.config.json
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
| `--config`         | 项目策略配置文件                      | 无；仍会读取全局/环境/仓库级配置     |
| `--yes`            | 自动批准命中 `approve` 的动作         | false                                |
| `--no-approve`     | 拒绝所有需审批动作                    | 非交互环境默认采用                   |
| `--memory`         | 启用历史 Run 召回和项目记忆读写       | false                                |
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
- 安全审计面板：策略模式、审批请求/批准/拒绝、决策来源、时间和脱敏动作。
- 记忆面板：召回/存储的层、来源、命中依据、分数与是否使用。
- 提示词版本面板：每个 LLM 阶段实际使用的资源版本及结构化输出状态。
- 上下文审计面板：注入 section 的来源、引用文件和估算 token 分布。

## 7. 产物与可观测性

- **工作区产物**：`docs/.forgemind/<run-id>/plan.md`、`architecture.md`
- **可选项目记忆**：`.forgemind/memory/decisions.json`、`lessons.json`（仅 `--memory`；加入目标仓库的 Git 本地 exclude，不进入生成 commit）
- **事件日志**：`.git/forgemind/runs/<run-id>.jsonl`（不进入 commit，不污染产出）
- **可视化报告**：`.git/forgemind/reports/<run-id>.html`（日志的只读投影，不是第二份事实源）
- **事件类型**：除运行、阶段、LLM、工具、产物和门禁事件外，包含 `approval.*`、`memory.recalled / memory.stored` 与 `context.assembled`
- **门禁判定**：REVIEW 以 diff 指纹（sha256）锚定，防止"审查后工作区又变了"；COMMIT 前强制复核 diff 指纹一致。
- **流程签名**：`workflowSignature` 忽略时间戳、runId、commit sha 等非确定数据，对事件顺序、阶段、工具结果和门禁结果生成稳定 sha256。

## 8. 安全策略与沙箱

`run_command` 默认通过 Docker/Podman 沙箱执行。执行前依次经过阶段工具白名单、动作级三态策略和审批网关：

- 策略模式：`allow` 自动放行、`approve` 需审批、`deny` 禁止；未命中规则默认拒绝
- 配置顺序：内置安全默认 → `FORGEMIND_GLOBAL_CONFIG` → `FORGEMIND_POLICY_JSON` → `--config` → 仓库 `forgemind.config.json`，后层同具体度规则优先
- 容器隔离：宿主工作区只读挂载到 `/source`，复制至 `/workspace` tmpfs 后测试；副产物不回传宿主
- 资源限制：网络默认关闭，限制 CPU、内存、PID、超时和输出；丢弃 Linux capabilities，禁止提权
- 镜像必须使用 `image@sha256:<digest>` 固定；无容器运行时或镜像未固定会在启动时失败
- 命令白名单：只能运行 `npm/pnpm/yarn/bun/node` 的测试类命令，无 shell，禁路径穿越
- 工具按阶段白名单：REVIEW/TEST 只读，CODE 可写但禁写 `docs/.forgemind` 与 `.git`
- 路径安全：目录穿越、symlink 逃逸、Git 元数据访问均被拒绝
- 审计脱敏：事件日志对密钥/内容类字段脱敏、超长截断
- 报告安全：工具参数/结果二次脱敏，所有动态内容 HTML 转义，CSP 禁止外部资源与联网
- Git hooks 默认执行；仅显式 `--skip-git-hooks` 时跳过，并在 ToolPolicy 审计描述中记录

显式设置 `sandbox.mode=local` 可用于受信任环境的兼容测试，但必须同时使用 `defaultMode=deny`；本机进程仍会在事件中标记为 `local/host`，不会伪装成沙箱。

最小配置示例：

```json
{
  "defaultMode": "deny",
  "rules": [
    {
      "match": { "stage": "COMMIT", "tool": "git_commit" },
      "mode": "approve"
    }
  ],
  "sandbox": {
    "mode": "container",
    "runtime": "auto",
    "image": "your-image@sha256:<64位十六进制摘要>",
    "cpu": 1,
    "memoryMb": 512,
    "pidsLimit": 128,
    "network": false
  }
}
```

## 9. 已知限制与失败场景

| 场景                              | 行为                                                         |
| --------------------------------- | ------------------------------------------------------------ |
| 目标仓库有未提交变更              | 拒绝执行（HardFailure）                                      |
| 无 LLM API Key                    | 拒绝执行                                                     |
| LLM 返回非 JSON / 缺字段          | 阶段失败，Run 失败                                           |
| REVIEW diff 超限截断              | 直接驳回并提示缩小变更                                       |
| TEST 超时（默认 5 分钟）/输出超限 | 视为测试失败                                                 |
| 返工超限                          | FAILED，保留现场                                             |
| 无效 run-id / 重复 run-id         | 拒绝（FatalFailure）                                         |
| Git commit hook 失败              | FAILED，保留分支供处理                                       |
| 策略配置非法 / 镜像未固定         | 启动时 HardFailure                                           |
| Docker/Podman 不可用              | 默认拒绝并给出降级指引                                       |
| 审批拒绝 / 非交互环境未显式批准   | 动作不执行，Run FAILED                                       |
| 容器 OOM / 超时 / 非零退出        | TEST 门禁失败并保留审计                                      |
| 项目记忆 JSON 损坏                | HardFailure，保留原文件且不覆盖                              |
| 模型不支持 JSON Schema            | 关闭能力位；本次有内容则按旧 JSON 解析，否则阶段失败；不重试 |

## 10. 常见问题

**Q：测试命令怎么被确定的？**
自动读取仓库 `package.json` 的 `scripts.test`；非 Node 仓库可用 `--test-command "node --test"` 显式指定。

**Q：为什么我的仓库必须有已提交内容？**
`prepareGitWorkspace` 要求工作区干净，且不支持 detached HEAD。

**Q：产物为什么不进 commit？**
运行事件写入 `.git/forgemind/runs/`（Git 元数据目录），从设计上避免污染提交产物。

**Q：报告为什么不需要服务？**
报告是内嵌 CSS/JavaScript 的单个 HTML 文件，所有数据都来自对应 Run 的 JSONL 事件日志；它不加载任何外链资源。

**Q：CI 中如何处理审批？**
在策略中保持危险动作是 `approve`，再显式传 `--yes`；事件会记录 `decisionSource=auto`。若希望 CI 验证必须拒绝审批，传 `--no-approve`。

**Q：项目记忆会污染 commit 吗？**
不会。只有显式传 `--memory` 才会写入 `.forgemind/memory/`，运行入口同时把该目录加入目标仓库的 Git 本地 exclude。记忆可查看、删除，但不会被 `git add --all` 纳入 ForgeMind 生成的 commit。

**Q：如何评估提示词改动？**
运行 `npm run eval`。它用确定性 FakeProvider 对 4 条代表性需求比较旧版与当前提示词的通过率、返工轮次、越权工具调用和估算 token 成本。
