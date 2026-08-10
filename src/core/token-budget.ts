import { HardFailure } from "./errors.js";
import type { TokenBudget } from "./types.js";

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

export class TokenBudgetTracker {
  readonly #budget: TokenBudget;
  #inputUsed = 0;
  #outputUsed = 0;

  public constructor(budget: TokenBudget) {
    if (budget.input <= 0 || budget.output <= 0) {
      throw new HardFailure("Token budgets must be positive integers");
    }
    this.#budget = budget;
  }

  public consumeInput(tokens: number): void {
    assertNonNegative(tokens);
    this.ensureInputFits(tokens);
    this.#inputUsed += tokens;
  }

  public ensureInputFits(tokens: number): void {
    assertNonNegative(tokens);
    if (this.#inputUsed + tokens > this.#budget.input) {
      throw new HardFailure(
        `Input token budget exceeded (${this.#inputUsed + tokens}/${this.#budget.input})`,
      );
    }
  }

  public consumeOutput(tokens: number): void {
    assertNonNegative(tokens);
    this.ensureOutputFits(tokens);
    this.#outputUsed += tokens;
  }

  public ensureOutputFits(tokens: number): void {
    assertNonNegative(tokens);
    if (this.#outputUsed + tokens > this.#budget.output) {
      throw new HardFailure(
        `Output token budget exceeded (${this.#outputUsed + tokens}/${this.#budget.output})`,
      );
    }
  }

  public get usage(): Readonly<{ input: number; output: number }> {
    return { input: this.#inputUsed, output: this.#outputUsed };
  }
}

function assertNonNegative(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new HardFailure(`Invalid token usage: ${value}`);
  }
}
