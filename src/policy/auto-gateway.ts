import type { ApprovalDecision, ApprovalGateway } from "./gateway.js";
import type { ActionRequest } from "./types.js";

export class AutoApprovalGateway implements ApprovalGateway {
  public readonly source = "auto";

  public request(_action: ActionRequest): Promise<ApprovalDecision> {
    return Promise.resolve("APPROVED");
  }
}
