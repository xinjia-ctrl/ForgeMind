import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_TOKEN_BUDGETS } from "../../src/config/budgets.js";
import {
  createTaskContext,
  withArchitecture,
  withArtifacts,
  withGate,
} from "../../src/core/context.js";
import {
  detectArchitectureConflict,
  detectArtifactMismatch,
  detectRepeatedReviewRejection,
} from "../../src/negotiation/triggers.js";

describe("negotiation triggers", () => {
  it("detects materially different architecture alternatives", () => {
    const conflict = detectArchitectureConflict({
      decisions: ["Keep the existing orchestration core"],
      files: [],
      risks: [],
      alternatives: [
        { position: "Add an outer protocol service", tradeoffs: ["Small integration surface"] },
        { position: "Extend each stage agent", tradeoffs: ["Tighter lifecycle coupling"] },
      ],
      summary: "Add bounded negotiation",
    });
    assert.ok(conflict);
    assert.equal(conflict.trigger, "arch-conflict");
    assert.match(conflict.proposal, /outer protocol/);
    assert.match(conflict.counter, /stage agent/);

    assert.equal(
      detectArchitectureConflict({
        decisions: [],
        files: [],
        risks: [],
        alternatives: [
          { position: "Same option", tradeoffs: ["A"] },
          { position: " same   option ", tradeoffs: ["B"] },
        ],
        summary: "No conflict",
      }),
      null,
    );
  });

  it("detects only consecutive review rejections", () => {
    const base = createTaskContext({
      runId: "negotiation-trigger-run",
      requirement: "Add bounded negotiation",
      repoPath: "/repo",
      branch: "forgemind/negotiation-trigger-run",
      tokenBudget: DEFAULT_TOKEN_BUDGETS,
    });
    const architectureArtifact = {
      path: "architecture.md",
      kind: "architecture" as const,
      stage: "ARCH" as const,
      summary: "Use an outer layer",
    };
    let context = withArchitecture(
      base,
      {
        decisions: ["Use an outer layer"],
        files: [],
        risks: [],
        summary: "Use an outer layer",
      },
      architectureArtifact,
    );
    context = withArtifacts(context, [
      { path: "src/a.ts", kind: "source", stage: "CODE", summary: "First implementation" },
      { path: "src/a.ts", kind: "source", stage: "CODE", summary: "Second implementation" },
    ]);
    context = withGate(context, rejection(1));
    assert.equal(detectRepeatedReviewRejection(context), null);
    context = withGate(context, rejection(2));
    const repeated = detectRepeatedReviewRejection(context);
    assert.ok(repeated);
    assert.equal(repeated.trigger, "review-repeated-rejection");
    assert.match(repeated.counter, /Fix boundary handling/);

    const passed = withGate(context, { ...rejection(3), passed: true });
    const afterPass = withGate(passed, rejection(4));
    assert.equal(detectRepeatedReviewRejection(afterPass), null);
  });

  it("detects conflicting meanings for the same cross-task artifact", () => {
    const mismatch = detectArtifactMismatch([
      {
        taskId: "api",
        artifact: {
          path: "contracts/payment.json",
          kind: "source",
          stage: "CODE",
          summary: "Amount is represented in cents",
        },
      },
      {
        taskId: "web",
        artifact: {
          path: "contracts/payment.json",
          kind: "source",
          stage: "CODE",
          summary: "Amount is represented in decimal dollars",
        },
      },
    ]);
    assert.ok(mismatch);
    assert.equal(mismatch.trigger, "artifact-mismatch");
    assert.match(mismatch.topic, /payment\.json/);
  });
});

function rejection(attempt: number) {
  return {
    stage: "REVIEW" as const,
    attempt,
    passed: false,
    reason: "Boundary defect",
    feedback: "Fix boundary handling",
    evidence: "diff",
  };
}
