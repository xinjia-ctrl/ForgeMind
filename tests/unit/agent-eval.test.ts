import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  renderRealAgentEvaluationMarkdown,
  summarizeRealAgentResults,
  type RealAgentEvalReport,
  type ScenarioResult,
} from "../../evals/agent-eval.js";

describe("real agent evaluation reporting", () => {
  it("aggregates outcome, evidence, recovery, safety, efficiency, and latency metrics", () => {
    const results = [
      scenario({ name: "correctness", category: "correctness", passed: true }),
      scenario({
        name: "recovery",
        category: "recovery",
        passed: true,
        faultInjected: true,
        crashRecoveries: 1,
        hiddenChecksPassed: 3,
        hiddenChecksTotal: 3,
        estimatedCostUsd: 0.02,
        durationMs: 20_000,
      }),
      scenario({
        name: "safety",
        category: "safety",
        passed: false,
        acceptanceCriteriaPassed: 1,
        hiddenChecksPassed: 2,
        hiddenChecksTotal: 3,
        unauthorizedToolCalls: 1,
        toolFailures: 2,
        estimatedCostUsd: 0.03,
        durationMs: 30_000,
      }),
    ] as const;

    const summary = summarizeRealAgentResults(results);

    assert.equal(summary.runCount, 3);
    assert.equal(summary.taskSuccessRate, 0.666667);
    assert.equal(summary.scenarioReliabilityRate, 0.666667);
    assert.equal(summary.cleanFirstPassRate, 0.5);
    assert.equal(summary.acceptanceEvidenceRate, 0.833333);
    assert.equal(summary.hiddenCheckPassRate, 0.875);
    assert.equal(summary.recoverySuccessRate, 1);
    assert.equal(summary.safetyPassRate, 0);
    assert.equal(summary.toolSuccessRate, 0.933333);
    assert.equal(summary.unauthorizedToolCallRate, 0.033333);
    assert.equal(summary.p50DurationMs, 20_000);
    assert.equal(summary.p95DurationMs, 30_000);
    assert.equal(summary.estimatedTotalCostUsd, 0.06);
  });

  it("renders a recruiter-readable Markdown scorecard", () => {
    const results = [scenario({ name: "bug-fix", category: "correctness", passed: true })];
    const report: RealAgentEvalReport = {
      kind: "real-agent-evaluation",
      benchmarkVersion: "1.0",
      benchmarkHash: "a".repeat(64),
      provider: "deepseek",
      model: "deepseek-flash",
      generatedAt: "2026-09-12T00:00:00.000Z",
      trialsPerScenario: 1,
      system: {
        revision: "abc123",
        dirty: false,
        node: "v22.0.0",
        platform: "darwin",
        architecture: "arm64",
      },
      pricing: {
        inputUsdPerMillion: 0.44,
        outputUsdPerMillion: 1.32,
        label: "conservative upper bound",
      },
      passed: 1,
      total: 1,
      passRate: 1,
      summary: summarizeRealAgentResults(results),
      scenarios: results,
    };

    const markdown = renderRealAgentEvaluationMarkdown(report);

    assert.match(markdown, /任务成功率 \| 100\.0%/u);
    assert.match(markdown, /故障恢复成功率 \| N\/A/u);
    assert.match(markdown, /bug-fix/u);
    assert.match(markdown, /conservative upper bound/u);
  });
});

function scenario(
  overrides: Partial<ScenarioResult> & Pick<ScenarioResult, "name" | "category" | "passed">,
): ScenarioResult {
  const { name, category, passed, ...rest } = overrides;
  return {
    name,
    category,
    difficulty: "intermediate",
    capabilities: ["fixture"],
    trial: 1,
    faultInjected: false,
    passed,
    status: passed ? "SUCCEEDED" : "FAILED",
    semanticFailures: passed ? [] : ["fixture failure"],
    hiddenChecksPassed: 2,
    hiddenChecksTotal: 2,
    acceptanceEvidenceComplete: passed,
    acceptanceCriteriaPassed: passed ? 2 : 0,
    acceptanceCriteriaTotal: 2,
    modelCalls: 4,
    reworkRounds: 0,
    crashRecoveries: 0,
    toolCalls: 10,
    toolFailures: 0,
    unauthorizedToolCalls: 0,
    inputTokens: 1_000,
    outputTokens: 200,
    durationMs: 10_000,
    estimatedCostUsd: 0.01,
    finalAcceptanceEvidence: [],
    ...rest,
  };
}
