export type RunProfile = "light" | "standard" | "dag";

export interface RunProfileDecision {
  readonly profile: RunProfile;
  readonly includePlan: true;
  readonly includeArchitecture: boolean;
  readonly reason: string;
}

export interface RunProfileSignals {
  readonly repositoryCount?: number;
  readonly estimatedFileCount?: number;
  readonly touchesPublicInterface?: boolean;
  readonly touchesDependencies?: boolean;
  readonly touchesDatabase?: boolean;
  readonly architectureChangeRequested?: boolean;
  readonly independentSubgoalCount?: number;
}

export function selectRunProfile(
  options: RunProfileSignals & {
    readonly requirement: string;
    readonly explicit?: RunProfile;
  },
): RunProfileDecision {
  const repositoryCount = options.repositoryCount ?? 1;
  const estimatedFileCount = options.estimatedFileCount ?? 0;
  const independentSubgoalCount = options.independentSubgoalCount ?? 0;
  if (!Number.isSafeInteger(repositoryCount) || repositoryCount < 1) {
    throw new Error("repositoryCount must be a positive safe integer");
  }
  if (!Number.isSafeInteger(estimatedFileCount) || estimatedFileCount < 0) {
    throw new Error("estimatedFileCount must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(independentSubgoalCount) || independentSubgoalCount < 0) {
    throw new Error("independentSubgoalCount must be a non-negative safe integer");
  }
  const requirement = options.requirement.toLocaleLowerCase();
  const complex =
    estimatedFileCount > 3 ||
    options.touchesPublicInterface === true ||
    options.touchesDependencies === true ||
    options.touchesDatabase === true ||
    options.architectureChangeRequested === true ||
    /\b(?:architecture|architectural|public api|database|schema migration|dependency|dependencies|protocol|cross[- ]module|breaking change)\b/u.test(
      requirement,
    );
  if (options.explicit === "dag" || repositoryCount > 1 || independentSubgoalCount > 1) {
    return {
      profile: "dag",
      includePlan: true,
      includeArchitecture: true,
      reason:
        repositoryCount > 1
          ? "multiple repositories"
          : independentSubgoalCount > 1
            ? "parallel independent subgoals"
            : "explicit DAG profile",
    };
  }
  const profile =
    options.explicit ??
    (/\b(?:typo|rename|one[- ]line|single[- ]file|small fix|hotfix)\b/u.test(requirement)
      ? "light"
      : "standard");
  return {
    profile,
    includePlan: true,
    includeArchitecture: complex,
    reason: complex
      ? estimatedFileCount > 3
        ? "multi-file architecture-sensitive change"
        : "architecture-sensitive requirement"
      : `${profile} deterministic route`,
  };
}
