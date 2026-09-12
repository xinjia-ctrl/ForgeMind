import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AgentFactory } from "../../src/core/agent-factory.js";
import { createTaskContext } from "../../src/core/context.js";
import { EventLog } from "../../src/core/event-log.js";
import { DEFAULT_MAX_REWORK, Orchestrator } from "../../src/core/orchestrator.js";
import { FileRunCheckpointStore } from "../../src/core/run-checkpoint.js";
import type { StageAgent, StageId, StageOutput } from "../../src/core/types.js";
import { DEFAULT_TOKEN_BUDGETS } from "../../src/config/budgets.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Orchestrator", () => {
  it("returns review feedback to CODE and commits after both gates pass", async () => {
    const fixture = await orchestratorFixture([
      ["PLAN", planOutput()],
      ["ARCH", architectureOutput()],
      ["CODE", codeOutput("initial")],
      ["TEST", testOutput(true, 1)],
      ["REVIEW", reviewOutput(false, 1)],
      ["CODE", codeOutput("fixed")],
      ["TEST", testOutput(true, 2)],
      ["REVIEW", reviewOutput(true, 2)],
      ["COMMIT", commitOutput()],
    ]);

    const result = await fixture.orchestrator.run(fixture.context);
    assert.equal(result.status, "SUCCEEDED");
    assert.deepEqual(
      result.context.gates.map((gate) => [gate.stage, gate.passed]),
      [
        ["TEST", true],
        ["REVIEW", false],
        ["TEST", true],
        ["REVIEW", true],
      ],
    );
    assert.match(fixture.factory.feedbackSeen ?? "", /Required rework: Fix the defect/);
    assert.match(fixture.factory.feedbackSeen ?? "", /Previous evidence:/);
    assert.deepEqual(result.context.meta.attempt, { stage: "COMMIT", count: 1 });
  });

  it("fails when the rework limit is exhausted", async () => {
    const fixture = await orchestratorFixture(
      [
        ["PLAN", planOutput()],
        ["ARCH", architectureOutput()],
        ["CODE", codeOutput("first")],
        ["TEST", testOutput(true, 1)],
        ["REVIEW", reviewOutput(false, 1)],
        ["CODE", codeOutput("second")],
        ["TEST", testOutput(true, 2)],
        ["REVIEW", reviewOutput(false, 2)],
      ],
      1,
    );
    const result = await fixture.orchestrator.run(fixture.context);
    assert.equal(result.status, "FAILED");
    assert.match(result.summary, /after 2 attempts/);
  });

  it("blocks commit when a passing gate omits criterion-level evidence", async () => {
    const incompleteReview: StageOutput = {
      kind: "gate",
      gate: {
        stage: "REVIEW",
        attempt: 1,
        passed: true,
        reason: "Approved without evidence",
        feedback: "None",
        evidence: "Reviewed diff",
        artifactFingerprint: "fingerprint",
        verificationEvidence: [],
      },
    };
    const fixture = await orchestratorFixture([
      ["PLAN", planOutput()],
      ["ARCH", architectureOutput()],
      ["CODE", codeOutput("implemented")],
      ["TEST", testOutput(true, 1)],
      ["REVIEW", incompleteReview],
      ["COMMIT", commitOutput()],
    ]);
    const result = await fixture.orchestrator.run(fixture.context);
    assert.equal(result.status, "FAILED");
    assert.match(result.summary, /missing verification evidence for AC-1/);
  });

  it("returns test failure evidence to CODE before running both gates again", async () => {
    const fixture = await orchestratorFixture([
      ["PLAN", planOutput()],
      ["ARCH", architectureOutput()],
      ["CODE", codeOutput("initial")],
      ["TEST", testOutput(false, 1)],
      ["CODE", codeOutput("fixed")],
      ["TEST", testOutput(true, 2)],
      ["REVIEW", reviewOutput(true, 2)],
      ["COMMIT", commitOutput()],
    ]);
    const result = await fixture.orchestrator.run(fixture.context);
    assert.equal(result.status, "SUCCEEDED");
    assert.match(fixture.factory.feedbackSeen ?? "", /Required rework: Fix tests/);
    assert.match(fixture.factory.feedbackSeen ?? "", /Previous evidence:/);
    assert.deepEqual(
      result.context.gates.map((gate) => [gate.stage, gate.passed]),
      [
        ["TEST", false],
        ["TEST", true],
        ["REVIEW", true],
      ],
    );
  });

  it("keeps every prior gate requirement in later CODE recovery attempts", async () => {
    const fixture = await orchestratorFixture([
      ["PLAN", planOutput()],
      ["ARCH", architectureOutput()],
      ["CODE", codeOutput("initial")],
      ["TEST", testOutput(true, 1)],
      ["REVIEW", reviewOutput(false, 1, "Clamp the crop rectangle")],
      ["CODE", codeOutput("bounded")],
      ["TEST", testOutput(true, 2)],
      ["REVIEW", reviewOutput(false, 2, "Enforce a positive minimum size")],
      ["CODE", codeOutput("fully fixed")],
      ["TEST", testOutput(true, 3)],
      ["REVIEW", reviewOutput(true, 3)],
      ["COMMIT", commitOutput()],
    ]);

    const result = await fixture.orchestrator.run(fixture.context);
    assert.equal(result.status, "SUCCEEDED");
    const latestFeedback = fixture.factory.feedbackHistory.at(-1) ?? "";
    assert.match(latestFeedback, /Cumulative rework contract/);
    assert.match(latestFeedback, /Clamp the crop rectangle/);
    assert.match(latestFeedback, /Enforce a positive minimum size/);
  });

  it("uses a six-rework default recovery budget", () => {
    assert.equal(DEFAULT_MAX_REWORK, 6);
  });

  it("keeps nested context decisions immutable", async () => {
    const fixture = await orchestratorFixture([
      ["PLAN", planOutput()],
      ["ARCH", architectureOutput()],
      ["CODE", codeOutput("done")],
      ["TEST", testOutput(true, 1)],
      ["REVIEW", reviewOutput(true, 1)],
      ["COMMIT", commitOutput()],
    ]);
    const result = await fixture.orchestrator.run(fixture.context);
    assert.throws(() => {
      (result.context.plan as { summary: string }).summary = "mutated";
    }, TypeError);
  });

  it("checkpoints a cancellation and resumes from the next safe phase", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-resume-"));
    temporaryDirectories.push(directory);
    const checkpointStore = new FileRunCheckpointStore(path.join(directory, "checkpoints"));
    const controller = new AbortController();
    const factory = new QueueAgentFactory(
      [
        ["PLAN", planOutput()],
        ["ARCH", architectureOutput()],
        ["CODE", codeOutput("implemented")],
        ["TEST", testOutput(true, 1)],
        ["REVIEW", reviewOutput(true, 1)],
        ["COMMIT", commitOutput()],
      ],
      (stage) => {
        if (stage === "ARCH") controller.abort();
      },
    );
    const context = createTaskContext({
      runId: "resume-run",
      requirement: "Add a feature",
      repoPath: directory,
      branch: "forgemind/resume-run",
      tokenBudget: DEFAULT_TOKEN_BUDGETS,
    });
    const firstLog = await EventLog.create(directory, "resume-run");
    await assert.rejects(
      () =>
        new Orchestrator({
          eventLog: firstLog,
          agentFactory: factory,
          checkpointStore,
          signal: controller.signal,
        }).run(context),
      /cancelled/i,
    );
    assert.equal((await checkpointStore.load("resume-run"))?.phase, "CODE");

    factory.afterStage = undefined;
    const result = await new Orchestrator({
      eventLog: EventLog.open(directory, "resume-run"),
      agentFactory: factory,
      checkpointStore,
      resume: true,
    }).run(context);
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(await checkpointStore.load("resume-run"), null);
    assert.ok((await firstLog.load()).some((event) => event.type === "run.resumed"));
  });
});

async function orchestratorFixture(outputs: Array<readonly [StageId, StageOutput]>, maxRework = 3) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-orchestrator-"));
  temporaryDirectories.push(directory);
  const eventLog = await EventLog.create(directory, "unit-run");
  const factory = new QueueAgentFactory(outputs);
  return {
    factory,
    orchestrator: new Orchestrator({
      eventLog,
      agentFactory: factory,
      maxRework,
    }),
    context: createTaskContext({
      runId: "unit-run",
      requirement: "Add a feature",
      repoPath: directory,
      branch: "forgemind/unit-run",
      tokenBudget: DEFAULT_TOKEN_BUDGETS,
    }),
  };
}

class QueueAgentFactory implements AgentFactory {
  public feedbackSeen: string | undefined;
  public readonly feedbackHistory: string[] = [];

  public constructor(
    private readonly queue: Array<readonly [StageId, StageOutput]>,
    public afterStage?: (stage: StageId) => void,
  ) {}

  public create(stage: StageId): StageAgent {
    const next = this.queue.shift();
    assert.ok(next, `No queued output for ${stage}`);
    assert.equal(next[0], stage);
    return {
      id: stage,
      tools: [],
      lifecycle: "CREATED",
      run: async (input) => {
        if (stage === "CODE" && input.feedback !== undefined) {
          this.feedbackSeen = input.feedback;
          this.feedbackHistory.push(input.feedback);
        }
        this.afterStage?.(stage);
        return next[1];
      },
    };
  }
}

function planOutput(): StageOutput {
  return {
    kind: "plan",
    plan: {
      objective: "Add a feature",
      steps: [{ id: "1", title: "Implement", description: "Implement it" }],
      acceptanceCriteria: [
        {
          id: "AC-1",
          description: "Tests pass",
          requiredEvidence: ["test", "review"],
          verifier: { kind: "test-suite", commandId: "primary" },
        },
      ],
      summary: "A plan",
    },
    artifact: { path: "plan.md", kind: "plan", stage: "PLAN", summary: "A plan" },
  };
}

function architectureOutput(): StageOutput {
  return {
    kind: "architecture",
    architecture: {
      decisions: ["Reuse existing module"],
      files: [{ path: "src/index.ts", purpose: "Implementation" }],
      risks: ["Regression"],
      summary: "An architecture",
    },
    artifact: {
      path: "architecture.md",
      kind: "architecture",
      stage: "ARCH",
      summary: "An architecture",
    },
  };
}

function codeOutput(summary: string): StageOutput {
  return {
    kind: "code",
    summary,
    artifacts: [{ path: "src/index.ts", kind: "source", stage: "CODE", summary }],
  };
}

function reviewOutput(passed: boolean, attempt: number, feedback = "Fix the defect"): StageOutput {
  return {
    kind: "gate",
    gate: {
      stage: "REVIEW",
      attempt,
      passed,
      reason: passed ? "Approved" : "Defect found",
      feedback: passed ? "No changes" : feedback,
      evidence: "Reviewed diff",
      artifactFingerprint: "fingerprint",
      verificationEvidence: [
        {
          criterionId: "AC-1",
          verifierKind: "test-suite",
          source: "review:model",
          artifactFingerprint: "fingerprint",
          passed,
          details: passed ? "The diff and tests satisfy the criterion" : feedback,
        },
      ],
    },
  };
}

function testOutput(passed: boolean, attempt: number): StageOutput {
  return {
    kind: "gate",
    gate: {
      stage: "TEST",
      attempt,
      passed,
      reason: passed ? "Passed" : "Failed",
      feedback: passed ? "None" : "Fix tests",
      evidence: "node --test",
      artifactFingerprint: "fingerprint",
      verificationEvidence: [
        {
          criterionId: "AC-1",
          verifierKind: "test-suite",
          source: "test:command:primary",
          artifactFingerprint: "fingerprint",
          passed,
          details: passed ? "The configured test command passed" : "The test command failed",
        },
      ],
    },
  };
}

function commitOutput(): StageOutput {
  return {
    kind: "commit",
    commit: "abc123",
    artifact: {
      path: "abc123",
      kind: "commit",
      stage: "COMMIT",
      summary: "feat: add a feature",
    },
  };
}
