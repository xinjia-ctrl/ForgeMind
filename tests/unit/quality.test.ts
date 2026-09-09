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
        artifactFingerprint: "fingerprint",
        verificationEvidence: [],
      }),
      event(2, "gate.passed", {
        runId: "quality-run",
        stage: "REVIEW",
        evidence: "Reviewed fix",
        artifactFingerprint: "fingerprint",
        verificationEvidence: [evidence("review:model", "review")],
      }),
      event(3, "gate.passed", {
        runId: "quality-run",
        stage: "TEST",
        evidence: "Tests passed",
        coveragePercent: 84.5,
        artifactFingerprint: "fingerprint",
        verificationEvidence: [evidence("test:case:primary", "test-case")],
      }),
      event(4, "run.finished", {
        runId: "quality-run",
        status: "SUCCEEDED",
        summary: "Complete",
      }),
    ]);

    assert.deepEqual(
      {
        outcome: quality.outcome,
        evidenceCompleteness: quality.evidenceCompleteness,
        verificationStrength: quality.verificationStrength,
        reworkRounds: quality.reworkRounds,
        coveragePercent: quality.coveragePercent,
        policyViolations: quality.policyViolations,
        confidence: quality.confidence,
      },
      {
        outcome: "succeeded",
        evidenceCompleteness: 100,
        verificationStrength: "strong",
        reworkRounds: 1,
        coveragePercent: 84.5,
        policyViolations: 0,
        confidence: 1,
      },
    );
  });

  it("reports unavailable coverage instead of inventing a percentage", () => {
    const quality = evaluateRunQuality([
      event(1, "run.finished", {
        runId: "early-failure",
        status: "FAILED",
        summary: "Stopped before gates",
      }),
    ]);

    assert.equal(quality.outcome, "failed");
    assert.equal(quality.evidenceCompleteness, 0);
    assert.equal(quality.verificationStrength, "weak");
    assert.equal(quality.coveragePercent, null);
    assert.equal(quality.confidence, 0);
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

function evidence(source: string, verifierKind: "review" | "test-case") {
  return {
    criterionId: "AC-1",
    verifierKind,
    source,
    artifactFingerprint: "fingerprint",
    passed: true,
    details: "Bound evidence",
  };
}
