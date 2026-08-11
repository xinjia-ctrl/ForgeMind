import { randomUUID } from "node:crypto";
import path from "node:path";
import { DEFAULT_TOKEN_BUDGETS } from "../config/budgets.js";
import { DefaultAgentFactory } from "../core/agent-factory.js";
import { createTaskContext } from "../core/context.js";
import { assertValidRunId, EventLog } from "../core/event-log.js";
import { Orchestrator } from "../core/orchestrator.js";
import type { RunResult } from "../core/types.js";
import type { ChatProvider } from "../llm/chat-provider.js";
import { NoopMemoryProvider } from "../memory/noop-memory-provider.js";
import { createDefaultToolRegistry } from "../tools/index.js";
import { inspectGitWorkspace, prepareGitWorkspace } from "./git-workspace.js";
import { resolveTestCommand } from "./test-command.js";

export interface RunOptions {
  readonly repoPath: string;
  readonly requirement: string;
  readonly provider: ChatProvider;
  readonly model: string;
  readonly runId?: string;
  readonly testCommand?: string;
  readonly maxRework?: number;
  readonly skipGitHooks?: boolean;
}

export interface RunExecution {
  readonly result: RunResult;
  readonly eventLogPath: string;
}

export async function runForgeMind(options: RunOptions): Promise<RunExecution> {
  if (options.requirement.trim().length === 0) {
    throw new Error("Requirement cannot be empty");
  }
  if (options.requirement.length > 100_000) {
    throw new Error("Requirement exceeds the 100,000 character input limit");
  }
  if (
    options.maxRework !== undefined &&
    (!Number.isInteger(options.maxRework) || options.maxRework < 0)
  ) {
    throw new Error("maxRework must be a non-negative integer");
  }
  const runId = options.runId ?? createRunId();
  assertValidRunId(runId);
  const inspected = await inspectGitWorkspace(options.repoPath);
  const testCommand = await resolveTestCommand(inspected.root, options.testCommand);
  const workspace = await prepareGitWorkspace(options.repoPath, runId);
  const eventsDirectory = path.join(workspace.gitDirectory, "forgemind", "runs");
  const eventLog = await EventLog.create(eventsDirectory, runId);
  const context = createTaskContext({
    runId,
    requirement: options.requirement.trim(),
    repoPath: workspace.root,
    branch: workspace.branch,
    tokenBudget: DEFAULT_TOKEN_BUDGETS,
  });
  const factory = new DefaultAgentFactory({
    provider: options.provider,
    model: options.model,
    eventLog,
    registry: createDefaultToolRegistry(),
    runId,
    workspaceRoot: workspace.root,
    budgets: DEFAULT_TOKEN_BUDGETS,
    testCommand,
    skipGitHooks: options.skipGitHooks ?? false,
  });
  const orchestrator = new Orchestrator({
    eventLog,
    agentFactory: factory,
    memory: new NoopMemoryProvider(),
    ...(options.maxRework === undefined ? {} : { maxRework: options.maxRework }),
  });
  const result = await orchestrator.run(context);
  return { result, eventLogPath: eventLog.filePath };
}

function createRunId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}
