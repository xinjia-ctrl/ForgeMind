import type { StageId } from "../core/types.js";
import type { RiskLevel } from "../auth/types.js";

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
  readonly risk?: RiskLevel;
}

export interface PolicyDecision {
  readonly mode: PolicyMode;
  readonly policy: string;
  readonly risk?: RiskLevel;
}

export interface PolicyResolver {
  resolve(action: ActionRequest): PolicyDecision;
}
