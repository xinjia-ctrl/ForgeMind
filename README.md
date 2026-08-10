# ForgeMind

ForgeMind is a TypeScript/Node multi-agent coding workflow. One natural-language requirement moves through a deterministic orchestration pipeline:

```text
PLAN → ARCH → CODE ⇄ REVIEW ⇄ TEST → COMMIT
```

The Orchestrator is the only decision-maker. Agents never call one another: they exchange immutable `TaskContext` decisions and bounded workspace artifacts. Review and test are mandatory gates, every interaction is written to a versioned JSONL event log, and every run is isolated on a new `forgemind/<run-id>` branch.

## Requirements

- Node.js 22 or newer
- Git
- An OpenAI-compatible chat-completions endpoint
- A clean target Git repository with an existing commit and Git author configured

## Setup

```bash
npm install
npm run build
```

## Run

```bash
export OPENAI_API_KEY="..."
export FORGEMIND_MODEL="gpt-4.1-mini"

node dist/src/runtime/cli.js run \
  --repo /absolute/path/to/target-repo \
  --requirement "Add a health-check endpoint with tests"
```

The target repository must be clean. ForgeMind creates a new branch and never performs a merge. In particular, it never merges `test` into a development branch. Failed runs retain their branch and changes for audit and recovery.

The test command is auto-detected from `package.json`; it can be set explicitly to an allowlisted, shell-free test invocation:

```bash
node dist/src/runtime/cli.js run \
  --repo /absolute/path/to/target-repo \
  --requirement "..." \
  --test-command "npm run test"
```

## Replay

Run events live under the target repository's Git metadata directory, so they do not pollute the generated commit:

```bash
node dist/src/runtime/cli.js replay \
  --repo /absolute/path/to/target-repo \
  --run-id <run-id>
```

## Quality checks

```bash
npm run typecheck
npm test
```

The test suite covers state transitions and rework limits, token budgets, path and symlink safety, command policy, the versioned event/replay contract, and an end-to-end workflow that runs a real `node --test` command and creates a real Git commit using a deterministic fake LLM.

## Security boundary

MVP commands run on the local machine. ForgeMind uses deny-by-default stage policies, exact command allowlists, no shell execution, path containment checks, symlink escape protection, read-only review/test agents, bounded outputs, and audit redaction. Run it only against trusted repositories until sandbox execution and approval gateways are added in a later phase.
