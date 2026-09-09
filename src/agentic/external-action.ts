import { authorize } from "../auth/rbac.js";
import type { ApprovalContext, RiskLevel } from "../auth/types.js";
import type { EventLog } from "../core/event-log.js";
import type { ApprovalGateway } from "../policy/gateway.js";
import type { ActionRequest } from "../policy/types.js";
import { auditValue } from "../tools/audit.js";

export interface ExternalAction<T> {
  readonly runId: string;
  readonly eventLog?: EventLog | undefined;
  readonly tool: "external_push" | "external_pull_request" | "external_comment";
  readonly args: unknown;
  readonly target: string;
  readonly idempotencyKey: string;
  readonly risk: RiskLevel;
  execute(): Promise<T>;
  verify(result: T): Promise<boolean>;
}

export interface ExternalActionGovernor {
  execute<T>(action: ExternalAction<T>): Promise<T>;
}

export interface ApprovalExternalActionGovernorOptions {
  readonly approvalGateway: ApprovalGateway;
  readonly approvalContext?: ApprovalContext;
}

export class ApprovalExternalActionGovernor implements ExternalActionGovernor {
  readonly #approvalGateway: ApprovalGateway;
  readonly #approvalContext: ApprovalContext | undefined;

  public constructor(options: ApprovalExternalActionGovernorOptions) {
    this.#approvalGateway = options.approvalGateway;
    this.#approvalContext = options.approvalContext;
  }

  public async execute<T>(action: ExternalAction<T>): Promise<T> {
    if (action.eventLog === undefined) {
      throw new Error("An event log is required for governed external actions");
    }
    const eventLog = action.eventLog;
    const request: ActionRequest = {
      stage: "COMMIT",
      tool: action.tool,
      args: {
        target: action.target,
        idempotencyKey: action.idempotencyKey,
        details: auditValue(action.args),
      },
    };
    const common = {
      runId: action.runId,
      stage: "COMMIT" as const,
      tool: action.tool,
      action: auditValue(request),
      policy: `external:approve:${action.risk}`,
      mode: "approve" as const,
      ...(this.#approvalContext === undefined
        ? {}
        : {
            actor: this.#approvalContext.actor.id,
            role: this.#approvalContext.actor.role,
            risk: action.risk,
          }),
    };
    await eventLog.append({ type: "approval.requested", data: common });
    if (!this.isAuthorized(action.risk)) {
      await eventLog.append({
        type: "approval.rejected",
        data: {
          ...common,
          reason: "Actor is not authorized for this external action risk",
          decisionSource: "policy",
        },
      });
      throw new Error(`External action ${action.tool} was not authorized`);
    }
    const decision = await this.#approvalGateway.request(
      request,
      this.#approvalContext === undefined
        ? undefined
        : { ...this.#approvalContext, risk: action.risk },
    );
    if (decision !== "APPROVED") {
      await eventLog.append({
        type: "approval.rejected",
        data: {
          ...common,
          reason: "Approval denied",
          decisionSource: this.#approvalGateway.source,
        },
      });
      throw new Error(`External action ${action.tool} was denied`);
    }
    await eventLog.append({
      type: "approval.approved",
      data: {
        ...common,
        decisionSource:
          this.#approvalGateway.source === "disabled" ? "config" : this.#approvalGateway.source,
      },
    });
    try {
      const result = await action.execute();
      const verified = await action.verify(result);
      if (!verified) throw new Error(`External action ${action.tool} could not be verified`);
      await eventLog.append({
        type: "tool.called",
        data: {
          runId: action.runId,
          stage: "COMMIT",
          tool: action.tool,
          args: auditValue(request.args),
          result: { ok: true, verified: true, target: action.target },
          policy: common.policy,
        },
      });
      return result;
    } catch (error) {
      await eventLog.append({
        type: "tool.called",
        data: {
          runId: action.runId,
          stage: "COMMIT",
          tool: action.tool,
          args: auditValue(request.args),
          result: { ok: false, error: error instanceof Error ? error.message : String(error) },
          policy: common.policy,
        },
      });
      throw error;
    }
  }

  private isAuthorized(risk: RiskLevel): boolean {
    if (this.#approvalContext === undefined) return true;
    return authorize(
      this.#approvalContext.actor,
      this.#approvalContext.scope,
      risk === "high" ? "approve:high" : risk === "medium" ? "approve:medium" : "run",
    );
  }
}
