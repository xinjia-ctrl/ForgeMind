import { createHash } from "node:crypto";
import type { MemoryProvider } from "../memory/memory-provider.js";
import type { DecisionRecord, NegotiationRound, NegotiationTrigger } from "./types.js";

export type DecisionRecordStore = Pick<MemoryProvider, "rememberDecisionRecord">;

export interface DecisionRecordInput {
  readonly runId: string;
  readonly topic: string;
  readonly trigger: NegotiationTrigger;
  readonly rounds: readonly NegotiationRound[];
  readonly decision: string;
  readonly escalated: boolean;
  readonly createdAt?: string;
}

export function createDecisionRecord(input: DecisionRecordInput): DecisionRecord {
  const decision = input.decision.trim();
  if (decision.length === 0) throw new Error("Negotiation decision cannot be empty");
  const positions = input.rounds.flatMap((round) => [
    { side: "proposal" as const, position: round.proposal },
    { side: "counter" as const, position: round.counter },
  ]);
  const canonical = JSON.stringify({
    runId: input.runId,
    topic: input.topic.trim(),
    trigger: input.trigger,
    positions,
    decision,
    escalated: input.escalated,
  });
  return {
    id: createHash("sha256").update(canonical).digest("hex"),
    runId: input.runId,
    topic: input.topic.trim(),
    trigger: input.trigger,
    positions,
    decision,
    escalated: input.escalated,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export async function persistDecisionRecord(
  memory: DecisionRecordStore,
  record: DecisionRecord,
): Promise<void> {
  await memory.rememberDecisionRecord?.(record);
}
