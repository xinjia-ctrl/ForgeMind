# ForgeMind Documentation

The root README is the project overview. These documents separate current behavior from historical design work.

## Current documents

| Document                            | Purpose                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------- |
| [Product scope](PRD.md)             | Current users, product contract, scope, non-goals, and success evidence   |
| [Architecture](ARCHITECTURE.md)     | Current component boundaries, state machines, policy, recovery, and ADRs  |
| [Product manual](PRODUCT_MANUAL.md) | CLI, Web workspace, configuration, reports, memory, DAG, and integrations |
| [Evaluation](EVALUATION.md)         | What is tested, latest real-agent evidence, and the next evaluation bar   |
| [Limitations](LIMITATIONS.md)       | Trust boundary, operational gaps, and claims the project does not make    |
| [Vision](VISION.md)                 | Stable direction and near-term priorities                                 |

## Historical documents

Version-specific PRDs and architecture snapshots live in [`history/`](history/README.md). They are retained to show how the design evolved; their status labels, test counts, and roadmaps are snapshots and may not describe the current repository.

When documents disagree, current executable behavior and tests take precedence, followed by the current architecture and product-scope documents.
