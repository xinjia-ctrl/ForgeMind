import { ArchitectureAgent, ARCH_TOOLS } from "../agents/architecture-agent.js";
import type { BaseAgentOptions } from "../agents/base-agent.js";
import { CodeAgent, CODE_TOOLS } from "../agents/code-agent.js";
import { CommitAgent, COMMIT_TOOLS } from "../agents/commit-agent.js";
import { PlanAgent, PLAN_TOOLS } from "../agents/plan-agent.js";
import { ReviewAgent, REVIEW_TOOLS } from "../agents/review-agent.js";
import { TestAgent, TEST_TOOLS } from "../agents/test-agent.js";
import type { ChatProvider } from "../llm/chat-provider.js";
import type { ApprovalContext } from "../auth/types.js";
import type { MemoryProvider } from "../memory/memory-provider.js";
import type { ApprovalGateway } from "../policy/gateway.js";
import type { PolicyResolver } from "../policy/types.js";
import { ScopedToolExecutor, type ToolRegistry } from "../tools/executor.js";
import { ToolPolicy } from "../tools/types.js";
import type { EventLog } from "./event-log.js";
import type { StageAgent, StageId, TokenBudgets } from "./types.js";

interface AgentFactoryOptions {
  readonly provider: ChatProvider;
  readonly model: string;
  readonly eventLog: EventLog;
  readonly registry: ToolRegistry;
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly budgets: TokenBudgets;
  readonly testCommand: readonly string[];
  readonly skipGitHooks: boolean;
  readonly policyResolver: PolicyResolver;
  readonly approvalGateway: ApprovalGateway;
  readonly approvalContext?: ApprovalContext;
  readonly memory: MemoryProvider;
}

export interface AgentFactory {
  create(stage: StageId): StageAgent;
}

export class DefaultAgentFactory implements AgentFactory {
  readonly #options: AgentFactoryOptions;

  public constructor(options: AgentFactoryOptions) {
    this.#options = options;
  }

  public create(stage: StageId): StageAgent {
    const tools = toolsFor(stage);
    const policy = policyFor(stage, tools, this.#options);
    const toolExecutor = new ScopedToolExecutor({
      registry: this.#options.registry,
      eventLog: this.#options.eventLog,
      runId: this.#options.runId,
      stage,
      agentTools: tools,
      policy,
      policyResolver: this.#options.policyResolver,
      approvalGateway: this.#options.approvalGateway,
      ...(this.#options.approvalContext === undefined
        ? {}
        : { approvalContext: this.#options.approvalContext }),
    });
    const common: Omit<BaseAgentOptions, "id" | "tools"> = {
      provider: this.#options.provider,
      model: this.#options.model,
      eventLog: this.#options.eventLog,
      toolExecutor,
      budget: this.#options.budgets[stage],
      memory: this.#options.memory,
    };

    switch (stage) {
      case "PLAN":
        return new PlanAgent(common);
      case "ARCH":
        return new ArchitectureAgent(common);
      case "CODE":
        return new CodeAgent(common);
      case "REVIEW":
        return new ReviewAgent(common);
      case "TEST":
        return new TestAgent({ ...common, testCommand: this.#options.testCommand });
      case "COMMIT":
        return new CommitAgent(common);
    }
  }
}

function toolsFor(stage: StageId): readonly string[] {
  switch (stage) {
    case "PLAN":
      return PLAN_TOOLS;
    case "ARCH":
      return ARCH_TOOLS;
    case "CODE":
      return CODE_TOOLS;
    case "REVIEW":
      return REVIEW_TOOLS;
    case "TEST":
      return TEST_TOOLS;
    case "COMMIT":
      return COMMIT_TOOLS;
  }
}

function policyFor(
  stage: StageId,
  tools: readonly string[],
  options: AgentFactoryOptions,
): ToolPolicy {
  const writable = stage === "PLAN" || stage === "ARCH" || stage === "CODE" || stage === "COMMIT";
  return new ToolPolicy({
    workspaceRoot: options.workspaceRoot,
    stage,
    allowedTools: tools,
    writable,
    ...(stage === "PLAN" || stage === "ARCH"
      ? { writablePrefixes: [`docs/.forgemind/${options.runId}`] }
      : {}),
    ...(stage === "CODE" ? { forbiddenWritePrefixes: ["docs/.forgemind"] } : {}),
    ...(stage === "TEST" ? { allowedCommands: [options.testCommand] } : {}),
    ...(stage === "COMMIT" ? { skipGitHooks: options.skipGitHooks } : {}),
    maxResultBytes: stage === "CODE" ? 128_000 : stage === "REVIEW" ? 72_000 : 32_000,
    commandTimeoutMs: stage === "TEST" ? 300_000 : 120_000,
  });
}
