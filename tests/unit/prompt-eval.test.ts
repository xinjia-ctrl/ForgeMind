import assert from "node:assert/strict";
import { it } from "node:test";
import { runPromptEvaluation } from "../../evals/prompt-eval.js";

it("keeps the deterministic prompt evaluation at or above baseline", async () => {
  const report = await runPromptEvaluation();
  assert.equal(report.current.total, 4);
  assert.ok(report.current.passRate >= report.baseline.passRate);
  assert.equal(report.current.reworkRounds, 0);
  assert.equal(report.current.unauthorizedToolCalls, 0);
  assert.ok(report.current.estimatedPromptTokens > 0);
});
