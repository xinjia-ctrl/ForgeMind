# Limitations and Non-goals

This document defines the boundary of current claims. It should be read together with the architecture and evaluation documents.

## Product and operations

- ForgeMind is a local, single-process reference implementation. It is not a hosted or multi-user service.
- The Web workspace binds to loopback and allows one active run. It is an operator convenience layer, not an administration console.
- GitHub, Jira, and CI code provides adapters and workflow boundaries. Public HTTP hosting, secret management, repository mapping, alerting, backups, and service deployment are outside this repository.
- Ambiguous persisted `RUNNING` dispatches fail closed and require external reconciliation; there is no operator reconciliation command yet.
- ForgeMind creates branches and PR candidates but does not merge or deploy changes.

## Agent model

- “Multi-agent” means stage-specialized roles with different prompts, tools, and permissions under one Orchestrator. Peer-to-peer agent communication is intentionally absent.
- The same provider and model are used for the stage roles by default. Optional multi-round negotiation is meaningful only when callers provide genuinely different evidence, context, permissions, or models.
- Only CODE has an autonomous tool loop. PLAN, ARCH, and REVIEW are bounded model judgments; TEST and COMMIT are deterministic components.
- Model output remains probabilistic. Structured output, retries, budgets, and validation reduce failure modes but cannot guarantee task correctness.

## Evaluation

- The latest real-agent result covers five controlled JavaScript repositories and one recorded model configuration.
- A 5/5 result on that set is a regression signal, not a general benchmark or production success rate.
- The deterministic prompt contract checks structure and tool vocabulary, not semantic quality.
- The project test suite does not currently enforce source line/branch coverage.
- Real-provider cost is reported only when explicit price inputs are configured.

## Security

- The included `forgemind-local.config.json` executes approved commands on the host and is intended only for trusted repositories.
- Container mode requires an explicitly configured digest-pinned image and an available Docker or Podman runtime.
- The sandbox reduces process privileges and network access but is not a proof of isolation against every container-runtime or kernel vulnerability.
- Path checks have a time-of-check/time-of-use window between canonicalization and file access. A hostile local process that can concurrently rewrite symlinks is outside the current guarantee.
- Approval, RBAC, audit logs, and redaction are application controls; they do not replace host access control, secret rotation, or centralized audit retention.
- Repository files, diffs, retrieved memory, issue text, and tool output are treated as untrusted context, but prompt-injection resistance is not absolute.

## Repository and language support

- The CLI requires Node.js 22+, Git, a clean repository, and at least one existing commit.
- Test-command detection is deliberately narrow and shell-free. Repositories requiring arbitrary setup scripts need an explicitly registered and approved workflow outside the model's control.
- The main CI job currently runs on Ubuntu with Node.js 22; cross-platform behavior is not claimed.
- The default semantic index is lexical-vector plus BM25. Synonym, multilingual, and domain-specific recall may require an injected embedding provider and separate retrieval evaluation.

## Non-goals

- automatic merge, release, or deployment;
- unrestricted shell access or model-created tools;
- autonomous modification of policies, credentials, or long-term memory;
- a distributed scheduler, message bus, database, or general agent framework;
- replacing human ownership of requirements, risk approval, and final code acceptance.
