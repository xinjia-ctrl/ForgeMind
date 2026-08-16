import type { ArtifactRef, StageId } from "../core/types.js";

export const NEGOTIATION_TRIGGERS = [
  "arch-conflict",
  "review-repeated-rejection",
  "artifact-mismatch",
] as const;

export type NegotiationTrigger = (typeof NEGOTIATION_TRIGGERS)[number];
export type NegotiationRoundNumber = 1 | 2 | 3;
export type NegotiationRoundStatus = "CONTINUE" | "CONVERGED";

export interface NegotiationRound {
  readonly round: NegotiationRoundNumber;
  readonly proposal: string;
  readonly counter: string;
  readonly status: NegotiationRoundStatus;
}

export interface DecisionRecord {
  readonly id: string;
  readonly runId: string;
  readonly topic: string;
  readonly trigger: NegotiationTrigger;
  readonly positions: readonly {
    readonly side: "proposal" | "counter";
    readonly position: string;
  }[];
  readonly decision: string;
  readonly escalated: boolean;
  readonly createdAt: string;
}

export interface Negotiation {
  readonly id: string;
  readonly runId: string;
  readonly trigger: NegotiationTrigger;
  readonly topic: string;
  readonly rounds: readonly NegotiationRound[];
  readonly status: "RESOLVED" | "ESCALATED" | "TIMED_OUT";
  readonly decisionRecord: DecisionRecord | null;
}

export interface NegotiationEvidence {
  readonly trigger: NegotiationTrigger;
  readonly topic: string;
  readonly proposal: string;
  readonly counter: string;
}

export interface NegotiationRequest extends NegotiationEvidence {
  readonly runId: string;
}

export interface NegotiationCoordinator {
  negotiate(request: NegotiationRequest): Promise<Negotiation>;
}

export interface NegotiationArtifact {
  readonly taskId: string;
  readonly artifact: ArtifactRef;
}

export function stageForNegotiationTrigger(
  trigger: NegotiationTrigger,
): Extract<StageId, "ARCH" | "REVIEW" | "CODE"> {
  switch (trigger) {
    case "arch-conflict":
      return "ARCH";
    case "review-repeated-rejection":
      return "REVIEW";
    case "artifact-mismatch":
      return "CODE";
  }
}
