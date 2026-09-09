import { ArchitectureAgent, ARCH_TOOLS } from "../agents/architecture-agent.js";
import type { BaseAgentOptions } from "../agents/base-agent.js";
import { CodeAgent, CODE_TOOLS } from "../agents/code-agent.js";
import { CommitExecutor, COMMIT_TOOLS } from "../agents/commit-agent.js";
import { PlanAgent, PLAN_TOOLS } from "../agents/plan-agent.js";
import { ReviewAgent, REVIEW_TOOLS } from "../agents/review-agent.js";
import { TestGate, TEST_TOOLS } from "../agents/test-agent.js";
import type { ChatProvider } from "../llm/chat-provider.js";
import type { ApprovalContext, RiskLevel } from "../auth/types.js";
import type { MemoryProvider } from "../memory/memory-provider.js";
import type { ApprovalGateway } from "../policy/gateway.js";
import type { PolicyResolver } from "../policy/types.js";
import { ScopedToolExecutor, type ToolRegistry } from "../tools/executor.js";
import { ToolPolicy } from "../tools/types.js";
import type { EventLog } from "./event-log.js";
import type { StageAgent, StageId, TokenBudgets } from "./types.js";
import type { AcceptanceVerifierRegistry } from "../verification/acceptance-verifier.js";
import type { RunArtifactStore } from "./run-artifact-store.js";
import type { RunBudgetTracker } from "./run-budget.js";
import type { ActionJournal } from "./action-journal.js";

interface AgentFactoryOptions {
  readonly provider: ChatProvider;
  readonly model: string;
  readonly eventLog: EventLog;
  readonly registry: ToolRegistry;
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly budgets: TokenBudgets;
  readonly testCommand: readonly string[];
  readonly acceptanceVerifiers: AcceptanceVerifierRegistry;
  readonly skipGitHooks: boolean;
  readonly policyResolver: PolicyResolver;
  readonly approvalGateway: ApprovalGateway;
  readonly approvalContext?: ApprovalContext;
  readonly memory: MemoryProvider;
  readonly toolAllowlist?: readonly string[];
  readonly commandAllowlist?: readonly (readonly string[])[];
  readonly riskTransform?: (risk: RiskLevel) => RiskLevel;
  readonly signal?: AbortSignal;
  readonly artifactStore: RunArtifactStore;
  readonly runBudget: RunBudgetTracker;
  readonly actionJournal: ActionJournal;
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
      runBudget: this.#options.runBudget,
      ...(this.#options.riskTransform === undefined
        ? {}
        : { riskTransform: this.#options.riskTransform }),
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
      runBudget: this.#options.runBudget,
      ...(this.#options.signal === undefined ? {} : { signal: this.#options.signal }),
    };

    switch (stage) {
      case "PLAN":
        return new PlanAgent({ ...common, artifactStore: this.#options.artifactStore });
      case "ARCH":
        return new ArchitectureAgent({ ...common, artifactStore: this.#options.artifactStore });
      case "CODE":
        return new CodeAgent({
          ...common,
          fastChecks: { primary: this.#options.testCommand },
          actionJournal: this.#options.actionJournal,
        });
      case "REVIEW":
        return new ReviewAgent(common);
      case "TEST":
        return new TestGate({
          ...common,
          testCommand: this.#options.testCommand,
          verifiers: this.#options.acceptanceVerifiers,
        });
      case "COMMIT":
        return new CommitExecutor(common);
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
  const writable = stage === "CODE" || stage === "COMMIT";
  const allowedTools =
    options.toolAllowlist === undefined
      ? tools
      : tools.filter((tool) => options.toolAllowlist?.includes(tool) === true);
  const allowedCommands =
    stage !== "TEST" && stage !== "CODE"
      ? []
      : stage === "CODE"
        ? [options.testCommand]
        : options.commandAllowlist === undefined
          ? options.acceptanceVerifiers.commandAllowlist
          : options.acceptanceVerifiers.commandAllowlist.filter((command) =>
              options.commandAllowlist?.some((allowed) => sameCommand(command, allowed)),
            );
  return new ToolPolicy({
    workspaceRoot: options.workspaceRoot,
    stage,
    allowedTools,
    writable,
    ...(stage === "CODE" ? { forbiddenWritePrefixes: ["docs/.forgemind"] } : {}),
    ...(stage === "TEST" || stage === "CODE" ? { allowedCommands } : {}),
    ...(stage === "COMMIT" ? { skipGitHooks: options.skipGitHooks } : {}),
    maxResultBytes: stage === "CODE" ? 128_000 : stage === "REVIEW" ? 72_000 : 32_000,
    commandTimeoutMs: stage === "TEST" || stage === "CODE" ? 300_000 : 120_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

function sameCommand(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}
