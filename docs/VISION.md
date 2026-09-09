# ForgeMind Vision

> Status: current direction, not a promise of deployment readiness or a feature roadmap.

## One-sentence direction

Make coding-agent work inspectable and verifiable: people define intent and approve risk, while a bounded workflow performs implementation and collects evidence.

## Product thesis

ForgeMind is built around three questions:

1. What information can each model role observe?
2. What actions can it perform, under which policy?
3. What external evidence proves that the requested outcome was achieved?

The project therefore favors a deterministic workflow over an open-ended society of agents. PLAN, optional ARCH, CODE, and REVIEW provide specialized model judgments; TEST and COMMIT remain deterministic gates. Multi-repository concurrency is used only when tasks can be isolated in separate worktrees.

## Current product boundary

The current repository is a local reference implementation with:

- one natural-language requirement to one verified commit;
- bounded rework, cancellation, checkpoints, and action recovery;
- evidence-bound TEST and REVIEW gates;
- branch/worktree isolation, policy, approvals, and audit events;
- optional DAG execution, governed memory, and external-service adapters;
- a loopback-only Web workspace and an offline report.

It is not a hosted cloud product, a multi-user collaboration service, a general replacement for an IDE, or an automatic merge/deployment system. External webhook hosting, secret management, repository mapping, operational alerting, and ambiguous-run reconciliation remain host responsibilities.

## Near-term priorities

Until the evidence below is stronger, new integrations and new Agent roles are not priorities:

1. Expand real-agent evaluation from controlled toy repositories to representative small projects.
2. Add repeat runs, multiple providers, latency/cost statistics, and controlled ablations.
3. Publish a short reproducible demo with a sanitized report and failure-recovery case study.
4. Keep the public documentation, package metadata, and release history synchronized with the code.

## North-star evidence

- end-to-end task success backed by criterion-level verifiers;
- first-pass success and recovery success after a failed gate;
- unauthorized and repeated tool-call rates;
- human-approval rate for risky actions;
- median and tail latency, model calls, tokens, and cost;
- reproducibility of workflow decisions under the same controlled inputs.

Historical product plans and architecture snapshots are retained under [`docs/history/`](history/README.md); they describe the evolution of the project, not its current readiness level.
