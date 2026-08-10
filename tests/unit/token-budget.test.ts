import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HardFailure } from "../../src/core/errors.js";
import { estimateTokens, TokenBudgetTracker } from "../../src/core/token-budget.js";

describe("TokenBudgetTracker", () => {
  it("tracks bounded input and output independently", () => {
    const tracker = new TokenBudgetTracker({ input: 10, output: 5 });
    tracker.ensureInputFits(6);
    tracker.consumeInput(6);
    tracker.consumeOutput(4);
    assert.deepEqual(tracker.usage, { input: 6, output: 4 });
  });

  it("fails fast before a budget is exceeded", () => {
    const tracker = new TokenBudgetTracker({ input: 3, output: 2 });
    tracker.consumeInput(3);
    assert.throws(() => tracker.ensureInputFits(1), HardFailure);
    assert.throws(() => tracker.consumeOutput(3), HardFailure);
  });

  it("uses a deterministic conservative estimate", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("12345"), 2);
  });
});
