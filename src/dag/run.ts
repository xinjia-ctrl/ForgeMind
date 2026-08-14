import { open } from "node:fs/promises";
import path from "node:path";
import { authorize } from "../auth/rbac.js";
import type { Actor, RiskLevel } from "../auth/types.js";
import { HardFailure } from "../core/errors.js";
import { assertValidRunId, EventLog } from "../core/event-log.js";
import type { ChatProvider } from "../llm/chat-provider.js";
import type { ApprovalGateway } from "../policy/gateway.js";
import type { ProcessRunner } from "../sandbox/types.js";
import {
  assertGitWorkspaceClean,
  inspectGitWorkspace,
  prepareTaskWorktree,
  type GitWorkspace,
} from "../runtime/git-workspace.js";
import { createRunId } from "../runtime/run.js";
import { DagPlanner } from "./plan.js";
import { DagScheduler } from "./scheduler.js";
import { ForgeMindTaskRunner } from "./task-runner.js";
import type { DagPlan, DagResult, DagTask } from "./types.js";

export interface DagRunOptions {
  readonly repositories: readonly string[];
  readonly requirement: string;
  readonly provider: ChatProvider;
  readonly model: string;
  readonly parentRunId?: string;
  readonly maxTasks?: number;
  readonly maxConcurrency?: number;
  readonly worktreesRoot?: string;
  readonly testCommand?: string;
  readonly maxRework?: number;
  readonly skipGitHooks?: boolean;
  readonly configPath?: string;
  readonly approveAll?: boolean;
  readonly noApprove?: boolean;
  readonly processRunner?: ProcessRunner;
  readonly approvalGateway?: ApprovalGateway;
  readonly memory?: boolean;
  readonly providerForTask?: (task: DagTask) => ChatProvider;
  readonly actor?: Actor;
  readonly team?: string;
  readonly approvalRisk?: RiskLevel;
}

export interface DagTaskWorkspace {
  readonly taskId: string;
  readonly repo: string;
  readonly root: string;
  readonly branch: string;
}

export interface DagRunExecution {
  readonly plan: DagPlan;
  readonly result: DagResult;
  readonly eventLogPath: string;
  readonly prListPath?: string;
  readonly workspaces: readonly DagTaskWorkspace[];
}

export async function runDagForgeMind(options: DagRunOptions): Promise<DagRunExecution> {
  const repositories = await inspectRepositories(options.repositories);
  await Promise.all(repositories.map((repository) => assertGitWorkspaceClean(repository.root)));
  if (options.actor !== undefined) {
    for (const repository of repositories) {
      if (
        !authorize(
          options.actor,
          {
            repo: repository.root,
            ...(options.team === undefined ? {} : { team: options.team }),
          },
          "run",
        )
      ) {
        throw new HardFailure(
          `Actor ${options.actor.id} is not authorized to run in ${repository.root}`,
        );
      }
    }
  }
  const parentRunId = options.parentRunId ?? createRunId();
  assertValidRunId(parentRunId);
  const planner = new DagPlanner({
    provider: options.provider,
    model: options.model,
    ...(options.maxTasks === undefined ? {} : { maxTasks: options.maxTasks }),
  });
  const plan = await planner.plan(
    options.requirement,
    repositories.map((repository) => repository.root),
  );
  const parentEventsDirectory = path.join(
    repositories[0]?.commonGitDirectory ?? failNoRepositories(),
    "forgemind",
    "dag-runs",
  );
  const eventLog = await EventLog.create(parentEventsDirectory, parentRunId);
  const repositoriesByRoot = new Map(
    repositories.map((repository) => [repository.root, repository] as const),
  );
  const workspaces = new Map<string, DagTaskWorkspace>();
  const taskRunner = new ForgeMindTaskRunner({
    createRunOptions: async (task, context) => {
      const repository = repositoriesByRoot.get(task.repo);
      if (repository === undefined) {
        throw new HardFailure(`Task ${task.taskId} targets unknown repository ${task.repo}`);
      }
      const workspace = await prepareTaskWorktree({
        repositoryPath: repository.root,
        parentRunId: context.parentRunId,
        taskId: task.taskId,
        runId: context.runId,
        ...(options.worktreesRoot === undefined ? {} : { worktreesRoot: options.worktreesRoot }),
      });
      workspaces.set(task.taskId, {
        taskId: task.taskId,
        repo: repository.root,
        root: workspace.root,
        branch: workspace.branch,
      });
      return {
        repoPath: workspace.root,
        preparedWorkspace: workspace,
        provider: options.providerForTask?.(task) ?? options.provider,
        model: options.model,
        ...(options.testCommand === undefined ? {} : { testCommand: options.testCommand }),
        ...(options.maxRework === undefined ? {} : { maxRework: options.maxRework }),
        ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
        ...(options.processRunner === undefined ? {} : { processRunner: options.processRunner }),
        ...(options.approvalGateway === undefined
          ? {}
          : { approvalGateway: options.approvalGateway }),
        skipGitHooks: options.skipGitHooks ?? false,
        approveAll: options.approveAll ?? false,
        noApprove: options.noApprove ?? false,
        memory: options.memory ?? false,
        ...(options.actor === undefined ? {} : { actor: options.actor }),
        ...(options.team === undefined ? {} : { team: options.team }),
        ...(options.approvalRisk === undefined ? {} : { approvalRisk: options.approvalRisk }),
        authorizationRepo: repository.root,
      };
    },
  });
  const scheduler = new DagScheduler({
    parentRunId,
    taskRunner,
    eventLog,
    ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
  });
  const result = await scheduler.run(plan.tasks);
  const prListPath =
    result.status === "SUCCEEDED"
      ? await persistPrList(parentEventsDirectory, parentRunId, result, eventLog)
      : undefined;
  return {
    plan,
    result,
    eventLogPath: eventLog.filePath,
    ...(prListPath === undefined ? {} : { prListPath }),
    workspaces: plan.tasks.flatMap((task) => {
      const workspace = workspaces.get(task.taskId);
      return workspace === undefined ? [] : [workspace];
    }),
  };
}

async function inspectRepositories(
  requestedRepositories: readonly string[],
): Promise<readonly Omit<GitWorkspace, "branch">[]> {
  const requested = requestedRepositories.map((repository) => repository.trim()).filter(Boolean);
  if (requested.length === 0) throw new HardFailure("At least one repository is required");
  const repositories = await Promise.all(requested.map(inspectGitWorkspace));
  const roots = new Set<string>();
  for (const repository of repositories) {
    if (roots.has(repository.root)) {
      throw new HardFailure(`Duplicate repository: ${repository.root}`);
    }
    roots.add(repository.root);
  }
  return repositories;
}

async function persistPrList(
  directory: string,
  parentRunId: string,
  result: DagResult,
  eventLog: EventLog,
): Promise<string> {
  const filePath = path.join(directory, `${parentRunId}.pr-list.json`);
  const handle = await open(filePath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(result.prList, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await eventLog.append({
    type: "artifact.produced",
    data: {
      runId: parentRunId,
      stage: "COMMIT",
      path: filePath,
      kind: "pr-candidate-list",
      summary: `${result.prList.length} PR candidates; no branches were merged`,
    },
  });
  return filePath;
}

function failNoRepositories(): never {
  throw new HardFailure("At least one repository is required");
}
