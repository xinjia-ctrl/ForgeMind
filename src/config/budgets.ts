import type { StageId, TokenBudget, TokenBudgets } from "../core/types.js";

export const DEFAULT_TOKEN_BUDGETS: TokenBudgets = Object.freeze({
  PLAN: { input: 8_000, output: 2_000 },
  ARCH: { input: 12_000, output: 3_000 },
  CODE: { input: 32_000, output: 8_000 },
  REVIEW: { input: 24_000, output: 3_000 },
  TEST: { input: 2_000, output: 500 },
  COMMIT: { input: 2_000, output: 500 },
});

export function budgetFor(budgets: TokenBudgets, stage: StageId): TokenBudget {
  return budgets[stage];
}
