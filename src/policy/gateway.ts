import type { ActionRequest } from "./types.js";

export type ApprovalDecision = "APPROVED" | "DENIED";
export type ApprovalSource = "interactive" | "auto" | "disabled";

export interface ApprovalGateway {
  readonly source: ApprovalSource;
  request(action: ActionRequest): Promise<ApprovalDecision>;
}

export class DenyApprovalGateway implements ApprovalGateway {
  public readonly source = "disabled";

  public request(_action: ActionRequest): Promise<ApprovalDecision> {
    return Promise.resolve("DENIED");
  }
}
