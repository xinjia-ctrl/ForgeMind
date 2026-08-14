import type { Actor, GovernedAction, RiskLevel, Role, Scope } from "./types.js";

const REQUIRED_ROLE: Readonly<Record<GovernedAction, Role>> = {
  view: "viewer",
  run: "developer",
  "approve:medium": "developer",
  "approve:high": "approver",
  configure: "admin",
};

const ROLE_RANK: Readonly<Record<Role, number>> = {
  viewer: 0,
  developer: 1,
  approver: 2,
  admin: 3,
};

export function authorize(actor: Actor | undefined, scope: Scope, action: GovernedAction): boolean {
  if (actor === undefined || actor.id.trim().length === 0) return false;
  if (!(actor.role in ROLE_RANK)) return false;
  if (ROLE_RANK[actor.role] < ROLE_RANK[REQUIRED_ROLE[action]]) return false;
  return actor.role === "admin" || inScope(actor, scope);
}

export function approvalAction(risk: RiskLevel): GovernedAction | null {
  switch (risk) {
    case "low":
      return null;
    case "medium":
      return "approve:medium";
    case "high":
      return "approve:high";
  }
}

function inScope(actor: Actor, scope: Scope): boolean {
  if (scope.repo === undefined && scope.team === undefined) return false;
  if (scope.repo !== undefined && !(actor.repos ?? []).includes(scope.repo)) return false;
  if (scope.team !== undefined && !(actor.teams ?? []).includes(scope.team)) return false;
  return true;
}
