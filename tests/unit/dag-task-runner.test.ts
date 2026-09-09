import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import type { RunOptions } from "../../src/runtime/run.js";
import { ForgeMindTaskRunner } from "../../src/dag/task-runner.js";
import type { DagTask } from "../../src/dag/types.js";
import { FakeChatProvider } from "../../src/llm/fake-provider.js";
import { testSuiteCriterion } from "../../src/core/acceptance.js";

it("adapts a DAG task to a child run with parent and task indexes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-task-runner-"));
  try {
    let received: RunOptions | undefined;
    const runner = new ForgeMindTaskRunner({
      createRunOptions: () => ({
        repoPath: directory,
        provider: new FakeChatProvider([]),
        model: "fake-model",
      }),
      execute: (options) => {
        received = options;
        return Promise.resolve({
          result: {
            status: "SUCCEEDED",
            summary: "done",
            context: {
              runId: options.runId ?? "missing",
              requirement: options.requirement,
              repo: { path: options.repoPath, branch: `forgemind/${options.runId ?? "missing"}` },
              plan: {
                objective: "Update API",
                steps: [{ id: "1", title: "Update", description: "Update API" }],
                acceptanceCriteria: [testSuiteCriterion("AC-1", "API is updated")],
                summary: "Update API",
              },
              architecture: null,
              artifacts: [
                {
                  path: "src/api.ts",
                  kind: "source",
                  stage: "CODE",
                  summary: "Initial API contract",
                },
                {
                  path: "architecture.md",
                  kind: "architecture",
                  stage: "ARCH",
                  summary: "Architecture",
                },
                {
                  path: "src/api.ts",
                  kind: "source",
                  stage: "CODE",
                  summary: "Final API contract",
                },
                {
                  path: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  kind: "commit",
                  stage: "COMMIT",
                  summary: "feat: update API",
                },
              ],
              gates: [
                {
                  stage: "TEST",
                  attempt: 1,
                  passed: false,
                  reason: "Failed",
                  feedback: "Fix the old failure",
                  evidence: "Old test failure",
                  artifactFingerprint: "old-fingerprint",
                  verificationEvidence: [
                    {
                      criterionId: "AC-1",
                      verifierKind: "test-suite",
                      source: "test:command:primary",
                      artifactFingerprint: "old-fingerprint",
                      passed: false,
                      details: "Old failure",
                    },
                  ],
                },
                {
                  stage: "TEST",
                  attempt: 1,
                  passed: true,
                  reason: "Passed",
                  feedback: "None",
                  evidence: "Tested",
                  artifactFingerprint: "fingerprint",
                  verificationEvidence: [
                    {
                      criterionId: "AC-1",
                      verifierKind: "test-suite",
                      source: "test:command:primary",
                      artifactFingerprint: "fingerprint",
                      passed: true,
                      details: "API tests passed",
                    },
                  ],
                },
                {
                  stage: "REVIEW",
                  attempt: 1,
                  passed: true,
                  reason: "Approved",
                  feedback: "None",
                  evidence: "Reviewed",
                  artifactFingerprint: "fingerprint",
                  verificationEvidence: [],
                },
              ],
              meta: {
                attempt: { stage: "PLAN", count: 1 },
                tokenBudget: {
                  PLAN: { input: 1, output: 1 },
                  ARCH: { input: 1, output: 1 },
                  CODE: { input: 1, output: 1 },
                  REVIEW: { input: 1, output: 1 },
                  TEST: { input: 1, output: 1 },
                  COMMIT: { input: 1, output: 1 },
                },
              },
            },
          },
          eventLogPath: "/events/child.jsonl",
        });
      },
    });
    const task: DagTask = {
      taskId: "backend",
      deps: [],
      repo: "/api",
      requirement: "Add API",
      acceptanceCriteria: [testSuiteCriterion("AC-1", "API is updated")],
    };
    const result = await runner.run(task, {
      parentRunId: "parent",
      runId: "child",
      dependencies: [],
    });

    assert.equal(result.runId, "child");
    assert.ok(received);
    assert.equal(received.parentRunId, "parent");
    assert.equal(received.taskId, "backend");
    assert.equal(received.requirement, "Add API");
    assert.deepEqual(result.artifacts, [
      {
        path: "src/api.ts",
        kind: "source",
        stage: "CODE",
        summary: "Final API contract",
        version: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ]);
    const handoff = result.handoff;
    assert.ok(handoff);
    assert.equal(handoff.verificationEvidence.length, 1);
    assert.equal(handoff.verificationEvidence[0]?.passed, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects sequential workspace reuse by different tasks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-shared-workspace-"));
  try {
    const runner = new ForgeMindTaskRunner({
      createRunOptions: () => ({
        repoPath: directory,
        provider: new FakeChatProvider([]),
        model: "fake-model",
      }),
      execute: (options) =>
        Promise.resolve({
          result: {
            status: "FAILED",
            summary: "done",
            context: {
              runId: options.runId ?? "missing",
              requirement: options.requirement,
              repo: { path: options.repoPath, branch: `forgemind/${options.runId ?? "missing"}` },
              plan: null,
              architecture: null,
              artifacts: [],
              gates: [],
              meta: {
                attempt: { stage: "PLAN", count: 1 },
                tokenBudget: {
                  PLAN: { input: 1, output: 1 },
                  ARCH: { input: 1, output: 1 },
                  CODE: { input: 1, output: 1 },
                  REVIEW: { input: 1, output: 1 },
                  TEST: { input: 1, output: 1 },
                  COMMIT: { input: 1, output: 1 },
                },
              },
            },
          },
          eventLogPath: "/events/child.jsonl",
        }),
    });
    await runner.run(
      {
        taskId: "one",
        deps: [],
        repo: "/repo",
        requirement: "One",
        acceptanceCriteria: [testSuiteCriterion("AC-1", "One completes")],
      },
      { parentRunId: "parent", runId: "child-one", dependencies: [] },
    );
    await assert.rejects(
      () =>
        runner.run(
          {
            taskId: "two",
            deps: ["one"],
            repo: "/repo",
            requirement: "Two",
            acceptanceCriteria: [testSuiteCriterion("AC-1", "Two completes")],
          },
          { parentRunId: "parent", runId: "child-two", dependencies: [] },
        ),
      /independent workspaces/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
