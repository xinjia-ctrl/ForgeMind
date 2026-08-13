import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_TOKEN_BUDGETS } from "../config/budgets.js";
import { loadPolicyConfig, type ForgeMindPolicyConfig } from "../config/policy.js";
import { DefaultAgentFactory } from "../core/agent-factory.js";
import { createTaskContext } from "../core/context.js";
import { assertValidRunId, assertValidTaskId, EventLog } from "../core/event-log.js";
import { Orchestrator } from "../core/orchestrator.js";
import type { RunResult } from "../core/types.js";
import type { ChatProvider } from "../llm/chat-provider.js";
import { EpisodicMemory } from "../memory/episodic-memory.js";
import { LayeredMemory } from "../memory/layered-memory.js";
import type { MemoryProvider } from "../memory/memory-provider.js";
import { NoopMemoryProvider } from "../memory/noop-memory-provider.js";
import { ProjectMemory } from "../memory/project-memory.js";
import { AutoApprovalGateway } from "../policy/auto-gateway.js";
import { DenyApprovalGateway, type ApprovalGateway } from "../policy/gateway.js";
import { InteractiveApprovalGateway } from "../policy/interactive-gateway.js";
import { RulePolicyResolver } from "../policy/resolver.js";
import { createProcessRunner } from "../sandbox/detect.js";
import type { ProcessRunner } from "../sandbox/types.js";
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
  readonly configPath?: string;
  readonly approveAll?: boolean;
  readonly noApprove?: boolean;
  readonly policyConfig?: ForgeMindPolicyConfig;
  readonly processRunner?: ProcessRunner;
  readonly approvalGateway?: ApprovalGateway;
  readonly memory?: boolean;
  readonly memoryProvider?: MemoryProvider;
  readonly parentRunId?: string;
  readonly taskId?: string;
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
  if (options.approveAll === true && options.noApprove === true) {
    throw new Error("approveAll and noApprove cannot both be enabled");
  }
  const runId = options.runId ?? createRunId();
  assertValidRunId(runId);
  if (options.parentRunId !== undefined) assertValidRunId(options.parentRunId);
  if (options.taskId !== undefined) assertValidTaskId(options.taskId);
  const inspected = await inspectGitWorkspace(options.repoPath);
  const testCommand = await resolveTestCommand(inspected.root, options.testCommand);
  const policyConfig =
    options.policyConfig ??
    (await loadPolicyConfig({
      repositoryRoot: inspected.root,
      testCommand,
      ...(options.configPath === undefined ? {} : { explicitPath: options.configPath }),
    }));
  const processRunner = options.processRunner ?? (await createProcessRunner(policyConfig.sandbox));
  const approvalGateway = options.approvalGateway ?? approvalGatewayFor(options);
  const policyResolver = new RulePolicyResolver(policyConfig.defaultMode, policyConfig.rules);
  if (options.memory === true) await excludeProjectMemory(inspected.gitDirectory);
  const workspace = await prepareGitWorkspace(options.repoPath, runId);
  const eventsDirectory = path.join(workspace.gitDirectory, "forgemind", "runs");
  const eventLog = await EventLog.create(eventsDirectory, runId, {
    ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
  });
  const memory =
    options.memoryProvider ??
    (options.memory === true
      ? new LayeredMemory({
          layers: {
            episodic: new EpisodicMemory({ eventsDirectory, currentRunId: runId }),
            project: new ProjectMemory({
              repositoryRoot: workspace.root,
              writeEnabled: true,
              eventLog,
            }),
            semantic: null,
          },
        })
      : new NoopMemoryProvider());
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
    registry: createDefaultToolRegistry(processRunner),
    runId,
    workspaceRoot: workspace.root,
    budgets: DEFAULT_TOKEN_BUDGETS,
    testCommand,
    skipGitHooks: options.skipGitHooks ?? false,
    policyResolver,
    approvalGateway,
    memory,
  });
  const orchestrator = new Orchestrator({
    eventLog,
    agentFactory: factory,
    memory,
    ...(options.maxRework === undefined ? {} : { maxRework: options.maxRework }),
  });
  const result = await orchestrator.run(context);
  return { result, eventLogPath: eventLog.filePath };
}

async function excludeProjectMemory(gitDirectory: string): Promise<void> {
  const infoDirectory = path.join(gitDirectory, "info");
  const excludePath = path.join(infoDirectory, "exclude");
  const rule = "/.forgemind/memory/";
  let content = "";
  try {
    content = await readFile(excludePath, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  if (content.split(/\r?\n/).includes(rule)) return;
  await mkdir(infoDirectory, { recursive: true });
  await appendFile(
    excludePath,
    `${content.length > 0 && !content.endsWith("\n") ? "\n" : ""}${rule}\n`,
  );
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function approvalGatewayFor(options: RunOptions): ApprovalGateway {
  if (options.approveAll === true) return new AutoApprovalGateway();
  if (options.noApprove === true || !process.stdin.isTTY || !process.stdout.isTTY) {
    return new DenyApprovalGateway();
  }
  return new InteractiveApprovalGateway({ input: process.stdin, output: process.stdout });
}

function createRunId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}
