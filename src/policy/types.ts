import type { StageId } from "../core/types.js";

export type PolicyMode = "allow" | "approve" | "deny";

export interface ActionRequest {
  readonly stage: StageId;
  readonly tool: string;
  readonly args: unknown;
  readonly command?: readonly string[];
}

export interface PolicyRule {
  readonly match: {
    readonly stage?: StageId;
    readonly tool: string;
    readonly command?: readonly string[];
  };
  readonly mode: PolicyMode;
}

export interface PolicyDecision {
  readonly mode: PolicyMode;
  readonly policy: string;
}

export interface PolicyResolver {
  resolve(action: ActionRequest): PolicyDecision;
}
