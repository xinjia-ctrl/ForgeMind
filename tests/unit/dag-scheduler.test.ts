import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { EventLog } from "../../src/core/event-log.js";
import { DagScheduler } from "../../src/dag/scheduler.js";
import type { DagTask, TaskExecution, TaskRunner } from "../../src/dag/types.js";
import { createDecisionRecord } from "../../src/negotiation/record.js";
import type {
  DecisionRecord,
  Negotiation,
  NegotiationCoordinator,
  NegotiationRequest,
} from "../../src/negotiation/types.js";

describe("DAG scheduler", () => {
  it("runs ready tasks concurrently and starts dependents after both succeed", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-dag-"));
    try {
      const events = await EventLog.create(directory, "parent-run");
      const runner = new RecordingRunner({ delayMs: 30 });
      const scheduler = new DagScheduler({
        parentRunId: "parent-run",
        taskRunner: runner,
        eventLog: events,
        maxConcurrency: 2,
      });
      const result = await scheduler.run(tasks());

      assert.equal(result.status, "SUCCEEDED");
      assert.equal(result.prList.length, 3);
      assert.ok(runner.maximumActive >= 2, "independent tasks did not overlap");
      assert.ok(
        (runner.startedAt.get("integration") ?? 0) >=
          Math.max(runner.finishedAt.get("backend") ?? 0, runner.finishedAt.get("frontend") ?? 0),
        "dependent task started before its predecessors finished",
      );
      const logged = await events.load();
      assert.deepEqual(
        logged.map((event) => event.type),
        [
          "task.started",
          "task.started",
          "task.completed",
          "task.completed",
          "task.started",
          "task.completed",
        ],
      );
      assert.ok(logged.every((event) => event.data.runId === "parent-run"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps independent work running and blocks all descendants of a failure", async () => {
    const runner = new RecordingRunner({ failedTask: "backend" });
    const result = await new DagScheduler({
      parentRunId: "parent-failure",
      taskRunner: runner,
      maxConcurrency: 3,
    }).run([
      ...tasks(),
      { taskId: "release", deps: ["integration"], repo: "/web", requirement: "Release" },
    ]);

    assert.equal(result.status, "PARTIAL");
    assert.deepEqual(
      result.tasks.map((task) => [task.taskId, task.status]),
      [
        ["backend", "FAILED"],
        ["frontend", "SUCCEEDED"],
        ["integration", "BLOCKED"],
        ["release", "BLOCKED"],
      ],
    );
    assert.equal(result.prList.length, 0);
    assert.deepEqual(runner.started, ["backend", "frontend"]);
  });

  it("refills a free concurrency slot as soon as a dependency finishes", async () => {
    const runner = new VariableDelayRunner({ slow: 80, fast: 5, "after-fast": 0 });
    const result = await new DagScheduler({
      parentRunId: "parent-refill",
      taskRunner: runner,
      maxConcurrency: 2,
    }).run([
      { taskId: "slow", deps: [], repo: "/slow", requirement: "Slow independent work" },
      { taskId: "fast", deps: [], repo: "/fast", requirement: "Fast prerequisite" },
      { taskId: "after-fast", deps: ["fast"], repo: "/fast", requirement: "Dependent work" },
    ]);

    assert.equal(result.status, "SUCCEEDED");
    assert.ok(
      (runner.startedAt.get("after-fast") ?? Infinity) < (runner.finishedAt.get("slow") ?? 0),
      "dependent task waited for an unrelated slow task",
    );
  });

  it("negotiates artifact mismatches before dependents start and persists the DecisionRecord", async () => {
    const negotiation = new ResolvingNegotiation();
    const stored: DecisionRecord[] = [];
    const runner = new ArtifactRunner(() => negotiation.resolved);
    const result = await new DagScheduler({
      parentRunId: "parent-artifact-mismatch",
      taskRunner: runner,
      negotiation,
      memory: {
        rememberDecisionRecord: (record) => {
          stored.push(record);
          return Promise.resolve();
        },
      },
      maxConcurrency: 2,
    }).run(tasks());

    assert.equal(result.status, "SUCCEEDED");
    assert.equal(negotiation.requests.length, 1);
    const request = negotiation.requests[0];
    assert.ok(request);
    assert.equal(request.runId, "parent-artifact-mismatch");
    assert.equal(request.trigger, "artifact-mismatch");
    assert.match(request.topic, /contracts\/payment\.json/);
    assert.equal(result.decisionRecords.length, 1);
    assert.deepEqual(stored, result.decisionRecords);
    assert.ok(runner.integrationStartedAfterResolution);
  });
});

function tasks(): readonly DagTask[] {
  return [
    { taskId: "backend", deps: [], repo: "/api", requirement: "Add API" },
    { taskId: "frontend", deps: [], repo: "/web", requirement: "Add UI" },
    {
      taskId: "integration",
      deps: ["backend", "frontend"],
      repo: "/web",
      requirement: "Integrate",
    },
  ];
}

class RecordingRunner implements TaskRunner {
  public readonly started: string[] = [];
  public readonly startedAt = new Map<string, number>();
  public readonly finishedAt = new Map<string, number>();
  public maximumActive = 0;
  #active = 0;

  public constructor(
    private readonly options: { readonly delayMs?: number; readonly failedTask?: string },
  ) {}

  public async run(
    task: DagTask,
    context: { readonly parentRunId: string; readonly runId: string },
  ): Promise<TaskExecution> {
    this.started.push(task.taskId);
    this.startedAt.set(task.taskId, performance.now());
    this.#active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.#active);
    await new Promise<void>((resolve) => setTimeout(resolve, this.options.delayMs ?? 0));
    this.#active -= 1;
    this.finishedAt.set(task.taskId, performance.now());
    assert.match(context.runId, new RegExp(task.taskId));
    return {
      runId: context.runId,
      status: task.taskId === this.options.failedTask ? "FAILED" : "SUCCEEDED",
      branch: `forgemind/${context.runId}`,
      summary: task.taskId === this.options.failedTask ? "failed" : "done",
      artifacts: [],
    };
  }
}

class VariableDelayRunner implements TaskRunner {
  public readonly startedAt = new Map<string, number>();
  public readonly finishedAt = new Map<string, number>();

  public constructor(private readonly delays: Readonly<Record<string, number>>) {}

  public async run(
    task: DagTask,
    context: { readonly parentRunId: string; readonly runId: string },
  ): Promise<TaskExecution> {
    this.startedAt.set(task.taskId, performance.now());
    await new Promise<void>((resolve) => setTimeout(resolve, this.delays[task.taskId] ?? 0));
    this.finishedAt.set(task.taskId, performance.now());
    return {
      runId: context.runId,
      status: "SUCCEEDED",
      branch: `forgemind/${context.runId}`,
      summary: "done",
      artifacts: [],
    };
  }
}

class ArtifactRunner implements TaskRunner {
  public integrationStartedAfterResolution = false;

  public constructor(private readonly negotiationResolved: () => boolean) {}

  public run(
    task: DagTask,
    context: { readonly parentRunId: string; readonly runId: string },
  ): Promise<TaskExecution> {
    if (task.taskId === "integration") {
      this.integrationStartedAfterResolution = this.negotiationResolved();
    }
    const summary =
      task.taskId === "backend"
        ? "Amount is represented in cents"
        : task.taskId === "frontend"
          ? "Amount is represented in decimal dollars"
          : "Use the negotiated payment amount representation";
    return Promise.resolve({
      runId: context.runId,
      status: "SUCCEEDED",
      branch: `forgemind/${context.runId}`,
      summary: "done",
      artifacts: [
        {
          path: "contracts/payment.json",
          kind: "source",
          stage: "CODE",
          summary,
        },
      ],
    });
  }
}

class ResolvingNegotiation implements NegotiationCoordinator {
  public readonly requests: NegotiationRequest[] = [];
  public resolved = false;

  public negotiate(request: NegotiationRequest): Promise<Negotiation> {
    this.requests.push(request);
    const rounds = [
      {
        round: 1 as const,
        proposal: request.proposal,
        counter: request.counter,
        status: "CONVERGED" as const,
      },
    ];
    const decisionRecord = createDecisionRecord({
      runId: request.runId,
      topic: request.topic,
      trigger: request.trigger,
      rounds,
      decision: "Represent payment amounts in integer cents",
      escalated: false,
      createdAt: "2026-08-18T00:00:00.000Z",
    });
    this.resolved = true;
    return Promise.resolve({
      id: "artifact-negotiation",
      runId: request.runId,
      trigger: request.trigger,
      topic: request.topic,
      rounds,
      status: "RESOLVED",
      decisionRecord,
    });
  }
}
