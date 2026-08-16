import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AgentFactory } from "../../src/core/agent-factory.js";
import { createTaskContext } from "../../src/core/context.js";
import { EventLog } from "../../src/core/event-log.js";
import { Orchestrator } from "../../src/core/orchestrator.js";
import type { StageAgent, StageId, StageOutput } from "../../src/core/types.js";
import { DEFAULT_TOKEN_BUDGETS } from "../../src/config/budgets.js";
import { NoopMemoryProvider } from "../../src/memory/noop-memory-provider.js";
import type { MemoryProvider } from "../../src/memory/memory-provider.js";
import { createDecisionRecord } from "../../src/negotiation/record.js";
import type {
  DecisionRecord,
  NegotiationCoordinator,
  NegotiationRequest,
} from "../../src/negotiation/types.js";

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
      ["REVIEW", reviewOutput(false, 1)],
      ["CODE", codeOutput("fixed")],
      ["REVIEW", reviewOutput(true, 2)],
      ["TEST", testOutput(true, 2)],
      ["COMMIT", commitOutput()],
    ]);

    const result = await fixture.orchestrator.run(fixture.context);
    assert.equal(result.status, "SUCCEEDED");
    assert.deepEqual(
      result.context.gates.map((gate) => [gate.stage, gate.passed]),
      [
        ["REVIEW", false],
        ["REVIEW", true],
        ["TEST", true],
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
        ["REVIEW", reviewOutput(false, 1)],
        ["CODE", codeOutput("second")],
        ["REVIEW", reviewOutput(false, 2)],
      ],
      1,
    );
    const result = await fixture.orchestrator.run(fixture.context);
    assert.equal(result.status, "FAILED");
    assert.match(result.summary, /after 2 attempts/);
  });

  it("returns test failure evidence to CODE before running both gates again", async () => {
    const fixture = await orchestratorFixture([
      ["PLAN", planOutput()],
      ["ARCH", architectureOutput()],
      ["CODE", codeOutput("initial")],
      ["REVIEW", reviewOutput(true, 1)],
      ["TEST", testOutput(false, 1)],
      ["CODE", codeOutput("fixed")],
      ["REVIEW", reviewOutput(true, 2)],
      ["TEST", testOutput(true, 2)],
      ["COMMIT", commitOutput()],
    ]);
    const result = await fixture.orchestrator.run(fixture.context);
    assert.equal(result.status, "SUCCEEDED");
    assert.match(fixture.factory.feedbackSeen ?? "", /Required rework: Fix tests/);
    assert.match(fixture.factory.feedbackSeen ?? "", /Previous evidence:/);
    assert.deepEqual(
      result.context.gates.map((gate) => [gate.stage, gate.passed]),
      [
        ["REVIEW", true],
        ["TEST", false],
        ["REVIEW", true],
        ["TEST", true],
      ],
    );
  });

  it("keeps nested context decisions immutable", async () => {
    const fixture = await orchestratorFixture([
      ["PLAN", planOutput()],
      ["ARCH", architectureOutput()],
      ["CODE", codeOutput("done")],
      ["REVIEW", reviewOutput(true, 1)],
      ["TEST", testOutput(true, 1)],
      ["COMMIT", commitOutput()],
    ]);
    const result = await fixture.orchestrator.run(fixture.context);
    assert.throws(() => {
      (result.context.plan as { summary: string }).summary = "mutated";
    }, TypeError);
  });

  it("negotiates once after repeated review rejection and returns the decision to CODE", async () => {
    const negotiation = new StaticNegotiationCoordinator(
      "Reduce the change to the affected boundary",
    );
    const memory = new CapturingMemory();
    const fixture = await orchestratorFixture(
      [
        ["PLAN", planOutput()],
        ["ARCH", architectureOutput()],
        ["CODE", codeOutput("initial")],
        ["REVIEW", reviewOutput(false, 1)],
        ["CODE", codeOutput("first fix")],
        ["REVIEW", reviewOutput(false, 2)],
        ["CODE", codeOutput("negotiated fix")],
        ["REVIEW", reviewOutput(true, 3)],
        ["TEST", testOutput(true, 3)],
        ["COMMIT", commitOutput()],
      ],
      3,
      { negotiation, memory },
    );
    const result = await fixture.orchestrator.run(fixture.context);
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(negotiation.requests.length, 1);
    assert.equal(negotiation.requests[0]?.trigger, "review-repeated-rejection");
    assert.match(fixture.factory.feedbackSeen ?? "", /Negotiated decision: Reduce the change/);
    assert.equal(memory.records.length, 1);
  });

  it("applies a resolved architecture conflict before CODE", async () => {
    const negotiation = new StaticNegotiationCoordinator("Use the outer protocol service");
    const fixture = await orchestratorFixture(
      [
        ["PLAN", planOutput()],
        ["ARCH", architectureOutput(true)],
        ["CODE", codeOutput("implemented")],
        ["REVIEW", reviewOutput(true, 1)],
        ["TEST", testOutput(true, 1)],
        ["COMMIT", commitOutput()],
      ],
      3,
      { negotiation },
    );
    const result = await fixture.orchestrator.run(fixture.context);
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(negotiation.requests[0]?.trigger, "arch-conflict");
    assert.match(fixture.factory.architectureSeen ?? "", /Use the outer protocol service/);
  });
});

async function orchestratorFixture(
  outputs: Array<readonly [StageId, StageOutput]>,
  maxRework = 3,
  options: {
    readonly negotiation?: NegotiationCoordinator;
    readonly memory?: MemoryProvider;
  } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-orchestrator-"));
  temporaryDirectories.push(directory);
  const eventLog = await EventLog.create(directory, "unit-run");
  const factory = new QueueAgentFactory(outputs);
  return {
    factory,
    orchestrator: new Orchestrator({
      eventLog,
      agentFactory: factory,
      memory: options.memory ?? new NoopMemoryProvider(),
      maxRework,
      ...(options.negotiation === undefined ? {} : { negotiation: options.negotiation }),
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
  public architectureSeen: string | undefined;

  public constructor(private readonly queue: Array<readonly [StageId, StageOutput]>) {}

  public create(stage: StageId): StageAgent {
    const next = this.queue.shift();
    assert.ok(next, `No queued output for ${stage}`);
    assert.equal(next[0], stage);
    return {
      id: stage,
      tools: [],
      lifecycle: "CREATED",
      run: async (input, context) => {
        if (stage === "CODE" && input.feedback !== undefined) {
          this.feedbackSeen = input.feedback;
        }
        if (stage === "CODE") this.architectureSeen = context.architecture?.summary;
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
      acceptanceCriteria: ["Tests pass"],
      summary: "A plan",
    },
    artifact: { path: "plan.md", kind: "plan", stage: "PLAN", summary: "A plan" },
  };
}

function architectureOutput(withConflict = false): StageOutput {
  return {
    kind: "architecture",
    architecture: {
      decisions: ["Reuse existing module"],
      files: [{ path: "src/index.ts", purpose: "Implementation" }],
      risks: ["Regression"],
      ...(withConflict
        ? {
            alternatives: [
              { position: "Use an outer protocol service", tradeoffs: ["Keeps agents uniform"] },
              { position: "Extend stage agents", tradeoffs: ["Couples negotiation to stages"] },
            ],
          }
        : {}),
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

class StaticNegotiationCoordinator implements NegotiationCoordinator {
  public readonly requests: NegotiationRequest[] = [];

  public constructor(private readonly decision: string) {}

  public negotiate(request: NegotiationRequest) {
    this.requests.push(request);
    const round = {
      round: 1 as const,
      proposal: request.proposal,
      counter: request.counter,
      status: "CONVERGED" as const,
    };
    const record = createDecisionRecord({
      runId: request.runId,
      topic: request.topic,
      trigger: request.trigger,
      rounds: [round],
      decision: this.decision,
      escalated: false,
      createdAt: "2026-08-14T00:00:00.000Z",
    });
    return Promise.resolve({
      id: "negotiation-id",
      runId: request.runId,
      trigger: request.trigger,
      topic: request.topic,
      rounds: [round],
      status: "RESOLVED" as const,
      decisionRecord: record,
    });
  }
}

class CapturingMemory extends NoopMemoryProvider {
  public readonly records: DecisionRecord[] = [];

  public rememberDecisionRecord(record: DecisionRecord): Promise<void> {
    this.records.push(record);
    return Promise.resolve();
  }
}

function codeOutput(summary: string): StageOutput {
  return {
    kind: "code",
    summary,
    artifacts: [{ path: "src/index.ts", kind: "source", stage: "CODE", summary }],
  };
}

function reviewOutput(passed: boolean, attempt: number): StageOutput {
  return {
    kind: "gate",
    gate: {
      stage: "REVIEW",
      attempt,
      passed,
      reason: passed ? "Approved" : "Defect found",
      feedback: passed ? "No changes" : "Fix the defect",
      evidence: "Reviewed diff",
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
