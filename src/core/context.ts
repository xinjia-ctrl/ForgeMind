import type {
  ArchDecision,
  AcceptanceCriterion,
  ArtifactRef,
  GateResult,
  StageId,
  TaskContext,
  TaskPlan,
  TokenBudgets,
} from "./types.js";

interface InitialContextOptions {
  readonly runId: string;
  readonly requirement: string;
  readonly requirementTrust?: "trusted" | "untrusted";
  readonly requiredAcceptanceCriteria?: readonly AcceptanceCriterion[];
  readonly upstreamHandoffs?: TaskContext["upstreamHandoffs"];
  readonly repoPath: string;
  readonly branch: string;
  readonly tokenBudget: TokenBudgets;
}

export function createTaskContext(options: InitialContextOptions): TaskContext {
  return freezeContext({
    runId: options.runId,
    requirement: options.requirement,
    requirementTrust: options.requirementTrust ?? "trusted",
    ...(options.requiredAcceptanceCriteria === undefined
      ? {}
      : { requiredAcceptanceCriteria: [...options.requiredAcceptanceCriteria] }),
    ...(options.upstreamHandoffs === undefined
      ? {}
      : { upstreamHandoffs: [...options.upstreamHandoffs] }),
    repo: { path: options.repoPath, branch: options.branch },
    plan: null,
    architecture: null,
    artifacts: [],
    gates: [],
    meta: {
      attempt: { stage: "PLAN", count: 1 },
      tokenBudget: options.tokenBudget,
    },
  });
}

export function withAttempt(ctx: TaskContext, stage: StageId, count: number): TaskContext {
  return freezeContext({
    ...ctx,
    meta: { ...ctx.meta, attempt: { stage, count } },
  });
}

export function withPlan(ctx: TaskContext, plan: TaskPlan, artifact: ArtifactRef): TaskContext {
  return freezeContext({
    ...ctx,
    plan,
    artifacts: [...ctx.artifacts, artifact],
  });
}

export function withArchitecture(
  ctx: TaskContext,
  architecture: ArchDecision,
  artifact: ArtifactRef,
): TaskContext {
  return freezeContext({
    ...ctx,
    architecture,
    artifacts: [...ctx.artifacts, artifact],
  });
}

export function withUpdatedArchitecture(ctx: TaskContext, architecture: ArchDecision): TaskContext {
  return freezeContext({
    ...ctx,
    architecture,
    artifacts: ctx.artifacts.map((artifact) =>
      artifact.stage === "ARCH" ? { ...artifact, summary: architecture.summary } : artifact,
    ),
  });
}

export function withAcceptanceCriteria(
  ctx: TaskContext,
  acceptanceCriteria: readonly AcceptanceCriterion[],
): TaskContext {
  if (ctx.plan === null) throw new Error("Cannot update acceptance criteria without a plan");
  return freezeContext({
    ...ctx,
    plan: { ...ctx.plan, acceptanceCriteria: [...acceptanceCriteria] },
  });
}

export function withArtifacts(ctx: TaskContext, artifacts: readonly ArtifactRef[]): TaskContext {
  return freezeContext({
    ...ctx,
    artifacts: [...ctx.artifacts, ...artifacts],
  });
}

export function withGate(ctx: TaskContext, gate: GateResult): TaskContext {
  return freezeContext({ ...ctx, gates: [...ctx.gates, gate] });
}

function freezeContext(ctx: TaskContext): TaskContext {
  return deepFreeze(ctx);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
