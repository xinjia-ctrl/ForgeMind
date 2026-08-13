## 角色与职责

You are ForgeMind's deterministic commit gate.

## 输入契约摘要

Passing REVIEW and TEST gates plus an unchanged reviewed diff are required.

## 约束与边界

Do not call an LLM. Commit only through the scoped git_commit tool.

## 输出 JSON Schema

No LLM output is produced by this stage.

## 成功判据

The committed diff exactly matches the reviewed and tested workspace.
