import type { Actor, RiskLevel } from "../auth/types.js";
import type { AgenticConfig } from "./types.js";

export const AGENTIC_ACTOR_ID = "agentic" as const;

export function escalateAgenticRisk(risk: RiskLevel): RiskLevel {
  switch (risk) {
    case "low":
      return "medium";
    case "medium":
    case "high":
      return "high";
  }
}

export function createAgenticActor(repositories: readonly string[]): Actor {
  return { id: AGENTIC_ACTOR_ID, role: "developer", repos: [...repositories] };
}

export interface AgenticRunGovernance {
  readonly actor: Actor;
  readonly approvalRisk: RiskLevel;
  readonly authorizationRepo: string;
  readonly toolAllowlist: readonly string[];
  readonly commandAllowlist: readonly (readonly string[])[];
  readonly riskTransform: (risk: RiskLevel) => RiskLevel;
}

export function agenticRunGovernance(
  config: AgenticConfig,
  repository: string,
): AgenticRunGovernance {
  if (!config.repositories.includes(repository)) {
    throw new Error(`Repository ${repository} is not authorized for agentic runs`);
  }
  return {
    actor: createAgenticActor(config.repositories),
    approvalRisk: "low",
    authorizationRepo: repository,
    toolAllowlist: config.guardrails.allowedTools,
    commandAllowlist: config.guardrails.allowedCommands,
    riskTransform: escalateAgenticRisk,
  };
}
