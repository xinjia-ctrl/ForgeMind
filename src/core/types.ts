export const STAGES = ["PLAN", "ARCH", "CODE", "TEST", "REVIEW", "COMMIT"] as const;

export type StageId = (typeof STAGES)[number];
export type GateStage = "REVIEW" | "TEST";
export type StageStatus = "SUCCEEDED" | "FAILED";
export type RunStatus = "SUCCEEDED" | "FAILED" | "BLOCKED";
export type AgentLifecycle = "CREATED" | "RUNNING" | StageStatus;

export interface TokenBudget {
  readonly input: number;
  readonly output: number;
}

export type TokenBudgets = Readonly<Record<StageId, TokenBudget>>;

export interface PlanStep {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

export interface TaskPlan {
  readonly objective: string;
  readonly steps: readonly PlanStep[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly summary: string;
}

export type RequiredEvidence = "test" | "review";

export type AcceptanceVerifier =
  | { readonly kind: "test-suite"; readonly commandId: string }
  | {
      readonly kind: "test-case";
      readonly commandId: string;
      readonly pattern: string;
    }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly assertion: "exists" | "absent" | "contains";
      readonly value?: string;
    }
  | { readonly kind: "behavior"; readonly probeId: string }
  | { readonly kind: "review"; readonly rubric: string };

export interface AcceptanceCriterion {
  readonly id: string;
  readonly description: string;
  readonly requiredEvidence: readonly RequiredEvidence[];
  readonly verifier: AcceptanceVerifier;
}

export interface ArchitectureFile {
  readonly path: string;
  readonly purpose: string;
}

export interface ArchitectureAlternative {
  readonly position: string;
  readonly tradeoffs: readonly string[];
}

export interface ArchDecision {
  readonly decisions: readonly string[];
  readonly files: readonly ArchitectureFile[];
  readonly risks: readonly string[];
  readonly alternatives?: readonly ArchitectureAlternative[];
  readonly summary: string;
}

export type ArtifactKind = "plan" | "architecture" | "source" | "review" | "test" | "commit";

export interface ArtifactRef {
  readonly path: string;
  readonly kind: ArtifactKind;
  readonly summary: string;
  readonly stage: StageId;
  readonly version?: string;
}

export interface GateResult {
  readonly stage: GateStage;
  readonly attempt: number;
  readonly passed: boolean;
  readonly reason: string;
  readonly feedback: string;
  readonly evidence: string;
  readonly artifactFingerprint: string;
  readonly verificationEvidence: readonly VerificationEvidence[];
  readonly coveragePercent?: number;
}

export interface VerificationEvidence {
  readonly criterionId: string;
  readonly verifierKind: AcceptanceVerifier["kind"];
  readonly source: string;
  readonly artifactFingerprint: string;
  readonly passed: boolean;
  readonly details: string;
}

export interface TaskContext {
  readonly runId: string;
  readonly requirement: string;
  readonly requirementTrust?: "trusted" | "untrusted";
  readonly requiredAcceptanceCriteria?: readonly AcceptanceCriterion[];
  readonly upstreamHandoffs?: readonly UpstreamHandoff[];
  readonly repo: { readonly path: string; readonly branch: string };
  readonly plan: TaskPlan | null;
  readonly architecture: ArchDecision | null;
  readonly artifacts: readonly ArtifactRef[];
  readonly gates: readonly GateResult[];
  readonly meta: {
    readonly attempt: { readonly stage: StageId; readonly count: number };
    readonly tokenBudget: TokenBudgets;
  };
}

export interface UpstreamHandoff {
  readonly taskId: string;
  readonly repo: string;
  readonly branch: string;
  readonly commit: string;
  readonly summary: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly verificationEvidence: readonly VerificationEvidence[];
  readonly artifacts: readonly ArtifactRef[];
  readonly incompleteItems: readonly string[];
}

export interface StageInput {
  readonly attempt: number;
  readonly feedback?: string;
}

export interface PlanStageOutput {
  readonly kind: "plan";
  readonly plan: TaskPlan;
  readonly artifact: ArtifactRef;
}

export interface ArchitectureStageOutput {
  readonly kind: "architecture";
  readonly architecture: ArchDecision;
  readonly artifact: ArtifactRef;
}

export interface CodeStageOutput {
  readonly kind: "code";
  readonly summary: string;
  readonly artifacts: readonly ArtifactRef[];
}

export interface GateStageOutput {
  readonly kind: "gate";
  readonly gate: GateResult;
}

export interface CommitStageOutput {
  readonly kind: "commit";
  readonly commit: string;
  readonly artifact: ArtifactRef;
}

export type StageOutput =
  PlanStageOutput | ArchitectureStageOutput | CodeStageOutput | GateStageOutput | CommitStageOutput;

export interface StageAgent {
  readonly id: StageId;
  readonly tools: readonly string[];
  readonly lifecycle: AgentLifecycle;
  run(input: StageInput, ctx: TaskContext): Promise<StageOutput>;
}

export interface RunResult {
  readonly status: RunStatus;
  readonly context: TaskContext;
  readonly summary: string;
}
