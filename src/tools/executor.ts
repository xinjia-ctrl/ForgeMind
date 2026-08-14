import type { EventLog } from "../core/event-log.js";
import type { StageId } from "../core/types.js";
import { approvalAction, authorize } from "../auth/rbac.js";
import type { ApprovalContext } from "../auth/types.js";
import type { ApprovalGateway } from "../policy/gateway.js";
import type { ActionRequest, PolicyResolver } from "../policy/types.js";
import type { RiskLevel } from "../auth/types.js";
import { auditValue } from "./audit.js";
import type { Tool, ToolPolicy, ToolResult } from "./types.js";

export class ToolRegistry {
  readonly #tools: ReadonlyMap<string, Tool>;

  public constructor(tools: readonly Tool[]) {
    const entries = tools.map((tool) => [tool.name, tool] as const);
    if (new Set(entries.map(([name]) => name)).size !== entries.length) {
      throw new Error("Tool names must be unique");
    }
    this.#tools = new Map(entries);
  }

  public get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }
}

interface ScopedExecutorOptions {
  readonly registry: ToolRegistry;
  readonly eventLog: EventLog;
  readonly runId: string;
  readonly stage: StageId;
  readonly agentTools: readonly string[];
  readonly policy: ToolPolicy;
  readonly policyResolver: PolicyResolver;
  readonly approvalGateway: ApprovalGateway;
  readonly approvalContext?: ApprovalContext;
  readonly riskTransform?: (risk: RiskLevel) => RiskLevel;
}

export class ScopedToolExecutor {
  readonly #options: ScopedExecutorOptions;

  public constructor(options: ScopedExecutorOptions) {
    this.#options = options;
  }

  public async execute(name: string, args: unknown): Promise<ToolResult> {
    let result: ToolResult;
    let actionPolicy = "stage-policy";
    const tool = this.#options.registry.get(name);
    if (tool === undefined) {
      result = { ok: false, error: `Unknown tool: ${name}` };
    } else if (
      !this.#options.agentTools.includes(name) ||
      !this.#options.policy.allowedTools.has(name)
    ) {
      result = {
        ok: false,
        error: `Tool ${name} is not allowed during ${this.#options.stage}`,
      };
    } else {
      const action = actionRequest(this.#options.stage, name, args);
      const decision = this.#options.policyResolver.resolve(action);
      actionPolicy = decision.policy;
      const allowed = await this.authorize(action, decision.mode, decision.policy, decision.risk);
      if (!allowed) {
        result = { ok: false, error: `Policy denied ${this.#options.stage}/${name}` };
        await this.recordToolCall(name, args, result, decision.policy);
        return result;
      }
      try {
        result = await tool.execute(args, this.#options.policy);
      } catch (error) {
        result = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    await this.recordToolCall(name, args, result, actionPolicy);
    return result;
  }

  private async authorize(
    action: ActionRequest,
    mode: "allow" | "approve" | "deny",
    policy: string,
    policyRisk?: RiskLevel,
  ): Promise<boolean> {
    const baseRisk = policyRisk ?? this.#options.approvalContext?.risk;
    const risk =
      baseRisk === undefined || this.#options.riskTransform === undefined
        ? baseRisk
        : this.#options.riskTransform(baseRisk);
    const common = {
      runId: this.#options.runId,
      stage: this.#options.stage,
      tool: action.tool,
      action: auditValue({ args: action.args, command: action.command }),
      policy,
      ...(risk === undefined ? {} : { risk }),
      ...(this.#options.approvalContext === undefined
        ? {}
        : {
            actor: this.#options.approvalContext.actor.id,
            role: this.#options.approvalContext.actor.role,
          }),
    };
    if (mode === "allow") return true;
    if (mode === "deny") {
      await this.#options.eventLog.append({
        type: "approval.rejected",
        data: {
          ...common,
          mode,
          reason: "Action denied by policy",
          decisionSource: "policy",
        },
      });
      return false;
    }
    await this.#options.eventLog.append({
      type: "approval.requested",
      data: { ...common, mode },
    });
    const context = this.#options.approvalContext;
    if (context !== undefined) {
      const effectiveContext = { ...context, risk: risk ?? "high" };
      const governedAction = approvalAction(effectiveContext.risk);
      if (governedAction === null) {
        await this.#options.eventLog.append({
          type: "approval.approved",
          data: { ...common, mode, decisionSource: "config" },
        });
        return true;
      }
      if (!authorize(context.actor, context.scope, governedAction)) {
        await this.#options.eventLog.append({
          type: "approval.rejected",
          data: {
            ...common,
            mode,
            reason: `Actor ${context.actor.id} is not authorized for ${effectiveContext.risk}-risk approval`,
            decisionSource: "policy",
          },
        });
        return false;
      }
    }
    const approval =
      context === undefined
        ? await this.#options.approvalGateway.request(action)
        : await this.#options.approvalGateway.request(action, {
            ...context,
            risk: risk ?? "high",
          });
    if (approval === "APPROVED") {
      await this.#options.eventLog.append({
        type: "approval.approved",
        data: {
          ...common,
          mode,
          decisionSource:
            this.#options.approvalGateway.source === "disabled"
              ? "config"
              : this.#options.approvalGateway.source,
        },
      });
      return true;
    }
    await this.#options.eventLog.append({
      type: "approval.rejected",
      data: {
        ...common,
        mode,
        reason: "Approval denied",
        decisionSource: this.#options.approvalGateway.source,
      },
    });
    return false;
  }

  private async recordToolCall(
    name: string,
    args: unknown,
    result: ToolResult,
    policy: string,
  ): Promise<void> {
    await this.#options.eventLog.append({
      type: "tool.called",
      data: {
        runId: this.#options.runId,
        stage: this.#options.stage,
        tool: name,
        args: auditValue(args),
        result: auditValue(result),
        policy: `${this.#options.policy.describe()}:${policy}`,
      },
    });
  }
}

function actionRequest(stage: StageId, tool: string, args: unknown): ActionRequest {
  const command = tool === "run_command" ? commandFromArgs(args) : undefined;
  return { stage, tool, args, ...(command === undefined ? {} : { command }) };
}

function commandFromArgs(args: unknown): readonly string[] | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const command = "command" in args ? args.command : undefined;
  const commandArgs = "args" in args ? args.args : undefined;
  if (
    typeof command !== "string" ||
    !Array.isArray(commandArgs) ||
    !commandArgs.every((item) => typeof item === "string")
  ) {
    return undefined;
  }
  return [command, ...commandArgs];
}
