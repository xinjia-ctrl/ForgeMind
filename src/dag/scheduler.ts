import { createHash } from "node:crypto";
import { errorMessage, HardFailure } from "../core/errors.js";
import { assertValidRunId, type EventLog } from "../core/event-log.js";
import type { ArtifactRef } from "../core/types.js";
import { persistDecisionRecord, type DecisionRecordStore } from "../negotiation/record.js";
import { detectArtifactMismatch } from "../negotiation/triggers.js";
import type {
  DecisionRecord,
  NegotiationArtifact,
  NegotiationCoordinator,
} from "../negotiation/types.js";
import { validateDagTasks } from "./plan.js";
import type {
  DagResult,
  DagTask,
  DagTaskResult,
  PRCandidate,
  TaskExecution,
  TaskRunner,
} from "./types.js";

export interface DagSchedulerOptions {
  readonly parentRunId: string;
  readonly taskRunner: TaskRunner;
  readonly eventLog?: EventLog;
  readonly negotiation?: NegotiationCoordinator;
  readonly memory?: DecisionRecordStore;
  readonly maxConcurrency?: number;
}

interface CompletedTask {
  readonly result: DagTaskResult;
  readonly artifacts: readonly ArtifactRef[];
}

export class DagScheduler {
  readonly #parentRunId: string;
  readonly #taskRunner: TaskRunner;
  readonly #eventLog: EventLog | undefined;
  readonly #negotiation: NegotiationCoordinator | undefined;
  readonly #memory: DecisionRecordStore | undefined;
  readonly #maxConcurrency: number;

  public constructor(options: DagSchedulerOptions) {
    assertValidRunId(options.parentRunId);
    this.#parentRunId = options.parentRunId;
    this.#taskRunner = options.taskRunner;
    this.#eventLog = options.eventLog;
    this.#negotiation = options.negotiation;
    this.#memory = options.memory;
    this.#maxConcurrency = options.maxConcurrency ?? 4;
    if (!Number.isInteger(this.#maxConcurrency) || this.#maxConcurrency < 1) {
      throw new HardFailure("maxConcurrency must be a positive integer");
    }
  }

  public async run(tasks: readonly DagTask[]): Promise<DagResult> {
    validateDagTasks(tasks);
    const byId = new Map(tasks.map((task) => [task.taskId, task]));
    const results = new Map<string, DagTaskResult>();
    const pending = new Set(tasks.map((task) => task.taskId));
    const running = new Map<string, Promise<CompletedTask>>();
    const artifacts: NegotiationArtifact[] = [];
    const negotiatedPaths = new Set<string>();
    const decisionRecords: DecisionRecord[] = [];

    while (pending.size > 0 || running.size > 0) {
      await this.propagateBlocked(tasks, pending, results);
      for (const task of tasks) {
        if (running.size >= this.#maxConcurrency) break;
        if (
          pending.has(task.taskId) &&
          task.deps.every((dependency) => results.get(dependency)?.status === "SUCCEEDED")
        ) {
          pending.delete(task.taskId);
          running.set(task.taskId, this.execute(task));
        }
      }
      if (running.size === 0 && pending.size > 0) {
        throw new HardFailure("DAG scheduler reached an invalid dependency state");
      }
      if (running.size === 0) break;
      const completed = await Promise.race(running.values());
      running.delete(completed.result.taskId);
      results.set(completed.result.taskId, completed.result);
      if (completed.result.status === "SUCCEEDED") {
        artifacts.push(
          ...completed.artifacts.map((artifact) => ({
            taskId: completed.result.taskId,
            artifact,
          })),
        );
        await this.negotiateArtifactMismatches(artifacts, negotiatedPaths, decisionRecords);
      }
    }

    const orderedResults = tasks.map((task) => {
      const result = results.get(task.taskId);
      if (result === undefined) throw new HardFailure(`Missing result for task ${task.taskId}`);
      return result;
    });
    const succeeded = orderedResults.filter((result) => result.status === "SUCCEEDED");
    const status =
      succeeded.length === orderedResults.length
        ? "SUCCEEDED"
        : succeeded.length === 0
          ? "FAILED"
          : "PARTIAL";
    return {
      parentRunId: this.#parentRunId,
      status,
      tasks: orderedResults,
      decisionRecords,
      prList: status === "SUCCEEDED" ? prCandidates(tasks, orderedResults, byId) : [],
    };
  }

  private async negotiateArtifactMismatches(
    artifacts: readonly NegotiationArtifact[],
    negotiatedPaths: Set<string>,
    records: DecisionRecord[],
  ): Promise<void> {
    if (this.#negotiation === undefined) return;
    const paths = [
      ...new Set(
        artifacts.map((entry) => entry.artifact.path).filter((path) => !negotiatedPaths.has(path)),
      ),
    ].sort((left, right) => left.localeCompare(right));
    for (const path of paths) {
      const evidence = detectArtifactMismatch(
        artifacts.filter((entry) => entry.artifact.path === path),
      );
      if (evidence === null) continue;
      negotiatedPaths.add(path);
      const negotiation = await this.#negotiation.negotiate({
        runId: this.#parentRunId,
        ...evidence,
      });
      if (negotiation.decisionRecord === null) continue;
      records.push(negotiation.decisionRecord);
      if (this.#memory !== undefined) {
        await persistDecisionRecord(this.#memory, negotiation.decisionRecord);
      }
    }
  }

  private async propagateBlocked(
    tasks: readonly DagTask[],
    pending: Set<string>,
    results: Map<string, DagTaskResult>,
  ): Promise<void> {
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks) {
        if (!pending.has(task.taskId)) continue;
        const failedDependencies = task.deps.filter((dependency) => {
          const status = results.get(dependency)?.status;
          return status === "FAILED" || status === "BLOCKED";
        });
        if (failedDependencies.length === 0) continue;
        const runId = childRunId(this.#parentRunId, task.taskId);
        const summary = `Blocked by failed dependencies: ${failedDependencies.join(", ")}`;
        const result: DagTaskResult = {
          taskId: task.taskId,
          runId,
          repo: task.repo,
          status: "BLOCKED",
          summary,
        };
        results.set(task.taskId, result);
        pending.delete(task.taskId);
        await this.#eventLog?.append({
          type: "task.failed",
          data: {
            runId: this.#parentRunId,
            taskId: task.taskId,
            childRunId: runId,
            repo: task.repo,
            status: "BLOCKED",
            error: summary,
          },
        });
        changed = true;
      }
    }
  }

  private async execute(task: DagTask): Promise<CompletedTask> {
    const runId = childRunId(this.#parentRunId, task.taskId);
    await this.#eventLog?.append({
      type: "task.started",
      data: {
        runId: this.#parentRunId,
        taskId: task.taskId,
        childRunId: runId,
        repo: task.repo,
        requirement: task.requirement,
      },
    });
    let execution: TaskExecution;
    try {
      execution = await this.#taskRunner.run(task, { parentRunId: this.#parentRunId, runId });
    } catch (error) {
      const summary = errorMessage(error);
      await this.recordFailure(task, runId, summary);
      return {
        result: { taskId: task.taskId, runId, repo: task.repo, status: "FAILED", summary },
        artifacts: [],
      };
    }
    if (execution.runId !== runId) {
      const summary = `Task runner returned unexpected run id ${execution.runId}; expected ${runId}`;
      await this.recordFailure(task, runId, summary);
      return {
        result: { taskId: task.taskId, runId, repo: task.repo, status: "FAILED", summary },
        artifacts: [],
      };
    }
    if (execution.status === "SUCCEEDED" && execution.branch.trim().length === 0) {
      const summary = "Successful task runner result must include a branch";
      await this.recordFailure(task, runId, summary);
      return {
        result: { taskId: task.taskId, runId, repo: task.repo, status: "FAILED", summary },
        artifacts: [],
      };
    }
    if (execution.status !== "SUCCEEDED") {
      await this.recordFailure(task, execution.runId, execution.summary);
      return {
        result: {
          taskId: task.taskId,
          runId: execution.runId,
          repo: task.repo,
          status: "FAILED",
          branch: execution.branch,
          summary: execution.summary,
        },
        artifacts: [],
      };
    }
    await this.#eventLog?.append({
      type: "task.completed",
      data: {
        runId: this.#parentRunId,
        taskId: task.taskId,
        childRunId: execution.runId,
        repo: task.repo,
        branch: execution.branch,
        status: "SUCCEEDED",
        summary: execution.summary,
      },
    });
    return {
      result: {
        taskId: task.taskId,
        runId: execution.runId,
        repo: task.repo,
        status: "SUCCEEDED",
        branch: execution.branch,
        summary: execution.summary,
      },
      artifacts: execution.artifacts,
    };
  }

  private async recordFailure(task: DagTask, runId: string, summary: string): Promise<void> {
    await this.#eventLog?.append({
      type: "task.failed",
      data: {
        runId: this.#parentRunId,
        taskId: task.taskId,
        childRunId: runId,
        repo: task.repo,
        status: "FAILED",
        error: summary,
      },
    });
  }
}

export function childRunId(parentRunId: string, taskId: string): string {
  const digest = createHash("sha256")
    .update(`${parentRunId}\0${taskId}`)
    .digest("hex")
    .slice(0, 12);
  const prefix = parentRunId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
  const task = taskId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 24);
  return `${prefix}-${task}-${digest}`;
}

function prCandidates(
  tasks: readonly DagTask[],
  results: readonly DagTaskResult[],
  byId: ReadonlyMap<string, DagTask>,
): readonly PRCandidate[] {
  return results.map((result, index) => {
    const task = byId.get(result.taskId) ?? tasks[index];
    if (task === undefined || result.branch === undefined) {
      throw new HardFailure(`Successful task ${result.taskId} has no PR candidate metadata`);
    }
    return {
      taskId: task.taskId,
      repo: task.repo,
      branch: result.branch,
      requirement: task.requirement,
      summary: result.summary,
    };
  });
}
