export type VerificationStrength = "weak" | "moderate" | "strong";

export interface RunQuality {
  readonly runId: string;
  readonly requirement: string;
  readonly outcome: "succeeded" | "failed";
  readonly evidenceCompleteness: number;
  readonly verificationStrength: VerificationStrength;
  readonly coveragePercent: number | null;
  readonly reworkRounds: number;
  readonly policyViolations: number;
  readonly confidence: number;
}

export type RunQualityMetrics = RunQuality;
