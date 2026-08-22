import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EventDataMap, EventType, ForgeMindEvent } from "../../src/core/events.js";
import { extractCoveragePercent } from "../../src/agents/test-agent.js";
import { evaluateRunQuality } from "../../src/quality/metrics.js";

describe("run quality evaluation", () => {
  it("aggregates gates, rework, tests, and explicit coverage deterministically", () => {
    const quality = evaluateRunQuality([
      event(1, "gate.rejected", {
        runId: "quality-run",
        stage: "REVIEW",
        reason: "Missing boundary test",
        feedback: "Add coverage",
      }),
      event(2, "gate.passed", {
        runId: "quality-run",
        stage: "REVIEW",
        evidence: "Reviewed fix",
      }),
      event(3, "gate.passed", {
        runId: "quality-run",
        stage: "TEST",
        evidence: "Tests passed",
        coveragePercent: 84.5,
      }),
      event(4, "run.finished", {
        runId: "quality-run",
        status: "SUCCEEDED",
        summary: "Complete",
      }),
    ]);

    assert.deepEqual(
      {
        score: quality.score,
        grade: quality.grade,
        gatePassRate: quality.gatePassRate,
        gatesPassed: quality.gatesPassed,
        gatesTotal: quality.gatesTotal,
        reworkRounds: quality.reworkRounds,
        testPassRate: quality.testPassRate,
        codeCoveragePercent: quality.codeCoveragePercent,
        coverageSource: quality.coverageSource,
      },
      {
        score: 74,
        grade: "NEEDS_ATTENTION",
        gatePassRate: 66.67,
        gatesPassed: 2,
        gatesTotal: 3,
        reworkRounds: 1,
        testPassRate: 100,
        codeCoveragePercent: 84.5,
        coverageSource: "test-output",
      },
    );
    assert.match(quality.recommendations.join(" "), /required 1 rework round/);
  });

  it("reports unavailable coverage instead of inventing a percentage", () => {
    const quality = evaluateRunQuality([
      event(1, "run.finished", {
        runId: "early-failure",
        status: "FAILED",
        summary: "Stopped before gates",
      }),
    ]);

    assert.equal(quality.score, 0);
    assert.equal(quality.grade, "POOR");
    assert.equal(quality.codeCoveragePercent, null);
    assert.equal(quality.coverageSource, "unavailable");
    assert.match(quality.recommendations.join(" "), /FORGEMIND_COVERAGE/);
  });

  it("extracts only a bounded explicit coverage marker from test output", () => {
    assert.equal(extractCoveragePercent("ok\nFORGEMIND_COVERAGE=91.25\n"), 91.25);
    assert.equal(extractCoveragePercent("FORGEMIND_COVERAGE=101"), null);
    assert.equal(extractCoveragePercent("Statements: 92%"), null);
  });
});

function event<K extends EventType>(
  seq: number,
  type: K,
  data: EventDataMap[K],
): Extract<ForgeMindEvent, { readonly type: K }> {
  return {
    v: 1,
    seq,
    ts: new Date(seq * 1_000).toISOString(),
    type,
    data,
  } as Extract<ForgeMindEvent, { readonly type: K }>;
}
