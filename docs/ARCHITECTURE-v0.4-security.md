# ForgeMind 架构设计文档（ADR）— Phase 3 生产级安全与沙箱（v0.4）

> 迭代：v0.4（第四轮，Phase 3 生产级安全与沙箱）
> 前置：v0.3 已实现（MVP 闭环 + 可观测性报告，31/31 测试通过）
> 状态：已实现（45/45 测试通过，对齐 `docs/PRD-v0.4-security.md`）
> 技术栈：TypeScript / Node，零运行时第三方依赖（沙箱运行时除外，见 §5）

---

## 1. 范围与设计原则

本轮目标：把"仅限受信任仓库的演示工具"升级为"可在真实项目上安全运行的生产级工具"。

沿用既有原则，追加本轮专属约束：

> **ADR-6（本轮核心）：安全是三层纵深，不是单点开关。**
>
> 1. **动作级三态策略**（allow / approve / deny）——第一道闸门，默认 deny；
> 2. **审批网关**（approve 时的决策点）——人机决策，决策进审计；
> 3. **沙箱执行**（实际代码运行）——第二道防线，隔离宿主机。
>
> 任何一层缺失都必须**显式配置确认**，不得静默降级（安全边界后退即 fail-fast）。

**兼容原则**：本轮不改 Orchestrator 核心状态机、不改 Agent 契约、不改 TaskContext。所有改动收敛在 `tools/`（执行链）、新增 `policy/` 与 `sandbox/` 模块、以及事件 Schema 的向后兼容演进。v0.2/v0.3 的 31 个测试必须全部保持通过（PRD DoD）。

---

## 2. 架构总览（增量视角）

```
ScopedToolExecutor.execute(name, args)          [src/tools/executor.ts 改造]
  │
  ├─ 1. ToolPolicy.allowedTools                 阶段级白名单（既有，粗粒度）
  ├─ 2. PolicyResolver.resolve(action)          [新增 src/policy/resolver.ts] 动作级三态
  │     ├─ deny    → ToolResult{ok:false} + approval.rejected 事件
  │     ├─ allow   → 执行
  │     └─ approve → ApprovalGateway.request()   [新增 src/policy/gateway.ts]
  │                    ├─ APPROVED → 执行 + approval.approved 事件
  │                    └─ DENIED   → ToolResult{ok:false} + approval.rejected 事件
  ├─ 3. 执行：RunCommandTool → ProcessRunner     [新增 src/sandbox/]
  │            ├─ SandboxProcessRunner（Docker，主方案）
  │            └─ LocalProcessRunner（既有 runProcess，仅显式配置允许时降级）
  └─ 4. 所有决策/执行 → EventLog（新增 approval.* 事件）
                              └→ report 安全事件面板（S4，复用 v0.3 投影管线）
```

**三层职责不重叠**：`ToolPolicy` = 阶段级静态白名单（"REVIEW 阶段只有 git 只读工具"）；`PolicyResolver` = 动作级动态策略（"run_command 需要审批"）；`Sandbox` = 运行隔离（"命令在容器里跑"）。

---

## 3. 模块边界（新增/改动）

```
src/
├── config/
│   ├── budgets.ts           # 既有
│   └── policy.ts            # 新增：策略配置加载/校验/三层合并（全局→项目→仓库）
├── policy/                  # 新增：三态判定 + 审批网关
│   ├── resolver.ts          # ActionRequest → PolicyDecision（最具体规则优先）
│   ├── gateway.ts           # ApprovalGateway 接口（APPROVED | DENIED）
│   ├── interactive-gateway.ts  # CLI y/n（P1-7）
│   └── auto-gateway.ts      # --yes 自动批准白名单（P1-7）
├── sandbox/                 # 新增：沙箱执行
│   ├── types.ts             # SandboxConfig / ProcessRunner 接口
│   ├── docker.ts            # Docker/Podman 实现（主方案）
│   ├── local.ts             # 显式受信任环境的本机 Runner
│   └── detect.ts            # 运行时检测 + 降级判定（默认 deny 降级）
├── tools/
│   ├── process.ts           # 无 shell 的宿主进程原语（超时 + 共享输出上限）
│   └── executor.ts          # 改造：执行前插入 PolicyResolver + ApprovalGateway
├── report/
│   ├── view-model.ts        # 扩展 security 面板聚合
│   └── render-html.ts       # 渲染安全事件（复用 auditValue + escapeHtml）
└── runtime/cli.ts           # 新增 --config / --yes / --no-approve 选项
```

---

## 4. 核心设计：策略配置化（S1）

### 4.1 三层配置合并（`src/config/policy.ts`）

优先级：**仓库级 > 项目级 > 全局级**（仓库内的 `forgemind.config.json` 优先）。

```ts
interface ForgeMindPolicyConfig {
  readonly defaultMode: "allow" | "approve" | "deny"; // 默认 deny
  readonly rules: readonly PolicyRule[];
  readonly sandbox: SandboxConfig;
}

interface PolicyRule {
  readonly match: { stage?: StageId; tool: string; command?: readonly string[] };
  readonly mode: "allow" | "approve" | "deny";
}
```

判定：`resolve(action)` 遍历规则，命中取**最具体规则**（command 精确匹配 > tool 匹配 > defaultMode）。

### 4.2 与既有 `ToolPolicy` 的分工（关键决策）

- 既有 `ToolPolicy`（`agent-factory.ts` 的 `policyFor()`）**保持不变**，作为阶段级第一道粗粒度闸门（REVIEW/TEST 只读、CODE 禁写 `docs/.forgemind`）。
- 新增动作级 `PolicyResolver` 作为第二道闸门，负责"风险高低"判定。
- 无需重写既有安全逻辑：新增能力是**叠加**而非替换，31 个既有测试不受影响。

### 4.3 默认策略建议（最小惊扰，PRD §8-2）

| 动作                                            | 默认模式 | 理由                            |
| ----------------------------------------------- | -------- | ------------------------------- |
| read_file / grep / glob / git_status / git_diff | allow    | 只读，无风险                    |
| write_file / edit_file（CODE 阶段）             | allow    | 已在阶段白名单 + 路径策略约束内 |
| run_command（TEST 阶段测试命令）                | allow    | 精确白名单 + 沙箱隔离双保险     |
| run_command（其他）                             | approve  | 任意命令执行风险                |
| git_commit                                      | approve  | 变更仓库状态，PRD 明示高风险    |

---

## 5. 核心设计：审批网关（S2）

### 5.1 接口

```ts
type ApprovalDecision = "APPROVED" | "DENIED";

interface ApprovalGateway {
  request(action: ActionRequest): Promise<ApprovalDecision>;
}
```

实现：

- `InteractiveApprovalGateway`：终端 `y/n`（已实现）。
- `AutoApprovalGateway`：`--yes` 模式对已命中 `approve` 规则的动作批准（已实现）。
- `DenyApprovalGateway`：`--no-approve` 或无 TTY 时拒绝（已实现）。
- 未来可扩展远程审批（本轮非目标）。

### 5.2 事件演进（v1 增量扩展，向后兼容）

`EventDataMap` 新增三个类型，golden 快照同步；历史日志不含新类型，`parseEvent` 无需破坏性变更：

| type                 | data                                     | 说明                              |
| -------------------- | ---------------------------------------- | --------------------------------- |
| `approval.requested` | runId, stage, tool, action(脱敏), policy | 记录"何时要求审批"                |
| `approval.approved`  | runId, stage, tool, decisionSource       | 谁批的（interactive/auto/config） |
| `approval.rejected`  | runId, stage, tool, reason               | 谁拒的 / 为何拒                   |

脱敏：`action` 一律经 `auditValue`（复用 `src/tools/audit.ts`）。

### 5.3 审批与审计的闭环

拒绝 → `ToolResult{ok:false}` → Agent 走既有 `StageFailure` 路径（FAILED）；Run 失败定位到阶段。所有决策（requested/approved/rejected）进入 EventLog，构成完整审计链。**审批不再产生新的"事实源"**——决策就是事件。

---

## 6. 核心设计：沙箱执行（S3）

### 6.1 `ProcessRunner` 抽象

```ts
interface ProcessRunner {
  run(
    invocation: { command: string; args: readonly string[] },
    opts: {
      cwd: string;
      timeoutMs: number;
      maxBytes: number;
    },
  ): Promise<ProcessResult>;
}
```

- `LocalProcessRunner`：封装现有 `runProcess`——**仅显式配置 `sandbox.mode=local` 且默认 deny 时可用**，作为无容器环境的降级路径；启动时打印警示，执行证据写入审计。
- `ContainerProcessRunner`：容器内执行，主方案。

`RunCommandTool` 改为通过注入的 `ProcessRunner` 执行，不再直接调 `runProcess`（`src/tools/command-tools.ts` 改造，接口不变）。

### 6.2 沙箱语义（PRD §8-3：避免语义漂移）

```
docker run --rm
  --cpus <cpu> --memory <memory> --network=none
  --mount type=bind,src=<workspace>,dst=/source,readonly
  --tmpfs /workspace:rw,nosuid,nodev,size=<memory>
  --read-only --cap-drop ALL --security-opt no-new-privileges
  <image@sha256:digest> /bin/sh -c '<固定复制脚本>' -- <command> <args>
```

关键设计决策：

1. **唯一暴露路径 = `/source` 只读挂载**；容器内访问不到宿主其他文件系统、网络、进程。
2. 固定入口脚本把 `/source` 复制到 `/workspace` tmpfs 后再通过 `"$@"` 执行 argv；脚本不插值模型或用户内容。测试副产物（覆盖率、缓存、构建输出）留在可写层并在容器结束时销毁，**不回传宿主**。
3. **命令白名单仍生效**：沙箱 ≠ 任意执行；TEST 阶段只允许白名单测试命令在沙箱内跑。

### 6.3 资源上限（P1-6）

| 维度 | 实现                                                  |
| ---- | ----------------------------------------------------- |
| CPU  | `--cpus`                                              |
| 内存 | `--memory`                                            |
| 网络 | `--network=none`（默认）                              |
| 超时 | 既有 `commandTimeoutMs`；超时必失败并强制清理命名容器 |
| 输出 | 既有 `maxBytes`（字节截断）                           |

超限即失败（容器被 OOM/超时杀掉 → 非零退出），不拖垮宿主。

### 6.4 运行时检测与降级（PRD §8-1）

- 启动时 `detect()` 检测 `docker` / `podman` 可用性。
- 无容器运行时：**默认拒绝沙箱执行并报错退出**（给出安装指引与 `sandbox.mode=local` 显式降级开关），绝不停用沙箱直接跑本机。

### 6.5 可复现性约束（PRD §8-4）

- 沙箱镜像强制使用 **sha256 digest**；只给 tag 会在启动时 `HardFailure`。
- 容器内固定挂载路径（`/workspace`），避免路径差异破坏 `workflowSignature`。

---

## 7. 审计可视化（S4）

`report` 复用 v0.3 纯函数管线，`view-model.ts` 新增：

```ts
interface ReportSecurityEvent {
  readonly seq: number;
  readonly ts: string;
  readonly stage: StageId | null;
  readonly action: string; // tool + 概要
  readonly mode: "allow" | "approve" | "deny";
  readonly decision: "ALLOWED" | "REQUESTED" | "APPROVED" | "DENIED";
  readonly reason?: string;
}
```

来源：`approval.*` 事件 + `tool.called.policy` 聚合；渲染层复用 `auditValue` + `escapeHtml`（不得泄露原始参数）。

---

## 8. 错误分类补充

| 场景           | 处理                                                             |
| -------------- | ---------------------------------------------------------------- |
| 审批拒绝       | `ToolResult{ok:false}` → `StageFailure` → FAILED，Run 可定位     |
| 策略配置非法   | 启动时 `HardFailure`（fail-fast，不静默用默认）                  |
| 沙箱运行时缺失 | 启动时 `HardFailure`（默认），或显式 `sandbox.mode=local`        |
| 沙箱资源超限   | 非零退出 + `tool.called` truncated 标记 → 既有 TEST 门禁失败路径 |

---

## 9. 测试策略

| 里程碑        | 测试落点                                                          | 形态                                                      |
| ------------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| S1 策略配置化 | 三层合并优先级、规则匹配（具体性）、默认 deny、配置非法 fail-fast | 单元测试（纯函数）                                        |
| S2 审批网关   | requested/approved/rejected 三条路径、拒绝→FAILED、事件落盘       | 单元 + e2e（FakeChatProvider + 注入 FakeApprovalGateway） |
| S3 沙箱执行   | 沙箱调用参数（挂载/资源 flag）、无 Docker 时默认拒绝、资源超限    | 集成测试（对容器层打桩）+ e2e                             |
| S4 审计可视化 | 安全面板聚合正确性、脱敏二次生效                                  | 单元测试（复用 report-render/report-view-model 模式）     |

验收结果：`npm run check` 通过，原 31 项与新增 14 项共 45/45 通过。

---

## 10. 风险与决策记录

| #   | 问题                                              | 严重度 | 处置                                                                          |
| --- | ------------------------------------------------- | ------ | ----------------------------------------------------------------------------- |
| 1   | 沙箱与宿主文件系统语义（只读挂载 + 可写层不回传） | 高     | §6.2 显式设计；产品文档明确"测试副产物不回传"                                 |
| 2   | 无容器环境产品不可用                              | 高     | §6.4 检测 + 默认拒绝 + 显式降级（默认 deny）                                  |
| 3   | 审批拖慢演示体验                                  | 中     | §4.3 默认策略"最小惊扰"，仅高风险 approve                                     |
| 4   | 沙箱环境差异破坏可复现性                          | 中     | §6.5 固定镜像 digest + 固定挂载路径                                           |
| 5   | 审批绕过风险（--yes 滥用）                        | 中     | `--yes` 仅对配置白名单生效，且 `approval.approved.decisionSource=auto` 入审计 |
| 6   | 事件 Schema 演进破坏旧日志                        | 低     | v1 信封仅新增 approval.* 类型，parseEvent 兼容既有 v1 日志                    |

## 11. 里程碑映射（PRD §9）

| 里程碑 | 架构动作                                                  |
| ------ | --------------------------------------------------------- |
| S1     | ✅ `src/config/policy.ts` + `src/policy/resolver.ts`      |
| S2     | ✅ `src/policy/gateway.ts` 系列 + 审批链 + `approval.*`   |
| S3     | ✅ `src/sandbox/` + `RunCommandTool` 注入 `ProcessRunner` |
| S4     | ✅ 报告安全事件投影与渲染                                 |

## 12. 与既有架构的衔接

- **不触碰**：Orchestrator 状态机、Agent 契约、TaskContext、reproducibility。
- **叠加**：策略/审批/沙箱均为执行链新层；report 为投影新面板。
- **演进**：Phase 4（长期记忆）与本轮正交；Phase 3 后半段（实时交互审批、远程审批）为 `ApprovalGateway` 的新实现，不改接口。
