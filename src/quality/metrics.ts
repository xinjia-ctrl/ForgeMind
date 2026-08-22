import type { ForgeMindEvent } from "../core/events.js";
import type { RunStatus } from "../core/types.js";
import type { QualityGrade, RunQualityMetrics } from "./types.js";

export function evaluateRunQuality(events: readonly ForgeMindEvent[]): RunQualityMetrics {
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const finished = [...ordered].reverse().find((event) => event.type === "run.finished");
  const started = ordered.find((event) => event.type === "run.started");
  if (finished?.type !== "run.finished") {
    throw new Error("Run quality requires a run.finished event");
  }
  const gates = ordered.filter(
    (event) => event.type === "gate.passed" || event.type === "gate.rejected",
  );
  const tests = gates.filter((event) => event.data.stage === "TEST");
  const gatesPassed = gates.filter((event) => event.type === "gate.passed").length;
  const testsPassed = tests.filter((event) => event.type === "gate.passed").length;
  const reworkRounds = gates.filter((event) => event.type === "gate.rejected").length;
  const gatePassRate = percentage(gatesPassed, gates.length);
  const testPassRate = percentage(testsPassed, tests.length);
  const codeCoveragePercent = latestCoverage(tests);
  const coverageScore = codeCoveragePercent ?? testPassRate;
  const score = clamp(
    Math.round(
      gatePassRate * 0.4 +
        coverageScore * 0.5 +
        (finished.data.status === "SUCCEEDED" ? 10 : 0) -
        Math.min(20, reworkRounds * 5),
    ),
    0,
    100,
  );
  return {
    runId: finished.data.runId,
    requirement: started?.type === "run.started" ? started.data.requirement : "",
    status: finished.data.status,
    score,
    grade: gradeFor(score),
    gatePassRate,
    gatesPassed,
    gatesTotal: gates.length,
    reworkRounds,
    testPassRate,
    testsPassed,
    testsTotal: tests.length,
    codeCoveragePercent,
    coverageSource: codeCoveragePercent === null ? "unavailable" : "test-output",
    recommendations: recommendationsFor({
      status: finished.data.status,
      gatePassRate,
      gatesTotal: gates.length,
      reworkRounds,
      testPassRate,
      testsTotal: tests.length,
      codeCoveragePercent,
    }),
  };
}

function percentage(passed: number, total: number): number {
  return total === 0 ? 0 : Math.round((passed / total) * 10_000) / 100;
}

function latestCoverage(
  tests: readonly Extract<ForgeMindEvent, { readonly type: "gate.passed" | "gate.rejected" }>[],
): number | null {
  for (let index = tests.length - 1; index >= 0; index -= 1) {
    const coverage = tests[index]?.data.coveragePercent;
    if (coverage !== undefined) return coverage;
  }
  return null;
}

function gradeFor(score: number): QualityGrade {
  if (score >= 90) return "EXCELLENT";
  if (score >= 75) return "GOOD";
  if (score >= 50) return "NEEDS_ATTENTION";
  return "POOR";
}

function recommendationsFor(input: {
  readonly status: RunStatus;
  readonly gatePassRate: number;
  readonly gatesTotal: number;
  readonly reworkRounds: number;
  readonly testPassRate: number;
  readonly testsTotal: number;
  readonly codeCoveragePercent: number | null;
}): readonly string[] {
  const recommendations: string[] = [];
  if (input.status !== "SUCCEEDED") {
    recommendations.push("Resolve the recorded run failure before reusing this implementation.");
  }
  if (input.gatesTotal === 0) {
    recommendations.push("Ensure the run reaches REVIEW and TEST quality gates.");
  } else if (input.gatePassRate < 100) {
    recommendations.push("Use rejected gate feedback to reduce repeat review and test defects.");
  }
  if (input.reworkRounds > 0) {
    recommendations.push(
      `Address recurring gate feedback earlier; this run required ${input.reworkRounds} rework round${input.reworkRounds === 1 ? "" : "s"}.`,
    );
  }
  if (input.testsTotal === 0) {
    recommendations.push("Add or restore a TEST gate before considering the change complete.");
  } else if (input.testPassRate < 100) {
    recommendations.push("Stabilize the configured test command and its failing scenarios.");
  }
  if (input.codeCoveragePercent === null) {
    recommendations.push(
      "Emit FORGEMIND_COVERAGE=<0-100> from the test command to audit code coverage.",
    );
  } else if (input.codeCoveragePercent < 80) {
    recommendations.push("Increase code coverage for changed behavior to at least 80%.");
  }
  return recommendations;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
