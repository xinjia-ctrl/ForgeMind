import type { ActionRequest } from "./types.js";
import type { ApprovalContext } from "../auth/types.js";

export type ApprovalDecision = "APPROVED" | "DENIED";
export type ApprovalSource = "interactive" | "auto" | "disabled";

export interface ApprovalGateway {
  readonly source: ApprovalSource;
  request(action: ActionRequest, context?: ApprovalContext): Promise<ApprovalDecision>;
}

export class DenyApprovalGateway implements ApprovalGateway {
  public readonly source = "disabled";

  public request(_action: ActionRequest): Promise<ApprovalDecision> {
    return Promise.resolve("DENIED");
  }
}
