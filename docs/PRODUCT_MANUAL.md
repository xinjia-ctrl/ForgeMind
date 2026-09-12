# ForgeMind 使用手册

## 1. 环境

- Node.js 22+
- Git
- Docker 或 Podman（默认配置）
- 至少一个模型供应商 API Key

```bash
npm install
cp .env.example .env
```

默认配置：

```dotenv
DEEPSEEK_API_KEY=your-key
FORGEMIND_PROVIDER=deepseek
FORGEMIND_MODEL=deepseek-flash
```

密钥只由后端读取，不要提交 `.env`。

## 2. Web 使用

```bash
npm run web
```

页面只监听本机地址。选择一个已有初始 commit 且工作区干净的 Git 仓库，填写需求、模型和最大返工次数，然后启动。

## 3. CLI 使用

```bash
npm run build
node --env-file-if-exists=.env dist/src/runtime/cli.js run \
  --repo /path/to/repo \
  --requirement "增加输入校验并补充测试" \
  --provider deepseek \
  --model deepseek-flash \
  --yes
```

常用参数：

| 参数                     | 含义                   |
| ------------------------ | ---------------------- |
| `--repo`                 | 目标仓库路径           |
| `--requirement`          | 自然语言需求           |
| `--provider` / `--model` | 模型供应商与模型       |
| `--test-command`         | 显式测试命令           |
| `--max-rework`           | 最大返工次数，默认 6   |
| `--yes`                  | 自动批准需要批准的操作 |
| `--no-approve`           | 拒绝所有批准请求       |
| `--skip-git-hooks`       | 提交时跳过 Git hooks   |
| `--run-id ... --resume`  | 恢复指定运行           |
| `--config`               | 显式策略配置文件       |

## 4. 回放与报告

```bash
node dist/src/runtime/cli.js replay --repo /path/to/repo --run-id <id>
node dist/src/runtime/cli.js report --repo /path/to/repo --run-id <id>
```

运行日志、检查点和阶段产物位于仓库 Git metadata 的 `forgemind/runs/` 下，不进入业务 commit。报告为离线单文件 HTML。

## 5. 策略配置

仓库根目录可放置 `forgemind.config.json`：

```json
{
  "defaultMode": "deny",
  "rules": [
    {
      "match": { "stage": "COMMIT", "tool": "git_commit" },
      "mode": "approve",
      "risk": "high"
    }
  ],
  "sandbox": {
    "mode": "container",
    "runtime": "auto",
    "image": "node@sha256:<64-hex-digest>",
    "cpu": 1,
    "memoryMb": 512,
    "pidsLimit": 128,
    "network": false
  }
}
```

配置合并顺序为：内置默认 → 全局文件 → 环境 JSON → `--config` → 仓库配置。后加载规则优先，但不能绕过工具自身的路径和命令检查。

本地沙箱只适合可信演示，并要求 `defaultMode: "deny"`：

```json
{ "defaultMode": "deny", "sandbox": { "mode": "local" } }
```

## 6. 支持的供应商

- `deepseek`：`DEEPSEEK_API_KEY`
- `openai`：`OPENAI_API_KEY`
- `bigmodel`：`BIGMODEL_API_KEY` 或 `ZHIPU_API_KEY`
- `dashscope`：`DASHSCOPE_API_KEY`
- `moonshot`：`MOONSHOT_API_KEY`
- `custom`：`OPENAI_API_KEY` + `OPENAI_BASE_URL`

CLI 参数优先于环境默认。常用供应商的 API 地址由目录固定；只有 `custom` 接受任意地址。

## 7. 运行状态

- `SUCCEEDED`：TEST、REVIEW 和 COMMIT 全部成功。
- `FAILED`：阶段、门禁、策略或预算导致本次运行失败。
- `BLOCKED`：输入或配置存在致命问题，继续执行没有意义。

## 8. 常见问题

**为什么拒绝启动？** 仓库需要至少一个 commit、非 detached HEAD，并且工作区必须干净。

**为什么没有架构阶段？** 轻量任务会跳过 ARCH；公共 API、依赖、数据库或多文件复杂修改会启用。

**为什么测试命令被拒绝？** 命令必须由测试配置或 verifier 预注册，并以 argv 精确匹配。

**为什么无法恢复？** 必须位于原运行分支，且需求、模型、初始 HEAD、策略、提示词、测试和预算指纹不能漂移。

**会自动合并吗？** 不会。ForgeMind 只在独立运行分支创建 commit。
