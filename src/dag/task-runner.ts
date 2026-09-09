import { realpath } from "node:fs/promises";
import { HardFailure } from "../core/errors.js";
import { assertAcceptanceSatisfied } from "../core/acceptance.js";
import type { UpstreamHandoff } from "../core/types.js";
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
    context: {
      readonly parentRunId: string;
      readonly runId: string;
      readonly dependencies: readonly UpstreamHandoff[];
    },
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
    context: {
      readonly parentRunId: string;
      readonly runId: string;
      readonly dependencies: readonly UpstreamHandoff[];
    },
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
      requirementTrust: "untrusted",
      runId: context.runId,
      parentRunId: context.parentRunId,
      taskId: task.taskId,
      acceptanceCriteria: task.acceptanceCriteria,
      upstreamHandoffs: context.dependencies,
    });
    if (execution.result.status === "SUCCEEDED")
      assertAcceptanceSatisfied(execution.result.context);
    const commit = finalCommit(execution.result.context.artifacts);
    const artifacts = finalCodeArtifacts(execution.result.context.artifacts).map((artifact) => ({
      ...artifact,
      ...(commit === undefined ? {} : { version: commit }),
    }));
    const verificationEvidence = finalVerificationEvidence(execution.result.context.gates);
    return {
      runId: execution.result.context.runId,
      status: execution.result.status,
      branch: execution.result.context.repo.branch,
      summary: execution.result.summary,
      artifacts,
      eventLogPath: execution.eventLogPath,
      ...(commit === undefined || execution.result.context.plan === null
        ? {}
        : {
            handoff: {
              taskId: task.taskId,
              repo: task.repo,
              branch: execution.result.context.repo.branch,
              commit,
              summary: execution.result.summary,
              acceptanceCriteria: execution.result.context.plan.acceptanceCriteria,
              verificationEvidence,
              artifacts,
              incompleteItems: [],
            },
          }),
    };
  }
}

function finalVerificationEvidence(
  gates: RunExecution["result"]["context"]["gates"],
): UpstreamHandoff["verificationEvidence"] {
  const latestTest = [...gates].reverse().find((gate) => gate.stage === "TEST");
  const latestReview = [...gates].reverse().find((gate) => gate.stage === "REVIEW");
  return [
    ...(latestTest?.verificationEvidence ?? []),
    ...(latestReview?.verificationEvidence ?? []),
  ];
}

function finalCommit(
  artifacts: RunExecution["result"]["context"]["artifacts"],
): string | undefined {
  return [...artifacts].reverse().find((artifact) => artifact.kind === "commit")?.path;
}

function finalCodeArtifacts(
  artifacts: RunExecution["result"]["context"]["artifacts"],
): RunExecution["result"]["context"]["artifacts"] {
  const byPath = new Map<string, (typeof artifacts)[number]>();
  for (const artifact of artifacts) {
    if (artifact.stage === "CODE" && artifact.kind === "source") {
      byPath.set(artifact.path, artifact);
    }
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}
