import { assertAcceptanceContract } from "../core/acceptance.js";
import { FatalFailure } from "../core/errors.js";
import type { AcceptanceCriterion } from "../core/types.js";
import type { DecisionRecord } from "./types.js";

export function bindDecisionAcceptanceCriteria(
  record: DecisionRecord,
  existing: readonly AcceptanceCriterion[],
): readonly AcceptanceCriterion[] {
  if (record.requiredVerification.length === 0) {
    throw new FatalFailure(
      `Negotiation ${record.id} has no bindable verification requirement; stopping before commit`,
    );
  }
  let nextId = Math.max(0, ...existing.map((criterion) => criterionNumber(criterion.id))) + 1;
  const additions = record.requiredVerification.map((requirement): AcceptanceCriterion => {
    const criterion: AcceptanceCriterion = {
      id: `AC-${nextId}`,
      description: requirement.description,
      requiredEvidence: [requirement.verifier.kind === "review" ? "review" : "test"],
      verifier: requirement.verifier,
    };
    nextId += 1;
    return criterion;
  });
  const result = [...existing, ...additions];
  try {
    assertAcceptanceContract(result);
  } catch (error) {
    throw new FatalFailure(
      `Negotiation ${record.id} verification could not be bound to the acceptance contract`,
      { cause: error },
    );
  }
  return result;
}

function criterionNumber(id: string): number {
  const value = Number(id.slice(3));
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}
