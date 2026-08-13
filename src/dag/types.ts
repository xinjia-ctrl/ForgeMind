import type { RunStatus } from "../core/types.js";

export const TASK_STATUSES = ["SUCCEEDED", "FAILED", "BLOCKED"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface DagTask {
  readonly taskId: string;
  readonly deps: readonly string[];
  readonly repo: string;
  readonly requirement: string;
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
  readonly eventLogPath?: string;
}

export interface DagTaskResult {
  readonly taskId: string;
  readonly runId: string;
  readonly repo: string;
  readonly status: TaskStatus;
  readonly branch?: string;
  readonly summary: string;
}

export interface PRCandidate {
  readonly taskId: string;
  readonly repo: string;
  readonly branch: string;
  readonly requirement: string;
  readonly summary: string;
}

export interface DagResult {
  readonly parentRunId: string;
  readonly status: "SUCCEEDED" | "FAILED" | "PARTIAL";
  readonly tasks: readonly DagTaskResult[];
  readonly prList: readonly PRCandidate[];
}

export interface TaskRunner {
  run(
    task: DagTask,
    options: { readonly parentRunId: string; readonly runId: string },
  ): Promise<TaskExecution>;
}
