# Evaluation

ForgeMind separates deterministic engineering checks from model-behavior evaluation. Passing the repository test suite does not prove that the coding workflow solves arbitrary software tasks, and a small real-model scenario set is not a benchmark.

## 1. Engineering quality gate

`npm run check` runs strict TypeScript checks, type-aware ESLint, Prettier verification, a build, and the complete Node test suite.

Latest local run on 2026-09-08:

| Result                                     | Count |
| ------------------------------------------ | ----: |
| Registered tests                           |   204 |
| Passed                                     |   201 |
| Failed                                     |     0 |
| Environment-dependent smoke checks skipped |     3 |

The skipped checks require a real digest-pinned container, external chat provider, or external embedding provider. Release environments can require them with `npm run test:smoke:release`.

The repository does not currently enforce line or branch coverage for its own source. Test count must not be presented as coverage.

## 2. Prompt and schema contract

`npm run prompt:contract` uses deterministic fixtures to check prompt sections, structured-output schemas, response parsing, and allowed action kinds.

This check is deliberately not described as an effectiveness benchmark. In the current fixtures, both the legacy and current contracts pass 4/4; the current prompt set has a larger estimated prompt footprint. Effectiveness claims require real task outcomes and controlled ablations.

`npm run eval:contract` remains as a compatibility alias.

## 3. Real-agent evaluation

`npm run eval:real` connects to the selected model, creates temporary Git repositories, runs the actual agents, performs real file edits and tests, creates a commit, and applies hidden semantic checks plus criterion-level verifiers.

Latest recorded run: `evals/results/latest-real-agent.json`, generated 2026-09-02 with `deepseek-v4-flash`.

| Scenario                |  Passed | Model calls | Input tokens | Output tokens | Special path         |
| ----------------------- | ------: | ----------: | -----------: | ------------: | -------------------- |
| Single-file defect fix  |     Yes |           4 |        3,869 |           587 | Behavior probe       |
| Cross-file feature      |     Yes |           5 |        5,265 |           741 | Cross-file verifier  |
| Test failure and rework |     Yes |           7 |        8,265 |         1,273 | 1 rework round       |
| Crash recovery          |     Yes |           5 |        4,910 |           665 | 1 recovered crash    |
| Conflict resolution     |     Yes |          14 |       17,698 |         2,420 | 1 negotiation        |
| **Total**               | **5/5** |      **35** |   **40,007** |     **5,686** | 0 unauthorized tools |

The recorded result has no price inputs, so estimated cost is unavailable. The evaluation runs a bounded local `node --test`; the separate release smoke gate validates the container integration.

## 4. What this result supports

The current evidence supports these narrow claims:

- the end-to-end workflow can edit, test, review, and commit in controlled small repositories;
- a failed test can return evidence to CODE and lead to a successful rework;
- an interrupted write can be reconciled through the action journal in the tested failure window;
- conflict-selected verification can become an additional acceptance requirement;
- the tested scenarios produced no unauthorized tool calls.

It does not establish broad repository compatibility, model superiority, production reliability, or a stable 100% success rate.

## 5. Next evaluation bar

Before strengthening readiness claims, add:

1. 20–30 representative tasks across several maintained small repositories;
2. repeated runs with at least two providers;
3. success@1, recovery success, repeated-tool rate, approval rate, P50/P95 latency, tokens, and cost;
4. adversarial repository instructions, denied permissions, dependency failures, cancellation, and long-context cases;
5. ablations for no evidence gate, no recovery journal, and single-loop versus staged workflow;
6. a versioned result format that preserves the task-set commit and runtime configuration.

Evaluation updates should change one small set of variables at a time and keep the prior result available for comparison.
