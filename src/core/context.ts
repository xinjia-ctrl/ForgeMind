import type {
  ArchDecision,
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
  readonly repoPath: string;
  readonly branch: string;
  readonly tokenBudget: TokenBudgets;
}

export function createTaskContext(options: InitialContextOptions): TaskContext {
  return freezeContext({
    runId: options.runId,
    requirement: options.requirement,
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

export function withAttempt(
  ctx: TaskContext,
  stage: StageId,
  count: number,
): TaskContext {
  return freezeContext({
    ...ctx,
    meta: { ...ctx.meta, attempt: { stage, count } },
  });
}

export function withPlan(
  ctx: TaskContext,
  plan: TaskPlan,
  artifact: ArtifactRef,
): TaskContext {
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

export function withArtifacts(
  ctx: TaskContext,
  artifacts: readonly ArtifactRef[],
): TaskContext {
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
