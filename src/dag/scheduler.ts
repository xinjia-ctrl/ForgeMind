import { createHash } from "node:crypto";
import { errorMessage, HardFailure, isCancellation, throwIfCancelled } from "../core/errors.js";
import { assertValidRunId, type EventLog } from "../core/event-log.js";
import type { ArtifactRef } from "../core/types.js";
import type { UpstreamHandoff } from "../core/types.js";
import { persistDecisionRecord, type DecisionRecordStore } from "../negotiation/record.js";
import { bindDecisionAcceptanceCriteria } from "../negotiation/acceptance.js";
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
  readonly signal?: AbortSignal;
}

interface CompletedTask {
  readonly result: DagTaskResult;
  readonly artifacts: readonly ArtifactRef[];
  readonly handoff?: UpstreamHandoff;
}

export class DagScheduler {
  readonly #parentRunId: string;
  readonly #taskRunner: TaskRunner;
  readonly #eventLog: EventLog | undefined;
  readonly #negotiation: NegotiationCoordinator | undefined;
  readonly #memory: DecisionRecordStore | undefined;
  readonly #maxConcurrency: number;
  readonly #signal: AbortSignal | undefined;

  public constructor(options: DagSchedulerOptions) {
    assertValidRunId(options.parentRunId);
    this.#parentRunId = options.parentRunId;
    this.#taskRunner = options.taskRunner;
    this.#eventLog = options.eventLog;
    this.#negotiation = options.negotiation;
    this.#memory = options.memory;
    this.#maxConcurrency = options.maxConcurrency ?? 4;
    this.#signal = options.signal;
    if (!Number.isInteger(this.#maxConcurrency) || this.#maxConcurrency < 1) {
      throw new HardFailure("maxConcurrency must be a positive integer");
    }
  }

  public async run(tasks: readonly DagTask[]): Promise<DagResult> {
    throwIfCancelled(this.#signal);
    validateDagTasks(tasks);
    const byId = new Map(tasks.map((task) => [task.taskId, task]));
    const runtimeTasks = new Map(tasks.map((task) => [task.taskId, task]));
    const results = new Map<string, DagTaskResult>();
    const pending = new Set(tasks.map((task) => task.taskId));
    const running = new Map<string, Promise<CompletedTask>>();
    const artifacts: NegotiationArtifact[] = [];
    const negotiatedPaths = new Set<string>();
    const decisionRecords: DecisionRecord[] = [];
    const handoffs = new Map<string, UpstreamHandoff>();

    while (pending.size > 0 || running.size > 0) {
      throwIfCancelled(this.#signal);
      await this.propagateBlocked(tasks, pending, results);
      for (const task of tasks) {
        if (running.size >= this.#maxConcurrency) break;
        if (
          pending.has(task.taskId) &&
          task.deps.every((dependency) => results.get(dependency)?.status === "SUCCEEDED")
        ) {
          pending.delete(task.taskId);
          const dependencies = task.deps.map((dependency) => {
            const handoff = handoffs.get(dependency);
            if (handoff === undefined) {
              throw new HardFailure(`Task ${task.taskId} has no handoff from ${dependency}`);
            }
            return handoff;
          });
          const runtimeTask = runtimeTasks.get(task.taskId);
          if (runtimeTask === undefined) throw new HardFailure(`Missing task ${task.taskId}`);
          running.set(task.taskId, this.execute(runtimeTask, dependencies));
        }
      }
      if (running.size === 0 && pending.size > 0) {
        throw new HardFailure("DAG scheduler reached an invalid dependency state");
      }
      if (running.size === 0) break;
      const completed = await Promise.race(running.values());
      throwIfCancelled(this.#signal);
      running.delete(completed.result.taskId);
      results.set(completed.result.taskId, completed.result);
      if (completed.result.status === "SUCCEEDED") {
        if (completed.handoff === undefined) {
          throw new HardFailure(`Successful task ${completed.result.taskId} has no handoff`);
        }
        handoffs.set(completed.result.taskId, completed.handoff);
        artifacts.push(
          ...completed.artifacts.map((artifact) => ({
            taskId: completed.result.taskId,
            repo: completed.result.repo,
            artifact,
          })),
        );
        await this.negotiateArtifactMismatches(
          artifacts,
          negotiatedPaths,
          decisionRecords,
          tasks,
          pending,
          runtimeTasks,
          byId,
        );
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
    tasks: readonly DagTask[],
    pending: ReadonlySet<string>,
    runtimeTasks: Map<string, DagTask>,
    byId: ReadonlyMap<string, DagTask>,
  ): Promise<void> {
    if (this.#negotiation === undefined) return;
    const keys = [
      ...new Set(
        artifacts
          .map((entry) => artifactConflictKey(entry))
          .filter((key) => !negotiatedPaths.has(key)),
      ),
    ].sort((left, right) => left.localeCompare(right));
    for (const key of keys) {
      const conflicting = artifacts.filter((entry) => artifactConflictKey(entry) === key);
      const evidence = detectArtifactMismatch(conflicting);
      if (evidence === null) continue;
      negotiatedPaths.add(key);
      const negotiation = await this.#negotiation.negotiate({
        runId: this.#parentRunId,
        ...evidence,
      });
      if (negotiation.decisionRecord === null) continue;
      records.push(negotiation.decisionRecord);
      if (this.#memory !== undefined) {
        await persistDecisionRecord(this.#memory, negotiation.decisionRecord);
      }
      const sourceTasks = [...new Set(conflicting.map((entry) => entry.taskId))];
      const consumers = tasks.filter(
        (task) =>
          pending.has(task.taskId) &&
          task.repo === conflicting[0]?.repo &&
          sourceTasks.every((sourceTask) => dependsOn(task, sourceTask, byId)),
      );
      if (consumers.length === 0) {
        throw new HardFailure(
          `Negotiation ${negotiation.decisionRecord.id} verification cannot be bound to a pending task; stopping before submission`,
        );
      }
      for (const consumer of consumers) {
        const runtimeTask = runtimeTasks.get(consumer.taskId);
        if (runtimeTask === undefined) throw new HardFailure(`Missing task ${consumer.taskId}`);
        runtimeTasks.set(consumer.taskId, {
          ...runtimeTask,
          acceptanceCriteria: bindDecisionAcceptanceCriteria(
            negotiation.decisionRecord,
            runtimeTask.acceptanceCriteria,
          ),
        });
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

  private async execute(
    task: DagTask,
    dependencies: readonly UpstreamHandoff[],
  ): Promise<CompletedTask> {
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
      execution = await this.#taskRunner.run(task, {
        parentRunId: this.#parentRunId,
        runId,
        dependencies,
      });
    } catch (error) {
      if (isCancellation(error)) throw error;
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
    if (execution.status === "SUCCEEDED" && execution.handoff === undefined) {
      const summary = "Successful task runner result must include a complete upstream handoff";
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
    const handoff = execution.handoff;
    if (handoff === undefined) {
      throw new HardFailure(`Successful task ${task.taskId} has no handoff`);
    }
    try {
      assertHandoffAcceptance(task, handoff);
    } catch (error) {
      const summary = errorMessage(error);
      await this.recordFailure(task, execution.runId, summary);
      return {
        result: {
          taskId: task.taskId,
          runId: execution.runId,
          repo: task.repo,
          status: "FAILED",
          branch: execution.branch,
          summary,
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
        ...(execution.handoff === undefined ? {} : { commit: execution.handoff.commit }),
        upstreamCommits: dependencies.map((dependency) => dependency.commit),
      },
      artifacts: execution.artifacts,
      ...(execution.handoff === undefined ? {} : { handoff: execution.handoff }),
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

function dependsOn(
  task: DagTask,
  dependencyId: string,
  byId: ReadonlyMap<string, DagTask>,
  visited = new Set<string>(),
): boolean {
  if (task.deps.includes(dependencyId)) return true;
  if (visited.has(task.taskId)) return false;
  visited.add(task.taskId);
  return task.deps.some((id) => {
    const dependency = byId.get(id);
    return dependency !== undefined && dependsOn(dependency, dependencyId, byId, visited);
  });
}

function assertHandoffAcceptance(task: DagTask, handoff: UpstreamHandoff): void {
  if (JSON.stringify(handoff.acceptanceCriteria) !== JSON.stringify(task.acceptanceCriteria)) {
    throw new HardFailure(
      `Task ${task.taskId} handoff does not contain its complete acceptance contract`,
    );
  }
  for (const criterion of task.acceptanceCriteria) {
    for (const required of criterion.requiredEvidence) {
      const expectedSource = verificationSource(criterion, required);
      const evidence = handoff.verificationEvidence.find(
        (item) =>
          item.criterionId === criterion.id &&
          item.verifierKind === criterion.verifier.kind &&
          item.source === expectedSource,
      );
      if (evidence?.passed !== true || evidence.details.trim().length === 0) {
        throw new HardFailure(
          `Task ${task.taskId} handoff lacks passing ${required} evidence for ${criterion.id}`,
        );
      }
    }
  }
}

function verificationSource(
  criterion: DagTask["acceptanceCriteria"][number],
  required: "test" | "review",
): string {
  if (required === "review") return "review:model";
  switch (criterion.verifier.kind) {
    case "test-suite":
      return `test:command:${criterion.verifier.commandId}`;
    case "test-case":
      return `test:case:${criterion.verifier.commandId}`;
    case "file":
      return `test:file:${criterion.verifier.assertion}`;
    case "behavior":
      return `test:behavior:${criterion.verifier.probeId}`;
    case "review":
      throw new HardFailure(`Review criterion ${criterion.id} cannot require TEST evidence`);
  }
}

function artifactConflictKey(entry: NegotiationArtifact): string {
  return `${entry.repo}:${entry.artifact.path}`;
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
  const resultsById = new Map(results.map((result) => [result.taskId, result]));
  return validateDagTasks(tasks).map((taskId) => {
    const result = resultsById.get(taskId);
    const task = byId.get(taskId);
    if (task === undefined || result === undefined || result.branch === undefined) {
      throw new HardFailure(`Successful task ${taskId} has no PR candidate metadata`);
    }
    const sameRepoDependencies = task.deps
      .map((dependency) => ({ task: byId.get(dependency), result: resultsById.get(dependency) }))
      .filter((entry) => entry.task?.repo === task.repo && entry.result?.branch !== undefined);
    return {
      taskId: task.taskId,
      repo: task.repo,
      branch: result.branch,
      requirement: task.requirement,
      summary: result.summary,
      ...(sameRepoDependencies[0]?.result?.branch === undefined
        ? {}
        : { baseBranch: sameRepoDependencies[0].result.branch }),
      upstreamBranches: sameRepoDependencies.flatMap((entry) =>
        entry.result?.branch === undefined ? [] : [entry.result.branch],
      ),
    };
  });
}
