import type {
  AcceptanceCriterion,
  ArtifactRef,
  RunStatus,
  UpstreamHandoff,
} from "../core/types.js";
import type { DecisionRecord } from "../negotiation/types.js";

export const TASK_STATUSES = ["SUCCEEDED", "FAILED", "BLOCKED"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface DagTask {
  readonly taskId: string;
  readonly deps: readonly string[];
  readonly repo: string;
  readonly requirement: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
}

export interface DagPlan {
  readonly summary: string;
  readonly tasks: readonly DagTask[];
}

export interface TaskExecution {
  readonly runId: string;
  readonly status: RunStatus;
  readonly branch: string;
  readonly summary: string;
  readonly artifacts: readonly ArtifactRef[];
  readonly eventLogPath?: string;
  readonly handoff?: UpstreamHandoff;
}

export interface DagTaskResult {
  readonly taskId: string;
  readonly runId: string;
  readonly repo: string;
  readonly status: TaskStatus;
  readonly branch?: string;
  readonly summary: string;
  readonly commit?: string;
  readonly upstreamCommits?: readonly string[];
}

export interface PRCandidate {
  readonly taskId: string;
  readonly repo: string;
  readonly branch: string;
  readonly requirement: string;
  readonly summary: string;
  readonly baseBranch?: string;
  readonly upstreamBranches: readonly string[];
}

export interface DagResult {
  readonly parentRunId: string;
  readonly status: "SUCCEEDED" | "FAILED" | "PARTIAL";
  readonly tasks: readonly DagTaskResult[];
  readonly decisionRecords: readonly DecisionRecord[];
  readonly prList: readonly PRCandidate[];
}

export interface TaskRunner {
  run(
    task: DagTask,
    options: {
      readonly parentRunId: string;
      readonly runId: string;
      readonly dependencies: readonly UpstreamHandoff[];
    },
  ): Promise<TaskExecution>;
}
