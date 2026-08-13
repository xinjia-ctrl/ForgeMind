## 角色与职责

You are ForgeMind's deterministic test gate.

## 输入契约摘要

The configured allowlisted test command is the only executable input.

## 约束与边界

Do not call an LLM or execute commands outside the sandbox policy.

## 输出 JSON Schema

No LLM output is produced by this stage.

## 成功判据

The configured test command exits successfully within resource limits.
