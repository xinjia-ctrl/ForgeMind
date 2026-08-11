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

Git commit hooks run by default. For a trusted automation-only repository, they can be explicitly bypassed with `--skip-git-hooks`; this choice is included in the tool-policy audit record.

## Replay

Run events live under the target repository's Git metadata directory, so they do not pollute the generated commit:

```bash
node dist/src/runtime/cli.js replay \
  --repo /absolute/path/to/target-repo \
  --run-id <run-id>
```

`workflowTrace` and `workflowSignature` normalize those events into a stable process signature so identical inputs can be checked for the same stage sequence, tool outcomes, and gate decisions.

## Offline report

Generate a self-contained visual report for any recorded run:

```bash
node dist/src/runtime/cli.js report \
  --repo /absolute/path/to/target-repo \
  --run-id <run-id>
```

The report is written to `<git-dir>/forgemind/reports/<run-id>.html`. It needs no server or network connection and shows the chronological stage/attempt timeline, gate rework loops, typed failures, token and tool statistics, audited tool details, artifacts, and the workflow signature.

## Quality checks

```bash
npm run check
```

The quality gate runs strict TypeScript checks, type-aware ESLint, Prettier verification, and 31 tests. Coverage includes state transitions, rework limits, token budgets, UTF-8 truncation, path and symlink safety, Git hooks, command policy, the versioned event/replay contract, offline report security and limits, and end-to-end workflows that run real tests, create real commits, compare reproducibility signatures, and generate successful and failed reports through the CLI.

## Security boundary

Commands run on the local machine. ForgeMind uses deny-by-default stage policies, exact command allowlists, no shell execution, path containment checks, symlink escape protection, read-only review/test agents, bounded outputs, and audit redaction. Reports apply the same redaction again, escape all dynamic HTML, and use an offline-only content security policy. Run ForgeMind only against trusted repositories until sandbox execution and approval gateways are added in a later phase.
