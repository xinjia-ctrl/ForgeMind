export const STAGES = ["PLAN", "ARCH", "CODE", "REVIEW", "TEST", "COMMIT"] as const;

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
  readonly acceptanceCriteria: readonly string[];
  readonly summary: string;
}

export interface ArchitectureFile {
  readonly path: string;
  readonly purpose: string;
}

export interface ArchDecision {
  readonly decisions: readonly string[];
  readonly files: readonly ArchitectureFile[];
  readonly risks: readonly string[];
  readonly summary: string;
}

export type ArtifactKind = "plan" | "architecture" | "source" | "review" | "test" | "commit";

export interface ArtifactRef {
  readonly path: string;
  readonly kind: ArtifactKind;
  readonly summary: string;
  readonly stage: StageId;
}

export interface GateResult {
  readonly stage: GateStage;
  readonly attempt: number;
  readonly passed: boolean;
  readonly reason: string;
  readonly feedback: string;
  readonly evidence: string;
}

export interface TaskContext {
  readonly runId: string;
  readonly requirement: string;
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
