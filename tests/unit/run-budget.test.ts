import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RunBudgetTracker, RunStopFailure } from "../../src/core/run-budget.js";

describe("RunBudgetTracker", () => {
  it("accumulates LLM and tool usage across calls", () => {
    const tracker = new RunBudgetTracker({
      maxLlmCalls: 2,
      maxInputTokens: 100,
      maxOutputTokens: 50,
      maxDurationMs: 60_000,
      maxToolCalls: 2,
    });
    const first = tracker.beforeLlm(20, 15);
    tracker.settleLlm(first, 25, 10);
    const second = tracker.beforeLlm(30, 25);
    tracker.settleLlm(second, 35, 20);
    tracker.consumeToolCall();
    tracker.consumeToolCall();

    assert.deepEqual(
      (({ llmCalls, inputTokens, outputTokens, toolCalls }) => ({
        llmCalls,
        inputTokens,
        outputTokens,
        toolCalls,
      }))(tracker.snapshot()),
      { llmCalls: 2, inputTokens: 60, outputTokens: 30, toolCalls: 2 },
    );
    assert.throws(
      () => tracker.beforeLlm(1),
      (error: unknown) =>
        error instanceof RunStopFailure && error.stopReason === "BUDGET_EXHAUSTED",
    );
    assert.throws(
      () => tracker.consumeToolCall(),
      (error: unknown) =>
        error instanceof RunStopFailure && error.stopReason === "BUDGET_EXHAUSTED",
    );
  });

  it("restores cumulative usage and preserves the original duration boundary", () => {
    const tracker = new RunBudgetTracker({
      maxLlmCalls: 3,
      maxInputTokens: 100,
      maxOutputTokens: 100,
      maxDurationMs: 1_000,
      maxToolCalls: 3,
    });
    assert.throws(
      () =>
        tracker.restore({
          llmCalls: 1,
          inputTokens: 10,
          outputTokens: 5,
          estimatedCostUsd: 0.00003,
          toolCalls: 1,
          startedAt: new Date(Date.now() - 2_000).toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      (error: unknown) => error instanceof RunStopFailure && error.stopReason === "TIMEOUT",
    );
  });

  it("rejects fractional call and token limits", () => {
    assert.throws(
      () =>
        new RunBudgetTracker({
          maxLlmCalls: 1.5,
          maxInputTokens: 100,
          maxOutputTokens: 100,
          maxDurationMs: 1_000,
          maxToolCalls: 10,
        }),
      /maxLlmCalls must be a positive safe integer/,
    );
  });

  it("pre-reserves concurrent model capacity before either call settles", () => {
    const tracker = new RunBudgetTracker({
      maxLlmCalls: 3,
      maxInputTokens: 100,
      maxOutputTokens: 50,
      maxDurationMs: 60_000,
      maxToolCalls: 10,
    });
    tracker.beforeLlm(60, 30);
    assert.throws(
      () => tracker.beforeLlm(50, 10),
      (error: unknown) =>
        error instanceof RunStopFailure && error.stopReason === "BUDGET_EXHAUSTED",
    );
  });

  it("releases reserved output when a model call fails", () => {
    const tracker = new RunBudgetTracker({
      maxLlmCalls: 2,
      maxInputTokens: 100,
      maxOutputTokens: 50,
      maxDurationMs: 60_000,
      maxToolCalls: 10,
    });
    const failed = tracker.beforeLlm(20, 50);

    tracker.failLlm(failed);

    const next = tracker.beforeLlm(20, 50);
    tracker.settleLlm(next, 20, 10);
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.llmCalls, 2);
    assert.equal(snapshot.inputTokens, 40);
    assert.equal(snapshot.outputTokens, 10);
  });
});
