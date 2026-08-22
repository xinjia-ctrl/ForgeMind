# ForgeMind

ForgeMind is a TypeScript/Node multi-agent coding workflow. One natural-language requirement moves through a deterministic orchestration pipeline:

Current package release: `3.0.0` (publishable; runtime files are limited to `dist/src`).

```text
PLAN → ARCH → CODE ⇄ REVIEW ⇄ TEST → COMMIT
```

The Orchestrator is the only decision-maker. Agents never call one another: they exchange immutable `TaskContext` decisions and bounded workspace artifacts. Review and test are mandatory gates, every interaction is written to a versioned JSONL event log, and every run is isolated on a new `forgemind/<run-id>` branch.

## Requirements

- Node.js 22 or newer
- Git
- Docker or Podman for the default command sandbox
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
  --requirement "Add a health-check endpoint with tests" \
  --config /absolute/path/to/forgemind.config.json
```

The target repository must be clean. ForgeMind creates a new branch and never performs a merge. In particular, it never merges `test` into a development branch. Failed runs retain their branch and changes for audit and recovery.

For a requirement spanning multiple repositories, use the DAG runner:

```bash
node dist/src/runtime/cli.js dag run \
  --repos /absolute/path/to/service,/absolute/path/to/web \
  --requirement "Add a feature across the service and web client" \
  --max-concurrency 4 \
  --yes
```

The planning agent binds each DAG task to an allowlisted repository. Every task runs in a separate Git linked worktree, branch, sandbox, test gate, and child EventLog. Source repositories are not switched or modified. Worktrees are retained for audit; their default root is the operating system temporary directory and can be made durable with `--worktrees-root <path>`. Before dependent tasks start, conflicting meanings for the same cross-task artifact path trigger bounded negotiation; resolved `DecisionRecord`s are returned with the DAG result and written to L3 project memory when memory is enabled. A PR-candidate JSON artifact is produced only when all tasks succeed. ForgeMind never merges those branches.

## Enterprise RBAC and audit export

RBAC is opt-in for backward compatibility and deny-by-default once an actor is supplied. A strict actor policy maps identities to roles and repository/team scopes:

```json
{
  "actors": [
    {
      "id": "alice",
      "role": "approver",
      "repos": ["/absolute/path/to/target-repo"],
      "teams": ["platform"]
    }
  ]
}
```

Pass `--actor-policy /path/to/actors.json --actor alice` to `run` or `dag run`. ForgeMind checks Run permission before creating a branch or worktree. Approval policy rules may declare `risk` as `low`, `medium`, or `high`; medium risk requires a developer and high risk requires an approver. Actor, role, and risk are recorded on approval events and reports.

Export a bounded, read-only audit projection from EventLog JSONL files:

```bash
node dist/src/runtime/cli.js audit export \
  --repo /absolute/path/to/target-repo \
  --from 2026-08-01T00:00:00Z \
  --to 2026-08-13T23:59:59Z \
  --actor-policy /path/to/actors.json \
  --actor alice \
  --format csv
```

Audit queries require an explicit window of at most 31 days and support `--filter-actor`, `--filter-repo`, and `--status`. Exports are written under the repository's Git metadata in `forgemind/audit/`; JSON and formula-injection-safe CSV are generated from the same projection.

The test command is auto-detected from `package.json`; it can be set explicitly to an allowlisted, shell-free test invocation:

```bash
node dist/src/runtime/cli.js run \
  --repo /absolute/path/to/target-repo \
  --requirement "..." \
  --test-command "npm run test"
```

Git commit hooks run by default. For a trusted automation-only repository, they can be explicitly bypassed with `--skip-git-hooks`; this choice is included in the tool-policy audit record.

The production default is fail-fast: command execution requires Docker or Podman and a digest-pinned image. A minimal policy file is:

```json
{
  "defaultMode": "deny",
  "sandbox": {
    "mode": "container",
    "runtime": "auto",
    "image": "your-test-image@sha256:<64-hex-digest>",
    "cpu": 1,
    "memoryMb": 512,
    "pidsLimit": 128,
    "network": false
  }
}
```

Rules support `allow`, `approve`, and `deny`. Interactive terminals ask before `approve` actions; `--yes` records automatic approval and `--no-approve` rejects them. `sandbox.mode=local` is an explicit trusted-environment fallback and is accepted only with `defaultMode=deny`.

## Replay

Run events live under the target repository's Git metadata directory, so they do not pollute the generated commit:

```bash
node dist/src/runtime/cli.js replay \
  --repo /absolute/path/to/target-repo \
  --run-id <run-id>
```

`workflowTrace` and `workflowSignature` normalize those events into a stable process signature so identical inputs can be checked for the same stage sequence, tool outcomes, and gate decisions.

## Optional project memory

Memory is disabled by default. Enable deterministic L2 episodic retrieval, L3 project memory, and L4 semantic recall explicitly:

```bash
node dist/src/runtime/cli.js run \
  --repo /absolute/path/to/target-repo \
  --requirement "Add a health-check endpoint with tests" \
  --memory \
  --config /absolute/path/to/forgemind.config.json
```

Historical run outcomes are retrieved from the JSONL EventLog, while architecture decisions, rejected-gate lessons, and deterministic run-quality assessments are stored under `.forgemind/memory/`. L4 semantic recall reads those project documents with a zero-dependency lexical-vector + BM25 scorer (`LexicalEmbeddingProvider`) or an injected `EmbeddingProvider`. Project memory is generated by deterministic rules, injected read-only into PLAN and ARCH, and excluded locally from Git commits. Recall and storage decisions remain visible in the event log and report.

For an OpenAI-compatible external vector endpoint, inject `OpenAICompatibleEmbeddingProvider` with an explicit model and dimension. Responses are rejected unless they contain exactly that many finite vector values.

## Persistent active-layer state

Production `AgenticWatchService` instances can use `FileAgenticStateStore` to atomically checkpoint polling cursors, event TTL dedupe, object cooldowns, deferred work, sliding-window rate state, daily quota counts, and failed dispatch retries. Keep the file in service data or `<git-dir>/forgemind/agentic/`, outside the tracked worktree. State is restored lazily before accepting or polling events; call `await watch.restore()` when cursor inspection is needed before the first poll. Dispatch requests retain their stable `ruleId:eventId` idempotency key across recovery.

## GitHub, Jira, and CI integration

The active layer includes production-facing adapters rather than vendor payloads leaking into the workflow:

- `GitHubWebhookReceiver`, `JiraWebhookReceiver`, and `CiWebhookReceiver` verify SHA-256 HMAC signatures over the untouched request bytes before parsing JSON. `handleNodeWebhook` mounts any receiver on a Node HTTP server with bounded request bodies.
- `GitHubWorkflowRunPoller`, `JiraIssuePoller`, and `CiEventPoller` provide cursor-based fallback ingestion. Watch cursors advance only after every event in the batch is handled.
- `ForgeMindAgenticRunDispatcher` persists an idempotency record before execution and routes one target to `runForgeMind` or multiple targets to `runDagForgeMind`. A known failure gets a new attempt id; an ambiguous crash record remains fail-closed for reconciliation.
- `AgenticFeedbackCoordinator` pushes generated branches, creates or reuses GitHub pull requests, and idempotently writes GitHub Issue/PR, Jira Issue, or generic CI feedback. It never merges a branch and explicitly rejects `test` as a PR source.

Store the watch checkpoint and `FileAgenticDispatchStore` directory outside the worktree. Configure the GitHub/Jira tokens, webhook secrets, repository-to-local-path resolver, and base branches through the hosting service; secrets are never part of `AgenticRunRequest` or EventLog data.

## Offline report

Generate a self-contained visual report for any recorded run:

```bash
node dist/src/runtime/cli.js report \
  --repo /absolute/path/to/target-repo \
  --run-id <run-id>
```

The report is written to `<git-dir>/forgemind/reports/<run-id>.html`. It needs no server or network connection and shows the chronological stage/attempt timeline, gate rework loops, typed failures, deterministic quality score and recommendations, token and tool statistics, audited tool details, artifacts, policy/approval security events, memory use, prompt versions, injected-context sources, and the workflow signature. Test commands may emit `FORGEMIND_COVERAGE=<0-100>` as explicit code-coverage evidence; otherwise coverage is reported as unavailable.

## Quality checks

```bash
npm run check
```

The quality gate runs strict TypeScript checks, type-aware ESLint, Prettier verification, and the complete test suite. Coverage includes orchestration, policy and approval, container isolation, layered memory, structured-output fallback, prompt resources, context ranking, concurrent event logging, workspace search, report panels, and a two-run memory E2E.

Release environments can run the real dependency smoke gate:

```bash
FORGEMIND_SMOKE_CONTAINER_IMAGE='node@sha256:<64-hex-digest>' \
FORGEMIND_SMOKE_CONTAINER_RUNTIME=auto \
OPENAI_API_KEY='...' \
FORGEMIND_SMOKE_MODEL='...' \
FORGEMIND_SMOKE_EMBEDDING_MODEL='...' \
FORGEMIND_SMOKE_EMBEDDING_DIMENSION=1536 \
npm run test:smoke:release
```

`OPENAI_BASE_URL` selects an OpenAI-compatible endpoint. The normal `test:smoke` command skips unavailable external dependencies; `test:smoke:release` fails when any real container, chat model, or vector prerequisite is missing. The persisted-dispatch recovery smoke always runs.

Prompt changes also have an explicit deterministic evaluation gate:

```bash
npm run eval
```

It compares the legacy and current prompt sets across four representative scenarios for pass rate, rework rounds, unauthorized tool calls, and estimated prompt tokens.

## Security boundary

Test commands run in a no-network, capability-dropped, resource-bounded container over a read-only source mount and an isolated writable layer. Action policy and approval precede execution; all decisions and sandbox evidence enter the EventLog. Exact command allowlists, path containment, symlink protection, bounded output, audit redaction, report re-redaction, HTML escaping, and an offline CSP remain in force.
