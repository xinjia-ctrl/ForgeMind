import type { RunStatus } from "../core/types.js";

export const QUALITY_GRADES = ["EXCELLENT", "GOOD", "NEEDS_ATTENTION", "POOR"] as const;

export type QualityGrade = (typeof QUALITY_GRADES)[number];
export type CoverageSource = "test-output" | "unavailable";

export interface RunQualityMetrics {
  readonly runId: string;
  readonly requirement: string;
  readonly status: RunStatus;
  readonly score: number;
  readonly grade: QualityGrade;
  readonly gatePassRate: number;
  readonly gatesPassed: number;
  readonly gatesTotal: number;
  readonly reworkRounds: number;
  readonly testPassRate: number;
  readonly testsPassed: number;
  readonly testsTotal: number;
  readonly codeCoveragePercent: number | null;
  readonly coverageSource: CoverageSource;
  readonly recommendations: readonly string[];
}
