export const ROLES = ["viewer", "developer", "approver", "admin"] as const;

export type Role = (typeof ROLES)[number];

export type RiskLevel = "low" | "medium" | "high";

export type GovernedAction = "view" | "run" | "approve:medium" | "approve:high" | "configure";

export interface Actor {
  readonly id: string;
  readonly role: Role;
  readonly repos?: readonly string[];
  readonly teams?: readonly string[];
}

export interface Scope {
  readonly repo?: string;
  readonly team?: string;
}

export interface ApprovalContext {
  readonly actor: Actor;
  readonly scope: Scope;
  readonly risk: RiskLevel;
}
