# ForgeMind Current Product Scope

> Version: 3.0 code line
> Status: implemented and exercised as a local reference system; deployment readiness is not claimed.

## 1. Problem

Coding models can produce plausible changes without proving that the requested behavior works, that review inspected the same code tested, or that a retry did not duplicate a partially completed action.

ForgeMind addresses this problem with a bounded workflow whose completion decision depends on external evidence rather than a model's self-declaration.

## 2. Intended users

| User                  | Primary use                                                                     |
| --------------------- | ------------------------------------------------------------------------------- |
| AI/agent engineers    | Study deterministic orchestration, tool governance, recovery, and evaluation    |
| Individual developers | Run a controlled requirement-to-commit workflow on a trusted local repository   |
| Platform engineers    | Reuse the policy, audit, DAG, and external-adapter boundaries in a host service |

The repository is also suitable as an engineering portfolio and architecture case study. That is a presentation use case, not a product capability.

## 3. Product contract

Given a clean Git repository, a requirement, a model provider, a registered test command, and an execution policy, a successful single-repository run must:

1. create an isolated branch;
2. produce a structured plan with observable acceptance criteria;
3. optionally create an architecture decision when deterministic complexity signals require it;
4. allow CODE to inspect and modify only through registered, policy-checked tools;
5. execute every TEST-assigned verifier and collect criterion-level evidence;
6. run an independent read-only REVIEW over the tested artifact;
7. verify that TEST, REVIEW, and the current workspace share the same fingerprint;
8. create a Git commit only after all required evidence passes;
9. record enough state to explain, replay, report, and safely resume the run.

Failure must leave the generated branch and evidence available for inspection. ForgeMind never merges a branch automatically.

## 4. Core scope

### Required path

- Deterministic profile selection and stage orchestration.
- Immutable task context and versioned PLAN/ARCH artifacts.
- Bounded CODE observe/action/evidence loop with step, action, token, tool, duration, and rework budgets.
- TEST and REVIEW gates with registered verifier contracts and artifact fingerprints.
- Phase checkpoints, runtime manifest validation, cancellation, and action-journal recovery.
- Git branch isolation, exact tool/command policy, approval events, and JSONL audit log.
- Replay and self-contained offline HTML report.

### Optional extensions

- Multi-repository DAG planning and concurrent worktree execution.
- Actor policy, RBAC, and bounded audit export.
- Governed project memory and semantic retrieval index.
- GitHub, Jira, and CI webhook/poller/feedback adapters.
- One-shot conflict resolution and explicitly enabled bounded multi-round negotiation.
- Loopback-only local Web workspace.

Optional extensions must reuse the same core run, policy, evidence, and event contracts. They must not introduce a second execution engine.

## 5. Autonomy model

ForgeMind uses the minimum autonomy needed for each stage:

| Stage  | Decision type                            | Autonomy                    |
| ------ | ---------------------------------------- | --------------------------- |
| PLAN   | Structured task/acceptance decomposition | One bounded model call      |
| ARCH   | Scoped design judgment                   | Optional bounded model call |
| CODE   | Environment-dependent implementation     | Bounded tool loop           |
| TEST   | Registered verification                  | Deterministic               |
| REVIEW | Independent semantic review              | One bounded model call      |
| COMMIT | Evidence and fingerprint enforcement     | Deterministic               |

“Multi-agent” refers to these stage-specialized model roles and isolated permissions. It does not mean unrestricted peer-to-peer agent conversation.

## 6. Non-goals

- Hosted, remote, or multi-user operation.
- Automatic merge, deployment, or release.
- General-purpose shell access or model-defined tools.
- Unbounded self-improvement or automatic promotion of temporary trajectory data into permanent memory.
- Claims of model superiority based on the current small evaluation set.
- A message bus, database, distributed scheduler, or free-form agent topology.

## 7. Success evidence

The project is considered healthy when:

- `npm run check` passes;
- event-schema golden tests remain stable or change through an explicit version update;
- deterministic prompt/schema contracts do not regress;
- real-agent scenarios pass hidden semantic checks and criterion-level verifiers;
- failure, permission rejection, cancellation, rework, and recovery paths remain covered;
- published evaluation results state their model, date, scenario scope, tokens, failures, and limitations.

Test count alone is not a product metric. The next evaluation milestone is a representative multi-repository task set with repeated runs, at least two providers, latency/cost distribution, and workflow ablations.

## 8. Current implementation map

| Capability                              | Primary location                            |
| --------------------------------------- | ------------------------------------------- |
| Run orchestration and recovery          | `src/core/`, `src/runtime/`                 |
| Stage roles and bounded CODE loop       | `src/agents/`                               |
| Acceptance verification                 | `src/verification/`                         |
| Tools, policy, and sandbox              | `src/tools/`, `src/policy/`, `src/sandbox/` |
| Multi-repository DAG                    | `src/dag/`                                  |
| Memory and retrieval                    | `src/memory/`                               |
| Active-event adapters                   | `src/agentic/`                              |
| Reports and audit export                | `src/report/`, `src/audit/`                 |
| Local Web workspace                     | `src/web/`                                  |
| Deterministic and real-agent evaluation | `evals/`                                    |

## 9. Related documents

- [Documentation index](README.md)
- [Architecture](ARCHITECTURE.md)
- [Product manual](PRODUCT_MANUAL.md)
- [Evaluation](EVALUATION.md)
- [Limitations](LIMITATIONS.md)
- [Historical plans and ADRs](history/README.md)
