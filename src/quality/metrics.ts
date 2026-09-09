import type { ForgeMindEvent } from "../core/events.js";
import type { RunQuality, VerificationStrength } from "./types.js";

type GateEvent = Extract<ForgeMindEvent, { readonly type: "gate.passed" | "gate.rejected" }>;

export function evaluateRunQuality(events: readonly ForgeMindEvent[]): RunQuality {
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const finished = [...ordered].reverse().find((event) => event.type === "run.finished");
  const started = ordered.find((event) => event.type === "run.started");
  if (finished?.type !== "run.finished") {
    throw new Error("Run quality requires a run.finished event");
  }
  const gates = ordered.filter(
    (event): event is GateEvent => event.type === "gate.passed" || event.type === "gate.rejected",
  );
  const latestTest = latestGate(gates, "TEST");
  const latestReview = latestGate(gates, "REVIEW");
  const evidenceCompleteness = round(
    (stageEvidenceCompleteness(latestTest) + stageEvidenceCompleteness(latestReview)) / 2,
    2,
  );
  const fingerprintsMatch =
    latestTest !== undefined &&
    latestReview !== undefined &&
    latestTest.data.artifactFingerprint === latestReview.data.artifactFingerprint;
  const verificationStrength = strengthFor(latestTest, latestReview, fingerprintsMatch);
  const outcome = finished.data.status === "SUCCEEDED" ? "succeeded" : "failed";
  const coveragePercent = latestCoverage(gates.filter((gate) => gate.data.stage === "TEST"));
  const reworkRounds = gates.filter((gate) => gate.type === "gate.rejected").length;
  const policyViolations = ordered.filter((event) => event.type === "approval.rejected").length;
  const confidence = confidenceFor({
    outcome,
    evidenceCompleteness,
    verificationStrength,
    fingerprintsMatch,
    policyViolations,
  });
  return {
    runId: finished.data.runId,
    requirement: started?.type === "run.started" ? started.data.requirement : "",
    outcome,
    evidenceCompleteness,
    verificationStrength,
    coveragePercent,
    reworkRounds,
    policyViolations,
    confidence,
  };
}

function latestGate(gates: readonly GateEvent[], stage: "TEST" | "REVIEW"): GateEvent | undefined {
  return [...gates].reverse().find((gate) => gate.data.stage === stage);
}

function stageEvidenceCompleteness(gate: GateEvent | undefined): number {
  if (gate === undefined) return 0;
  const evidence = gate.data.verificationEvidence;
  if (evidence.length === 0) return gate.type === "gate.passed" ? 100 : 0;
  const passed = evidence.filter(
    (item) =>
      item.passed &&
      item.details.trim().length > 0 &&
      item.artifactFingerprint === gate.data.artifactFingerprint,
  ).length;
  return (passed / evidence.length) * 100;
}

function strengthFor(
  test: GateEvent | undefined,
  review: GateEvent | undefined,
  fingerprintsMatch: boolean,
): VerificationStrength {
  if (test?.type !== "gate.passed" || review?.type !== "gate.passed" || !fingerprintsMatch) {
    return "weak";
  }
  const specificBehavior = test.data.verificationEvidence.some((item) =>
    ["test-case", "file", "behavior"].includes(item.verifierKind),
  );
  const independentReview = review.data.verificationEvidence.some((item) =>
    item.source.startsWith("review:"),
  );
  return specificBehavior && independentReview ? "strong" : "moderate";
}

function latestCoverage(tests: readonly GateEvent[]): number | null {
  for (let index = tests.length - 1; index >= 0; index -= 1) {
    const coverage = tests[index]?.data.coveragePercent;
    if (coverage !== undefined) return coverage;
  }
  return null;
}

function confidenceFor(input: {
  readonly outcome: "succeeded" | "failed";
  readonly evidenceCompleteness: number;
  readonly verificationStrength: VerificationStrength;
  readonly fingerprintsMatch: boolean;
  readonly policyViolations: number;
}): number {
  const strength =
    input.verificationStrength === "strong"
      ? 0.2
      : input.verificationStrength === "moderate"
        ? 0.12
        : 0;
  let confidence = (input.evidenceCompleteness / 100) * 0.65 + strength;
  if (input.outcome === "succeeded") confidence += 0.15;
  if (!input.fingerprintsMatch) confidence = Math.min(confidence, 0.49);
  if (input.policyViolations > 0) confidence = Math.min(confidence, 0.69);
  return round(Math.max(0, Math.min(1, confidence)), 3);
}

function round(value: number, digits: number): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}
