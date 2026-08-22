import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import type { RunOptions } from "../../src/runtime/run.js";
import { ForgeMindTaskRunner } from "../../src/dag/task-runner.js";
import type { DagTask } from "../../src/dag/types.js";
import { FakeChatProvider } from "../../src/llm/fake-provider.js";

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
              plan: null,
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
              ],
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
        });
      },
    });
    const task: DagTask = {
      taskId: "backend",
      deps: [],
      repo: "/api",
      requirement: "Add API",
    };
    const result = await runner.run(task, { parentRunId: "parent", runId: "child" });

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
      },
    ]);
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
            status: "SUCCEEDED",
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
      { taskId: "one", deps: [], repo: "/repo", requirement: "One" },
      { parentRunId: "parent", runId: "child-one" },
    );
    await assert.rejects(
      () =>
        runner.run(
          { taskId: "two", deps: ["one"], repo: "/repo", requirement: "Two" },
          { parentRunId: "parent", runId: "child-two" },
        ),
      /independent workspaces/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
