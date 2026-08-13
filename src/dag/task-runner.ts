import { realpath } from "node:fs/promises";
import { HardFailure } from "../core/errors.js";
import { runForgeMind, type RunExecution, type RunOptions } from "../runtime/run.js";
import type { DagTask, TaskExecution, TaskRunner } from "./types.js";

type TaskRunOptions = Omit<
  RunOptions,
  "repoPath" | "requirement" | "runId" | "parentRunId" | "taskId"
> & {
  readonly repoPath: string;
};

export interface ForgeMindTaskRunnerOptions {
  readonly createRunOptions: (
    task: DagTask,
    context: { readonly parentRunId: string; readonly runId: string },
  ) => Promise<TaskRunOptions> | TaskRunOptions;
  readonly execute?: (options: RunOptions) => Promise<RunExecution>;
}

export class ForgeMindTaskRunner implements TaskRunner {
  readonly #createRunOptions: ForgeMindTaskRunnerOptions["createRunOptions"];
  readonly #execute: (options: RunOptions) => Promise<RunExecution>;
  readonly #workspaceOwners = new Map<string, string>();

  public constructor(options: ForgeMindTaskRunnerOptions) {
    this.#createRunOptions = options.createRunOptions;
    this.#execute = options.execute ?? runForgeMind;
  }

  public async run(
    task: DagTask,
    context: { readonly parentRunId: string; readonly runId: string },
  ): Promise<TaskExecution> {
    const options = await this.#createRunOptions(task, context);
    const workspaceKey = await realpath(options.repoPath);
    const owner = this.#workspaceOwners.get(workspaceKey);
    if (owner !== undefined && owner !== task.taskId) {
      throw new HardFailure(
        `DAG tasks require independent workspaces; ${workspaceKey} is already assigned to ${owner}`,
      );
    }
    this.#workspaceOwners.set(workspaceKey, task.taskId);
    const execution = await this.#execute({
      ...options,
      repoPath: options.repoPath,
      requirement: task.requirement,
      runId: context.runId,
      parentRunId: context.parentRunId,
      taskId: task.taskId,
    });
    return {
      runId: execution.result.context.runId,
      status: execution.result.status,
      branch: execution.result.context.repo.branch,
      summary: execution.result.summary,
      eventLogPath: execution.eventLogPath,
    };
  }
}
